/** Initialize the current chat using the server's authenticated business state. */
import { createHash } from 'node:crypto'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { LoginInfo } from '../../packages/client/ui-custom/connection/src/browser-auth.ts'
import { prepareDirectory } from '../url-workspace/index.ts'
import { isAbsolute } from 'node:path'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPlugins } from './plugins.ts'
import { installSettings, recordModel, resolveModel } from './agent-settings.ts'

export const name = 'business-login'
export const inject = ['connection', 'businessAuth', 'sessionController', 'workspaceRegistry', 'loader', 'llm', 'systemPrompt']
export interface Config { rootDirectory: string; pluginsDir: string; timeoutMs: number }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'business-login': { kind: 'business-login'; identity: string }
  }
}

function identity(info: LoginInfo): string {
  return createHash('sha256').update(JSON.stringify(info)).digest('hex')
}
export function binding(session: Session): string | undefined {
  for (const event of session.snapshotEvents()) {
    const messages = event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    for (const message of messages) if (message.source.kind === name) return message.source.identity
  }
  return undefined
}

/** Every route derives initialization facts from the HttpOnly authentication cookie. */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.rootDirectory) || typeof config.pluginsDir !== 'string' || !config.pluginsDir.trim() || !Number.isInteger(config.timeoutMs)
    || config.timeoutMs < 1 || config.timeoutMs > 2147483647) throw new Error('业务初始化配置无效')
  const pending = new WeakMap<Session, { identity: string; ready: Promise<void> }>()
  const initialized = new WeakMap<Agent, string>()
  const owners = new Set<Fiber>()
  const directory = resolve(fileURLToPath(new URL('.', import.meta.url)), config.pluginsDir)
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.all([...owners].map(async owner => { await owner.dispose(); await owner.await() }))
    owners.clear()
  })

  async function initialize(agent: Agent, info: LoginInfo, signal: AbortSignal): Promise<void> {
    const wanted = identity(info)
    const existing = binding(agent.session)
    if (existing !== undefined && existing !== wanted) throw new Error('当前会话已绑定其他业务登录信息，请新建会话')
    if (initialized.get(agent) === wanted) return
    // Await recovery/previous work without interrupting it; maintenance keeps new input queued.
    let abort: (() => void) | undefined
    try {
      await Promise.race([agent.whenIdle(), new Promise<never>((_resolve, reject) => {
        abort = (): void => { reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
    } finally {
      if (abort !== undefined) signal.removeEventListener('abort', abort)
    }
    signal.throwIfAborted()
    await agent.runMaintenance(async maintenanceSignal => {
      const activeSignal = AbortSignal.any([signal, maintenanceSignal])
      const selected = await resolveModel(ctx, info.agentInfo.model, activeSignal)
      let owner: Fiber | undefined
      try {
        owner = await mountPlugins(agent, info.agentInfo.pluginList, directory, activeSignal)
          ?? agent.ctx.plugin({ name: 'business-login-settings', apply() {} })
        await owner.await()
        owners.add(owner)
        const mounted = owner
        owner.ctx.effect(() => () => { owners.delete(mounted); initialized.delete(agent) })
        installSettings(owner.ctx, info.agentInfo.sysPrompt, selected)
        await owner.ctx.systemPrompt.assemble({ agent, scope: agent, signal: activeSignal })
        activeSignal.throwIfAborted()
        recordModel(agent, selected)
        if (existing === undefined) {
          agent.inbox.prepend('next-step', createUserMessage({
            content: [{ type: 'text', text: `业务系统提供的默认上下文（JSON）：\n${JSON.stringify(info.defaultContext, null, 2)}` }],
            source: { kind: 'business-login', identity: wanted },
          }))
        }
        initialized.set(agent, wanted)
      } catch (error) {
        if (owner !== undefined) { await owner.dispose(); await owner.await(); owners.delete(owner) }
        throw error
      }
    })
  }

  for (const operation of ['workspace', 'initialize'] as const) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/business/${operation}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let body: unknown
        try { body = await request.json() } catch { return new Response('Invalid JSON', { status: 400 }) }
        const parsed = clientRequestSchema.safeParse(body)
        if (!parsed.success || parsed.data.method !== `business/${operation}`) return new Response('Invalid RPC envelope', { status: 400 })
        const message = parsed.data
        const respond = (result: unknown): Response => Response.json({ type: 'server-response', rpcId: message.rpcId, result },
          { headers: { 'cache-control': 'no-store' } })
        try {
          const info = ctx.businessAuth.lookup({ headers: request.headers }, ctx.get('webServer')?.protocol === 'https:')
          if (info === undefined) throw new Error('业务登录已过期，请重新登录')
          const directory = await prepareDirectory(config.rootDirectory, info.path)
          const workspace = await ctx.workspaceRegistry.create(directory)
          if (operation === 'workspace') return respond({ ok: true, value: { path: workspace.path, name: info.agentInfo.name } })
          const payload = message.payload
          if (typeof payload !== 'object' || payload === null || !('sessionId' in payload)
            || typeof payload.sessionId !== 'string' || !payload.sessionId) throw new Error('会话 ID 无效')
          const result = await ctx.sessionController.resolveAgent(SessionId(payload.sessionId))
          if ('error' in result) throw result.error
          if (!workspace.sessionIds.includes(result.agent.session.id)) throw new Error('当前会话不属于业务工作区')
          const signal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(config.timeoutMs)])
          const wanted = identity(info)
          let loading = pending.get(result.agent.session)
          if (loading !== undefined && loading.identity !== wanted) throw new Error('当前会话正在初始化其他业务信息')
          if (loading === undefined) {
            const session = result.agent.session
            const ready = initialize(result.agent, info, signal).finally(() => { pending.delete(session) })
            loading = { identity: wanted, ready }
            pending.set(session, loading)
          }
          await loading.ready
          return respond({ ok: true, value: null })
        } catch (error) {
          return respond({ ok: false, error: { code: 'business-login/failed',
            message: `业务会话初始化失败：${error instanceof Error ? error.message : '请求超时或已取消'}。请重新登录或新建会话。`, details: {} } })
        }
      },
    }))
  }
}
