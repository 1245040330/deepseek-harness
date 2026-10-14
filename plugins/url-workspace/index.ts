/** Prepare URL-selected workspaces beneath a configured Host directory. */
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'url-workspace'
export const inject = ['typert', 'workspaceRegistry']

export interface Config {
  rootDirectory: string
}

/** Validate decoded URL input before any directory mutation. */
export function pathSegments(path: unknown): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024
    || isAbsolute(path) || /[\\\x00-\x1f\x7f:]/.test(path)) {
    throw new Error('path must be a non-empty relative workspace path')
  }
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'
    || segment.trim() !== segment)) {
    throw new Error('path contains an invalid workspace directory segment')
  }
  return segments
}

function withinRoot(root: string, directory: string): void {
  const suffix = relative(root, directory)
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('workspace directory escapes rootDirectory')
  }
}

/** Create parent directories while checking every resolved level. */
export async function prepareDirectory(rootDirectory: string, path: unknown): Promise<string> {
  const segments = pathSegments(path)
  await mkdir(rootDirectory, { recursive: true })
  const root = await realpath(rootDirectory)
  let directory = root
  for (const segment of segments) {
    const next = resolve(directory, segment)
    try {
      await mkdir(next)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    directory = await realpath(next)
    withinRoot(root, directory)
  }
  return directory
}

class UrlWorkspace extends TypertRemoteService {
  constructor(ctx: Context, private readonly rootDirectory: string) {
    super(ctx, 'urlWorkspace')
  }

  /** Prepare and reuse the Workspace represented by a relative URL path. */
  @Remote('ensure')
  async ensure(path: string): Promise<string> {
    const directory = await prepareDirectory(this.rootDirectory, path)
    const workspace = await this.ctx.workspaceRegistry.create(directory)
    return workspace.path
  }
}

/** Mount the isolated Remote endpoint without changing the Workspace controller. */
export function apply(ctx: Context, config: Config): void {
  if (typeof config.rootDirectory !== 'string' || !isAbsolute(config.rootDirectory)) {
    throw new Error('url-workspace rootDirectory must be an absolute Host path')
  }
  new UrlWorkspace(ctx, config.rootDirectory)
}
