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

import type { MessageId, ProviderRequestId, RunId } from '../domain/ids.ts'
import type { MediaOutput, MediaUnit, UnitPrice } from '../domain/media.ts'
import type {
  ContextBreakdown,
  ContextGroup,
  ContextOmitted,
  Currency,
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
import type { CacheMissAttribution } from '../domain/monitor/cache-miss.ts'

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
   * 会话当前正在运行的轮次与请求。
   *
   * 落库账本无法回答当前请求处于哪一阶段，而事件环容量有限，长时间断线后无法补发，
   * 因此刷新只能从此处恢复。该字段由服务端从 RunManager 的当前 run 与同一份请求账
   * 实时读取，不是第二份状态：每个字段都能在 `provider_requests` 的对应行中找到来源。
   */
  live: ConversationLiveSnapshot
}

/** 会话运行状态的只读快照。没有运行中的轮次时 `runId` 为 null，序号照常携带。 */
export interface ConversationLiveSnapshot {
  runId: string | null
  /**
   * 生成快照时事件总线的序号。
   *
   * 客户端据此判定先后：序号更大的实时事件比快照新，不得被快照覆盖；
   * 序号不大于该值的迟到事件已包含在快照中，直接丢弃。「没有运行中的轮次」同样按序号裁决：
   * 历史请求在途期间新一轮开始时，该快照比已收到的 `run.started` 旧。
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
  /** 上次失败的分类说明，从同一故障链的请求诊断恢复。 */
  retryReason?: string | null
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
  origin: 'subagent' | 'workflow' | 'command' | null
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
 * `GET /api/cloud/state`：云端账号状态。`unavailable` 表示未配置云端服务，界面不显示账号入口。
 * `provider` 是配置中云端接口的名称：模型设置页据此不提供它的编辑与删除，移除只经退出。
 */
export type CloudState =
  | { state: 'unavailable' }
  | { state: 'signed_out'; reason?: 'revoked' }
  | {
      state: 'signed_in'
      email: string
      /**
       * 用户名：只用于显示，可以重名，不用于登录；未设置时为空字符串，界面此时显示邮箱。
       * 云端暂时无法访问时为本设备上一次取得的值。
       */
      name: string
      credits: number | null
      /** 头像的 data URL；未设置或云端暂时无法访问时为 null。 */
      avatar: string | null
      provider: string
      /** 云端地址：账号窗口据此打开官网首页。 */
      origin: string
      /** 云端已开通微信支付充值；false 时账号窗口不显示「充值」。云端暂时无法访问时为 false。 */
      recharge: boolean
      /**
       * 本账号读到的最新一条公告的 id，保存在云端账号上，官网与各台电脑读写同一个值；没有记录时为 null。
       * 云端暂时无法访问时为本设备上一次取得的值；本次运行中从未取得时缺省，界面不据此判定未读。
       */
      announcementSeen?: string | null
    }

/** `POST /api/cloud/recharge`：一笔充值订单。1 元充值 1 积分。 */
export interface CloudRechargeOrder {
  orderNo: string
  /** 付款码的内容，界面据此绘制二维码。 */
  codeUrl: string
  /** 金额（元），等于到账的积分。 */
  amount: number
  expiresAt: string
}

/** `GET /api/cloud/recharge/:orderNo`：pending 待支付，paid 已到账，expired 付款码已过期。 */
export type CloudRechargeStatus = 'pending' | 'paid' | 'expired'

/**
 * `GET /api/cloud/release-notes?version=`：云端为该版本发布的版本公告。没有、已撤回或未配置云端时为 null。
 * `body` 是 Markdown。
 */
export interface ReleaseNotes {
  version: string
  title: string
  body: string
  publishedAt: string
}

/**
 * `GET /api/cloud/announcements`：云端已发布的公告，新者在前，与官网顶栏的公告相同。未配置云端时为空数组。
 * `body` 是 Markdown。
 */
export interface Announcement {
  id: string
  /** release 版本更新，notice 通知。 */
  kind: 'release' | 'notice'
  /** 版本公告的版本号；通知为 null。 */
  version: string | null
  title: string
  body: string
  publishedAt: string
}

/**
 * `GET /api/cloud/usage`：云端统计的本账号用量。token 四项与云端计费口径相同：输入不含缓存命中与缓存写入。
 */
export interface CloudUsage {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 累计消耗的积分。 */
  credits: number
  /** 近 53 周中有请求的日期（`YYYY-MM-DD`，按电脑所在时区分日），升序。 */
  days: { day: string; requests: number; tokens: number; credits: number }[]
}

/**
 * `GET /api/cloud/models`：云端当前提供的型号。对话型号为售价倍率与单价（基础档乘以倍率），单位为积分 / 百万 token，
 * 云端未定价时为 null；生成型号为计费单位与单价（积分 / 单位），可按分辨率档位分别定价。
 */
export type CloudModel =
  | {
      output: 'chat'
      id: string
      ratio: number
      /** true：售价为官方价乘以倍率；false：售价为后台填写的单价乘以倍率，界面不列出倍率。 */
      official: boolean
      price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
    }
  | {
      output: MediaOutput
      id: string
      unit: MediaUnit
      unitPrice: UnitPrice
    }

/** `GET /api/cloud/requests`：云端的一条请求记录，按时间倒序分页。 */
export interface CloudRequest {
  id: string
  /** 余额不大于 0 时云端在读取请求之前拒绝，型号未知，为 null。 */
  modelId: string | null
  /** 失败原因（如「429 请求过多」「连接中断」）；成功为 null。 */
  failure: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 缓存写入中按 1 小时档计价的部分。 */
  cacheWrite1hTokens: number
  /** 按长上下文档计价。 */
  longContext: boolean
  /** 按空闲时段的折扣价计价。 */
  offPeak: boolean
  /** 生成任务的计量：张数、秒数、次数或万字符，按分辨率计价时带档位；对话请求为 null，token 四项为 0。 */
  mediaMeter: { units: number; unit: MediaUnit; resolution?: string } | null
  /** 本次扣除的积分。 */
  credits: number
  startedAt: string
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

/**
 * `GET /api/conversations/:id/requests[?after=<请求编号>]`：本会话的主请求序列，即逐请求趋势所需的部分。
 * 用量、各阶段时刻、工具耗时与金额在 `/request-details`，两者按 `id` 对应。不要合为一个响应：
 * 合并后每行约 800 字节，一千三百次请求的会话整段读取即超过 1 MB。
 *
 * 只含本会话自身轮次的主请求：摘要请求不发送会话上下文，子会话各是一个会话，均不在其中。
 * 带 `after` 时 `requests` 是该请求之后的行，`compactions` 是创建时刻晚于该请求创建时刻的记录，
 * 内容与整段读取的对应部分相同；客户端删去本地序列中该请求之后的部分再追加。
 * `tools` 每次都是整个会话的合计。
 */
export interface ConversationRequestsResponse {
  /** 按创建顺序排列。 */
  requests: MonitorRequest[]
  /** 已改写 manifest 的压缩记录，按创建时刻排列。 */
  compactions: MonitorCompaction[]
  tools: ToolCallTotal[]
}

/** 一次主请求。 */
export interface MonitorRequest {
  id: ProviderRequestId
  runId: RunId
  turnIndex: number
  retryIndex: number
  status: ProviderRequestStatus
  /** 请求行的创建时刻。压缩记录位于创建时刻不早于它的第一条请求之前，与 `cacheMiss` 的判据相同。 */
  createdAt: number
  /**
   * 对账后的分组占用。总数在有用量时为「输入 + 命中 + 写入」，没有用量时为发出时的运行中读数，
   * 此时 `estimated` 为 true。消息条目重建与界面各处使用同一结果。
   */
  breakdown: ContextBreakdown
  estimated: boolean
  /** 本次请求所在轮次的压缩触发线；早于该字段的旧行为 null。 */
  compactAt: number | null
  /** 缓存未命中归因；没有用量或未回报命中量时为 null。 */
  cacheMiss: CacheMissAttribution | null
}

/**
 * `GET /api/conversations/:id/request-details[?after=<请求编号>]`：本会话主请求的明细，
 * 行与 `/requests` 的 `requests` 逐条对应，`after` 的含义相同。
 */
export interface ConversationRequestDetailsResponse {
  details: MonitorRequestDetail[]
}

export interface MonitorRequestDetail {
  id: ProviderRequestId
  sentAt: number | null
  headersAt: number | null
  firstContentAt: number | null
  completedAt: number | null
  /** 上游回报的用量；未回报时为 null。其中的 null 表示上游未回报该项，不表示 0。 */
  usage: {
    input: number
    output: number
    cached: number | null
    cacheWrite: number | null
    /** 缓存写入中按 1 小时档写入的部分。 */
    cacheWrite1h: number | null
  } | null
  omitted: ContextOmitted
  /** 本次请求所产生批次的工具执行时长（毫秒），同一波次取最长一次；没有已记录时长的调用时为 null。 */
  toolMs: number | null
  /** 金额。只在带用量且状态为 `received` 的行上有值；该轮的用量账中没有对应记录时为 null。 */
  cost: { amount: number; currency: Currency } | null
}

/**
 * `GET /api/requests/:id/items`：一次主请求的消息条目。摘要请求返回 422。
 *
 * 条目不逐请求保存，按账本的现状重建，一律是估算值：取该请求发出之前已存在的单元，按其前最近一次改写
 * manifest 的压缩记录的两条边界判定每个单元是原文、已收纳还是已被摘要替代（后者不列出），逐条估算后
 * 按 `breakdown` 等比对齐。待办清单、附件文件、摘要正文、媒体缩放与推理剥离取的是读取时的状态，
 * 不是该请求发出时的状态。
 */
export interface RequestItemsResponse {
  requestId: ProviderRequestId
  /** 与 `/requests` 中该请求的 `breakdown`、`estimated` 相同。 */
  breakdown: ContextBreakdown
  estimated: boolean
  /**
   * 覆盖该请求的压缩记录带边界，或该请求之前没有压缩。为 false 时（早于边界字段的旧记录之后的请求）
   * `items` 只含信封条目，消息部分只有 `breakdown` 的分组合计。
   */
  boundaryKnown: boolean
  /** 摘要分组只有分组合计，没有条目；信封明细缺失时信封分组同样只有分组合计。 */
  items: RequestItem[]
  /** 与上一次主请求的条目差；没有上一次请求或任一方的边界未知时为 null。 */
  diff: { added: RequestItem[]; removed: RequestItem[] } | null
  /** 本轮的用户消息，取开头一段。 */
  userMessage: string | null
  /** 这次新进入的内容：`diff.added` 中各消息的名称，取开头一段。 */
  entered: string | null
  /** 这次的回复：本请求产生的正文，取开头一段；只调用了工具时为 null。 */
  reply: string | null
}

/** 一个条目：一条消息在一个分组中的部分，或一项信封明细。工具结果分为执行记录与工具结果正文两个条目。 */
export interface RequestItem {
  /** 同一内容在相邻请求中相同，新增与移除按它比较。 */
  id: string
  group: ContextGroup
  /** 消息条目所属的会话消息与单元戳；信封条目为 null。 */
  messageId: MessageId | null
  step: string | null
  /** 信封条目为 null。 */
  role: 'user' | 'assistant' | 'tool' | 'context' | null
  /** `condensed` 表示该单元位于收纳线以内，工具正文已替换为信封。 */
  state: 'raw' | 'condensed'
  /** 工具名，或正文开头的一段；系统提示词为 null。 */
  label: string | null
  /** 估算值，已按比例对齐到 `breakdown` 中所在分组的值。 */
  tokens: number
}

/** 一次改写了 manifest 的压缩。 */
export interface MonitorCompaction {
  createdAt: number
  /** 早于该字段的旧记录为 null。 */
  trigger: 'manual' | 'automatic' | 'overflow' | null
  /** 摘要线随之前移。 */
  summarized: boolean
  /** 压缩前占用；旧记录为 null。 */
  occupancy: number | null
  /** 压缩后占用，与 `occupancy` 同一口径；旧记录为 null。 */
  occupancyAfter: number | null
}

/** 本会话一个工具的调用次数与累计执行时长。 */
export interface ToolCallTotal {
  toolName: string
  /** 调用次数，含运行中与被中断的调用。 */
  calls: number
  /**
   * 已记录时长的调用的执行时长之和（毫秒），同一波次的并行调用分别计入。
   * 运行中与被中断的调用没有时长，不计入本项。
   */
  durationMs: number
}
