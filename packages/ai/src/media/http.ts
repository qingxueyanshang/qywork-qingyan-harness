/**
 * 生成适配器共用的 HTTP：发请求、读错误原文、下载产物、认图片格式。
 */

import { MediaError } from './types.ts'

/**
 * 同步生成一次请求的上限。OpenAI 文档写明复杂提示词最长约 2 分钟；超过 5 分钟没有响应按失败回报，
 * 不无限等。用户停止走调用方的 signal，与这个上限互不替代。
 */
export const SYNC_TIMEOUT_MS = 5 * 60_000

/** 错误响应里接口自己的那句话。各家字段名不同：`error.message`、`message`、`code`。 */
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

/** 发请求，非 2xx 抛 `MediaError`（带状态码与接口原文）。 */
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
    throw new MediaError(`请求没有到达接口或没有收到响应：${reason}`)
  }
  if (!res.ok) {
    throw new MediaError(`HTTP ${res.status}：${await providerMessage(res)}`, {
      status: res.status,
    })
  }
  return res
}

/** 发 JSON 请求并解析 JSON 响应。 */
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

/** 发 GET 并解析 JSON 响应。查询异步任务用。 */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await send(url, { method: 'GET', headers }, signal)
  return (await res.json()) as Record<string, unknown>
}

/**
 * 下载接口给的临时地址。地址 24 小时或 60 分钟后失效，所以拿到就下，地址不出适配器。
 * 下载失败算这次生成失败：图已经生成、费用已经发生，消息里写明这一点。
 */
export async function download(
  url: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<{ bytes: Uint8Array; mime: string }> {
  let res: Response
  try {
    res = await send(url, { method: 'GET', headers }, signal)
  } catch (err) {
    if (signal.aborted) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new MediaError(`已生成，但下载结果失败（费用已发生）：${reason}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const header = res.headers.get('content-type')?.split(';')[0]?.trim()
  return { bytes, mime: sniffMime(bytes) ?? header ?? 'application/octet-stream' }
}

/** 文件头是否以这串 ASCII 开头（从 `offset` 起）。 */
function magic(bytes: Uint8Array, text: string, offset = 0): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/**
 * 按文件头认格式。接口回的 base64 不带类型，下载地址的 content-type 也常是
 * `application/octet-stream`；认错了落盘的扩展名就错，预览按扩展名认不出。
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

/** `data:<mime>;base64,<...>`。火山要求类型小写。 */
export function dataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime.toLowerCase()};base64,${Buffer.from(bytes).toString('base64')}`
}
