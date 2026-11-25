/**
 * 服务进程的计算线程：缩小图片（`imageAtWidth`）、读取主机字体并拆分、计算哈希与按码位裁剪（`subsetFace`）。
 * 这些计算单次耗时 0.01–0.7 秒，在主线程执行时聊天事件与全部接口随之停顿；主线程经 `media-jobs.ts` 排队调用。
 *
 * 不变量：请求与回复按 `id` 对应；处理中的异常以 `error` 回复，不抛出到线程之外（主线程据此拒绝对应的调用）。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extractFace, subsetFace } from '@qywork/ooxml/font'
import { imageAtWidth } from '@qywork/tools/image'

export type MediaJob =
  | {
      readonly kind: 'scale'
      readonly bytes: Uint8Array
      readonly mime: string
      readonly width: number
    }
  | { readonly kind: 'digest'; readonly path: string; readonly index: number }
  | {
      readonly kind: 'face'
      readonly path: string
      readonly index: number
      readonly points: readonly number[] | null
    }

export type MediaResult =
  | { readonly kind: 'scale'; readonly bytes: Uint8Array; readonly mime: string }
  | { readonly kind: 'digest'; readonly digest: string }
  | { readonly kind: 'face'; readonly bytes: Uint8Array }

export type MediaReply =
  | { readonly id: number; readonly result: MediaResult }
  | { readonly id: number; readonly error: string }

async function run(job: MediaJob): Promise<MediaResult> {
  if (job.kind === 'scale') {
    const out = await imageAtWidth(job.bytes, job.mime, job.width)
    return { kind: 'scale', bytes: out.bytes, mime: out.mime }
  }
  const face = extractFace(new Uint8Array(await readFile(job.path)), job.index)
  if (job.kind === 'digest') {
    return { kind: 'digest', digest: createHash('sha256').update(face).digest('hex') }
  }
  return { kind: 'face', bytes: job.points ? subsetFace(face, job.points) : face }
}

declare const self: Worker

self.onmessage = (e: MessageEvent<{ id: number; job: MediaJob }>) => {
  const { id, job } = e.data
  run(job).then(
    (result) => {
      const transfer = 'bytes' in result ? [result.bytes.buffer as ArrayBuffer] : []
      self.postMessage({ id, result } satisfies MediaReply, transfer)
    },
    (err: unknown) => {
      self.postMessage({
        id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies MediaReply)
    },
  )
}
