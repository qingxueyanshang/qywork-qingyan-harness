/**
 * HTTP 响应契约。
 *
 * 此处只放服务端与前端共同依赖的响应结构。服务端有一百多个 `json(...)`，绝大多数只有一个
 * 消费者，结构写在处理函数中即可。移入此处的判据只有一条：同一个响应的结构已在两处以上分别定义。
 * 两个用量响应即属此类：服务端、设置页、运行面板各有一份，三份互不校验，修改一个字段名时
 * 另外两份不会报类型错误。
 *
 * 放在 core 的原因：依赖只能指向底层，而 `apps/web` 只依赖 `@qywork/core`。放在 `store` 或 `server`
 * 中前端无法引用，只能复制定义。放在此处后，写入方（store）、发送方（server）、渲染方（web）
 * 使用同一份定义。
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
 * `GET /api/conversations/:id/history`：会话流中一页完整轮次。
 *
 * 一页以用户消息为边界：`messages` 是选中的用户消息，`runs` 与 `steps` 是它们名下的
 * 完整记录（助手回复与工具记录都在 steps 中），因此翻页不会把一轮工具调用从中间截断。
 * `nextCursor` 是下一页的排他上界；null 表示已到最早一页。
 *
 * `todos` 不构成独立的第二份状态，只是服务端由同一批 steps 记录投影出的当前快照。
 * 它必须随首屏一并返回：最新一次 `write_todos` 可能早于当前页，前端不能为查找它
 * 而加载全部历史。
 */
export interface ConversationHistoryPage {
  messages: Message[]
  runs: Run[]
  steps: Step[]
  todos: TodoItem[]
  /**
   * 本页中的续接调用所引用、但不在本页的 workflow 首次派发 step。
   * 图的结构只存在于首次派发的参数中，缺少它时无法渲染该卡片；该 step 自身的行由折叠隐藏。
   */
  workflowStarts: Step[]
  nextCursor: MessageId | null
}

export interface ConversationHistoryPageResponse extends ConversationHistoryPage {
  /**
   * 会话当前正在运行的轮次与请求；没有运行中的 run 时为 null。
   *
   * 落库账本无法回答当前请求处于哪一阶段，而事件环容量有限，长时间断线后无法补发，
   * 因此刷新只能从此处恢复。该字段由服务端从 RunManager 的当前 run 与同一份请求账
   * 实时读取，不是第二份状态：每个字段都能在 `provider_requests` 的对应行中找到来源。
   */
  live: ConversationLiveSnapshot | null
}

/** 运行中轮次的只读快照。 */
export interface ConversationLiveSnapshot {
  runId: string
  /**
   * 生成快照时事件总线的序号。
   *
   * 客户端据此判定先后：序号更大的实时事件比快照新，不得被快照覆盖；
   * 序号不大于该值的迟到事件已包含在快照中，直接丢弃。
   */
  seq: number
  /** 本轮最近一次主请求；尚未登记任何请求时为 null。 */
  request: LiveRequestSnapshot | null
}

/** 最近一次主请求（`purpose='turn'`）在账本中的记录。 */
export interface LiveRequestSnapshot {
  requestId: string
  /** 本次故障链内的重发序号，首发为 0。与 `run.request` 口径相同。 */
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
   * 仅在本次请求已失败且下一次尚未发出时非空。
   */
  backoffUntil: number | null
}

/**
 * `GET /api/conversations/:id/changes?before&limit`：会话修改过的文件，按轮次分页。
 *
 * 与 `todos` 同类：服务端由 steps 记录投影出的视图，不构成独立的第二份状态。
 * 不并入历史页：历史页按完整用户轮次分页，一页中可能没有写入任何文件，变更面板
 * 若用它翻页，会把整段会话流连同 Markdown 一并加载到主区。此处按写入过文件的轮次分页，
 * 未写入文件的轮次在查询中直接跳过。`before` 与历史页相同，为用户消息 id、排他上界。
 *
 * `totals` 是整条会话的合计，不是本页的合计：每一轮的写入先经 `foldFileChanges` 折叠为
 * 净效果再相加，与界面各行使用同一个折叠函数；两侧分别折叠时，先创建后删除的文件
 * 会从行中消失，却仍计入表头的数字。`paths` 返回去重后的路径而不只返回数量：
 * 实时追加一条变更时，客户端需判断该路径是否已计入，仅有数量无法判断。
 */
export interface ConversationChangesPageResponse {
  /** 最新的轮次在前。 */
  turns: ConversationChangeTurn[]
  totals: { paths: string[]; additions: number; deletions: number }
  nextCursor: MessageId | null
}

export interface ConversationChangeTurn {
  userMessageId: MessageId
  text: string
  origin: 'subagent' | 'workflow' | null
  createdAt: number
  /** 本轮中的每一次写入，按发生顺序排列。 */
  steps: ConversationChangeStep[]
}

/**
 * 一次写入。三种来源使用同一结构：
 * - 本会话的文件类工具：`via` 为 null，`args` 是该步骤的调用参数（正文取自其中）；
 * - 内置子 agent 的文件类工具：来自子会话的 step，`via` 是该子 agent；
 * - shell 与外部 CLI：来自工作区观察器，`fileChanges` 不含行数；外部 CLI 的 `via` 是对应节点。
 */
export interface ConversationChangeStep {
  id: string
  toolName: string
  args?: Record<string, unknown>
  fileChanges: FileChange[]
  via: { name: string } | null
}

/**
 * `GET /api/usage`：本机最近若干天的用量。
 *
 * `workspaceTotals` 单独返回，而不由前端用总量自行相减：本机合计与当前工作区合计
 * 是两个都会被查询的问题，无法相减得出。
 */
export interface UsageResponse {
  days: number
  /** 区间起点（毫秒）。返回给调用方，以表明数据的覆盖范围。 */
  since: number
  by: string
  totals: UsageTotals
  rows: UsageBucket[]
  workspaceTotals: UsageTotals
}

/**
 * `GET /api/conversations/:id/usage`：单个会话的完整花费。
 *
 * `entries` 逐笔返回，而不只返回合计：合计中包含压缩摘要等不属于任何轮次的开销，
 * 只返回合计时，界面上总数大于各轮之和的差额无从解释。
 */
/**
 * 会话的轮次。子会话的轮次单独列出：它们不属于该会话的对话流，
 * 但计入同一笔花费，运行页需将其并入同一份清单与合计。
 */
export interface ConversationRunsResponse {
  runs: Run[]
  /** 子会话的轮次。`name` 是对应子 agent 的名称（子会话标题），三种子 agent 规则相同。 */
  childRuns: { name: string; run: Run }[]
}

export interface ConversationUsageResponse {
  totals: UsageTotals
  entries: UsageLedgerRow[]
}
