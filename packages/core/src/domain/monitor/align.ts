/**
 * 逐项估算与分组值对齐：信封明细（store 的 `requestEnvelopeItems`）与消息条目重建（runtime）共用。
 *
 * 必须对齐：分组值由 `breakdownOf` 对整组内容一次估算并经对账，逐项值对每一项分别估算，
 * 两者之差来自序列化中的分隔符、取整与对账吸收的差额。不对齐时，展开某一分组后各项之和与该分组的数值不一致。
 */

import type { ContextGroup } from '../model.ts'

/**
 * 按占比重新分配每个分组内各项的值，使其总和精确等于 `groups` 中该分组的值；就地修改 `items`。
 *
 * 余数归入分组内最大的一项；分组内各项全为零时全部分配给第一项。`groups` 中没有的分组、
 * 没有任何一项的分组不处理。
 */
export function alignGroupItems(
  items: readonly { group: ContextGroup; tokens: number }[],
  groups: Partial<Record<ContextGroup, number>>,
): void {
  const byGroup = new Map<ContextGroup, { group: ContextGroup; tokens: number }[]>()
  for (const item of items) {
    const members = byGroup.get(item.group) ?? []
    members.push(item)
    byGroup.set(item.group, members)
  }
  for (const [group, members] of byGroup) {
    const want = groups[group]
    const first = members[0]
    if (want === undefined || !first) continue
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
}
