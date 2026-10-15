import { mkdtemp, realpath, rm } from 'node:fs/promises'
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
import * as ToolLoader from '../agent-tool-loader/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const data = { path: '992/1/教学工作台/1serviceName', agentId: '123',
  defaultContext: { '工作职责': '文档摘要，归集整理，统计分析，质量初审', '智能体名称': '教学工作台', all: [false, null, 0] } }

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'business-initialize-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = await harness()
  cleanup.push(() => ctx.fiber.dispose())
  await declare(ctx, { id: 'standard', plugins: [] })
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
    return Response.json(url.pathname === '/login' ? { code: 200, data: current }
      : { code: 200, data: { agentId: url.searchParams.get('agentId'), plugins: [] } })
  })
  vi.stubGlobal('fetch', fetcher)
  await ctx.plugin(Connection, { loginEndpoint: 'https://example.test/login' })
  await ctx.plugin(TypertRegistry)
  ctx.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: ctx.agents.get(SessionId(id))! }) })
  // Mount the actual loader and business routes through Loader entry records.
  ctx.loader.builtins.businessLogin = BusinessLogin
  ctx.loader.builtins.agentToolLoader = ToolLoader
  await ctx.loader.create({ name: 'cordis:agentToolLoader', config: { endpoint: 'https://example.test/tools', pluginsDir: '.', timeoutMs: 1000 } })
  await ctx.loader.create({ name: 'cordis:businessLogin', config: { rootDirectory: root, timeoutMs: 1000 } })
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
  const workspace = (await ctx.workspaceRegistry.resolveByPath(workspaceResult.value))!
  const first = (await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: workspace.path } })).agent
  const second = (await ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd: workspace.path } })).agent
  await workspace.attachSession(first.session.id)
  await workspace.attachSession(second.session.id)
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
  const tools = b.fetcher.mock.calls.filter(([url]) => new URL(url).pathname === '/tools')
  expect(tools).toHaveLength(1)
  expect(new URL(tools[0]![0]).searchParams.get('agentId')).toBe('123')
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
  b.fetcher.mockResolvedValueOnce(new Response('failure', { status: 503 }))
  expect((await b.call('initialize', b.cookie, { sessionId: 'first' })).ok).toBe(false)
  expect(b.first.inbox.nextStep).toHaveLength(0)
  expect(await b.call('initialize', b.cookie, { sessionId: 'first' })).toEqual({ ok: true, value: null })
  b.first.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'later' }], source: { kind: 'user' } }))
  expect(b.first.inbox.nextStep).toHaveLength(2)
})
