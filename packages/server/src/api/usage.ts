/**
 * 用量账本的 HTTP 出口。
 *
 * **必要性。** 账本（`usage_ledger`）持续写入，`usageTotals` / `usageBy` 也已存在，
 * 但没有 HTTP 出口时只有 `qy usage` 这个 CLI 读取它们，界面上能看到的用量只剩当前会话的 runs 之和：
 * 会话删除后即丢失，也无法回答本月花费多少。这属于 ARCHITECTURE §11 表中的第三种形状：
 * 两端均已实现，中间缺少一个环节。
 *
 * **口径与 CLI 完全一致。** 使用同一组函数与同一组参数，不在此处另行计算。界面与命令行报告不同的数字，
 * 比其中一方报错更难排查。
 */

import type { UsageResponse } from '@qywork/core'
import { type GroupBy, usageBy, usageTotals } from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

const GROUPS: GroupBy[] = ['model', 'day', 'workspace', 'kind']

const DEFAULT_DAYS = 30
/** 上限只用于拒绝误传的极大数值，不是业务约束：账本不删除旧数据。 */
const MAX_DAYS = 3650

export const handleUsageApi: ApiHandler = async (url, _req, d) => {
  if (url.pathname !== '/api/usage') return null

  const days = Number(url.searchParams.get('days') ?? DEFAULT_DAYS)
  if (!Number.isFinite(days) || days <= 0 || days > MAX_DAYS) {
    return json({ error: `days 必须在 1..${MAX_DAYS} 之间` }, 400)
  }

  const by = (url.searchParams.get('by') ?? 'model') as GroupBy
  if (!GROUPS.includes(by)) {
    return json({ error: `by 只能是 ${GROUPS.join(' / ')}` }, 400)
  }

  const since = Date.now() - days * 86_400_000
  const res: UsageResponse = {
    days,
    since,
    by,
    totals: usageTotals(d.store, { since }),
    rows: usageBy(d.store, by, { since }),
    // 单独返回本工作区的用量：界面上本机用量与本工作区用量是两个都会被查询的问题，
    // 前端无法从总量中自行计算出本工作区的用量。
    workspaceTotals: usageTotals(d.store, { since, workspaceId: d.workspaceId }),
  }
  return json(res)
}
