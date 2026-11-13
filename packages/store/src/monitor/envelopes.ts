/**
 * 请求信封的明细：系统提示词一项与每个工具定义的名称与估算值，按信封指纹保存，同一指纹一行。
 *
 * 指纹即请求行的 `cache_route_fingerprint`（agent 的 `envelopeHashOf`，覆盖型号、系统提示词与工具表）。
 * 系统提示词与工具表不保存在账本中，明细只能在请求发出时估算，事后无法重算。
 * 明细只用于展示，不参与任何裁决；分组值仍以请求行的 `sent_categories` 为准。
 */

import type { ContextBreakdown, ContextGroup } from '@qywork/core'
import type { Store } from '../db.ts'
import { readJson } from '../db.ts'
import type { RequestEnvelopeRow } from '../schema.ts'

export type EnvelopeGroup = Extract<ContextGroup, 'systemPrompt' | 'systemTools' | 'mcpTools'>

const ENVELOPE_GROUPS: readonly EnvelopeGroup[] = ['systemPrompt', 'systemTools', 'mcpTools']

export interface EnvelopeItem {
  group: EnvelopeGroup
  /** 工具名。系统提示词一项为 null。 */
  name: string | null
  tokens: number
}

/**
 * 该指纹尚无明细时调用 `estimate` 并写入；已有时不调用。
 *
 * 由调用方与请求行置于同一事务中：先查后写之间不能有其他写入者，否则同一指纹会写入两次而违反主键。
 */
export function saveRequestEnvelope(
  store: Store,
  fingerprint: string,
  estimate: () => readonly EnvelopeItem[],
): void {
  if (store.db.query('SELECT 1 FROM request_envelopes WHERE fingerprint = ?').get(fingerprint)) {
    return
  }
  store.db
    .query('INSERT INTO request_envelopes (fingerprint, items, created_at) VALUES (?, ?, ?)')
    .run(fingerprint, JSON.stringify(estimate()), Date.now())
}

/** 删除不再被任何请求行引用的明细，返回删除的行数。经 `idx_provider_fingerprint` 逐行判定。 */
export function pruneRequestEnvelopes(store: Store): number {
  return store.db
    .query(
      `DELETE FROM request_envelopes
       WHERE NOT EXISTS (
         SELECT 1 FROM provider_requests pr
         WHERE pr.cache_route_fingerprint = request_envelopes.fingerprint
       )`,
    )
    .run().changes
}

/**
 * 按指纹读取信封明细，各分组的逐项值按比例对齐到 `groups` 中对应的分组值；没有明细时返回 null。
 *
 * 必须对齐：分组值由 `breakdownOf` 对整张工具表一次估算，逐项值对每个工具分别估算，
 * 两者之差来自序列化中的分隔符与取整。不对齐时，展开某一分组后各项之和与该分组的数值不一致。
 * `groups` 可以传入请求行的原值，也可以传入对账后的值，结果与传入值的口径相同。
 */
export function requestEnvelopeItems(
  store: Store,
  fingerprint: string,
  groups: Pick<ContextBreakdown, EnvelopeGroup>,
): EnvelopeItem[] | null {
  const row = store.db
    .query<Pick<RequestEnvelopeRow, 'items'>, [string]>(
      'SELECT items FROM request_envelopes WHERE fingerprint = ?',
    )
    .get(fingerprint)
  if (!row) return null
  return alignItems(readJson<EnvelopeItem[]>(row.items, []), groups)
}

/**
 * 按占比重新分配每个分组内各项的值，使其总和精确等于该分组的值。
 *
 * 余数归入其中最大的一项；分组内各项全为零时全部分配给第一项。分组没有任何一项时不处理。
 */
function alignItems(
  items: readonly EnvelopeItem[],
  groups: Pick<ContextBreakdown, EnvelopeGroup>,
): EnvelopeItem[] {
  const out = items.map((item) => ({ ...item }))
  for (const group of ENVELOPE_GROUPS) {
    const members = out.filter((item) => item.group === group)
    const first = members[0]
    if (!first) continue
    const want = groups[group]
    const base = members.reduce((n, item) => n + item.tokens, 0)
    if (base <= 0) {
      for (const item of members) item.tokens = 0
      first.tokens = want
      continue
    }
    let assigned = 0
    let biggest = first
    for (const item of members) {
      item.tokens = Math.trunc((item.tokens / base) * want)
      assigned += item.tokens
      if (item.tokens > biggest.tokens) biggest = item
    }
    biggest.tokens += want - assigned
  }
  return out
}
