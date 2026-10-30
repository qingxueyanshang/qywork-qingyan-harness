/** 生成适配器共用的请求、诊断、下载与文件格式识别。 */
import type { MediaDiagnostic } from '@qywork/core'
import { bodyMessage, httpStatusName, quotaExhausted, retryAfterOf } from '../errors.ts'
import { PROVIDER_HEADERS, PROVIDER_HTTP } from '../types.ts'
import { MediaError } from './types.ts'

/**
 * 各阶段的静默上限：连续这么久没有收到任何数据（响应头或正文字节）即判定连接已失效，数据仍在到达时不中止。
 * 素材上传每个请求最多等待 5 分钟响应；上传失败时生成尚未提交，可由用户重试，不能无限占住卡片。
 * 查询与下载是只读请求，中止后重发不丢失结果。生成请求不设上限：同步接口在生成完成之前不返回任何数据，
 * 静默时长就是生成耗时，任何上限都会截断仍在进行的生成；它只在收到响应、连接被关闭或重置、用户停止时结束。
 */
const IDLE_MS: Record<MediaDiagnostic['stage'], number | undefined> = {
  upload: 5 * 60_000,
  generate: undefined,
  query: 60_000,
  download: 2 * 60_000,
}
const DOWNLOAD_ATTEMPTS = 3

interface RequestPolicy {
  stage?: MediaDiagnostic['stage']
  /** 响应结构必须满足协议；HTTP 成功但缺少受理凭据仍为结果未知。 */
  validate?: (body: Record<string, unknown>) => string | undefined
  /** 替换该阶段的静默上限（`IDLE_MS`）。 */
  idleMs?: number
}

function stageOf(init: RequestInit, policy: RequestPolicy): MediaDiagnostic['stage'] {
  return policy.stage ?? (init.method === 'GET' ? 'query' : 'generate')
}

/**
 * 报错由阶段前缀与原因组成，生成阶段结果未知时另加「远端结果未知」。
 * 素材上传失败时生成请求尚未发出；下载的前缀由 `download` 添加。
 */
function stageMessage(
  stage: MediaDiagnostic['stage'],
  reason: string,
  facts: MediaDiagnostic,
): string {
  if (stage === 'upload') return `素材上传失败，未提交生成：${reason}`
  if (stage === 'query') return `任务查询失败：${reason}`
  return stage === 'generate' && facts.outcome === 'unknown' ? `${reason}；远端结果未知` : reason
}

/**
 * 连接在发出请求之前失败时的原因；其余连接错误返回 null。TLS 握手完成之前不发送 HTTP 字节，
 * 证书与握手失败同属此类：Bun 把握手失败报为 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`。
 * Windows 上目标地址无应答时，Bun 在 21 秒后同样报 `ConnectionRefused`。
 */
function unsentReason(code: string | undefined, host: string): string | null {
  if (code === 'ConnectionRefused') return `无法连接 ${host}`
  if (code === 'ENOTFOUND') return `无法解析域名 ${host}`
  if (code && /CERT|TLS|UNABLE_TO_VERIFY/.test(code)) return `与 ${host} 的 TLS 握手失败`
  return null
}

/** 错误正文中的说明，解析规则与对话一侧相同；说明超过 500 个字符时截断。 */
function providerMessage(res: Response, text: string): string {
  return bodyMessage(text)?.slice(0, 500) || res.statusText
}

