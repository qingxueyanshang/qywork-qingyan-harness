/**
 * 按有无进展判定连接失效的传输：发出请求内容或收到数据即为进展，数据仍在传输时不中止，不设总时长，
 * 传输耗时随文件大小与网速变化。连续 `idleMs` 没有进展时以 `TransferStalled` 中止。
 *
 * 必须展开 `PROVIDER_HTTP.fetchOptions`（本文件已展开）：Bun 的连接在连续约 5 分钟没有收到数据时自行中断，
 * 发送请求内容期间同样计时（2026-11-27 实测，上传持续进行，第 360 秒中断）。
 */
import { PROVIDER_HTTP } from '../types.ts'

/**
 * 上传的静默上限。请求内容的进展以 Bun 读取请求流的时刻计，Bun 预读数 MB（2026-11-27 实测约 5 MB），读取时刻早于实际发送；
 * 本值须远大于预读量在慢速网络下的发送时间：5 分钟时，速度不低于约 30 KB/s 即不误判。
 */
export const UPLOAD_IDLE_MS = 5 * 60_000
/** 下载的静默上限：连续该时长没有收到任何数据。 */
export const DOWNLOAD_IDLE_MS = 60_000

/** 连续 `idleMs` 没有进展。 */
export class TransferStalled extends Error {
  constructor(readonly idleMs: number) {
    super(`传输中断：连续 ${Math.round(idleMs / 1000)} 秒没有进展`)
    this.name = 'TransferStalled'
  }
}

/** 流经该流的每一块调用 `onChunk`。 */
function observed(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onChunk()
        controller.enqueue(chunk)
      },
      flush() {
        onEnd()
      },
    }),
  )
}

/**
 * 发出请求并在读取响应正文期间按进展计时。`init.body` 为流时，Bun 每读取一块计为一次进展；响应头与正文的每一块同样计为进展。
 * 返回的响应的正文已在计时之下：读取正文时连续 `idleMs` 没有数据即以 `TransferStalled` 失败。`signal` 中止时随之中止。
 */
export async function fetchWithIdle(
  url: string,
  init: RequestInit,
  idleMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const progress = () => {
    clearTimeout(timer)
    timer = setTimeout(() => abort.abort(new TransferStalled(idleMs)), idleMs)
  }
  const stop = () => clearTimeout(timer)
  const onAbort = () => abort.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  abort.signal.addEventListener('abort', stop, { once: true })
  const body =
    init.body instanceof ReadableStream ? observed(init.body, progress, () => {}) : init.body
  progress()
  let res: Response
  try {
    res = await fetch(url, {
      ...PROVIDER_HTTP.fetchOptions,
      ...init,
      ...(body === undefined ? {} : { body }),
      signal: abort.signal,
    })
  } catch (err) {
    stop()
    signal?.removeEventListener('abort', onAbort)
    throw abort.signal.reason instanceof TransferStalled ? abort.signal.reason : err
  }
  progress()
  const end = () => {
    stop()
    signal?.removeEventListener('abort', onAbort)
  }
  if (!res.body) {
    end()
    return res
  }
  const reader = res.body.getReader()
  // 中止之后读取以运行时的中止错误失败：改为给出中止的原因，调用方据此区分连接失效与用户停止。
  const watched = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          end()
          controller.close()
          return
        }
        progress()
        controller.enqueue(value)
      } catch (err) {
        end()
        controller.error(abort.signal.aborted ? (abort.signal.reason ?? err) : err)
      }
    },
    async cancel(reason) {
      end()
      await reader.cancel(reason)
    },
  })
  return new Response(watched, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/** 表单编码中名称与文件名的写法：`"`、CR、LF 写为 `%22`、`%0D`、`%0A`，其余字符为 UTF-8 原文。 */
const quoted = (v: string) =>
  v.replaceAll('"', '%22').replaceAll('\r', '%0D').replaceAll('\n', '%0A')

/** multipart 的一个字段：文本，或文件（`Bun.file` 从磁盘按块读取）。 */
export type MultipartField =
  | { name: string; value: string }
  | { name: string; filename: string; type?: string; file: Blob }

/** 表单的字段：文件字段的文件名取 `File.name`。 */
export function formFields(form: FormData): MultipartField[] {
  return [...form.entries()].map(([name, value]): MultipartField => {
    if (typeof value === 'string') return { name, value }
    const file = value as File
    return { name, filename: file.name, type: file.type, file }
  })
}

/**
 * 把字段编码为 multipart/form-data 的流，并给出总长度：文件按块读取，不整体读入内存。
 * 与 `fetchWithIdle` 一起使用时，Bun 读取每一块计为一次上传进展。
 */
export function multipartBody(fields: readonly MultipartField[]): {
  body: ReadableStream<Uint8Array>
  length: number
  contentType: string
} {
  const boundary = `----qywork${crypto.randomUUID().replaceAll('-', '')}`
  const enc = new TextEncoder()
  const pieces: (Uint8Array | Blob)[] = []
  for (const f of fields) {
    const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(f.name)}"`
    if ('value' in f) {
      pieces.push(enc.encode(`${disposition}\r\n\r\n`), enc.encode(f.value))
    } else {
      pieces.push(
        enc.encode(
          `${disposition}; filename="${quoted(f.filename)}"\r\n` +
            `Content-Type: ${f.type || 'application/octet-stream'}\r\n\r\n`,
        ),
        f.file,
      )
    }
    pieces.push(enc.encode('\r\n'))
  }
  pieces.push(enc.encode(`--${boundary}--\r\n`))
  const length = pieces.reduce((n, p) => n + (p instanceof Uint8Array ? p.byteLength : p.size), 0)
  let at = 0
  let chunks: AsyncIterator<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (chunks) {
          const next = await chunks.next()
          if (!next.done) {
            controller.enqueue(next.value)
            return
          }
          chunks = null
          at++
          continue
        }
        const piece = pieces[at]
        if (piece === undefined) {
          controller.close()
          return
        }
        if (piece instanceof Uint8Array) {
          at++
          controller.enqueue(piece)
          return
        }
        chunks = (piece.stream() as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      }
    },
    async cancel() {
      await chunks?.return?.()
    },
  })
  return { body, length, contentType: `multipart/form-data; boundary=${boundary}` }
}
