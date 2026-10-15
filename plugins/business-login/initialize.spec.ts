import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { MemoryStorageBackend } from '../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import { declare, harness } from '../../packages/preset/agent-preset-registry/tests/harness.ts'
import * as Connection from '../../packages/client/ui-custom/connection/src/index.ts'
import * as BusinessLogin from './index.ts'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { agentEvents, installModelSelection } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
class CatalogAdapter extends LlmAdapter {
  async *stream() { throw new Error('No real model request expected') }
  override async listModels(provider: string) { return [{ provider, id: 'qwen3.8-max', name: 'qwen3.8-max' }] }
}
const fixture = `export const inject = ['tools'];
export function apply(ctx) { ctx.tools.register({ name: 'fixture_lookup', description: 'lookup',
parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
execute: async () => 'fixture result' }); }`

const data = { path: '992/1/教学工作台/1serviceName', agentId: '123',
  agentInfo: { name: '高校专业智能体', model: 'qwen3.8-max', sysPrompt: '你是高校专业智能体。保留 {{literal}}。', pluginList: ['fixture'] },
  defaultContext: { '工作职责': '文档摘要，归集整理，统计分析，质量初审', '智能体名称': '教学工作台', all: [false, null, 0] } }

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'business-initialize-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = await harness()
  cleanup.push(() => ctx.fiber.dispose())
  await declare(ctx, { id: 'standard', plugins: [] })
  ctx.llm.registerAdapter(['business-provider'], new CatalogAdapter())
  await mkdir(join(root, 'plugins/fixture'), { recursive: true })
  await writeFile(join(root, 'plugins/fixture/index.mjs'), fixture)
  await writeFile(join(root, 'plugins/fixture/cordis.patch.yml'), '- insert:\n    - id: fixture\n      name: ./index.mjs\n')
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'logs') })
  await ctx.plugin(WorkspaceRegistry)
  let current = data
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname !== '/login') throw new Error('Unexpected API: ' + url.pathname)
    return Response.json({ code: 200, data: current })
  })
  vi.stubGlobal('fetch', fetcher)
  await ctx.plugin(Connection, { loginEndpoint: 'https://example.test/login' })
  await ctx.plugin(TypertRegistry)
  ctx.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: ctx.agents.get(SessionId(id))! }) })
  // Mount the actual loader and business routes through Loader entry records.
  ctx.loader.builtins.businessLogin = BusinessLogin
  await ctx.loader.create({ name: 'cordis:businessLogin', config: { rootDirectory: root, pluginsDir: join(root, 'plugins'), timeoutMs: 1000 } })
  await ctx.loader.await()
  async function login() {
    let cookie = ''
    await ctx.businessAuth.authorizeBusinessIndex({ method: 'GET', url: '/?token=business', headers: { host: 'example.test' } },
      { writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] ?? '' }, end() {} })
    return cookie
  }
  async function call(operation: string, cookie: string, payload: unknown = {}) {
    const result = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(`http://example.test/api/business/${operation}`, {
      method: 'POST', headers: { host: 'example.test', cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: `business/${operation}`, payload }),
    }))
    return (await result.json()).result
  }
  const cookie = await login()
  const workspaceResult = await call('workspace', cookie, { path: 'evil', agentId: 'evil' })
  const workspace = (await ctx.workspaceRegistry.resolveByPath(workspaceResult.value.path))!
  const first = (await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: workspace.path } })).agent
  const second = (await ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd: workspace.path } })).agent
  await workspace.attachSession(first.session.id)
  await workspace.attachSession(second.session.id)
  installModelSelection(first.ctx, { current: { provider: 'old-provider', model: 'old-model' }, assembled: undefined })
  return { ctx, root, cookie, first, second, workspace, call, login, fetcher, setData: (value: typeof data) => { current = value } }
}

it('uses server-authenticated path and agentId and durably injects complete context exactly once', async () => {
  const b = await setup()
  expect(b.workspace.path).toBe(join(b.root, data.path))
  const payload = { sessionId: 'first', path: 'evil', agentId: 'evil', defaultContext: { bad: true } }
  const results = await Promise.all([b.call('initialize', b.cookie, payload), b.call('initialize', b.cookie, payload)])
  expect(results).toEqual([{ ok: true, value: null }, { ok: true, value: null }])
  expect((await b.call('initialize', b.cookie, payload)).ok).toBe(true)
  expect(b.first.inbox.nextStep).toHaveLength(1)
  expect(b.first.inbox.nextStep[0]?.content).toEqual([{ type: 'text',
    text: `业务系统提供的默认上下文（JSON）：\n${JSON.stringify(data.defaultContext, null, 2)}` }])
  expect(BusinessLogin.binding(b.first.session)).toBeDefined()
  expect(b.second.inbox.nextStep).toHaveLength(0)
  expect(b.fetcher).toHaveBeenCalledTimes(1)
  expect(b.ctx.tools.schemas(b.first).map(tool => tool.name)).toContain('fixture_lookup')
  expect(b.ctx.tools.schemas(b.second).map(tool => tool.name)).not.toContain('fixture_lookup')
  const prompt = await b.ctx.systemPrompt.assemble({ agent: b.first, scope: b.first })
  expect(renderPrompt(prompt)).toBe(data.agentInfo.sysPrompt)
  expect(prompt.variables.model).toBe(data.agentInfo.model)
  const selected = await agentEvents(b.ctx, b.first).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ provider: 'old', model: 'old-model' }))
  expect(selected.provider).toBe('business-provider')
  expect(selected.model).toBe(data.agentInfo.model)
  const otherPrompt = await b.ctx.systemPrompt.assemble({ agent: b.second, scope: b.second })
  expect(renderPrompt(otherPrompt)).not.toContain(data.agentInfo.sysPrompt)
})

