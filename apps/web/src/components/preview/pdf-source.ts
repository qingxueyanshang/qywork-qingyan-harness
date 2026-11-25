/**
 * PDF 文件的分段读取（HTTP Range），供 `PdfPages.tsx` 交给 pdf.js：先读取开头一段，由 `Content-Range` 取得文件长度，
 * 其余按 pdf.js 的请求读取。可见页面所需的部分先读取，其余由 pdf.js 在后台继续请求。
 *
 * - 不要改为把地址交给 pdf.js：它按整份读取的应答头判断能否分段读取，经隧道转发的应答没有 `Content-Length`，
 *   结果是先整份下载再显示（9.9 MB 的文件首屏 13 秒）。
 * - 读取失败时调用 `fail`，不重试：pdf.js 的分段读取接口没有失败的回报，未取得的数据会使页面一直等待，调用方须据此结束显示。
 */

import { PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApiError } from '../../lib/client.ts'

/** 读取 `[begin, end)`；`total` 为文件长度。 */
export type ReadRange = (
  begin: number,
  end: number,
) => Promise<{ readonly bytes: Uint8Array; readonly total: number }>

/**
 * 按 `url` 分段读取。`total`：分段应答取自 `Content-Range`，整份应答（200，服务端不分段时）为正文长度。
 * `raw` 为 `client.raw`：携带令牌，不判定状态码。
 */
export function rangeReader(
  raw: (path: string, init: RequestInit) => Promise<Response>,
  url: string,
): ReadRange {
  return async (begin, end) => {
    const res = await raw(url, { headers: { range: `bytes=${begin}-${end - 1}` } })
    if (res.status !== 200 && res.status !== 206) {
      throw new ApiError(res.status, url, await res.text().catch(() => ''))
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const total =
      res.status === 200
        ? bytes.length
        : Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? Number.NaN)
    if (!Number.isInteger(total)) throw new ApiError(res.status, url, '')
    return { bytes, total }
  }
}

/** 按 pdf.js 请求的区间读取。文档销毁（`abort`）后到达的数据与失败不再转交。 */
class RangeSource extends PDFDataRangeTransport {
  #closed = false
  readonly #read: ReadRange
  readonly #fail: (err: unknown) => void

  constructor(read: ReadRange, length: number, head: Uint8Array, fail: (err: unknown) => void) {
    super(length, head)
    this.#read = read
    this.#fail = fail
  }

  override requestDataRange(begin: number, end: number): void {
    this.#read(begin, end).then(
      (r) => {
        if (!this.#closed) this.onDataRange(begin, r.bytes)
      },
      (err: unknown) => {
        if (!this.#closed) this.#fail(err)
      },
    )
  }

  override abort(): void {
    this.#closed = true
  }
}

/**
 * 读取开头 `chunk` 字节，返回交给 `getDocument` 的数据来源：文件不长于 `chunk` 时为全部字节，否则为分段读取。
 * 开头一段读取失败时拒绝；此后的读取失败调用 `fail`。
 */
export async function pdfSource(
  read: ReadRange,
  chunk: number,
  fail: (err: unknown) => void,
): Promise<{ readonly data: Uint8Array } | { readonly range: PDFDataRangeTransport }> {
  const head = await read(0, chunk)
  if (head.bytes.length >= head.total) return { data: head.bytes }
  return { range: new RangeSource(read, head.total, head.bytes, fail) }
}
