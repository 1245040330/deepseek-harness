/** Compose the shipped overlay with the actual Web bundle, including name-guard semantics. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

it('disables the original authentication owners and inserts the copied owners with startup configuration', async () => {
  const base = load(await readFile(new URL('../../packages/bundle/web-app/cordis.patch.yml', import.meta.url), 'utf8'),
    { schema: entryListSchema }) as PatchOptions[]
  const overlay = load(await readFile(new URL('../../packages/client/ui-custom/cordis.patch.yml', import.meta.url), 'utf8'),
    { schema: entryListSchema }) as PatchOptions[]
  const warnings: string[] = []
  const entries = applyEntryPatches(applyEntryPatches([], base, () => {}), overlay, (message, ...args) => {
    if (args.some(arg => arg === 'connection' || arg === 'web-runtime')) warnings.push(message)
  })
  const flatten = (rows: EntryOptions[]): EntryOptions[] => rows.flatMap(row => [row,
    ...row.group && Array.isArray(row.config) ? flatten(row.config) : [],
  ])
  const rows = flatten(entries)
  expect(warnings).toEqual([])
  expect(rows.find(row => row.id === 'connection')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'web-runtime')?.disabled).toBe(true)
  const connection = rows.find(row => row.id === 'business-connection')!
  expect(connection.name).toBe('./connection/lib/index.js')
  expect(connection.inject).toEqual(['webStartup'])
  expect(connection.config.trustedHosts).toEqual({ __jsExpr: 'ctx.webStartup.trustedHosts' })
  expect(connection.config.loginEndpoint).toContain('getHarnessLoginInfo.call')
  const runtime = rows.find(row => row.id === 'business-web-runtime')!
  expect(runtime.name).toBe('../../../plugins/business-frontend/index.ts')
  expect(runtime.inject).toEqual(['webStartup'])
  expect(runtime.config).toEqual({ openBrowser: { __jsExpr: 'ctx.webStartup.openBrowser' }, printUrl: true,
    publicUrl: { __jsExpr: 'ctx.webStartup.publicUrl' }, surfaceContext: true })
  expect(rows.filter(row => !row.disabled && row.name === '@deepseek-ai/dsh-client-connection')).toHaveLength(0)
  expect(rows.filter(row => !row.disabled && row.name === '@deepseek-ai/dsh-web-app')).toHaveLength(0)
})
