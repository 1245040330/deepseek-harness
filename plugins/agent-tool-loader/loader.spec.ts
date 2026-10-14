import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Include from '@deepseek-ai/cordis-plugin-include'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import * as loader from './index.ts'
import { harness } from '../../packages/preset/agent-preset-registry/tests/harness.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals() })

async function setup() {
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = await harness()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.agentToolLoader = loader
  await mkdir(join(root, 'custom'))
  await writeFile(join(root, 'custom', 'index.mjs'), `export const inject = ['tools'];
export function apply(ctx) { ctx.tools.register({ name: 'fixture_lookup', description: 'lookup',
parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
execute: async () => 'fixture result' }); }\n`)
  await writeFile(join(root, 'custom', 'cordis.patch.yml'), '- insert:\n    - id: custom\n      name: ./index.mjs\n')
  const file = join(root, 'cordis.yml')
  await writeFile(file, `- name: cordis:agentToolLoader\n  config:\n    endpoint: https://example.test/tools\n    pluginsDir: ${JSON.stringify(root)}\n    timeoutMs: 1000\n`)
  const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  const first = await ctx.agents.create({ sessionId: SessionId('first') })
  const second = await ctx.agents.create({ sessionId: SessionId('second') })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 200, data: { agentId: '2', plugins: [{ id: 'custom' }] } })))
  vi.stubGlobal('fetch', fetcher)
  const run = (agentId = '2', agent = first.agent) => ctx.tools.execute({ callId: ToolCallId('load'),
    name: 'load_agent_tools', arguments: { agentId }, agent, signal: new AbortController().signal })
  return { ctx, root, entry, first, second, fetcher, run }
}

it('loads URL-selected tools through RPC and shares the tool loader cache', async () => {
  const b = await setup()
  await b.ctx.plugin(TypertRegistry)
  b.ctx.provide('sessionController', { resolveAgent: async (id: string) => ({
    agent: id === 'first' ? b.first.agent : b.second.agent,
  }) })
  await b.ctx.fiber.await()
  await b.ctx.plugin(TypertGateway)
  const invoke = (sessionId = 'first', agentId = '2') => b.ctx.typertGateway.invoke({
    namespace: 'agentToolLoader', method: 'load', args: { sessionId, agentId },
  })
  expect(await invoke()).toEqual({ agentId: '2', plugins: ['custom'] })
  expect((await b.run()).isError).toBe(false)
  expect(b.fetcher).toHaveBeenCalledTimes(1)
  expect(b.ctx.tools.schemas(b.first.agent).map(row => row.name)).toContain('fixture_lookup')
  expect(b.ctx.tools.schemas(b.second.agent).map(row => row.name)).not.toContain('fixture_lookup')
  await expect(invoke('first', '3')).rejects.toThrow('新建聊天')
  await invoke('second')
  expect(b.fetcher).toHaveBeenCalledTimes(2)
})

it('allows URL loading to retry after an API failure', async () => {
  const b = await setup()
  await b.ctx.plugin(TypertRegistry)
  b.ctx.provide('sessionController', { resolveAgent: async () => ({ agent: b.first.agent }) })
  await b.ctx.fiber.await()
  await b.ctx.plugin(TypertGateway)
  const invoke = () => b.ctx.typertGateway.invoke({ namespace: 'agentToolLoader', method: 'load',
    args: { sessionId: 'first', agentId: '2' } })
  b.fetcher.mockResolvedValueOnce(new Response('failure', { status: 503 }))
  await expect(invoke()).rejects.toThrow('HTTP 503')
  expect(await invoke()).toEqual({ agentId: '2', plugins: ['custom'] })
})

