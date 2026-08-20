/**
 * HTTP 响应契约。
 *
 * ## 这里只放**两边都要认**的那几个
 *
 * 服务端有一百多个 `json(...)`，它们绝大多数只有一个消费者，形状写在处理函数里就够了。
 * 搬进来的判据只有一条：**同一个响应的形状已经在两处以上各写了一遍**。
 * 用量这两个就是——服务端一份、设置页一份、运行面板又一份，三份互不校验，
 * 改一个字段名另外两份不会红。
 *
 * ## 为什么在 core
 *
 * 依赖只能朝底层走，而 `apps/web` 只依赖 `@qywork/core`。放 `store` 或 `server` 里
 * 前端都够不着，于是只能抄。放这里之后，写它的（store）、发它的（server）、
 * 画它的（web）认的是同一份。
 */

import type { UsageBucket, UsageLedgerRow, UsageTotals } from '../domain/model.ts'

/**
 * `GET /api/usage` —— 这台机器最近这些天的账。
 *
 * `workspaceTotals` 单独给一份而不是让前端拿总量自己减：「这台机器」和「这个工作区」
 * 是两个都会被问到的问题，减不出来。
 */
export interface UsageResponse {
  days: number
  /** 区间起点（毫秒）。回给调用方是为了让它知道这份数据覆盖到哪。 */
  since: number
  by: string
  totals: UsageTotals
  rows: UsageBucket[]
  workspaceTotals: UsageTotals
}

/**
 * `GET /api/conversations/:id/usage` —— 这一条会话的**完整**花费。
 *
 * `entries` 逐笔给，不只给合计：合计里含压缩摘要那种不属于任何一轮的开销，
 * 只给合计的话界面上「总数比轮次加起来大」没有出处。
 */
export interface ConversationUsageResponse {
  totals: UsageTotals
  entries: UsageLedgerRow[]
}
