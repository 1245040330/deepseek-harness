/** Resolve a business model and install Agent-local system and request settings. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Resolve a bare model id only when exactly one configured provider offers it. */
export async function resolveModel(ctx: Context, model: string, signal: AbortSignal): Promise<LlmCallConfig> {
  const matches: string[] = []
  for (const provider of ctx.llm.listProviders()) {
    signal.throwIfAborted()
    const models = await ctx.llm.listModels(provider.id)
    if (models.some(entry => entry.id === model)) matches.push(provider.id)
  }
  if (matches.length === 0) throw new Error(`服务端指定的模型 ${model} 未在已配置的模型目录中找到`)
  if (matches.length !== 1) throw new Error(`模型 ${model} 匹配多个 provider：${matches.join('、')}，请管理员消除歧义`)
  return ctx.llm.resolveCallConfig({ provider: matches[0]!, model }, signal)
}

/** Contributions belong to the caller's disposable Agent child context. */
export function installSettings(ctx: Context, sysPrompt: string, selected: LlmCallConfig): void {
  ctx.systemPrompt.section({ name: 'business-login:system', order: 0, text: sysPrompt, interpolate: false, complete: true })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return { ...assembly, variables: { ...assembly.variables, provider: selected.provider, model: selected.model } }
  }, { prepend: true })
  ctx.on('agent/request', async (_payload, next) => {
    const { reasoningEffort: _previousEffort, ...current } = await next()
    return { ...current, ...selected }
  }, { prepend: true })
}

/** Record the session model without changing the shared default-model preference. */
export function recordModel(agent: Agent, selected: LlmCallConfig): void {
  agent.session.append('model/selection', { provider: selected.provider, model: selected.model,
    ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) })
}
