/**
 * 在计算线程（`media-worker.ts`）中执行图片缩小与字体处理，主线程只排队与等待。
 *
 * - 线程在第一次调用时创建，之后常驻；线程异常退出时拒绝全部未完成的调用，下一次调用重新创建。
 * - 线程脚本的位置：源码运行时为同目录的 `media-worker.ts`；sidecar 打包后与入口脚本 `index.js` 同目录，名为 `media-worker.js`
 *   （`scripts/build-sidecar.ts` 把它作为第二个入口按文件名输出）。不要改为其他路径：打包器不识别 `new Worker`，不会自动带上线程脚本。
 * - 字体的哈希按「路径 + 合集序号 + 修改时间 + 大小」缓存：`/api/fonts` 与 `/api/fonts/file` 每次请求都要按哈希找到字体，
 *   一份 Word 打开时有十余个请求，每次重新读取并哈希 10–20 MB 的文件。
 */

import { stat } from 'node:fs/promises'
import type { MediaJob, MediaReply, MediaResult } from './media-worker.ts'

const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './media-worker.ts' : './media-worker.js',
  import.meta.url,
)

let worker: Worker | null = null
let nextId = 0
const pending = new Map<
  number,
  { resolve: (result: MediaResult) => void; reject: (err: Error) => void }
>()

function workerOf(): Worker {
  if (worker) return worker
  const w = new Worker(WORKER_URL.href)
  w.onmessage = (e: MessageEvent<MediaReply>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if ('error' in e.data) p.reject(new Error(e.data.error))
    else p.resolve(e.data.result)
  }
  w.onerror = (e) => {
    if (worker === w) worker = null
    const err = new Error(e.message || '计算线程异常退出')
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }
  // 线程不阻止服务进程退出。
  w.unref()
  worker = w
  return w
}

function run(job: MediaJob, transfer: ArrayBuffer[] = []): Promise<MediaResult> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    workerOf().postMessage({ id, job }, transfer)
  })
}

/** 缩小结果的缓存总量上限（字节）：画布卡片不带版本时浏览器不缓存，每次打开画布都会再次请求。 */
const SCALED_LIMIT = 64 * 1024 * 1024
const scaled = new Map<string, Promise<{ bytes: Uint8Array; mime: string }>>()
const scaledSizes = new Map<string, number>()
let scaledBytes = 0

/**
 * 工作区中的图片 `abs` 缩小到宽度 `width` 的版本；规则见 `@qywork/tools` 的 `imageAtWidth`。
 * 按「路径 + 修改时间 + 大小 + 宽度」缓存，总量超过上限时淘汰最早的结果。
 */
export async function scaledImage(
  abs: string,
  mime: string,
  width: number,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const info = await stat(abs)
  const key = `${abs}\u0000${info.mtimeMs}\u0000${info.size}\u0000${width}`
  let hit = scaled.get(key)
  if (hit) {
    scaled.delete(key)
    scaled.set(key, hit)
    return hit
  }
  hit = Bun.file(abs)
    .bytes()
    .then((bytes) => run({ kind: 'scale', bytes, mime, width }, [bytes.buffer as ArrayBuffer]))
    .then((r) => {
      if (r.kind !== 'scale') throw new Error('计算线程回复的类型不符')
      return { bytes: r.bytes, mime: r.mime }
    })
  scaled.set(key, hit)
  hit.then(
    (out) => {
      if (scaled.get(key) !== hit) return
      scaledSizes.set(key, out.bytes.length)
      scaledBytes += out.bytes.length
      for (const old of scaled.keys()) {
        if (scaledBytes <= SCALED_LIMIT || old === key) break
        scaledBytes -= scaledSizes.get(old) ?? 0
        scaledSizes.delete(old)
        scaled.delete(old)
      }
    },
    () => scaled.delete(key),
  )
  return hit
}

/** 主机上一个字体（文件与合集中的序号）。 */
export interface FaceFile {
  readonly path: string
  readonly index: number
}

const digests = new Map<string, Promise<string>>()

/** 字体拆分后字节的 SHA-256（小写十六进制）；按文件的修改时间与大小缓存。 */
export async function faceDigest(face: FaceFile): Promise<string> {
  const info = await stat(face.path)
  const key = `${face.path}\u0000${face.index}\u0000${info.mtimeMs}\u0000${info.size}`
  let digest = digests.get(key)
  if (!digest) {
    digest = run({ kind: 'digest', path: face.path, index: face.index }).then((r) => {
      if (r.kind !== 'digest') throw new Error('计算线程回复的类型不符')
      return r.digest
    })
    digests.set(key, digest)
    digest.catch(() => digests.delete(key))
  }
  return digest
}

/** 字体拆分后的字节；给出 `points` 时按码位裁剪（`subsetFace`）。 */
export async function faceFile(
  face: FaceFile,
  points: readonly number[] | null,
): Promise<Uint8Array> {
  const result = await run({ kind: 'face', path: face.path, index: face.index, points })
  if (result.kind !== 'face') throw new Error('计算线程回复的类型不符')
  return result.bytes
}
