/**
 * xlsx 解析 Worker：接收文件字节（转移所有权），回复解析结果。请求与回复的格式见 `document.ts`。
 */

import { parseXlsx, type XlsxResult } from '@qywork/ooxml/xlsx'
import type { WorkerReply, WorkerRequest } from './document.ts'

export type XlsxRequest = { readonly kind: 'parse'; readonly bytes: ArrayBuffer }
export interface XlsxReplies {
  readonly parse: XlsxResult
}

self.onmessage = async (e: MessageEvent<WorkerRequest<XlsxRequest>>) => {
  const { id, body } = e.data
  let reply: WorkerReply<XlsxResult>
  try {
    reply = { id, body: await parseXlsx(new Uint8Array(body.bytes)) }
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(reply)
}
