import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import layout from './ui-layout/tsdown.config.ts'
import sidebar from './ui-sidebar/tsdown.config.ts'
import conversation from './ui-conversation/tsdown.config.ts'
import chat from './ui-chat/tsdown.config.ts'

/** Build the alternative UI packages during the workspace Client pass. */
export default defineConfig((options) => {
  if (options.env?.DSH_BUILD_FACE === 'host') return { entry: '' }
  const packages = [
    ['ui-layout', layout],
    ['ui-sidebar', sidebar],
    ['ui-conversation', conversation],
    ['ui-chat', chat],
  ] as const
  return packages.flatMap(([name, bundle]) => {
    const cwd = fileURLToPath(new URL(`./${name}/`, import.meta.url))
    return bundle(options).map(config => ({ ...config, cwd }))
  })
})
