/**
 * 中间资源登记。移植自原版 `resource_sink.py` 的持久化部分。
 *
 * 与 `content.ts` 的分工：正文库存**字节**，这里存**事实**。
 * 两者跨库，没有外键，所以顺序是硬约束：**先在正文库定稿 blob，再往这里登记。**
 */

import { newResourceId, type ResourceId } from '@qywork/core'
import type { Store } from './db.ts'
import { readJson, writeJson } from './db.ts'

export type ResourceStatus = 'complete' | 'partial' | 'failed'

/**
 * 覆盖事实：模型看到的那一小段，相对于完整正文是什么位置、占多少。
 *
 * 这几个数字**必须交给模型**。只给一段截断正文而不说「这是 2.3 MB 里的前 4 KB」，
 * 模型会把它当成全部，然后基于不完整的信息下结论——那比不给它更糟。
 */
export interface ResourceCoverage {
  /** 投递给模型的字节数。 */
  deliveredBytes?: number
  /** 完整正文的字节数。 */
  totalBytes?: number
  /** 是否只投了一部分。 */
  truncated?: boolean
  /** 产生它的查询/命令，供模型判断这段内容的语义。 */
  query?: string
  [k: string]: unknown
}

export interface IntermediateResource {
  id: ResourceId
  runId: string
  stepId: string | null
  toolName: string
  sourceType: string
  status: ResourceStatus
  /** null = 没有定稿的正文（抓取失败/中途断开）。登记仍然保留。 */
  contentHash: string | null
  sizeBytes: number
  mimeType: string | null
  coverage: ResourceCoverage
  createdAt: number
}

export function registerResource(
  store: Store,
  input: {
    runId: string
    stepId?: string | null
    toolName: string
    sourceType: string
    status: ResourceStatus
    contentHash?: string | null
    sizeBytes?: number
    mimeType?: string | null
    coverage?: ResourceCoverage
  },
): IntermediateResource {
  const res: IntermediateResource = {
    id: newResourceId(),
    runId: input.runId,
    stepId: input.stepId ?? null,
    toolName: input.toolName,
    sourceType: input.sourceType,
    status: input.status,
    contentHash: input.contentHash ?? null,
    sizeBytes: input.sizeBytes ?? 0,
    mimeType: input.mimeType ?? null,
    coverage: input.coverage ?? {},
    createdAt: Date.now(),
  }
  store.db
    .query(
      `INSERT INTO intermediate_resources
       (id, run_id, step_id, tool_name, source_type, status, content_hash, size_bytes, mime_type, coverage, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      res.id,
      res.runId,
      res.stepId,
      res.toolName,
      res.sourceType,
      res.status,
      res.contentHash,
      res.sizeBytes,
      res.mimeType,
      writeJson(res.coverage) ?? '{}',
      res.createdAt,
    )
  return res
}

export function getResource(store: Store, id: string): IntermediateResource | null {
  const row = store.db
    .query<Record<string, any>, [string]>('SELECT * FROM intermediate_resources WHERE id = ?')
    .get(id)
  return row ? rowToResource(row) : null
}

export function listResourcesForRun(store: Store, runId: string): IntermediateResource[] {
  return store.db
    .query<Record<string, any>, [string]>(
      'SELECT * FROM intermediate_resources WHERE run_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(runId)
    .map(rowToResource)
}

/**
 * 全量引用集合，供正文库 GC。
 *
 * **必须是全量**：`ContentStore.collectGarbage` 会删掉不在集合里的一切，
 * 传某个会话的局部引用等于把别的会话的正文全删了。
 */
export function referencedContentHashes(store: Store): string[] {
  return store.db
    .query<{ content_hash: string }, []>(
      'SELECT DISTINCT content_hash FROM intermediate_resources WHERE content_hash IS NOT NULL',
    )
    .all()
    .map((r) => r.content_hash)
}

function rowToResource(r: Record<string, any>): IntermediateResource {
  return {
    id: r.id,
    runId: r.run_id,
    stepId: r.step_id,
    toolName: r.tool_name,
    sourceType: r.source_type,
    status: r.status,
    contentHash: r.content_hash,
    sizeBytes: r.size_bytes,
    mimeType: r.mime_type,
    coverage: readJson<ResourceCoverage>(r.coverage, {}),
    createdAt: r.created_at,
  }
}
