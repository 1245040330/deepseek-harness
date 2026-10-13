import { clientBundle } from '../../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-conversation', ['lib/types/index.js'])
const logo = fileURLToPath(new URL('./src/client/skeleton/jinjiaoyun-logo.png', import.meta.url))
const emittedLogo = fileURLToPath(new URL('./lib/types/client/skeleton/jinjiaoyun-logo.png', import.meta.url))

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'jinjiaoyun-brand-logo',
    resolveId(source: string, importer: string | undefined) {
      if (importer === undefined || source !== './jinjiaoyun-logo.png') return null
      const requested = resolve(dirname(importer), source)
      return requested === logo || requested === emittedLogo ? logo : null
    },
    async load(id: string) {
      if (id !== logo) return null
      this.addWatchFile(logo)
      const contents = await readFile(logo)
      return `export default ${JSON.stringify(`data:image/png;base64,${contents.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
