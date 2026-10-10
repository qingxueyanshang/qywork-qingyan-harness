/** 生成适配器共用的请求、诊断、下载与文件格式识别。 */
import type { MediaDiagnostic } from '@qywork/core'
import { PROVIDER_HTTP } from '../types.ts'
import { MediaError } from './types.ts'

/**
 * 各阶段的静默上限：连续这么久没有收到任何数据（响应头或正文字节）即判定连接已失效，数据仍在到达时不中止。
 * 查询与下载是只读请求，中止后重发不丢失结果。生成请求不设上限：同步接口在生成完成之前不返回任何数据，
 * 静默时长就是生成耗时，任何上限都会截断仍在进行的生成；它只在收到响应、连接被关闭或重置、用户停止时结束。
 */
const IDLE_MS: Record<MediaDiagnostic['stage'], number | undefined> = {
  generate: undefined,
  query: 60_000,
  download: 2 * 60_000,
}
const DOWNLOAD_ATTEMPTS = 3

interface RequestPolicy {
  stage?: MediaDiagnostic['stage']
  /** 替换该阶段的静默上限（`IDLE_MS`）。 */
  idleMs?: number
}

function stageOf(init: RequestInit, policy: RequestPolicy): MediaDiagnostic['stage'] {
  return policy.stage ?? (init.method === 'GET' ? 'query' : 'generate')
}

async function providerMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const nested = body.error as Record<string, unknown> | string | undefined
    const message =
      (typeof nested === 'object' && nested ? nested.message : nested) ?? body.message ?? body.code
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {}
  return text.trim().slice(0, 500) || res.statusText
}

/** 读完响应体，每收到一段数据调用一次 `heard`。 */
async function readBody(res: Response, heard: () => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
      heard()
    }
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}

/**
 * 发出请求并读完响应体。期限按静默计算（`IDLE_MS`）：每收到一段数据重新计时。生成 POST 不自动重发。
 *
 * fetch 必须展开 `PROVIDER_HTTP.fetchOptions`：Bun 的 socket 空闲超时默认 300 秒，缺少该选项时
 * 生成请求静默 300 秒即以 `The operation timed out.` 中断。
 */
