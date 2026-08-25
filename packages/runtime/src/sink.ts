/**
 * `SinkPort` 的实际装配。
 *
 * 只有这一层同时握着内容库（正文）和账本（事实），所以落盘的**顺序约束**
 * 只能在这里保证：
 *
 *   1. 先把正文写进内容库并定稿 → 拿到 content_hash
 *   2. 再往账本登记 intermediate_resources 行
 *
 * 反过来做会让账本指向一个不存在或不完整的正文，而那种损坏要到模型来读的时候
 * 才发现——届时原始字节已经没了，无从修复。
 *
 * 跨库没有外键能守住这条，只有顺序。
 */

import type { SinkPort } from '@qywork/agent'
import type { ResourceCoverage, RunId } from '@qywork/core'
import {
  type ContentStore,
  getResource,
  referencedContentHashes,
  registerResource,
  type Store,
} from '@qywork/store'

export class RuntimeSink implements SinkPort {
  constructor(
    private readonly store: Store,
    private readonly content: ContentStore,
    private readonly runId: RunId,
  ) {}

  land(input: {
    toolName: string
    sourceType: string
    body: Uint8Array
    mimeType?: string | null
    coverage?: ResourceCoverage
  }): { resourceId: string; contentHash: string } {
    // 步骤 1：正文先定稿。失败就抛，调用方（deliver）会降级成纯截断并**如实告知模型**。
    const blob = this.content.put(input.body)

    // 步骤 2：账本登记。此时 blob 一定存在。
    const res = registerResource(this.store, {
      runId: this.runId,
      toolName: input.toolName,
      sourceType: input.sourceType,
      status: 'complete',
      contentHash: blob.contentHash,
      sizeBytes: blob.originalBytes,
      mimeType: input.mimeType ?? null,
      ...(input.coverage ? { coverage: input.coverage } : {}),
    })

    return { resourceId: res.id, contentHash: blob.contentHash }
  }

  read(resourceId: string, start: number, length: number): Uint8Array | null {
    const res = getResource(this.store, resourceId)
    if (!res?.contentHash) return null
    return this.content.readRange(res.contentHash, start, length)
  }

  stat(resourceId: string): { sizeBytes: number; mimeType: string | null } | null {
    const res = getResource(this.store, resourceId)
    if (!res?.contentHash) return null
    // 以内容库为准而不是账本上的 size_bytes：正文可能已被 GC 回收，
    // 那时账本还在但内容没了，必须报「不存在」而不是报一个读不出来的长度。
    const info = this.content.info(res.contentHash)
    if (!info) return null
    return { sizeBytes: info.originalBytes, mimeType: res.mimeType }
  }
}

/**
 * 回收无人引用的正文。
 *
 * **引用集合必须是全量的**——`collectGarbage` 会删掉集合之外的一切。
 * 这里直接从账本查全表，不接受调用方传局部集合：传错了后果是静默删掉
 * 其他会话的正文，而那种损坏同样要到读的时候才发现。
 */
export function collectResourceGarbage(store: Store, content: ContentStore): { removed: number } {
  return content.collectGarbage(referencedContentHashes(store))
}
