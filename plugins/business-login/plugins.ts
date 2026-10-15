/** Load login-selected local plugins into a disposable Agent scope. */
import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { loadOverlayPatches, prepareProfileEntries } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { auditRows, leakedServices } from '@deepseek-ai/dsh-agent-preset-registry'

const name = 'business-login'

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


/** Mount the complete selected list; failure disposes every partial contribution. */
export async function mountPlugins(agent: Agent, ids: readonly string[], directory: string, signal: AbortSignal): Promise<Fiber | undefined> {
  signal.throwIfAborted()
  if (ids.length === 0) return undefined
  const root = await realpath(directory)
  const patches = await Promise.all(ids.map(async id => {
    const file = await realpath(resolve(root, id, 'cordis.patch.yml'))
    if (!file.startsWith(root + sep)) throw new Error(`插件 ${id} 的配置路径超出了本地插件目录`)
    return loadOverlayPatches(name, file)
  }))
  const entries = applyEntryPatches([], patches.flat(), message => {
    throw new Error(`插件覆盖层无法应用：${message}`)
  })
  signal.throwIfAborted()
  const fiber = agent.ctx.plugin({ name: 'business-login-plugins', inject: ['loader', 'tools'], apply() {} })
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
    return fiber
  } catch (error) {
    await fiber.dispose()
    await fiber.await()
    throw error
  }

}
