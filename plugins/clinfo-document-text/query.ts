export interface Config {
  endpoint: string
  timeoutMs: number
}

export type DocumentTextResult =
  | { status: 'success'; extractedText: string }
  | { status: 'fallback'; reason: string; nextAction: string }

export function validateConfig(config: Config): URL {
  const endpoint = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new TypeError('文档正文查询 endpoint 必须为 HTTP 或 HTTPS 地址')
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2147483647) {
    throw new TypeError('文档正文查询 timeoutMs 必须为 1 至 2147483647 的整数')
  }
  return endpoint
}

function fallback(reason: string): DocumentTextResult {
  return { status: 'fallback', reason,
    nextAction: '未获取到已转换正文，请智能体使用现有文件读取或转换能力自行处理原始 fileUrl，不要将本次查询失败视为文件任务失败。' }
}

/** Query only the conversion record; the agent owns any subsequent file processing. */
export async function queryDocumentText(
  config: Config, fileUrl: string, signal: AbortSignal,
): Promise<DocumentTextResult> {
  const url = validateConfig(config)
  if (typeof fileUrl !== 'string' || !fileUrl.trim()) {
    throw new TypeError('文档正文查询 fileUrl 必填且不能为空')
  }
  signal.throwIfAborted()
  url.searchParams.set('fileUrl', fileUrl)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    })
    if (!response.ok) return fallback(`查询接口 HTTP ${response.status}`)
    const value: unknown = await response.json()
    signal.throwIfAborted()
    if (typeof value !== 'object' || value === null || !('code' in value) || value.code !== 200) {
      return fallback('查询接口返回业务错误或无效响应')
    }
    if (!('data' in value) || typeof value.data !== 'object' || value.data === null
      || !('extractedText' in value.data) || typeof value.data.extractedText !== 'string'
      || !value.data.extractedText.trim()) {
      return fallback('未找到文档记录或已转换正文为空')
    }
    return { status: 'success', extractedText: value.data.extractedText }
  } catch {
    // Cancellation belongs to the current task and must not trigger fallback work.
    signal.throwIfAborted()
    return fallback('查询接口网络异常、超时或返回内容不是有效 JSON')
  }
}
