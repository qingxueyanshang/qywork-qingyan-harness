/** 生成适配器共用的请求、诊断、下载与文件格式识别。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type ChannelVendor,
  type ErrorCode,
  log,
  type MediaDiagnostic,
  RESEND_LIMIT,
  resendDelay,
  waitOrAbort,
} from '@qywork/core'
import {
  bodyMessage,
  httpFailureCode,
  httpStatusName,
  parsedBody,
  quotaExhausted,
  retryAfterOf,
  upstreamFailureCode,
} from '../errors.ts'
import { PROVIDER_HEADERS, PROVIDER_HTTP } from '../types.ts'
import { MediaError, type MediaRunOptions } from './types.ts'

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

export interface RequestPolicy {
  stage?: MediaDiagnostic['stage']
  /** 响应结构必须满足协议；HTTP 成功但缺少受理凭据仍为结果未知。 */
  validate?: (body: Record<string, unknown>) => string | undefined
  /** 替换该阶段的静默上限（`IDLE_MS`）。 */
  idleMs?: number
  /**
   * 请求发往的上游（`upstreamFailureCode`）：原生协议的适配器按协议给出，OpenAI 形状的协议按接口地址（`channelVendorOf`），
   * 未收录的地址为 null。错误状态与 2xx 正文报告的失败按该上游的错误码归类（`failureCode`）；
   * `refused` 判定 HTTP 2xx 的正文是否报告了失败，报告时返回报错的原因，该次答复按被拒绝处理，与错误状态同样重试。
   */
  upstream?: {
    vendor: ChannelVendor | null
    refused?: (body: Record<string, unknown>) => string | undefined
  }
}

/**
 * 一次适配器运行期间的提交与重试回报回调、日志标识。经异步上下文传给 `send` 与 `waitTask`，不经各适配器的请求参数：
 * 提交、同步出图、语音与素材上传共有十余个请求点，逐处传参时漏掉一处，该协议的重试与提交时刻就不回报，日志也缺少标识。
 */
type RunContext = Pick<MediaRunOptions, 'onRetry' | 'onSubmit' | 'logFields'>
const runContext = new AsyncLocalStorage<RunContext>()

/**
 * 执行 `work`，其间 `send` 每次发出生成请求之前回报给 `opts.onSubmit`，进入与结束重试等待时回报给 `opts.onRetry`，
 * 重试与查询失败的日志带上 `opts.logFields`（`MediaRunOptions`）。
 */
export function reportingRetries<T>(opts: RunContext, work: () => Promise<T>): Promise<T> {
  return opts.onRetry || opts.onSubmit || opts.logFields ? runContext.run(opts, work) : work()
}

/** 当前运行的日志标识（`MediaRunOptions.logFields`）；不在 `reportingRetries` 之内时为空对象。 */
export function runLogFields(): Record<string, string> {
  return runContext.getStore()?.logFields ?? {}
}

/**
 * 一次查询（`waitTask` 的 `check`）期间最后收到的答复。上游在答复中报告任务失败时没有失败的请求，
 * 该失败的诊断（主机、用时、状态码、请求号）取自这次答复。
 */
const answers = new AsyncLocalStorage<{ last?: MediaDiagnostic }>()

/** 执行 `work`，其间 `send` 每收到一次答复即把该请求的事实写入 `seen.last`。 */
export function recordingAnswers<T>(
  seen: { last?: MediaDiagnostic },
  work: () => Promise<T>,
): Promise<T> {
  return answers.run(seen, work)
}

function stageOf(init: RequestInit, policy: RequestPolicy): MediaDiagnostic['stage'] {
  return policy.stage ?? (init.method === 'GET' ? 'query' : 'generate')
}

/** 生成阶段结果未知时报错末尾的一句。 */
const UNKNOWN_OUTCOME = '；远端结果未知'

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
  return stage === 'generate' && facts.outcome === 'unknown'
    ? `${reason}${UNKNOWN_OUTCOME}`
    : reason
}

/**
 * 结果未知的提交经查询确认远端没有受理：报错中的「远端结果未知」换为确认的结果，诊断判为被拒绝，
 * 调用方据此按未受理处理（可以重新提交）。
 */
export function confirmedRejected(failure: MediaError, conclusion: string): MediaError {
  const reason = failure.message.endsWith(UNKNOWN_OUTCOME)
    ? failure.message.slice(0, -UNKNOWN_OUTCOME.length)
    : failure.message
  return new MediaError(`${reason}；${conclusion}`, {
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.diagnostic ? { diagnostic: { ...failure.diagnostic, outcome: 'rejected' } } : {}),
    ...(failure.code ? { code: failure.code } : {}),
    cause: failure,
  })
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

