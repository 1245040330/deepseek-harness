/** Business-token authentication for the copied Connection provider. */
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest } from './rpc.ts'

export interface LoginInfo {
  path: string
  agentId: string
  defaultContext: Record<string, unknown>
}
export interface BusinessAuthConfig { loginEndpoint: string; loginTimeoutMs: number; cookieMaxAgeDays: number }
interface LoginSession { authority: string; expiresAt: number; info: LoginInfo }

declare module '@deepseek-ai/cordis' {
  interface Context { businessAuth: BrowserAuth }
}

function header(request: ConnectionTrustRequest, name: string): string | undefined {
  if (request.headers instanceof Headers) return request.headers.get(name) ?? undefined
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}
function audience(request: ConnectionTrustRequest, secure: boolean): string | undefined {
  const host = header(request, 'host')
  if (host === undefined) return undefined
  try { return new URL(`${secure ? 'https:' : 'http:'}//${host}`).origin } catch { return undefined }
}
function cookieName(authority: string): string {
  return `jjy-auth-${createHash('sha256').update(authority).digest('base64url')}`
}
export function loginInfo(value: unknown): LoginInfo {
  if (typeof value !== 'object' || value === null || !('code' in value) || value.code !== 200
    || !('data' in value) || typeof value.data !== 'object' || value.data === null) throw new Error('业务登录认证失败')
  const data = value.data
  if (!('path' in data) || typeof data.path !== 'string' || !data.path || data.path.length > 1024
    || /[\\\x00-\x1f\x7f:]/.test(data.path)
    || data.path.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.trim() !== segment)
    || !('agentId' in data) || typeof data.agentId !== 'string' || !data.agentId.trim()
    || !('defaultContext' in data) || typeof data.defaultContext !== 'object' || data.defaultContext === null
    || Array.isArray(data.defaultContext)) throw new Error('业务登录返回的 path、agentId 或 defaultContext 无效')
  return { path: data.path, agentId: data.agentId.trim(), defaultContext: { ...data.defaultContext } }
}

/** Process-owned opaque cookies; original launch tokens and cookies are never accepted. */
export class BrowserAuth {
  private readonly sessions = new Map<string, LoginSession>()
  private readonly lifetime = new AbortController()
  constructor(ctx: Context, private readonly config: BusinessAuthConfig) {
    const endpoint = new URL(config.loginEndpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol)
      || !Number.isSafeInteger(config.loginTimeoutMs) || config.loginTimeoutMs < 1 || config.loginTimeoutMs > 2147483647
      || !Number.isSafeInteger(config.cookieMaxAgeDays) || config.cookieMaxAgeDays < 1
      || !Number.isSafeInteger(Date.now() + config.cookieMaxAgeDays * 86400000)) throw new Error('业务认证配置无效')
    ctx.effect(() => () => { this.lifetime.abort(); this.sessions.clear() })
  }

  lookup(request: ConnectionTrustRequest, secure = false): LoginInfo | undefined {
    const authority = audience(request, secure)
    if (authority === undefined) return undefined
    const name = cookieName(authority)
    const segment = (header(request, 'cookie') ?? '').split(';').find(row => row.trim().startsWith(`${name}=`))
    const id = segment?.trim().slice(name.length + 1)
    if (id === undefined) return undefined
    const session = this.sessions.get(id)
    if (session === undefined || session.authority !== authority) return undefined
    if (session.expiresAt <= Date.now()) { this.sessions.delete(id); return undefined }
    return structuredClone(session.info)
  }
  isAuthenticated(request: ConnectionTrustRequest, secure = false): boolean { return this.lookup(request, secure) !== undefined }
  authenticatedUrl(baseUrl: string): string { const url = new URL(baseUrl); url.searchParams.delete('token'); return url.href }

  /** Synchronous consumers may only serve pages already admitted by the business entrance. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse, secure = false): boolean {
    if (this.isAuthenticated(request, secure)) return true
    response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    response.end('请使用有效的业务 token 登录')
    return false
  }

  async authorizeBusinessIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse, secure = false): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://harness.invalid')
    const tokens = url.searchParams.getAll('token')
    if (tokens.length === 0) return this.authorizeIndex(request, response, secure)
    const authority = audience(request, secure)
    if (request.method !== 'GET' || authority === undefined || tokens.length !== 1 || !tokens[0]?.trim()) {
      response.writeHead(401, { 'cache-control': 'no-store' }); response.end('业务 token 无效'); return false
    }
    let info: LoginInfo
    try {
      const target = new URL(this.config.loginEndpoint)
      target.searchParams.set('token', tokens[0])
      const result = await fetch(target, { headers: { Accept: 'application/json' },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.loginTimeoutMs)]) })
      if (!result.ok) throw new Error('业务认证接口请求失败')
      info = loginInfo(await result.json())
      this.lifetime.signal.throwIfAborted()
    } catch (error) {
      // Reject the page without logging the credential-bearing URL or remote response.
      response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'referrer-policy': 'no-referrer' })
      response.end(error instanceof Error && error.message === '业务登录返回的 path、agentId 或 defaultContext 无效'
        ? error.message : '业务认证失败，请检查 token 或稍后重试')
      return false
    }
    const now = Date.now()
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id)
    const id = randomBytes(32).toString('base64url')
    const maxAge = this.config.cookieMaxAgeDays * 86400
    this.sessions.set(id, { authority, expiresAt: now + maxAge * 1000, info })
    const cookie = `${cookieName(authority)}=${id}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
    // All initialization values come from the authenticated server session, never the URL.
    response.writeHead(303, { location: './', 'set-cookie': cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    response.end()
    return false
  }
}
