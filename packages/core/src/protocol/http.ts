/**
 * HTTP 响应契约。
 *
 * **这里只放**两边都要认**的那几个。** 服务端有一百多个 `json(...)`，它们绝大多数只有一个消费者，形
 * 状写在处理函数里就够了。搬进来的判据只有一条：**同一个响应的形状已经在两处以上各写了一遍**。用
 * 量这两个就是——服务端一份、设置页一份、运行面板又一份，三份互不校验，改一个字段名另外两份不会
 * 红。
 *
 * **为什么在 core。** 依赖只能朝底层走，而 `apps/web` 只依赖 `@qywork/core`。放 `store` 或 `server`
 * 里前端都够不着，因此只能抄。放这里之后，写它的（store）、发它的（server）、画它的（web）认的是
 * 同一份。
 */

import type { MessageId } from '../domain/ids.ts'
import type {
  Message,
  Run,
  Step,
  TodoItem,
  UsageBucket,
  UsageLedgerRow,
  UsageTotals,
} from '../domain/model.ts'

/**
 * `GET /api/conversations/:id/history` —— 会话流的一页完整轮次。
 *
 * 一页以 user message 为边界：`messages` 会包含所选用户消息之间的 assistant
 * 兜底消息，`runs` 与 `steps` 则是这些用户消息名下的完整事实。这样翻页不会把
 * 一轮工具调用从中间劈开。`nextCursor` 是下一页的排他上界；null = 已到最早。
 *
 * `todos` 不是第二本账，只是服务端从同一批 steps 账本里投影出的当前快照。
 * 它必须随首屏一起回：最新一次 `write_todos` 可能早于当前页，前端不能为了找它
 * 又把全部历史拉一遍。
 */
export interface ConversationHistoryPageResponse {
  messages: Message[]
  runs: Run[]
  steps: Step[]
  todos: TodoItem[]
  /**
   * 这一页里的续接调用所引用、却不在这一页的 workflow 首派 step。
   * 图的形状只在首派参数里，少了它那张卡画不出来；它自己那一行由折叠藏起来。
   */
  workflowStarts: Step[]
  nextCursor: MessageId | null
}

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
/**
 * 一条会话的轮次。**子会话的轮次单列**：它们不属于这条会话的对话流，
 * 但花的是同一笔钱，运行页要把它们并进同一份清单与合计。
 */
export interface ConversationRunsResponse {
  runs: Run[]
  /** 子会话的轮次。`name` 是那个子 agent 的名字（子会话标题），三种子 agent 同一条规则。 */
  childRuns: { name: string; run: Run }[]
}

export interface ConversationUsageResponse {
  totals: UsageTotals
  entries: UsageLedgerRow[]
}
