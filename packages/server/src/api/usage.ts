/**
 * 用量账本的 HTTP 出口。
 *
 * **为什么它到现在才有。** 账本（`usage_ledger`）一直在被正常写入，`usageTotals` / `usageBy` 也一直
 * 在，但**只有 `qy usage` 这个 CLI 在读**。因此界面上唯一能看到的用量是「当前会话的 runs 加起来」
 * ——会话一删就没了，也答不了「这个月花了多少」。这是 ARCHITECTURE §11 那张表里的第三种形状：两头
 * 都好，中间少一节。
 *
 * **口径与 CLI 完全一致。** 同一组函数、同一组参数，不在这里另算一遍。界面和命令行报出不同的数字，
 * 比其中一个报错要难查得多。
 */

import type { UsageResponse } from '@qywork/core'
import { type GroupBy, usageBy, usageTotals } from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

const GROUPS: GroupBy[] = ['model', 'day', 'workspace', 'kind']

const DEFAULT_DAYS = 30
/** 上限只是防手滑传个天文数字，不是业务约束——账本本来就不删旧数据。 */
const MAX_DAYS = 3650

export const handleUsageApi: ApiHandler = async (url, _req, d) => {
  if (url.pathname !== '/api/usage') return null

  const days = Number(url.searchParams.get('days') ?? DEFAULT_DAYS)
  if (!Number.isFinite(days) || days <= 0 || days > MAX_DAYS) {
    return json({ error: `days 要在 1..${MAX_DAYS} 之间` }, 400)
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
    // 本工作区的那一份单独给一次：界面上「这台机器」和「这个工作区」是两个
    // 都会被问到的问题，让前端拿总量自己减是算不出来的。
    workspaceTotals: usageTotals(d.store, { since, workspaceId: d.workspaceId }),
  }
  return json(res)
}