/**
 * 错误状态的失败码。正文中的错误码已收录时以它为准（`upstreamFailureCode`）；其余与对话请求同一分类（`httpFailureCode`），
 * 原文的额度判定（`quotaExhausted`）另覆盖全部状态码。对话分类未列出的状态码按类别归入：408 与其余 5xx 为暂时不可用，其余为请求被拒绝。
 * 查询与下载阶段的 404 是任务或结果不存在（超过保留期、地址失效），为请求被拒绝：`httpFailureCode` 的 404 是对话请求的型号不存在。
 * 两者都不在重试范围内（`retriesSubmission` 只处理提交与上传，`transientFailure` 只认限流与暂时不可用），改动只影响失败码。
 */
function failureCode(
  stage: MediaDiagnostic['stage'],
  status: number,
  body: unknown,
  message: string,
  vendor: ChannelVendor | null,
): ErrorCode {
  return (
    upstreamFailureCode(vendor, [body], message) ??
    (quotaExhausted(message) ? 'insufficient_quota' : null) ??
    (status === 404 && (stage === 'query' || stage === 'download') ? 'invalid_request' : null) ??
    httpFailureCode(status, body, message) ??
    (status === 408 || status >= 500 ? 'provider_unavailable' : 'invalid_request')
  )
}

/** HTTP 2xx 的正文报告的失败（`RequestPolicy.upstream`）：原因与失败码；正文不是对象或没有报告失败时为 null。 */
async function refusalOf(
  res: Response,
  upstream: NonNullable<RequestPolicy['upstream']>,
): Promise<{ reason: string; code: ErrorCode | null } | null> {
  const body = parsedBody(await res.clone().text())
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const reason = upstream.refused?.(body as Record<string, unknown>)
  return reason ? { reason, code: upstreamFailureCode(upstream.vendor, [body], reason) } : null
}

/**
 * 正文是否为接口的错误对象：JSON 对象带 `error`（OpenAI 格式的接口与中转站为对象，部分接口为字符串）
 * 或顶层错误码 `code`（百炼、可灵）。接口前的网关返回 HTML 页、空正文或只有 `message` 的 JSON，不满足。
 */
