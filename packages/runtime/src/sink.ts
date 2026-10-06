/**
 * `SinkPort` 的实际装配。
 *
 * 只有这一层同时持有内容库（正文）与账本（事实），因此写入磁盘的顺序约束
 * 只能在此处保证：
 *
 *   1. 先将正文写入内容库并定稿，取得 content_hash
 *   2. 再向账本登记 intermediate_resources 行
 *
 * 顺序颠倒时账本会指向不存在或不完整的正文，这种损坏要到模型读取时
 * 才被发现，届时原始字节已经丢失，无法修复。
 *
 * 跨库没有外键可以保证这一点，只能依靠顺序。
 *
 * 两库的并发约束是主库的写锁。顺序对单个写入者足够，对写入与回收同时进行的情况不够：
 * 正文定稿之后、引用登记之前，另一个连接查询到的引用集合中没有该条目，GC 会删除刚定稿的
 * 正文，随后登记的引用即为悬空引用。因此本文件的写入者与回收者遵守同一锁顺序：
 * 主库 IMMEDIATE 事务取得写锁 → 正文库操作 → 主库登记 / 提交，中间没有 await。
 * 两库仍不是一次原子提交：主库回滚会留下无人引用的正文（可回收），但不会留下悬空引用。
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
     * 主库写事务包含两个步骤。`Store.tx` 是 IMMEDIATE，进入回调前即取得主库写锁，
     * GC 在同一把锁上等待，无法删除正在登记的正文。
     *
     * 不要为缩短持锁时间而把 `put` 移到事务之外：那正是文件头所述的竞争窗口。
     * 回调中也不得出现 await：事务是同步的，跨 await 的部分不受锁保护。
     */
    return this.store.tx(() => {
      // 步骤 1：先将正文定稿。失败时抛出异常，主库事务随之回滚，账本中不留引用；
      // 调用方（deliver）降级为仅截断，并如实告知模型。
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
    // 以内容库为准，而不是账本上的 size_bytes：正文可能已被 GC 回收，
    // 此时账本行仍在而内容已删除，必须报告不存在，而不是报告一个无法读取的长度。
    const info = this.content.info(res.contentHash)
    if (!info) return null
    return { sizeBytes: info.originalBytes, mimeType: res.mimeType }
  }
}

/**
 * 回收无人引用的正文。
 *
 * 引用集合必须是全量的：`collectGarbage` 会删除集合之外的全部正文。
 * 此处直接从账本查询全表，不接受调用方传入的局部集合：传入错误的集合会静默删除
 * 其他会话的正文，而这种损坏同样要到读取时才被发现。
 *
 * 查询集合与删除正文都在主库写事务中，锁顺序与 `RuntimeSink.land` 相同。
 * 取得写锁之后才查询，查询到的集合即包含所有已提交的引用；尚未提交的引用，
 * 其写入者此时正被该锁阻塞在事务起点。不要把查询移到事务之外：
 * 否则查询到的是旧集合，期间登记的引用会被视为不存在。
 */
export function collectResourceGarbage(store: Store, content: ContentStore): { removed: number } {
  return store.tx(() => content.collectGarbage(referencedContentHashes(store)))
}
