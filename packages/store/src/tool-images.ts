/**
 * 工具结果中的图像字节。
 *
 * 工具返回时（`tool.finished` 事件）的形态是 `data.images: [{ data, mime }]`，`data` 为 base64；
 * 账本中的形态是 `data.images: [{ resourceId, mime, bytes }]`，字节以原始二进制存入正文库，按内容哈希去重，
 * `intermediate_resources` 登记引用（`step_id` 指向该 step）。写入账本时由 `storeToolImages` 转换。
 *
 * 请求历史直接使用引用（`agent` 的 `imagesOf` 按 `isStoredToolImage` 识别），发出前只读取未被换出的那些；
 * 界面、导出与 `read_history` 需要字节，经 `loadToolImages` 还原。
 *
 * 不要把字节写回 payload：同一张图被读取、经 `read_history` 取回时各存一份 base64，
 * 账本随图片读取次数线性增长，而历史接口与 `read_history` 每次都要解析全部字节。
 *
 * 键名保持 `images`：发给模型的信封由 `envelopeResult` 整体剥离该键，两种形态下信封逐字相同；
 * 改用其他键名时，未经读取转换的引用会作为文本进入信封，前缀随之改变。
 *
 * base64 按标准字母表、带填充重新编码。工具产生的 base64 本就是这种形式（`Buffer.toString('base64')`），
 * 读取后与写入前逐字节相同；第三方工具给出其他写法时，读取后的写法不同、图像相同，
 * 下一轮请求在该处的前缀缓存失效一次。
 */

import { log, type Step } from '@qywork/core'
import type { ContentStore } from './content.ts'
import type { Store } from './db.ts'
import { getResource, registerResource } from './resources.ts'

/** 账本中一张图像的引用。`mime` 与写入前相同，`bytes` 为解码后的字节数，其余字段原样保留。 */
export interface StoredToolImage {
  resourceId: string
  mime: string
  bytes: number
}

function withBytes(entry: unknown): entry is { data: string; mime: string } {
  return (
    !!entry &&
    typeof entry === 'object' &&
    typeof (entry as { data?: unknown }).data === 'string' &&
    typeof (entry as { mime?: unknown }).mime === 'string'
  )
}

export function isStoredToolImage(entry: unknown): entry is StoredToolImage {
  return (
    !!entry &&
    typeof entry === 'object' &&
    typeof (entry as { resourceId?: unknown }).resourceId === 'string' &&
    typeof (entry as { mime?: unknown }).mime === 'string' &&
    typeof (entry as { bytes?: unknown }).bytes === 'number' &&
    !('data' in entry)
  )
}

function imagesField(data: unknown): unknown[] | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const images = (data as { images?: unknown }).images
  return Array.isArray(images) ? images : null
}

/** `data.images` 中是否有仍带字节的图像，即写入账本前需要转换。 */
export function hasImageBytes(data: unknown): boolean {
  return imagesField(data)?.some(withBytes) ?? false
}

/**
 * 把 `data.images` 中的字节写入正文库，返回改为引用的 `data`；没有图像字节时原样返回。
 *
 * 调用方必须已持有主库写事务：正文定稿与引用登记之间不得被 GC 插入，锁顺序同 `RuntimeSink.land`。
 */
export function storeToolImages(
  store: Pick<Store, 'db'>,
  content: ContentStore,
  at: { runId: string; stepId: string; toolName: string },
  data: Record<string, unknown>,
): Record<string, unknown> {
  const images = imagesField(data)
  if (!images?.some(withBytes)) return data
  return {
    ...data,
    images: images.map((entry) => {
      if (!withBytes(entry)) return entry
      const { data: base64, ...rest } = entry
      const blob = content.put(Buffer.from(base64, 'base64'))
      const res = registerResource(store, {
        runId: at.runId,
        stepId: at.stepId,
        toolName: at.toolName,
        sourceType: 'tool_image',
        status: 'complete',
        contentHash: blob.contentHash,
        sizeBytes: blob.originalBytes,
        mimeType: entry.mime,
      })
      return { ...rest, resourceId: res.id, bytes: blob.originalBytes }
    }),
  }
}

/**
 * 把 steps 中工具结果的图像引用还原为字节。没有引用的 step 原样返回。
 *
 * 正文缺失（正文库被删除或损坏）时该图不还原，`data.imagesMissing` 记下缺失的张数：
 * 它随信封交给模型，模型据此知道此处原有图像，而不是把这次调用当作没有返回图像。
 */
export function loadToolImages(store: Store, content: ContentStore, steps: Step[]): Step[] {
  return steps.map((step) => {
    const payload = step.payload
    if (payload?.kind !== 'tool_result') return step
    const data = payload.outcome.data
    const images = imagesField(data)
    if (!images?.some(isStoredToolImage)) return step
    let missing = 0
    const loaded = images.flatMap((entry) => {
      if (!isStoredToolImage(entry)) return [entry]
      const res = getResource(store, entry.resourceId)
      const bytes = res?.contentHash ? content.readAll(res.contentHash) : null
      if (!bytes) {
        missing++
        return []
      }
      const { resourceId: _id, bytes: _bytes, ...rest } = entry
      return [{ ...rest, data: Buffer.from(bytes).toString('base64') }]
    })
    if (missing) {
      log.warn('store', '工具结果的图像正文缺失', { stepId: step.id, missing })
    }
    return {
      ...step,
      payload: {
        ...payload,
        outcome: {
          ...payload.outcome,
          data: { ...data, images: loaded, ...(missing ? { imagesMissing: missing } : {}) },
        },
      },
    }
  })
}
