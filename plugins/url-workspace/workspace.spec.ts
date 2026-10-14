import { mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { apply, pathSegments, prepareDirectory } from './index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'url-workspace-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return realpath(root)
}

it('creates nested directories and reuses the same canonical directory', async () => {
  const root = await directory()
  const first = await prepareDirectory(root, 'a/b/001jie')
  expect(first).toBe(join(root, 'a/b/001jie'))
  expect((await stat(first)).isDirectory()).toBe(true)
  expect(await prepareDirectory(root, 'a/b/001jie')).toBe(first)
  expect(await prepareDirectory(root, 'a/b/002jie')).not.toBe(first)
})

it('rejects invalid paths before creating directories', () => {
  for (const path of ['', '/tmp/a', '../a', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'C:/a', 'a\0b']) {
    expect(() => pathSegments(path)).toThrow()
  }
})

it('does not create child directories through a link outside the root', async () => {
  const root = await directory()
  const outside = await directory()
  await symlink(outside, join(root, 'link'))
  await expect(prepareDirectory(root, 'link/new')).rejects.toThrow('escapes')
  await expect(stat(join(outside, 'new'))).rejects.toThrow()
})

it('exports an invocable Remote endpoint and registers its prepared directory', async () => {
  const root = await directory()
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGateway)
  const registered: string[] = []
  ctx.provide('workspaceRegistry', { create: async (path: string) => {
    registered.push(path)
    return { path }
  } })
  apply(ctx, { rootDirectory: root })
  await ctx.fiber.await()
  expect(await ctx.typertGateway.invoke({ namespace: 'urlWorkspace', method: 'ensure', args: { path: 'a/b/001jie' } }))
    .toBe(join(root, 'a/b/001jie'))
  expect(registered).toEqual([join(root, 'a/b/001jie')])
})
