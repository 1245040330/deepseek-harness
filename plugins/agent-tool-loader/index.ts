/** Load API-selected local plugins into the calling chat's Agent scope. */
import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { loadOverlayPatches, prepareProfileEntries } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { auditRows, leakedServices } from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-tool-loader'
export const inject = ['tools', 'loader']

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'agent-tool-loader/failed': { readonly agentId: string }
  }
}

/** API and local-directory policy supplied by cordis.patch.yml. */
export interface Config {
  endpoint: string
  pluginsDir: string
  timeoutMs: number
}

/** In-memory composition owned by the calling Agent's child fiber. */
class PluginTree extends EntryTree {
  constructor(ctx: Context) {
    const entry = ctx.fiber.entry
    const subtree = entry?.subtree
    const subgroup = entry?.subgroup
    super(ctx)
    if (entry !== undefined) {
      if (subtree === undefined) delete entry.subtree
      else entry.subtree = subtree
      if (subgroup === undefined) delete entry.subgroup
      else entry.subgroup = subgroup
    }
  }

  override write(): void {}
}

interface Selection {
  agentId: string
  plugins: string[]
}

function selection(value: unknown, agentId: string): Selection {
  if (typeof value !== 'object' || value === null || !('code' in value) || value.code !== 200
    || !('data' in value) || typeof value.data !== 'object' || value.data === null
    || !('agentId' in value.data) || value.data.agentId !== agentId
    || !('plugins' in value.data) || !Array.isArray(value.data.plugins)) {
    throw new Error('插件列表接口返回无效数据、业务错误或不匹配的 agentId')
  }
  const ids = value.data.plugins.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string'
      || !/^[a-z0-9][a-z0-9-]*$/.test(row.id) || row.id === name) {
      throw new Error('接口返回了无效插件 ID；只允许小写英文、数字和连字符，且不能加载加载器自身')
    }
    return row.id
  })
  return { agentId, plugins: [...new Set(ids)] }
}

/** Register load_agent_tools; dynamically mounted contributions belong to the calling Agent.
 * @param ctx Loader-owned plugin context.
 * @param config API URL, local plugin directory and timeout.
 */