export async function send(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  policy: RequestPolicy = {},
): Promise<Response> {
  const stage = stageOf(init, policy)
  const idleMs = policy.idleMs ?? IDLE_MS[stage]
  const silence = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const heard = () => {
    clearTimeout(timer)
    if (idleMs !== undefined) timer = setTimeout(() => silence.abort(), idleMs)
  }
  const startedAt = Date.now()
  let response: Response | undefined
  const diagnostic = (kind: MediaDiagnostic['kind']): MediaDiagnostic => ({
    stage,
    kind,
    outcome: stage === 'download' ? 'available' : 'unknown',
    host: new URL(url).host,
    elapsedMs: Date.now() - startedAt,
    ...(idleMs === undefined ? {} : { timeoutMs: idleMs }),
    ...(response ? { status: response.status } : {}),
    ...(response?.headers.get('x-request-id') || response?.headers.get('request-id')
      ? { requestId: (response.headers.get('x-request-id') ?? response.headers.get('request-id'))! }
      : {}),
  })
  let res: Response
  try {
    heard()
    response = await fetch(url, {
      ...PROVIDER_HTTP.fetchOptions,
      ...init,
      signal: AbortSignal.any([signal, silence.signal]),
    })
    heard()
    if (init.redirect === 'manual' && [301, 302, 303, 307, 308].includes(response.status))
      return response
    const bytes = await readBody(response, heard)
    res = new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (err) {
    if (signal.aborted) throw signal.reason
    const facts = diagnostic(silence.signal.aborted ? 'timeout' : 'connection')
    const code =
      (err as { code?: unknown; cause?: { code?: unknown } })?.code ??
      (err as { cause?: { code?: unknown } })?.cause?.code
    if (typeof code === 'string') facts.code = code
    const reason = silence.signal.aborted
      ? `连续 ${idleMs! / 1000} 秒未收到数据`
      : `连接失败：${err instanceof Error ? err.message : String(err)}`
    throw new MediaError(
      `${reason}${stage === 'generate' ? '；远端结果未知，请勿自动重新生成' : ''}`,
      { diagnostic: facts, cause: err },
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const facts = diagnostic('http')
    if (stage !== 'download' && res.status >= 400 && res.status < 500 && res.status !== 408)
      facts.outcome = 'rejected'
    const uncertainty =
      stage === 'generate' && facts.outcome === 'unknown' ? '；远端结果未知，请勿自动重新生成' : ''
    throw new MediaError(`HTTP ${res.status}：${await providerMessage(res)}${uncertainty}`, {
      status: res.status,
      diagnostic: facts,
    })
  }
  return res
}

/** 可以重发的只读请求失败：连接中断、静默超过上限、HTTP 408 / 429 / 5xx。 */
export function transientFailure(err: unknown): boolean {
  return (
    err instanceof MediaError &&
    (err.diagnostic?.kind === 'connection' ||
      err.diagnostic?.kind === 'timeout' ||
      err.status === 408 ||
      err.status === 429 ||
      (err.status !== undefined && err.status >= 500))
  )
}

export async function sendJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  policy: RequestPolicy = {},
): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const stage = stageOf(init, policy)
  const idleMs = policy.idleMs ?? IDLE_MS[stage]
  const res = await send(url, init, signal, policy)
  try {
    const body: unknown = await res.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('响应不是对象')
    return body as Record<string, unknown>
  } catch (err) {
    throw new MediaError(
      `接口响应无法解析${stage === 'generate' ? '；远端结果未知，请勿自动重新生成' : ''}`,
      {
        cause: err,
        diagnostic: {
          stage,
          kind: 'response',
          outcome: 'unknown',
          host: new URL(url).host,
          elapsedMs: Date.now() - startedAt,
          ...(idleMs === undefined ? {} : { timeoutMs: idleMs }),
          status: res.status,
          ...(res.headers.get('x-request-id')
            ? { requestId: res.headers.get('x-request-id')! }
            : {}),
        },
      },
    )
  }
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  policy: RequestPolicy = {},
): Promise<Record<string, unknown>> {
  return sendJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    signal,
    policy,
  )
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return sendJson(url, { method: 'GET', headers }, signal)
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 重试只读取同一个产物，不提交生成。跨源重定向不得携带接口凭证。 */
export async function download(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<{ bytes: Uint8Array; mime: string }> {
  const origin = new URL(url).origin
  for (let attempt = 0; ; attempt++) {
    try {
      let target = url
      for (let redirects = 0; ; redirects++) {
        const res = await send(
          target,
          {
            method: 'GET',
            redirect: 'manual',
            headers: new URL(target).origin === origin ? headers : {},
          },
          signal,
          { stage: 'download' },
        )
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer())
          const header = res.headers.get('content-type')?.split(';')[0]?.trim()
          return { bytes, mime: sniffMime(bytes) ?? header ?? 'application/octet-stream' }
        }
        const location = res.headers.get('location')
        await res.body?.cancel()
        if (!location || redirects >= 5) throw new MediaError('下载重定向无效或次数过多')
        target = new URL(location, target).href
      }
    } catch (err) {
      if (signal.aborted) throw signal.reason
      if (transientFailure(err) && attempt + 1 < DOWNLOAD_ATTEMPTS) {
        await pause(500 * 2 ** attempt, signal)
        continue
      }
      throw new MediaError(
        `图片或媒体结果下载失败：${err instanceof Error ? err.message : String(err)}`,
        {
          ...(err instanceof MediaError && err.status !== undefined ? { status: err.status } : {}),
          ...(err instanceof MediaError && err.diagnostic ? { diagnostic: err.diagnostic } : {}),
          cause: err,
        },
      )
    }
  }
}

/** 文件头自 `offset` 起是否为指定的 ASCII 字符串。 */
function magic(bytes: Uint8Array, text: string, offset = 0): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/**
 * 按文件头识别格式。接口返回的 base64 不含类型，下载地址的 content-type 也常为
 * `application/octet-stream`；识别错误会使写入磁盘的扩展名错误，预览按扩展名无法识别该文件。
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && magic(bytes, 'PNG', 1)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (magic(bytes, 'RIFF') && magic(bytes, 'WEBP', 8)) return 'image/webp'
  if (magic(bytes, 'RIFF') && magic(bytes, 'WAVE', 8)) return 'audio/wav'
  if (magic(bytes, 'ftyp', 4)) return magic(bytes, 'qt', 8) ? 'video/quicktime' : 'video/mp4'
  if (magic(bytes, 'ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return 'audio/mpeg'
  }
  if (magic(bytes, 'OggS')) return 'audio/ogg'
  if (magic(bytes, 'fLaC')) return 'audio/flac'
  return null
}

/** 读取接口 JSON 中的数值：非数字与负数均视为未回报。字符串形式的数值（可灵的 `duration`）同样读取。 */
export function count(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** 删除值为 `undefined` 的键：`exactOptionalPropertyTypes` 下可选字段不接受 `undefined`。 */
export function defined<T extends object>(value: { [K in keyof T]?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** `data:<mime>;base64,<...>`。火山要求类型小写。 */
export function dataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime.toLowerCase()};base64,${Buffer.from(bytes).toString('base64')}`
}