it('rejects a different business identity on the same chat while allowing a new chat', async () => {
  const b = await setup()
  await b.call('initialize', b.cookie, { sessionId: 'first' })
  b.setData({ ...data, defaultContext: { ...data.defaultContext, '智能体名称': '另一个智能体' } })
  const changed = await b.login()
  const rejected = await b.call('initialize', changed, { sessionId: 'first' })
  expect(rejected.ok).toBe(false)
  expect(rejected.error.message).toContain('新建会话')
  expect(await b.call('initialize', changed, { sessionId: 'second' })).toEqual({ ok: true, value: null })
  expect(b.first.inbox.nextStep).toHaveLength(1)
  expect(b.second.inbox.nextStep).toHaveLength(1)
})

it('keeps the inbox unchanged when tool initialization fails and supports retry', async () => {
  const b = await setup()
  b.setData({ ...data, agentInfo: { ...data.agentInfo, pluginList: ['missing'] } })
  const cookie = await b.login()
  expect((await b.call('initialize', cookie, { sessionId: 'first' })).ok).toBe(false)
  expect(b.first.inbox.nextStep).toHaveLength(0)
  expect(b.ctx.tools.schemas(b.first).map(tool => tool.name)).not.toContain('fixture_lookup')
  await mkdir(join(b.root, 'plugins/missing'))
  await writeFile(join(b.root, 'plugins/missing/index.mjs'), fixture)
  await writeFile(join(b.root, 'plugins/missing/cordis.patch.yml'), '- insert:\n    - id: fixture\n      name: ./index.mjs\n')
  expect(await b.call('initialize', cookie, { sessionId: 'first' })).toEqual({ ok: true, value: null })
  b.first.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } }))
  expect(b.first.inbox.nextStep).toHaveLength(2)
})

it('rejects missing and ambiguous models without mounting plugins or writing context', async () => {
  const b = await setup()
  b.setData({ ...data, agentInfo: { ...data.agentInfo, model: 'missing-model' } })
  const missingCookie = await b.login()
  const missing = await b.call('initialize', missingCookie, { sessionId: 'first' })
  expect(missing.ok).toBe(false)
  expect(missing.error.message).toContain('未在已配置')
  b.ctx.llm.registerAdapter(['another-provider'], new CatalogAdapter())
  const ambiguous = await b.call('initialize', b.cookie, { sessionId: 'first' })
  expect(ambiguous.ok).toBe(false)
  expect(ambiguous.error.message).toContain('多个 provider')
  expect(b.first.inbox.nextStep).toHaveLength(0)
  expect(b.ctx.tools.schemas(b.first)).toHaveLength(0)
})

it('supports an empty plugin list while applying the business prompt, model and context', async () => {
  const b = await setup()
  b.setData({ ...data, agentInfo: { ...data.agentInfo, pluginList: [] } })
  const cookie = await b.login()
  expect(await b.call('initialize', cookie, { sessionId: 'first' })).toEqual({ ok: true, value: null })
  expect(b.ctx.tools.schemas(b.first)).toHaveLength(0)
  expect(b.first.inbox.nextStep).toHaveLength(1)
  expect(renderPrompt(await b.ctx.systemPrompt.assemble({ agent: b.first, scope: b.first }))).toBe(data.agentInfo.sysPrompt)
})

it('removes partial plugin registrations if a selected plugin fails to activate', async () => {
  const b = await setup()
  await mkdir(join(b.root, 'plugins/broken'))
  await writeFile(join(b.root, 'plugins/broken/index.mjs'), fixture.replace("'fixture_lookup'", "'broken_lookup'").replace("}); }", "}); throw new Error('activation failed'); }"))
  await writeFile(join(b.root, 'plugins/broken/cordis.patch.yml'), '- insert:\n    - id: broken\n      name: ./index.mjs\n')
  b.setData({ ...data, agentInfo: { ...data.agentInfo, pluginList: ['fixture', 'broken'] } })
  const cookie = await b.login()
  expect((await b.call('initialize', cookie, { sessionId: 'first' })).ok).toBe(false)
  expect(b.ctx.tools.schemas(b.first)).toHaveLength(0)
  expect(b.first.inbox.nextStep).toHaveLength(0)
  expect(BusinessLogin.binding(b.first.session)).toBeUndefined()
})
