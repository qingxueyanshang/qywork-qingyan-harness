/**
 * docx 解析与分页 Worker：首条请求 `parse` 接收文件字节（转移所有权）并保留解析结果，回复所需字体名；
 * 主线程取得字体后发出 `layout`，Worker 以同样的字体字节排版、分页，回复纯数据的分页结果。请求与回复的格式见 `../document.ts`。
 *
 * - 排版度量与绘制必须来自同一份字体字节：`layout` 中的字节即主线程注册 `FontFace` 与读取绘制度量所用的字节。
 * - 分页结果中的字形以文档中的字体名为族名（`DocumentPages.faces`），主线程按字体名换算为注册的族名。
 * - 回复中图片的字节转移给主线程。只转移独占整个缓冲区的字节：结构化复制一个视图会复制它所在的整个缓冲区。
 */

import {
  type DocumentPages,
  type DocxDocument,
  type DocxFace,
  type DocxFailure,
  DocxFonts,
  layoutPages,
  loadDocxFace,
  parseDocx,
  requiredFonts,
  type UnsupportedCounts,
} from '@qywork/ooxml/docx'
import type { WorkerReply, WorkerRequest } from '../document.ts'

export type DocxRequest =
  | { readonly kind: 'parse'; readonly bytes: ArrayBuffer }
  | {
      readonly kind: 'layout'
      /** 字体文件字节，每个文件只出现一次。 */
      readonly files: readonly Uint8Array[]
      /** 字体名与该名称在主机上对应的字体（`files` 的下标）。 */
      readonly families: readonly (readonly [string, readonly number[]])[]
      /** 缺字与缺少字体时使用的字体名，在 `families` 中且至少有一个可读取的字体。 */
      readonly fallback: string
    }

export type DocxParsed =
  | {
      readonly ok: true
      /** 排版所需的全部字体名。 */
      readonly fonts: readonly string[]
      readonly unsupported: UnsupportedCounts
    }
  | { readonly ok: false; readonly failure: DocxFailure }

export interface DocxReplies {
  readonly parse: DocxParsed
  readonly layout: DocumentPages
}

let doc: DocxDocument | null = null

/** 独占整个缓冲区的字节：原样返回，否则复制一份。 */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : bytes.slice()
}

/** 字体表不完整的文件按主机上没有该字体处理，与主线程读取绘制度量的结果一致。 */
function readFace(bytes: Uint8Array): DocxFace | null {
  try {
    return loadDocxFace(bytes, '')
  } catch {
    return null
  }
}

async function handle(
  body: DocxRequest,
): Promise<{ reply: DocxReplies[DocxRequest['kind']]; transfer: Transferable[] }> {
  if (body.kind === 'parse') {
    const parsed = await parseDocx(new Uint8Array(body.bytes))
    if (!parsed.ok) return { reply: parsed, transfer: [] }
    doc = parsed.value
    return {
      reply: { ok: true, fonts: requiredFonts(doc), unsupported: doc.unsupported },
      transfer: [],
    }
  }
  if (doc === null) throw new Error('尚未接收文件')
  const read = body.files.map(readFace)
  const faces: DocxFace[] = []
  for (const [name, indexes] of body.families) {
    for (const i of indexes) {
      const face = read[i]
      if (face) faces.push({ ...face, family: name })
    }
  }
  const { pages } = layoutPages(doc, new DocxFonts(faces, body.fallback))
  const images = pages.images.map((im) => ({ ...im, bytes: owned(im.bytes) }))
  return {
    reply: { ...pages, images },
    transfer: images.map((im) => im.bytes.buffer),
  }
}

self.onmessage = async ({ data: { id, body } }: MessageEvent<WorkerRequest<DocxRequest>>) => {
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
