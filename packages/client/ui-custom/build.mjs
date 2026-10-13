/** Build the copied UI packages without replacing the default sources. */
import { existsSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../../..')
const names = ['ui-layout', 'ui-sidebar', 'ui-conversation', 'ui-chat']
const run = (args, cwd = root) => {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`UI build failed (${result.status}): ${args.join(' ')}`)
}
for (const name of names) {
  const local = join(directory, name, 'node_modules')
  const installed = resolve(directory, '..', name, 'node_modules')
  if (!existsSync(installed)) throw new Error(`Missing dependencies for ${name}; run pnpm install at the repository root first`)
  if (!existsSync(local)) symlinkSync(installed, local, 'dir')
}
run([join(root, 'node_modules/typescript/bin/tsc'), '-b', ...names.map(name => join(directory, name, 'tsconfig.json'))])
for (const name of names) {
  run([join(root, 'node_modules/tsdown/dist/run.mjs'), '--config-loader', 'native'], join(directory, name))
}
