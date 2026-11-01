/**
 * pptx 解析 Worker：首条请求 `parse` 接收文件字节（转移所有权）并保留，其后的 `font`、`images` 从同一份字节中读取
 * 嵌入字体与图片部件。请求与回复的格式见 `../document.ts`。
 *
 * - 回复中的字节转移给主线程。只转移独占整个缓冲区的字节：结构化复制一个视图会复制它所在的整个缓冲区。
 * - 嵌入字体每条请求还原一个（MicroType Express 解压，中文字体可达数十兆字节、耗时约一秒），在此进行，不阻塞界面。
 * - 请求按到达顺序逐条处理。不要改为收到即处理：并发时后到的字体还原可在先到的图片请求等待解压期间开始同步解码，
 *   图片的回复因此推迟一个字体的解码时间。
 */

import {
  type EmbeddedFont,
  type EmbeddedFontFile,
  type ImagePart,
  type PptxResult,
  parsePptx,
  readEmbeddedFonts,
  readImages,
} from '@qywork/ooxml/pptx'
import type { WorkerReply, WorkerRequest } from '../document.ts'

export type PptxRequest =
  | { readonly kind: 'parse'; readonly bytes: ArrayBuffer }
  | { readonly kind: 'font'; readonly font: EmbeddedFont }
  | { readonly kind: 'images'; readonly parts: readonly string[] }

export interface PptxReplies {
  readonly parse: PptxResult
  /** 无法还原时为 `null`。 */
  readonly font: EmbeddedFontFile | null
  /** 包中不存在的部件不在结果中。 */
  readonly images: readonly (readonly [string, ImagePart])[]
}

let data: Uint8Array<ArrayBuffer> | null = null

/** 独占整个缓冲区的字节：原样返回，否则复制一份。 */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : bytes.slice()
}

async function handle(
  body: PptxRequest,
): Promise<{ reply: PptxReplies[PptxRequest['kind']]; transfer: Transferable[] }> {
  if (body.kind === 'parse') {
    data = new Uint8Array(body.bytes)
    return { reply: await parsePptx(data), transfer: [] }
  }
  if (data === null) throw new Error('尚未接收文件')
  if (body.kind === 'font') {
    const font = (await readEmbeddedFonts(data, [body.font])).fonts[0]
    if (!font) return { reply: null, transfer: [] }
    const bytes = owned(font.bytes)
    return { reply: { ...font, bytes }, transfer: [bytes.buffer] }
  }
  const images = [...(await readImages(data, body.parts))].map(
    ([part, img]) => [part, { ...img, bytes: owned(img.bytes) }] as const,
  )
  return { reply: images, transfer: images.map(([, img]) => img.bytes.buffer) }
}

async function respond({ id, body }: WorkerRequest<PptxRequest>): Promise<void> {
  try {
    const { reply, transfer } = await handle(body)
    self.postMessage({ id, body: reply } satisfies WorkerReply<unknown>, { transfer })
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerReply<unknown>)
  }
}

/** 上一条请求的处理；`respond` 不拒绝，链不会中断。 */
let previous: Promise<void> = Promise.resolve()

self.onmessage = (e: MessageEvent<WorkerRequest<PptxRequest>>) => {
  const request = e.data
  previous = previous.then(() => respond(request))
}
