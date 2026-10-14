import { afterEach, expect, it, vi } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { AgentChatPreset, boundChatId, referenceJson } from './index.ts'
import { agentOn, declare, harness } from '../../packages/preset/agent-preset-registry/tests/harness.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const ctx = await harness()
  cleanups.push(() => ctx.fiber.dispose())
  await declare(ctx, { id: 'standard', plugins: [] })
  const first = await agentOn(ctx, 'preset-first')
  const second = await agentOn(ctx, 'preset-second')
  ctx.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: id === first.session.id ? first : second }) })
  const plugin = new AgentChatPreset(ctx, { endpoint: 'https://example.test/preset', timeoutMs: 1000 })
  const fetcher = vi.fn(async (_input: string | URL) => new Response(JSON.stringify({ code: 200, msg: '成功',
    data: { '任务名': '', nested: { items: [1, false, null, '参考资料'] } } }), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  return { ctx, first, second, plugin, fetcher, signal: new AbortController().signal }
}

it('preserves all data and omits the business envelope', () => {
  expect(JSON.parse(referenceJson({ code: 200, msg: '成功', data: { '任务名': '', nested: [0, false, null] } })))
    .toEqual({ '任务名': '', nested: [0, false, null] })
  expect(() => referenceJson({ code: 500, data: {} })).toThrow()
})

it('writes complete reference data into the durable inbox and deduplicates concurrent loads', async () => {
  const b = await setup()
  await Promise.all([b.plugin.bind(b.first.session.id, '123', b.signal), b.plugin.bind(b.first.session.id, '123', b.signal)])
  await b.plugin.bind(b.first.session.id, '123', b.signal)
  expect(b.fetcher).toHaveBeenCalledTimes(1)
  expect(new URL(String(b.fetcher.mock.calls[0]?.[0])).searchParams.get('chatId')).toBe('123')
  expect(boundChatId(b.first.session)).toBe('123')
  expect(b.first.inbox.nextStep).toHaveLength(1)
  expect(b.first.inbox.nextStep[0]?.content).toEqual([{ type: 'text',
    text: '业务系统提供的参考资料（JSON）：\n' + JSON.stringify({ '任务名': '', nested: { items: [1, false, null, '参考资料'] } }, null, 2) }])
  expect(b.second.inbox.nextStep).toHaveLength(0)
  await b.plugin.bind(b.first.session.id, '123', b.signal)
  expect(b.fetcher).toHaveBeenCalledTimes(1)
})

it('rejects different chatIds on one session while allowing another session', async () => {
  const b = await setup()
  await b.plugin.bind(b.first.session.id, '123', b.signal)
  await expect(b.plugin.bind(b.first.session.id, '456', b.signal)).rejects.toThrow('其他 chatId')
  await b.plugin.bind(b.second.session.id, '456', b.signal)
  expect(boundChatId(b.second.session)).toBe('456')
})

it('leaves the inbox unchanged on failure and permits retry', async () => {
  const b = await setup()
  b.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: 500, data: {} })))
  await expect(b.plugin.bind(b.first.session.id, '123', b.signal)).rejects.toThrow('参考资料加载失败')
  expect(b.first.inbox.nextStep).toHaveLength(0)
  expect(boundChatId(b.first.session)).toBeUndefined()
  await b.plugin.bind(b.first.session.id, '123', b.signal)
  expect(boundChatId(b.first.session)).toBe('123')
})

it('accepts the browser RPC arguments through the Gateway and honors cancellation', async () => {
  const b = await setup()
  await b.ctx.plugin(TypertRegistry)
  await b.ctx.plugin(TypertGateway)
  await b.ctx.typertGateway.invoke({ namespace: 'agentChatPreset', method: 'bind',
    args: { sessionId: b.first.session.id, chatId: '123' }, signal: b.signal })
  expect(boundChatId(b.first.session)).toBe('123')
  const canceled = new AbortController()
  canceled.abort()
  await expect(b.plugin.bind(b.second.session.id, '456', canceled.signal)).rejects.toThrow()
  expect(b.second.inbox.nextStep).toHaveLength(0)
})
