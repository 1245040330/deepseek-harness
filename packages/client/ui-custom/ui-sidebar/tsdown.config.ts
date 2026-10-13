import { clientBundle } from '../../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-sidebar', ['lib/types/index.js'])
const logo = fileURLToPath(new URL('./src/client/jinjiaoyun-logo.png', import.meta.url))

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'jinjiaoyun-brand-logo',
    async load(id: string) {
      if (id !== logo) return null
      this.addWatchFile(logo)
      const contents = await readFile(logo)
      return `export default ${JSON.stringify(`data:image/png;base64,${contents.toString('base64')}`)}`
    },
  }],
}))) satisfies typeof bundle
