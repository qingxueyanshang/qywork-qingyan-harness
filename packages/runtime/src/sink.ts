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
 *
 * **两库的并发约束是主库的写锁。** 顺序对单个写入者够用，对「一边写、一边回收」不够：
 * 正文定稿之后、引用登记之前，另一个连接查到的引用集合里没有这一条，GC 会把刚定稿的
 * 正文删掉，随后登记进去的引用就是悬空的。所以本文件的写入者与回收者遵守同一条锁顺序
 * ——主库 IMMEDIATE 事务取写权 → 正文库操作 → 主库登记 / 提交，中间没有 await。
 * 两库仍不是一次原子提交：主库回滚会留下没人引用的正文（可回收），但不会留下悬空引用。
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
    /*
     * 主库写事务包住两步。`Store.tx` 是 IMMEDIATE，进回调前就拿到主库写权，
     * GC 在同一把锁上等待，删不到这条正在登记的正文。
     *
     * 不要把 `put` 挪到事务外面「少占一会儿锁」：那正是本文件头说的那个窗口。
     * 回调里也不许出现 await —— 事务是同步的，跨 await 的那一段不在锁的保护范围内。
     */
    return this.store.tx(() => {
      // 步骤 1：正文先定稿。失败就抛，主库事务随之回滚，账本里不留引用；
      // 调用方（deliver）会降级成纯截断并**如实告知模型**。
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
    })
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
 *
 * 查集合与删正文都在主库写事务里，锁顺序与 `RuntimeSink.land` 相同。
 * 拿到写权之后才查，查到的集合就包含所有已提交的引用；未提交的那些，
 * 它们的写入者此刻正被这把锁挡在事务起点。**不要把查询挪到事务外面**：
 * 那样查到的是一份旧集合，期间登记进来的引用会被当成不存在。
 */
export function collectResourceGarbage(store: Store, content: ContentStore): { removed: number } {
  return store.tx(() => content.collectGarbage(referencedContentHashes(store)))
}
