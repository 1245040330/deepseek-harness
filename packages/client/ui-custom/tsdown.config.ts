import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import layout from './ui-layout/tsdown.config.ts'
import sidebar from './ui-sidebar/tsdown.config.ts'
import conversation from './ui-conversation/tsdown.config.ts'
import chat from './ui-chat/tsdown.config.ts'
import workspace from './ui-workspace/tsdown.config.ts'
import connection from './connection/tsdown.config.ts'

/** Build the alternative UI packages during the workspace Client pass. */
export default defineConfig((options) => {
  if (options.env?.DSH_BUILD_FACE === 'host') {
    const cwd = fileURLToPath(new URL('./connection/', import.meta.url))
    return connection(options).map(config => ({ ...config, cwd }))
  }
  const packages = [
    ['ui-layout', layout],
    ['ui-sidebar', sidebar],
    ['ui-conversation', conversation],
    ['ui-chat', chat],
    ['ui-workspace', workspace],
    ['connection', connection],
  ] as const
  return packages.flatMap(([name, bundle]) => {
    const cwd = fileURLToPath(new URL(`./${name}/`, import.meta.url))
    return bundle(options).map(config => ({ ...config, cwd }))
  })
})