/** 错误正文按 JSON 解析后的对象，供 `quotaExhausted` 读取错误码；不是 JSON 时为 null。 */
function errorBodyOf(text: string): unknown {
  try {
    return JSON.parse(text.trim())
  } catch {
    return null
  }
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

/** 生成与上传遇到限流（HTTP 429 且不是额度用尽）时的重发次数上限；等待时间见 `rateLimitWait`。 */
const RATE_LIMIT_RETRIES = 5

/**
 * 限流之后的等待：基准取 Retry-After，未给出时依次为 2、4、8、16、32 秒，单次不超过 60 秒；在基准之上随机延后
 * 至多一半（至少 1 秒的范围）。不要去掉随机部分：同一批同时提交的请求同时收到 429，按相同的时间等待会在同一时刻
 * 再次超出限额。只延后不提前，不早于接口要求的时刻。
 */
export function rateLimitWait(res: Response, retry: number): number {
  const base = Math.min(retryAfterOf(res) ?? 2000 * 2 ** retry, 60_000)
  return base + Math.random() * Math.max(base / 2, 1000)
}

/**
 * 发出请求并读完响应体。期限按静默计算（`IDLE_MS`）：每收到一段数据重新计时。
 * 生成与上传只在限流时重发（`RATE_LIMIT_RETRIES`）：HTTP 429 表示接口未受理该请求，重发不会重复提交或计费；
 * 429 的原因是额度、余额或配额用尽时（`quotaExhausted`，与对话请求同一判定）等待不会改变结果，立即报告。
 * 超时、连接中断与 5xx 可能已被受理，不重发。查询与下载由调用方重发（`waitTask`、`download`），此处不再叠加一层。
 *
 * fetch 必须展开 `PROVIDER_HTTP.fetchOptions`：Bun 的 socket 空闲超时默认 300 秒，缺少该选项时
 * 生成请求静默 300 秒即以 `The operation timed out.` 中断。
 * 请求头必须带 `PROVIDER_HEADERS`：复用已被中转站关闭的空闲连接时，生成请求立即 `ECONNRESET`，远端结果未知。
 */
export async function send(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  policy: RequestPolicy = {},
): Promise<Response> {
  const stage = stageOf(init, policy)
  const idleMs = policy.idleMs ?? IDLE_MS[stage]
  for (let retry = 0; ; retry++) {
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
      outcome: stage === 'upload' ? 'rejected' : stage === 'download' ? 'available' : 'unknown',
      host: new URL(url).host,
      elapsedMs: Date.now() - startedAt,
      ...(idleMs === undefined ? {} : { timeoutMs: idleMs }),
      ...(response ? { status: response.status } : {}),
      ...(response?.headers.get('x-request-id') || response?.headers.get('request-id')
        ? {
            requestId: (response.headers.get('x-request-id') ??
              response.headers.get('request-id'))!,
          }
        : {}),
    })
    let res: Response
    try {
      heard()
      response = await fetch(url, {
        ...PROVIDER_HTTP.fetchOptions,
        ...init,
        headers: { ...PROVIDER_HEADERS, ...Object.fromEntries(new Headers(init.headers)) },
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
      const unsent = silence.signal.aborted ? null : unsentReason(facts.code, facts.host)
      if (unsent && stage !== 'download') facts.outcome = 'rejected'
      const reason = silence.signal.aborted
        ? `连续 ${idleMs! / 1000} 秒未收到数据`
        : (unsent ??
          (facts.code === 'ECONNRESET'
            ? '连接被断开'
            : `连接失败：${err instanceof Error ? err.message : String(err)}`))
      throw new MediaError(stageMessage(stage, reason, facts), { diagnostic: facts, cause: err })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const message = providerMessage(res, text)
      if (
        res.status === 429 &&
        (stage === 'generate' || stage === 'upload') &&
        retry < RATE_LIMIT_RETRIES &&
        !quotaExhausted(errorBodyOf(text), message)
      ) {
        await pause(rateLimitWait(res, retry), signal)
        continue
      }
      // 生成的 408 / 5xx 可能来自网关，不能据此断言上游未受理。明确的客户端拒绝才可视为未生成。
      // 上传错误发生在提交生成之前；下载失败时产物仍在远端，保持可取回。
      const facts = diagnostic('http')
      if (
        stage !== 'download' &&
        !(stage === 'generate' && (res.status === 408 || res.status >= 500))
      )
        facts.outcome = 'rejected'
      throw new MediaError(
        stageMessage(stage, `HTTP ${res.status} ${httpStatusName(res.status)}：${message}`, facts),
        { status: res.status, diagnostic: facts },
      )
    }
    return res
  }
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
  let problem = '响应无法解析'
  try {
    const body: unknown = await res.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('响应不是对象')
    const object = body as Record<string, unknown>
    const invalid = policy.validate?.(object)
    if (invalid) {
      problem = invalid
      throw new Error(invalid)
    }
    return object
  } catch (err) {
    const diagnostic: MediaDiagnostic = {
      stage,
      kind: 'response',
      outcome: stage === 'upload' ? 'rejected' : stage === 'download' ? 'available' : 'unknown',
      host: new URL(url).host,
      elapsedMs: Date.now() - startedAt,
      ...(idleMs === undefined ? {} : { timeoutMs: idleMs }),
      status: res.status,
      ...(res.headers.get('x-request-id') ? { requestId: res.headers.get('x-request-id')! } : {}),
    }
    if (err instanceof MediaError) throw err
    throw new MediaError(stageMessage(stage, problem, diagnostic), {
      cause: err,
      diagnostic,
    })
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
      throw new MediaError(`结果下载失败：${err instanceof Error ? err.message : String(err)}`, {
        ...(err instanceof MediaError && err.status !== undefined ? { status: err.status } : {}),
        ...(err instanceof MediaError && err.diagnostic ? { diagnostic: err.diagnostic } : {}),
        cause: err,
      })
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
