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
  FileChange,
  Message,
  ProviderRequestContentKind,
  ProviderRequestStatus,
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
 * `todos` 不构成独立的第二份状态，仅是服务端由同一批 steps 记录投影出的当前快照。
 * 它必须随首屏一起回：最新一次 `write_todos` 可能早于当前页，前端不能为了找它
 * 又把全部历史拉一遍。
 */
export interface ConversationHistoryPage {
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

export interface ConversationHistoryPageResponse extends ConversationHistoryPage {
  /**
   * 这条会话此刻正在跑的那一轮与那一次请求；没有在跑的 run 时为 null。
   *
   * 落库账本答不了「当前请求走到哪一阶段」，而事件环有界、断线久了补不回来，
   * 所以刷新只能从这里恢复。它由服务端从 RunManager 的当前 run 与同一份请求账
   * 现取，**不是第二份状态**：每个字段都能在 `provider_requests` 那一行里找到来源。
   */
  live: ConversationLiveSnapshot | null
}

/** 运行中这一轮的只读快照。 */
export interface ConversationLiveSnapshot {
  runId: string
  /**
   * 取快照那一刻事件总线的序号。
   *
   * 客户端按它裁决先后：序号更大的实时事件已经比这份快照新，不许被它覆盖回去；
   * 序号不大于它的迟到事件属于快照已经包含的那一段，丢弃。
   */
  seq: number
  /** 这一轮最近一次主请求；一次都还没登记时为 null。 */
  request: LiveRequestSnapshot | null
}

/** 最近一次主请求（`purpose='turn'`）在账本里的样子。 */
export interface LiveRequestSnapshot {
  requestId: string
  /** 本次故障链内的重发序号，首发 0。与 `run.request` 同一口径。 */
  attempt: number
  max: number
  status: ProviderRequestStatus
  sentAt: number | null
  headersAt: number | null
  firstContentAt: number | null
  lastContentAt: number | null
  lastContentKind: ProviderRequestContentKind | null
  lastVisibleAt: number | null
  /**
   * 退避倒计时的截止点（等待开始时刻 + 退避时长）。
   * 只有「这一次已失败且下一次尚未发出」时才非空。
   */
  backoffUntil: number | null
}

/**
 * `GET /api/conversations/:id/changes?before&limit` —— 这条会话改过的文件，按轮分页。
 *
 * 与 `todos` 同一类：服务端由 steps 记录投影出的视图，不构成独立的第二份状态。
 * 不塞进历史页：历史页按完整用户轮次分页，一页里可能一个文件都没写，变更面板
 * 拿它翻页会把整段会话流连同 Markdown 一起挂进主区。这里按「写过文件的轮」分页，
 * 没写文件的轮在查询里直接跳过。`before` 与历史页同为用户消息 id、排他上界。
 *
 * `totals` 是整条会话的合计，不是这一页的：每一轮的写入先经 `foldFileChanges` 折成
 * 净效果再相加，与界面上那些行折的是同一个函数——两边各折一次的话，建了又删的那些
 * 文件会从行里消失、却还留在表头的数里。`paths` 给去重后的路径而不只给个数：
 * 实时追加一条变更时，客户端要判断这个路径是否已经计入，只有个数无从判断。
 */
export interface ConversationChangesPageResponse {
  /** 最新的轮在前。 */
  turns: ConversationChangeTurn[]
  totals: { paths: string[]; additions: number; deletions: number }
  nextCursor: MessageId | null
}

export interface ConversationChangeTurn {
  userMessageId: MessageId
  text: string
  origin: 'subagent' | 'workflow' | null
  createdAt: number
  /** 这一轮里的每一次写入，按发生先后。 */
  steps: ConversationChangeStep[]
}

/**
 * 一次写入。三种来源同一形状：
 * - 本会话的文件类工具：`via` 为 null，`args` 是那一步的调用参数（正文从它来）；
 * - 内置子 agent 的文件类工具：来自子会话的 step，`via` 是那个子 agent；
 * - shell 与外部 CLI：来自工作区观察器，`fileChanges` 不带行数；外部 CLI 的 `via` 是那个节点。
 */
export interface ConversationChangeStep {
  id: string
  toolName: string
  args?: Record<string, unknown>
  fileChanges: FileChange[]
  via: { name: string } | null
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
