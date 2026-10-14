/** Load business reference data into one durable chat inbox. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'agent-chat-preset'
export const inject = ['typert', 'sessionController']
export interface Config { endpoint: string; timeoutMs: number }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-chat-preset': { kind: 'agent-chat-preset'; chatId: string }
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'agent-chat-preset/failed': { readonly chatId: string }
  }
}

/** Recognize durable binding facts without interpreting reference prose. */
export function boundChatId(session: Session): string | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Recover this plugin's inbox and consumed message facts.
  for (const event of session.snapshotEvents()) {
    const messages: readonly UserMessage[] = event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    for (const message of messages) {
      if (message.source.kind === name) return message.source.chatId
    }
  }
  return undefined
}

/** Keep every data field; the business envelope never enters model context. */
export function referenceJson(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('code' in value) || value.code !== 200
    || !('data' in value) || typeof value.data !== 'object' || value.data === null) {
    throw new Error('参考资料接口返回业务错误或无效 data')
  }
  return JSON.stringify(value.data, null, 2)
}

export class AgentChatPreset extends TypertRemoteService {
  private readonly pending = new WeakMap<Session, { chatId: string; ready: Promise<void> }>()
  private readonly lifetime = new AbortController()
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentChatPreset')
    ctx.effect(() => () => { this.lifetime.abort() })
  }

  /** Bind before exposing the conversation to user input. */
  @Remote('bind')
  async bind(sessionId: string, chatId: string, signal: AbortSignal): Promise<void> {
    try {
      if (typeof sessionId !== 'string' || !sessionId || typeof chatId !== 'string'
        || !chatId.trim() || chatId.length > 512) throw new Error('chatId 或会话 ID 无效')
      const result = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
      if ('error' in result) throw result.error
      const agent = result.agent
      const bound = boundChatId(agent.session)
      if (bound !== undefined) {
        if (bound !== chatId) throw new Error('该会话已绑定其他 chatId，请新建会话')
        return
      }
      let pending = this.pending.get(agent.session)
      if (pending !== undefined && pending.chatId !== chatId) throw new Error('该会话正在加载其他 chatId，请新建会话')
      if (pending === undefined) {
        const ready = this.load(agent, chatId, AbortSignal.any([signal, this.lifetime.signal]))
          .finally(() => { this.pending.delete(agent.session) })
        pending = { chatId, ready }
        this.pending.set(agent.session, pending)
      }
      await pending.ready
    } catch (error) {
      throw new RemoteError('agent-chat-preset/failed',
        `参考资料加载失败：${error instanceof Error ? error.message : String(error)}。请检查 chatId 后重试。`,
        { chatId }, { cause: error })
    }
  }

  private async load(agent: Agent, chatId: string, signal: AbortSignal): Promise<void> {
    if (agent.status !== 'idle') throw new Error('会话正在运行，请等待结束后重试')
    const url = new URL(this.config.endpoint)
    url.searchParams.set('chatId', chatId)
    const response = await fetch(url, { headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]) })
    if (!response.ok) throw new Error(`接口 HTTP ${response.status}`)
    const json = referenceJson(await response.json())
    signal.throwIfAborted()
    if (agent.status !== 'idle') throw new Error('会话已开始运行，请等待结束后重试')
    agent.inbox.prepend('next-step', createUserMessage({
      content: [{ type: 'text', text: `业务系统提供的参考资料（JSON）：\n${json}` }],
      source: { kind: 'agent-chat-preset', chatId },
    }))
  }
}

/** Mount the Host-only Remote owner. */
export function apply(ctx: Context, config: Config): void {
  const endpoint = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || !Number.isInteger(config.timeoutMs)
    || config.timeoutMs < 1 || config.timeoutMs > 2147483647) throw new Error('参考资料插件 endpoint 或 timeoutMs 配置无效')
  new AgentChatPreset(ctx, config)
}
