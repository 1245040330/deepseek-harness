import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { queryDocumentText, validateConfig } from './query.ts'

const config = { endpoint: 'https://example.test/byFileUrl', timeoutMs: 1000 }
const fileUrl = 'https://oss.example.com/报告.docx?Expires=123&Signature=a+b/c==&name=%E6%96%87#page=1'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const query = (signal = new AbortController().signal, options = config) =>
  queryDocumentText(options, fileUrl, signal)

test('GET encodes the entire signed file URL and preserves Markdown verbatim', async () => {
  const extractedText = '  # 年度报告\n\n| 项目 | 内容 |\n| --- | --- |\n| A | B |\n '
  globalThis.fetch = async (url, options) => {
    assert.equal(url.origin + url.pathname, config.endpoint)
    assert.deepEqual([...url.searchParams], [['fileUrl', fileUrl]])
    assert.equal(options.method, 'GET')
    assert.equal(options.headers.Accept, 'application/json')
    assert.ok(options.signal instanceof AbortSignal)
    return Response.json({ code: 200, data: { extractedText, extractRawJson: { ignored: true } } })
  }
  assert.deepEqual(await query(), { status: 'success', extractedText })
})

for (const [label, body] of [
  ['no record', { code: 200, data: null }],
  ['missing data', { code: 200 }],
  ['missing text', { code: 200, data: {} }],
  ['empty text', { code: 200, data: { extractedText: '' } }],
  ['whitespace text', { code: 200, data: { extractedText: ' \n\t' } }],
  ['non-string text', { code: 200, data: { extractedText: 123 } }],
  ['business error', { code: 500, data: { extractedText: 'do not use' } }],
  ['invalid envelope', null],
]) {
  test(`returns actionable fallback for ${label}`, async () => {
    globalThis.fetch = async () => Response.json(body)
    const result = await query()
    assert.equal(result.status, 'fallback')
    assert.ok(result.reason)
    assert.match(result.nextAction, /自行处理原始 fileUrl/)
    assert.equal('extractedText' in result, false)
  })
}

test('HTTP error, invalid JSON and network failure return fallback', async () => {
  for (const fetcher of [
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('<html>not json</html>'),
    async () => { throw new TypeError('network failure') },
  ]) {
    globalThis.fetch = fetcher
    assert.equal((await query()).status, 'fallback')
  }
})

test('request timeout returns fallback before the tool deadline', async () => {
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  // AbortSignal.timeout uses an unref timer; keep the test alive while it expires.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    assert.equal((await query(undefined, { ...config, timeoutMs: 10 })).status, 'fallback')
  } finally { clearTimeout(keepAlive) }
})

test('user cancellation propagates instead of returning fallback', async () => {
  const controller = new AbortController()
  const reason = new Error('user cancelled')
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    controller.abort(reason)
  })
  await assert.rejects(query(controller.signal), error => error === reason)
  await assert.rejects(query(controller.signal), error => error === reason)
})

test('rejects empty arguments and invalid configuration before sending a request', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('unexpected request') }
  for (const value of ['', ' \n ', undefined, null]) {
    await assert.rejects(queryDocumentText(config, value, new AbortController().signal), /fileUrl/)
  }
  for (const timeoutMs of [0, -1, 1.5, NaN, 2147483648]) {
    assert.throws(() => validateConfig({ ...config, timeoutMs }), /timeoutMs/)
  }
  assert.throws(() => validateConfig({ ...config, endpoint: 'file:///tmp/document' }), /HTTP/)
  assert.equal(calls, 0)
})
