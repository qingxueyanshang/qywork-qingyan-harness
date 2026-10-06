/**
 * 中间资源登记。
 *
 * 与 `content.ts` 的分工：正文库存储字节，此处存储事实。
 * 两者位于不同的库，没有外键，因此顺序是硬约束：先在正文库定稿 blob，再在此处登记。
 */

import { newResourceId, type ResourceId } from '@qywork/core'
import type { Store } from './db.ts'
import { readJson, writeJson } from './db.ts'
import type { IntermediateResourceRow } from './schema.ts'

export type ResourceStatus = 'complete' | 'partial' | 'failed'

/**
 * 覆盖范围：模型看到的片段在完整正文中的位置与占比。
 *
 * 这些数值必须提供给模型。只提供截断后的正文而不说明「这是 2.3 MB 中的前 4 KB」时，
 * 模型会将其视为全部内容，并基于不完整的信息下结论，后果比不提供正文更严重。
 */
export interface ResourceCoverage {
  /** 投递给模型的字节数。 */
  deliveredBytes?: number
  /** 完整正文的字节数。 */
  totalBytes?: number
  /** 是否只投递了一部分。 */
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
  /** null 表示没有定稿的正文（获取失败或中途断开）。登记记录仍然保留。 */
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
    .query<IntermediateResourceRow, [string]>('SELECT * FROM intermediate_resources WHERE id = ?')
    .get(id)
  return row ? rowToResource(row) : null
}

export function listResourcesForRun(store: Store, runId: string): IntermediateResource[] {
  return store.db
    .query<IntermediateResourceRow, [string]>(
      'SELECT * FROM intermediate_resources WHERE run_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(runId)
    .map(rowToResource)
}

/**
 * 全量引用集合，供正文库 GC。
 *
 * 必须是全量集合：`ContentStore.collectGarbage` 会删除集合之外的全部正文，
 * 只传某个会话的引用会删除其他会话的全部正文。
 */
export function referencedContentHashes(store: Store): string[] {
  return store.db
    .query<{ content_hash: string }, []>(
      'SELECT DISTINCT content_hash FROM intermediate_resources WHERE content_hash IS NOT NULL',
    )
    .all()
    .map((r) => r.content_hash)
}

function rowToResource(r: IntermediateResourceRow): IntermediateResource {
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
