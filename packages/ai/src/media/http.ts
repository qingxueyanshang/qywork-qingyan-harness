/**
 * 生成适配器共用的 HTTP 函数：发送请求、读取错误原文、下载产物、识别文件格式。
 */

import { MediaError } from './types.ts'

/**
 * 同步生成单次请求的时限。OpenAI 文档写明复杂提示词最长约 2 分钟；超过 5 分钟无响应即按失败回报，
 * 不无限等待。用户停止经由调用方的 signal 传递，与该时限互不替代。
 */
export const SYNC_TIMEOUT_MS = 5 * 60_000

/** 错误响应中接口返回的错误信息。各厂商字段名不同：`error.message`、`message`、`code`。 */
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

/** 发送请求，非 2xx 时抛出 `MediaError`（含状态码与接口原文）。 */
export async function send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(SYNC_TIMEOUT_MS)]),
    })
  } catch (err) {
    if (signal.aborted) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new MediaError(`请求未到达接口或未收到响应：${reason}`)
  }
  if (init.redirect === 'manual' && [301, 302, 303, 307, 308].includes(res.status)) return res
  if (!res.ok) {
    throw new MediaError(`HTTP ${res.status}：${await providerMessage(res)}`, {
      status: res.status,
    })
  }
  return res
}

/** 发送 JSON 请求并解析 JSON 响应。 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await send(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    signal,
  )
  return (await res.json()) as Record<string, unknown>
}

/** 发送 GET 请求并解析 JSON 响应，用于查询异步任务。 */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await send(url, { method: 'GET', headers }, signal)
  return (await res.json()) as Record<string, unknown>
}

/**
 * 下载接口返回的临时地址。地址在 24 小时或 60 分钟后失效，因此取得后立即下载，地址不传出适配器。
 * 下载失败计为本次生成失败：产物已生成、费用已发生，错误消息中写明这一点。
 */
export async function download(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<{ bytes: Uint8Array; mime: string }> {
  let res: Response
  try {
    const origin = new URL(url).origin
    let target = url
    for (let redirects = 0; ; redirects++) {
      // 自定义鉴权头（如 x-goog-api-key）不会被 fetch 在跨源重定向时自动清除。
      res = await send(
        target,
        {
          method: 'GET',
          redirect: 'manual',
          headers: new URL(target).origin === origin ? headers : {},
        },
        signal,
      )
      if (res.ok) break
      const location = res.headers.get('location')
      await res.body?.cancel()
      if (!location || redirects >= 5) throw new MediaError('下载重定向无效或次数过多')
      target = new URL(location, target).href
    }
  } catch (err) {
    if (signal.aborted) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new MediaError(`已生成，但结果下载失败（费用已发生）：${reason}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const header = res.headers.get('content-type')?.split(';')[0]?.trim()
  return { bytes, mime: sniffMime(bytes) ?? header ?? 'application/octet-stream' }
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
