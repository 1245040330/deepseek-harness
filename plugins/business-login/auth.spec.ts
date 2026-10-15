/** The Loader mounts the copied transport and frontend over real HTTP. */
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import * as Connection from '../../packages/client/ui-custom/connection/src/index.ts'
import * as Frontend from '../business-frontend/frontend.ts'
import { loginInfo } from '../../packages/client/ui-custom/connection/src/browser-auth.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const data = { path: '992/1/教学工作台/1serviceName', agentId: '123',
  agentInfo: { sysPrompt: '业务系统提示词', name: '教学工作台', model: 'qwen3.8-max', pluginList: [] },
  defaultContext: { '工作职责': '文档摘要，归集整理，统计分析，质量初审', '智能体名称': '教学工作台' } }

async function setup() {
  const calls: string[] = []
  const business = createServer((req, res) => {
    const token = new URL(req.url!, 'http://x').searchParams.get('token')!
    calls.push(token)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(token === 'valid-business-token' ? { code: 200, data } : { code: 401, data: null }))
  })
  business.listen(0, '127.0.0.1')
  await once(business, 'listening')
  cleanup.push(() => new Promise<void>((resolve, reject) => { business.close(error => error ? reject(error) : resolve()) }))
  const endpoint = `http://127.0.0.1:${(business.address() as AddressInfo).port}/login`
  const root = await mkdtemp(join(tmpdir(), 'business-auth-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist/index.html'), '<head></head><body>business shell</body>')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, businessConnection: Connection,
    businessFrontend: Frontend, httpServer: HttpServer, credentials: LocalCredentials,
    typert: TypertRegistry, gateway: TypertGateway })
  const file = join(root, 'cordis.yml')
  await writeFile(file, [
    '- name: cordis:credentials', `  config: { path: '${join(root, 'credentials.yml')}', watch: false }`,
    '- name: cordis:httpServer', "  config: { host: '127.0.0.1', port: 0 }",
    '- name: cordis:businessConnection', `  config: { loginEndpoint: '${endpoint}', loginTimeoutMs: 1000 }`,
    '- name: cordis:businessFrontend', `  config: { distIndex: '${join(root, 'dist/index.html')}' }`,
    '- name: cordis:typert', '- name: cordis:gateway',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/probe', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({ authenticated: true }) }))
  return { ctx, calls, base: `http://127.0.0.1:${ctx.webServer.port}` }
}

async function upgrade(base: string, cookie?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/remote.mux`, { headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.from('business-fixture').toString('base64'), origin: base,
      ...(cookie === undefined ? {} : { cookie }),
    } })
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode!) })
    request.on('response', response => { response.resume(); resolve(response.statusCode!) })
    request.on('error', reject)
    request.end()
  })
}

it('accepts business tokens, removes URL overrides and authenticates subsequent page/API requests', async () => {
  const b = await setup()
  expect((await fetch(b.base)).status).toBe(401)
  expect((await fetch(`${b.base}/api/probe`)).status).toBe(401)
  const login = await fetch(`${b.base}/?token=valid-business-token&path=evil&agentId=evil&chatId=old`, { redirect: 'manual' })
  expect(login.status).toBe(303)
  expect(login.headers.get('location')).toBe('./')
  const setCookie = login.headers.get('set-cookie')!
  expect(setCookie).toContain('HttpOnly')
  expect(setCookie).toContain('SameSite=Strict')
  const cookie = setCookie.split(';', 1)[0]!
  const request = { headers: new Headers({ host: new URL(b.base).host, cookie }) }
  expect(b.ctx.businessAuth.lookup(request)).toEqual(data)
  const altered = b.ctx.businessAuth.lookup(request)!
  altered.agentId = 'evil'
  expect(b.ctx.businessAuth.lookup(request)?.agentId).toBe('123')
  expect((await fetch(b.base, { headers: { cookie } })).status).toBe(200)
  expect(await (await fetch(`${b.base}/api/probe`, { headers: { cookie } })).json()).toEqual({ authenticated: true })
  expect(b.ctx.connection.authenticatedUrl(b.base)).not.toContain('token=')
  // WebSocket admission calls this same Host/Origin and cookie fence.
  expect(b.ctx.connection.requestRejection({ headers: { host: new URL(b.base).host, cookie, origin: b.base } })).toBeUndefined()
  expect(b.ctx.connection.requestRejection({ headers: { host: new URL(b.base).host, origin: b.base } })).toBe(401)
  expect(b.calls).toEqual(['valid-business-token'])
  expect(await upgrade(b.base)).toBe(401)
  expect(await upgrade(b.base, cookie)).toBe(101)
})

it('rejects invalid business tokens even when a previous login cookie is valid', async () => {
  const b = await setup()
  const first = await fetch(`${b.base}/?token=valid-business-token`, { redirect: 'manual' })
  const cookie = first.headers.get('set-cookie')!.split(';', 1)[0]!
  const denied = await fetch(`${b.base}/?token=original-launch-token`, { redirect: 'manual', headers: { cookie } })
  expect(denied.status).toBe(401)
  expect(denied.headers.get('set-cookie')).toBeNull()
  expect(denied.headers.get('location')).toBeNull()
  const duplicate = await fetch(`${b.base}/?token=valid-business-token&token=again`, { redirect: 'manual' })
  expect(duplicate.status).toBe(401)
})

it('validates business paths and preserves every default context field', () => {
  expect(loginInfo({ code: 200, data })).toEqual(data)
  for (const path of ['/outside', '../outside', 'a/../b', 'a\\b', 'a//b']) {
    expect(() => loginInfo({ code: 200, data: { ...data, path } })).toThrow()
  }
  expect(() => loginInfo({ code: 500, data })).toThrow()
  for (const agentInfo of [null, { ...data.agentInfo, pluginList: ['../outside'] },
    { ...data.agentInfo, pluginList: [12] }, { ...data.agentInfo, model: '' }, { ...data.agentInfo, sysPrompt: '' }]) {
    expect(() => loginInfo({ code: 200, data: { ...data, agentInfo } })).toThrow('agentInfo')
  }
})
