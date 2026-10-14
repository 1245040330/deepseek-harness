import { defineConfig } from 'tsdown'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

/** Select configured packages without treating extracted archive metadata as a package. */
function workspaceDirectories(client: boolean): string[] {
  const root = new URL('./', import.meta.url)
  const configured = (directory: string): boolean =>
    existsSync(new URL(`${directory}/package.json`, root))
    || existsSync(new URL(`${directory}/tsdown.config.ts`, root))
  const children = (directory: string): string[] =>
    readdirSync(new URL(`${directory}/`, root), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== '__MACOSX')
      .map(entry => `${directory}/${entry.name}`)
  const directories = [
    ...children('vendor'),
    ...children('packages').flatMap(children),
    'apps/cli',
    ...client ? [] : ['apps/desktop-host'],
  ]
  return directories.filter(configured).map(directory => fileURLToPath(new URL(directory, root)))
}

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact. `apps/desktop` bundles after
 * this pass (root package.json `build:lib:host`): its main bundle inlines
 * workspace devDependencies from their lib/ output, and tsdown builds
 * workspace members concurrently without ordering them.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: workspaceDirectories(client),
    entry: client ? '' : ['lib/types/{index,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