it('loads local tools through YAML into one chat, reuses the selection and disposes it', async () => {
  const b = await setup()
  const result = await b.run()
  expect(result.isError, JSON.stringify(result)).toBe(false)
  expect(b.ctx.tools.schemas(b.first.agent).map(row => row.name)).toContain('fixture_lookup')
  expect(b.ctx.tools.schemas(b.second.agent).map(row => row.name)).not.toContain('fixture_lookup')
  expect(b.ctx.tools.schemas().map(row => row.name)).not.toContain('fixture_lookup')
  expect((await b.ctx.tools.execute({ callId: ToolCallId('lookup'), name: 'fixture_lookup', arguments: {},
    agent: b.first.agent, signal: new AbortController().signal })).isError).toBe(false)
  expect((await b.run()).isError).toBe(false)
  expect(b.fetcher).toHaveBeenCalledTimes(1)
  await expect(JSON.stringify({ result: result.content,
    currentTools: b.ctx.tools.schemas(b.first.agent).map(row => row.name).sort(),
    otherTools: b.ctx.tools.schemas(b.second.agent).map(row => row.name).sort(),
  }, null, 2) + '\n').toMatchFileSnapshot('./expected-tools.json')
  expect((await b.run('3')).isError).not.toBe(false)
  const owner = [...b.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:agentToolLoader')?.fiber
  expect(owner).toBeDefined()
  await owner?.dispose()
  await owner?.await()
  expect(b.ctx.tools.schemas(b.first.agent).map(row => row.name)).not.toContain('fixture_lookup')
})

it('cleans failed mounts and allows a later retry', async () => {
  const b = await setup()
  await writeFile(join(b.root, 'custom', 'index.mjs'), `export const inject = ['tools'];
export function apply(ctx) { ctx.tools.register({name:'partial', description:'partial', parameters:{type:'object'},
output:{schema:{type:'string'},render:()=>[]},execute:async()=>''}); throw new Error('fixture failure'); }\n`)
  expect((await b.run()).isError).not.toBe(false)
  expect(b.ctx.tools.schemas(b.first.agent).map(row => row.name)).not.toContain('partial')
  b.fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: 200, data: { agentId: '2', plugins: [] } })))
  expect((await b.run()).isError).toBe(false)
})

it('rejects mismatched IDs, missing files, traversal and escaped symlinks', async () => {
  const b = await setup()
  for (const id of ['../outside', 'missing', 'agent-tool-loader']) {
    b.fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: 200, data: { agentId: '2', plugins: [{ id }] } })))
    expect((await b.run()).isError).not.toBe(false)
  }
  const outside = await mkdtemp(join(tmpdir(), 'agent-tool-outside-'))
  cleanup.push(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'cordis.patch.yml'), '[]\n')
  await symlink(outside, join(b.root, 'escaped'), 'dir')
  b.fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: 200, data: { agentId: '2', plugins: [{ id: 'escaped' }] } })))
  expect((await b.run()).isError).not.toBe(false)
  b.fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: 200, data: { agentId: 'wrong', plugins: [] } })))
  expect((await b.run()).isError).not.toBe(false)
  expect(b.ctx.tools.schemas(b.first.agent).map(row => row.name)).toEqual(['load_agent_tools'])
})


it('reports HTTP and invalid JSON failures without changing chat tools', async () => {
  const b = await setup()
  b.fetcher.mockImplementation(async () => new Response('unavailable', { status: 503 }))
  expect((await b.run()).isError).toBe(true)
  b.fetcher.mockImplementation(async () => new Response('invalid json'))
  expect((await b.run()).isError).toBe(true)
  expect(b.ctx.tools.schemas(b.first.agent).map(row => row.name)).toEqual(['load_agent_tools'])
})


it('loads the existing CLInfo source plugin without changing its files', async () => {
  const b = await setup()
  const dir = join(b.root, 'clinfo-document-record')
  await mkdir(dir)
  for (const file of ['index.ts', 'cordis.patch.yml']) {
    await writeFile(join(dir, file), await readFile(new URL(`../clinfo-document-record/${file}`, import.meta.url)))
  }
  b.fetcher.mockImplementation(async () => new Response(JSON.stringify({ code: 200,
    data: { agentId: '2', plugins: [{ id: 'clinfo-document-record' }] } })))
  const result = await b.run()
  expect(result.isError, JSON.stringify(result)).toBe(false)
  expect(b.ctx.tools.schemas(b.first.agent).map(row => row.name)).toContain('query_document_records')
  expect(b.ctx.tools.schemas(b.second.agent).map(row => row.name)).not.toContain('query_document_records')
})