export function apply(ctx: Context, config: Config): void {
  const endpoint = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('endpoint 必须为 HTTP 或 HTTPS URL')
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2147483647) {
    throw new Error('timeoutMs 必须为 1 至 2147483647 的整数')
  }
  if (!config.pluginsDir.trim()) throw new Error('pluginsDir 不能为空')
  const directory = resolve(fileURLToPath(new URL('.', import.meta.url)), config.pluginsDir)
  const loads = new WeakMap<Agent, { agentId: string; ready: Promise<Selection> }>()
  const owners = new Set<Fiber>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.all([...owners].map(async fiber => {
      await fiber.dispose()
      await fiber.await()
    }))
    owners.clear()
  })

  async function load(agent: Agent, agentId: string, signal: AbortSignal): Promise<Selection> {
    const url = new URL(endpoint)
    url.searchParams.set('agentId', agentId)
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
    if (!response.ok) throw new Error(`插件列表查询失败：HTTP ${response.status}`)
    const result = selection(await response.json(), agentId)
    signal.throwIfAborted()
    if (result.plugins.length === 0) return result
    const root = await realpath(directory)
    const patches = await Promise.all(result.plugins.map(async id => {
      const file = await realpath(resolve(root, id, 'cordis.patch.yml'))
      if (!file.startsWith(root + sep)) throw new Error(`插件 ${id} 的配置路径超出了本地插件目录`)
      return loadOverlayPatches(name, file)
    }))
    const entries = applyEntryPatches([], patches.flat(), message => {
      throw new Error(`插件覆盖层无法应用：${message}`)
    })
    signal.throwIfAborted()
    const fiber = agent.ctx.plugin({ name: 'agent-tool-loader-mount', inject: ['loader', 'tools'], apply() {} })
    owners.add(fiber)
    agent.ctx.effect(() => () => { owners.delete(fiber) })
    try {
      await fiber.await()
      if (scopeOf(fiber.ctx) === undefined) throw new Error('当前 Agent 没有独立作用域')
      const tree = new PluginTree(fiber.ctx)
      fiber.ctx.effect(() => async () => {
        const children = [...tree.entries()].map(entry => entry.fiber)
        tree.root.stop()
        await Promise.all(children.map(child => child?.await()))
      })
      await tree.root.update(prepareProfileEntries(fiber.ctx, entries, fiber.ctx.baseUrl))
      const audit = await auditRows(tree)
      if (audit.failed.length > 0) throw new Error(`插件加载失败：${audit.failed.join('; ')}`)
      const leaked = leakedServices(fiber.ctx, fiber)
      if (leaked.length > 0) throw new Error(`插件服务必须使用隔离域：${leaked.join(', ')}`)
      if (audit.pending.length > 0) throw new Error(`插件缺少依赖服务：${audit.pending.join('; ')}`)
      signal.throwIfAborted()
      return result
    } catch (error) {
      await fiber.dispose()
      await fiber.await()
      owners.delete(fiber)
      throw error
    }
  }

  async function loadSelected(agent: Agent, rawAgentId: string, signal: AbortSignal): Promise<Selection> {
    if (typeof rawAgentId !== 'string') throw new Error('请提供业务智能体 agentId')
    const agentId = rawAgentId.trim()
    if (!agentId) throw new Error('请提供业务智能体 agentId')
    let pending = loads.get(agent)
    if (pending !== undefined && pending.agentId !== agentId) {
      throw new Error(`当前聊天已绑定业务 agentId=${pending.agentId}；切换业务智能体请新建聊天`)
    }
    if (pending === undefined) {
      const ready = load(agent, agentId, AbortSignal.any([
        signal, lifetime.signal, AbortSignal.timeout(config.timeoutMs),
      ])).catch((error: unknown) => {
        loads.delete(agent)
        throw error
      })
      pending = { agentId, ready }
      loads.set(agent, pending)
    }
    return pending.ready
  }

  class AgentToolLoaderRemote extends TypertRemoteService {
    constructor(remoteCtx: Context) { super(remoteCtx, 'agentToolLoader') }

    /** Resolve the current chat and use the same loader as load_agent_tools. */
    @Remote('load')
    async load(sessionId: string, agentId: string, signal: AbortSignal): Promise<Selection> {
      try {
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('会话 ID 无效')
        const result = await this.ctx.sessionController.resolveAgent(SessionId(sessionId))
        if ('error' in result) throw result.error
        if (result.agent.status !== 'idle') throw new Error('会话正在运行，请等待结束后加载工具')
        return await loadSelected(result.agent, agentId, signal)
      } catch (error) {
        throw new RemoteError('agent-tool-loader/failed',
          `工具加载失败：${error instanceof Error ? error.message : String(error)}`,
          { agentId }, { cause: error })
      }
    }
  }
  ctx.inject(['typert', 'sessionController'], remoteCtx => { new AgentToolLoaderRemote(remoteCtx) })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'load_agent_tools',
    description: '根据用户明确提供的业务智能体 agentId 查询并加载当前聊天可用的本地工具插件。不要猜测 agentId；用户没有提供时先询问。加载成功后，后续模型请求可调用返回的插件提供的工具。同一聊天仅绑定一个业务 agentId，换 ID 请新建聊天。',
    parameters: { agentId: { type: 'string', required: true, description: '用户提供的业务智能体 ID，例如 2；不是聊天实例 ID' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('加载插件必须在当前聊天的 Agent 上下文中执行')
      return JSON.stringify(await loadSelected(agent, args.agentId, exec.signal))
    },
    presentCall: args => ({ card: 'generic', kind: 'search', title: '加载智能体工具', rawInput: args }),
  })))
}