function apiError(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  const o = body as Record<string, unknown>
  return o.error != null || o.code != null
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
 * 生成与上传失败的重试类别：
 * - `rate_limited`：被限流（失败码 `rate_limited`：429 且不是额度用尽，或上游在正文中以限流的错误码拒绝），接口立即答复拒绝。
 * - `connection`：生成的提交在发出请求之前连接失败，以及素材上传的连接失败与中断（上传在提交生成之前）。
 * - `unavailable`：素材上传得到接口的暂时不可用答复（失败码 `provider_unavailable`：408 / 5xx 等）。
 * 三类都按对话请求重发的次数与间隔重试（`RESEND_LIMIT`、`resendDelay`），用尽约一分钟：对话请求对 5xx 同样如此，
 * 上传失败时生成尚未提交，用户等待的是一次可以立即重新发起的请求，不需要更长的恢复时间。
 * 三类不要共用一个计数：同一次请求中几类交替出现时，各按自己的次数与回执计算（`send` 中的 `retries`），
 * 限流与连接失败的原因与次数分开报告。
 */
type RetryClass = 'rate_limited' | 'connection' | 'unavailable'

/**
 * 生成与上传的失败按哪一类重试；不重试时为 null。
 *
 * 只重试接口未受理的失败（`outcome: 'rejected'`），重试不会重复提交或计费。
 * 生成的暂时不可用（408 / 5xx）不要加入：接口答复的这类错误中有审核拒绝（中转站以 502 返回「提示词未过审」），
 * 重试得到同样的结果，且每次都要再等待一次生成耗时；正文不是接口错误对象的 408 / 5xx 为结果未知，只能取回，不能重新提交。
 * 静默超时（`kind: 'timeout'`）不重试：已连续数分钟没有收到任何数据，重试通常得到同样的结果，
 * 而每次重试都要再等待一个静默上限。额度、余额或配额用尽（失败码 `insufficient_quota`）等待不会改变结果，同样不重试。
 * 查询与下载由调用方重试（`waitTask`、`download`），此处不叠加一层。
 */
function retriesSubmission(
  stage: MediaDiagnostic['stage'],
  failure: MediaError,
): RetryClass | null {
  const facts = failure.diagnostic
  if (facts?.outcome !== 'rejected' || facts.kind === 'timeout') return null
  if (stage !== 'upload' && stage !== 'generate') return null
  if (failure.code === 'rate_limited') return 'rate_limited'
  if (facts.kind === 'connection') return 'connection'
  return stage === 'upload' && failure.code === 'provider_unavailable' ? 'unavailable' : null
}

/** 重试用尽后的报错：原文之后写明已做的自动重试，该句另存于 `retryReceipt`。 */
function afterRetries(failure: MediaError, retries: number) {
  const receipt = `已自动重试 ${retries} 次，仍失败`
  return new MediaError(`${failure.message}；${receipt}`, {
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
    ...(failure.code ? { code: failure.code } : {}),
    retryReceipt: receipt,
    cause: failure.cause,
  })
}

/**
 * 发出请求并读完响应体。期限按静默计算（`IDLE_MS`）：每收到一段数据重新计时。
 * 生成与上传被接口拒绝或请求未发出时自动重试（类别、次数与间隔见 `RetryClass`），每次等待写一行日志（带 `reportingRetries`
 * 登记的日志标识），并连同该次失败回报给登记的回调，用户停止时等待随之取消；结果未知的失败不重试。
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
  // 各类重试各自计数：次数上限、间隔与回执都按该类已做的重试计算。
  const retries: Record<RetryClass, number> = { rate_limited: 0, connection: 0, unavailable: 0 }
  for (;;) {
    let failure: MediaError | undefined
    let retryAfter: number | null = null
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
    let res: Response | undefined
    // 生成请求即将发出，每次发出（含重试）各回报一次；素材上传、查询与下载不回报。
    if (stage === 'generate') runContext.getStore()?.onSubmit?.()
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
      const seen = answers.getStore()
      if (seen) seen.last = diagnostic('http')
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
      failure = new MediaError(stageMessage(stage, reason, facts), {
        diagnostic: facts,
        cause: err,
      })
    } finally {
      clearTimeout(timer)
    }
    if (res?.ok) {
      const refusal = policy.upstream ? await refusalOf(res, policy.upstream) : null
      if (!refusal) return res
      // 接口以 2xx 答复而在正文中报告失败：接口自身的答复，判为被拒绝，与错误状态同样按失败码重试。
      const facts = diagnostic('http')
      if (stage !== 'download') facts.outcome = 'rejected'
      failure = new MediaError(stageMessage(stage, refusal.reason, facts), {
        diagnostic: facts,
        ...(refusal.code ? { code: refusal.code } : {}),
      })
    } else if (res) {
      const text = await res.text().catch(() => '')
      const message = providerMessage(res, text)
      const body = parsedBody(text)
      retryAfter = retryAfterOf(res)
      // 正文为接口错误对象的错误状态是接口自身的答复，远端不会再返回结果，判为被拒绝。
      // 生成的 408 / 5xx 而正文不是接口错误对象时，可能来自接口前的网关，接口仍可能在生成并计费，判为结果未知。
      // 上传错误发生在提交生成之前；下载失败时产物仍在远端，保持可取回。
      const facts = diagnostic('http')
      const gateway = (res.status === 408 || res.status >= 500) && !apiError(body)
      if (stage !== 'download' && !(stage === 'generate' && gateway)) facts.outcome = 'rejected'
      failure = new MediaError(
        stageMessage(stage, `HTTP ${res.status} ${httpStatusName(res.status)}：${message}`, facts),
        {
          status: res.status,
          diagnostic: facts,
          code: failureCode(stage, res.status, body, message, policy.upstream?.vendor ?? null),
        },
      )
    }
    // 没有响应时 catch 已写入失败原因，有响应时上一段写入，两条路径必有其一。
    const failed = failure as MediaError
    const kind = retriesSubmission(stage, failed)
    if (!kind) throw failed
    const retry = retries[kind]
    if (retry >= RESEND_LIMIT) throw afterRetries(failed, retry)
    retries[kind] += 1
    const wait = resendDelay(retry, retryAfter)
    log.warn('media', `${failed.message}；${Math.round(wait / 1000)} 秒后第 ${retry + 1} 次重试`, {
      stage,
      host: new URL(url).host,
      ...runLogFields(),
    })
    const report = runContext.getStore()?.onRetry
    report?.({ attempt: retry + 1, max: RESEND_LIMIT, reason: failed.message }, failed)
    // 等待被中止时不回报结束：请求没有重新发出，调用方据最后一次回报判定接口没有受理。
    await waitOrAbort(wait, signal)
    report?.(null)
  }
}

/**
 * 可以重发的只读请求失败：连接中断、静默超过上限，以及失败码为被限流或暂时不可用（`failureCode`：408、非额度的 429、5xx 等）。
 * 额度用尽的 429 不在其中：等待不会改变结果。
 */
export function transientFailure(err: unknown): boolean {
  return (
    err instanceof MediaError &&
    (err.diagnostic?.kind === 'connection' ||
      err.diagnostic?.kind === 'timeout' ||
      err.code === 'rate_limited' ||
      err.code === 'provider_unavailable')
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

/** 查询请求。`policy.upstream` 给出时，查询得到的错误状态同样按该上游的错误码归类。 */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  policy: RequestPolicy = {},
): Promise<Record<string, unknown>> {
  return sendJson(url, { method: 'GET', headers }, signal, policy)
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
        await waitOrAbort(500 * 2 ** attempt, signal)
        continue
      }
      throw new MediaError(`结果下载失败：${err instanceof Error ? err.message : String(err)}`, {
        ...(err instanceof MediaError && err.status !== undefined ? { status: err.status } : {}),
        ...(err instanceof MediaError && err.diagnostic ? { diagnostic: err.diagnostic } : {}),
        ...(err instanceof MediaError && err.code ? { code: err.code } : {}),
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
