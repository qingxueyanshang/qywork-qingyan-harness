/**
 * 应用状态的类型定义与唯一的 store 实例。
 *
 * 使用 Solid 的 `createStore`，而不是把整个 transcript 放入一个 signal：
 * 这是选用 Solid 的原因。模型每输出一个 token，只有对应 step 的 text 字段变化，
 * 只有绑定该字段的文本节点更新。长会话（数百条 step）下滚动仍不掉帧，
 * 无需对列表做 memo 化。
 *
 * 本文件只定义状态结构与 store 实例，不包含业务动作。修改状态的代码见 `connection.ts`
 * （事件驱动）与 `actions.ts`（用户驱动）。
 */

import type {
  ActionDescriptor,
  Attachment,
  ContextBreakdown,
  ContextOmitted,
  Conversation,
  ConversationChangeStep,
  DesktopTargetEvent,
  FileChange,
  FollowUp,
  GitStateEvent,
  Goal,
  NodeState,
  ProviderRequestContentKind,
  RunUsage,
  ServerCapabilities,
  StopReason,
  TodoItem,
  ToolOutcomeWire,
  WorkflowProjection,
} from '@qywork/core'
import { createStore, produce } from 'solid-js/store'
import type { ConnectionState } from '../client.ts'

/**
 * 乐观插入的用户气泡的 id 前缀。
 *
 * 按回车时本地生成，`run.started` 到达后替换为账本中的真实 id。两侧必须使用同一个常量：
 * 对齐判定依据它识别本地插入的条目；两侧各写一份字面量时，只修改其中一侧会使气泡重复为两条。
 */
export const LOCAL_ID_PREFIX = 'local_'

export interface TranscriptItem {
  id: string
  /**
   * `receipt` 是子 agent / workflow 投递回来的消息。它在 wire 上与用户消息同为 user
   * 角色，只能通过 `origin` 字段区分：该字段缺失时才是用户本人输入的消息。
   */
  kind: 'user' | 'receipt' | 'text' | 'tool' | 'thinking' | 'compaction' | 'run'
  text: string
  /**
   * kind='run' 专有：本轮的收尾读数（停止原因、实际用量与耗时）。
   *
   * 它必须是条目，不能读取运行中的 `ConversationView.usage`：后者每条会话只有
   * 一份，下一轮执行完毕时被清空，刷新后只恢复当前运行中的一轮。
   * run 行已逐轮落库（`runs` 表含 usage / stop_reason / created_at /
   * finished_at），投影层据此折叠还原即可。
   */
  run?: {
    runId: string
    stopReason: StopReason | null
    usage: RunUsage | null
    /** 本地时钟。回放历史时用落库的 created_at / finished_at，两者含义相同。 */
    startedAt: number
    /** null = 仍在运行，读数条自行按帧计时。 */
    endedAt: number | null
    /**
     * 报错正文。读数条上的停止原因使用它，为空时回退到停止原因的
     * 通用说法。落库于 `runs.error_message`，因此刷新后仍保留；错误卡是实时的
     * 全局单份状态，重连即丢失，不能作为唯一存储位置。
     */
    errorMessage: string | null
  }
  /** kind='compaction' 专有 */
  compaction?: {
    phase: 'started' | 'done' | 'skipped' | 'failed'
    reasonCode?: string
    /** phase='done' 专有：摘要线是否随之前移；为 false 时只收纳了工具正文。 */
    summarized?: boolean
    compactedMessages?: number
    revision?: number
  }
  /** kind='user' 专有：该消息携带的附件，只保存定位信息，不保存字节。 */
  attachments?: Attachment[]
  /** kind='receipt' 专有：回执的投递方。标题行据此决定移除哪一个来源前缀。 */
  origin?: 'subagent' | 'workflow'
  /** kind='tool' 专有 */
  toolName?: string
  action?: ActionDescriptor
  /**
   * 调用参数。`tool.started` 携带它，`applyEvent` 必须保留：丢弃后工具卡展开时
   * 只有一句 `outcome.message`，而它复述标题行，展开区等于没有内容。
   * 修改的 diff、执行的命令与读取的范围都在其中。
   */
  args?: Record<string, unknown>
  status?: 'running' | 'success' | 'failure'
  outcome?: ToolOutcomeWire
  durationMs?: number
  /** 长时间运行的工具的中途输出 */
  stdout?: string
  /**
   * 派发任务的两个工具专有：卡片上各节点的状态，键为节点 id。流式阶段由 `team.member` 逐个替换，
   * 回放时从 step payload 整体恢复，两者结构相同；绘图只读取该字段。
   */
  nodes?: Record<string, NodeState>
  /**
   * 外部 CLI 节点运行期间的输出（由 `team.output` 累积），键为节点 id。
   * 不落库：刷新后为空，此时显示落库的产出。
   */
  cliOutput?: Record<string, string>
  /** 同一 workflow 的多次 tool step 由 transcript 纯折叠得到的累计视图。 */
  workflow?: WorkflowProjection
  batchId?: string
  waveIndex?: number
}

/** 一次写入，与服务端投影结构相同：三种来源（本会话、子 agent、shell / 外部 CLI）均使用该类型。 */
export type ChangeStep = ConversationChangeStep

/** 一轮中写过文件的调用。键为该轮的用户消息 id，即服务端的 `runs.user_message_id`。 */
export interface ChangeTurn {
  userMessageId: string
  text: string
  origin: 'subagent' | 'workflow' | null
  createdAt: number
  steps: ChangeStep[]
}

/**
 * 变更面板的数据。服务端按写过文件的轮次投影并分页（`/changes`），运行期间由
 * `tool.finished` 的回执追加。`totals` 是整条会话的合计，`paths` 是去重后的路径。
 */
export interface ChangesView {
  /** 最新的轮在前。 */
  turns: ChangeTurn[]
  totals: { paths: string[]; additions: number; deletions: number }
  nextCursor: string | null
  loading: 'initial' | 'older' | null
  error: string | null
}

/**
 * 当前请求投影：本次请求的 id、重发次数、所处阶段与各阶段的时刻。
 *
 * 四个阶段按实际到达的事件推进，只有 `run.request` / `run.retrying` / 内容事件与刷新快照能写入它。
 * `backoff` 与 `sent` 不属于同一次请求：退避结束后 `requestId` 更换为新的一行，
 * 次数保留，供「正在重连 N / M」显示。
 */
export interface RequestProjection {
  requestId: string
  /** 本次故障链内的重发序号，首发 0。 */
  attempt: number
  max: number
  phase: 'backoff' | 'sent' | 'headers' | 'content'
  /** 退避倒计时的截止点；只有 `backoff` 阶段非空。 */
  backoffUntil: number | null
  sentAt: number | null
  headersAt: number | null
  /** 最后一段非空内容到达的时刻，与 `provider_requests.last_content_at` 同一个值。 */
  lastContentAt: number | null
  /** 最近一段内容的类型，供实时事件与刷新快照共用。 */
  lastContentKind: ProviderRequestContentKind | null
  /** 最后一次可见思考或正文的时刻；工具参数增量不推进。 */
  lastVisibleAt: number | null
  /**
   * 写入该投影的事件的序号（快照写入的是其携带的边界）。
   *
   * 先后顺序只按该序号裁决。序号不大于它的事件已折叠在内，予以丢弃；
   * 因此加载期间先到达的新事件不会被较旧的快照覆盖，旧请求的迟到事件也
   * 无法使新请求的阶段回退。
   */
  seq: number
}

/**
 * 一条会话的当前视图。
 *
 * 按会话 id 存放在一张表（`views`）中，当前会话只是其中一个键。右侧面板的页签显示
 * 另一条会话，即派发任务创建的子会话，它与当前会话同时接收事件。使用单例时两条会话的正文
 * 会写入同一个数组，界面上无法区分各段的归属。
 *
 * 表中还存放该会话正在运行的一轮的易失读数。当前会话与右侧子会话同时接收事件，
 * 用量、重试与静默时刻不按会话区分就必然互相覆盖。执行完毕后的终态仍写入 transcript
 * 中的 run 条目，不在此处另存一份。
 */
export interface ConversationView {
  transcript: TranscriptItem[]
  /**
   * 历史 REST 请求的界面状态。正文真源仍是 messages/runs/steps，此处只记录：
   * 是否已读取、请求是否在途、能否继续向前翻页，以及失败后需重试的页。
   */
  history: {
    /** unloaded 表示尚未读取；null 且无错误才表示读取完成。 */
    loading: 'unloaded' | 'initial' | 'older' | null
    nextCursor: string | null
    error: { phase: 'initial' | 'older'; message: string } | null
  }
  /** 变更面板的数据。`null` 表示尚未获取，打开面板时获取。 */
  changes: ChangesView | null
  /**
   * 正在运行的一轮所回复的用户消息。实时到达的变更按它归入轮次，
   * 与服务端 `runs.user_message_id` 是同一个键：两侧的归轮口径必须一致。
   */
  runUserMessageId: string | null
  /**
   * 本轮的开始时刻（本地时钟，毫秒）。`null` 表示未在运行。
   *
   * 取本地收到事件的时刻，不取服务端时间戳：此处表示用户的等待时长，
   * 而不是服务端的计算时长，手机使用蜂窝网络时两者可相差数百毫秒，
   * 而用户参照的是本机时钟。执行完毕后耗时由条目记录，此处清空。
   */
  runStartedAt: number | null
  /** 运行中这一轮的实时用量；收尾后转入 run 条目并清空。 */
  usage: RunUsage | null
  /** 来自 tool.generating；参数尚未接收完整，工具尚未开始执行。 */
  generatingToolCall: boolean
  /**
   * 该会话当前 provider 请求的进度。`null` 表示没有进行中的请求。
   *
   * 阶段、次数、等待截止点与最后内容时刻存放在同一个对象中。拆成并列字段时，
   * 退避结束的事件只能清除其中一个，界面因此同时显示「正在重连 2 / 5」与新请求的
   * 思考内容。实时事件与刷新快照按同一规则写入它，两条路径恢复出相同的状态。
   */
  request: RequestProjection | null
  /**
   * 该会话最近一次报错。
   *
   * 收尾条的报错正文从此处读取，因此它必须按会话存放：使用单例时，子会话的报错
   * 会写入当前会话的收尾条。
   */
  error: { code: string; message: string } | null
}

/** 尚未建表的会话读取到的视图。已冻结，写入一律经由 `openView`。 */
const EMPTY_VIEW: ConversationView = Object.freeze({
  transcript: Object.freeze([]) as unknown as TranscriptItem[],
  history: Object.freeze({ loading: 'unloaded', nextCursor: null, error: null }),
  changes: null,
  runUserMessageId: null,
  runStartedAt: null,
  usage: null,
  generatingToolCall: false,
  request: null,
  error: null,
})

export interface AppState {
  connection: ConnectionState
  connectionDetail: string
  capabilities: ServerCapabilities | null

  conversations: Conversation[]
  activeConversation: string | null

  /**
   * 正在接收事件的会话，按 id 存放。键为当前会话与右侧已打开的子会话页，
   * 与 `client.subscribe` 上报的集合同源（见 `connection.ts` 的订阅集）。
   */
  views: Record<string, ConversationView>
  /**
   * 正在运行的会话 id。全仓只有这一份运行状态记录，当前会话是否在运行由
   * `isRunning()` 从此处派生，不另记布尔值。
   *
   * 记录的是一张表而不是布尔值：左栏需要为列表中的每条会话显示状态，而客户端只订阅
   * 当前会话的事件；布尔值只能表示当前打开的会话，其他会话是否在运行
   * 界面无从得知。该表由工作区级的 `conversation.busy` 事件维护，
   * 快照在握手时下发（`HelloOkFrame.busyConversations`）。
   */
  busyConversations: string[]
  /**
   * 上下文占用。`breakdown` 表示占用的构成，`omitted` 表示被移除的内容。
   * 只有前者时信息不完整：用户看到占用下降，却无法得知下降的来源。
   *
   * 计量来源只在服务端用于诊断，不进入界面状态。
   */
  context: {
    source: 'actual' | 'projected' | 'estimated'
    tokens: number
    limit: number
    percent: number
    /** 超过该值时在下一次发送前执行一次压缩。对应读数条上的刻度线。 */
    compactAt: number
    breakdown: ContextBreakdown
    omitted: ContextOmitted
    /** 本次请求中未计入 `tokens` 的视频段数。非 0 时读数显示「未知」。 */
    unmeasuredVideos: number
  } | null
  /**
   * 当前会话排队中的跟进消息。整表快照语义：`queue.changed` 每次整体替换。
   *
   * 真源在服务端进程内（`RunManager`），此处只是其投影：入队时先乐观添加一条
   * （id 使用 `clientRequestId`，与服务端同源），随后被快照整体覆盖。
   * 不维护本地增量：服务端按 id 去重一条时，两份增量记录必然不一致。
   */
  followUps: FollowUp[]
  /** 当前待办清单。整表快照语义：每次 todos 事件整体替换。 */
  todos: TodoItem[]
  /**
   * 当前目标。同一时刻只有一个，null 表示该会话未设定过目标。
   *
   * 它的生命周期长于 run：一轮执行完毕后自动开始下一轮，依据的就是它。因此既由 `goal` 事件
   * 实时更新，也在重新获取会话时从账本读取；只依赖事件时，刷新后目标不再显示，
   * 而对于不可见的自动循环，用户无从判断它是否仍在运行。
   */
  goal: Goal | null
  /** 当前会话最后一个 run，重试的目标。 */
  lastRunId: string | null
  /**
   * 服务端拒绝指令的提示。
   *
   * 这是 fail-closed 在界面上的体现：拒绝必须可见。只保存最后一条：
   * 连续拒绝时用户需要的是当前被拒绝的原因，而不是历史记录。
   */
  notice: { message: string; reason: string } | null

  /**
   * 工作区文件视图的失效序号。每收到一条 `file.changed` 就递增一次。
   *
   * `fileChanges` 是展示给用户的精确增删摘要，不能用其长度兼作刷新信号：
   * `run_command` / 格式化器只能确认可能修改了文件，无法列出路径。
   * 该值不描述磁盘内容，只表示上一份文件快照已过期。
   */
  fileVersion: number
  /**
   * 画布卡片运行状态的变化序号。每收到一条本项目的 `canvas.run` 就递增一次，已打开的画布页签据此重新读取；
   * 卡片状态与失败原文以画布读取接口的响应为准，此处不另存一份。
   */
  canvasVersion: number
  /** 本轮的每一次写入，按到达顺序排列；净效果由 `foldFileChanges` 折叠计算，与变更页口径相同。 */
  fileChanges: FileChange[]
  git: Omit<GitStateEvent, 'type'> | null
  /**
   * 服务端桌面占用快照，带所属会话。保留后台会话的目标，切回时立即可读。
   *
   * `null` 表示没有执行者占用桌面目标。服务端在执行者释放与宿主断开时都会推送 `null`，
   * 前端不自行推断超时并清空：否则前后端各存一份判定。
   */
  desktopTarget: DesktopTargetEvent['target']
}

const initial: AppState = {
  connection: 'connecting',
  connectionDetail: '',
  capabilities: null,
  conversations: [],
  activeConversation: null,
  views: {},
  busyConversations: [],
  context: null,
  fileVersion: 0,
  canvasVersion: 0,
  fileChanges: [],
  git: null,
  desktopTarget: null,
  followUps: [],
  todos: [],
  goal: null,
  lastRunId: null,
  notice: null,
}

export const [state, setState] = createStore<AppState>(initial)

/**
 * 指定会话的当前视图。尚未建表的会话返回冻结的空视图，因此调用点无需各自编写
 * `?? []`；遗漏一处即导致整个界面白屏。
 */
export function viewOf(id: string | null): ConversationView {
  return (id && state.views[id]) || EMPTY_VIEW
}

/** 当前会话的视图。界面上绝大多数位置使用它。 */
export function view(): ConversationView {
  return viewOf(state.activeConversation)
}

/** 当前会话的正文流。 */
export function transcript(): TranscriptItem[] {
  return view().transcript
}

/**
 * 为一条会话建表（幂等）。开始接收其事件之前必须先建表：
 * 表中没有该会话时，事件整帧丢弃（见 `connection.ts` 的归属判定）。
 */
export function openView(id: string): void {
  if (state.views[id]) return
  setState('views', id, {
    transcript: [],
    history: { loading: 'unloaded', nextCursor: null, error: null },
    changes: null,
    runUserMessageId: null,
    runStartedAt: null,
    usage: null,
    generatingToolCall: false,
    request: null,
    error: null,
  })
}

/**
 * 移除一条会话的表：已切换离开的会话，或已关闭的子会话页。
 *
 * 不保留：执行过数百步的会话在表中有数百个条目，保留会使每打开一次子会话页
 * 就多占用一份内存，而重新打开时仍需按 id 重新获取。
 */
export function dropView(id: string): void {
  if (!state.views[id]) return
  // 必须使用 `produce` + `delete`：store 的对象写入是合并语义，
  // 传入缺少该键的新对象不会删除该键，对应的正文会保留在原处。
  setState(
    'views',
    produce((all) => {
      delete all[id]
    }),
  )
}

/**
 * 当前会话是否在运行。这是派生值，真源是 `busyConversations`。
 *
 * 不要为它添加 store 字段：乐观设置的布尔值与服务端维护的表之间以哪个为准，
 * 只能依赖每个写入点自行保证，这构成第二本账。
 */
export function isRunning(): boolean {
  return isConversationRunning(state.activeConversation)
}

/** 任意一条已打开会话的忙闲状态；父子页共用服务端的同一张权威表。 */
export function isConversationRunning(id: string | null): boolean {
  return id !== null && state.busyConversations.includes(id)
}

/** 当前会话的桌面目标。占用权仍由服务端裁决，切换会话只改变读数归属。 */
export function activeDesktopTarget(): DesktopTargetEvent['target'] {
  const target = state.desktopTarget
  return target?.conversationId === state.activeConversation ? target : null
}

/**
 * 本轮是否显示整轮状态条：存在未完成的待办、本轮修改过文件，或正在操作某个桌面应用。
 *
 * 判据放在此处而不是组件中：`RunStatus` 据此决定是否挂载，`Transcript` 据此决定
 * 底部留白高度，两处使用同一判据。
 */
export function hasRunStatus(): boolean {
  return (
    isRunning() &&
    view().runStartedAt !== null &&
    (state.todos.some((t) => t.status !== 'completed') ||
      state.fileChanges.length > 0 ||
      activeDesktopTarget() !== null)
  )
}

/**
 * 指定会话的运行中读数是否已交接给会话流中的终态条目。
 *
 * `conversation.busy=false` 比 `run.finished` 晚一帧到达；在此期间若只按忙态挂载
 * `LiveRunBar`，流尾会同时出现完成条与运行条。另一方面，不能再要求
 * `runStartedAt !== null`：较晚打开的子会话可能未收到瞬时的 run.started，而服务端
 * 的 RunManager 已明确报告其为忙，此时隐藏状态条会丢弃权威状态。
 *
 * 实时收尾与历史重建均由本会话的开始时间和末条终态判断。
 * 新一轮开始时会设置开始时间，用户发送消息会追加用户条目，两者均不应沿用上一轮的终态。
 */
export function conversationRunClosed(id: string | null): boolean {
  const items = viewOf(id).transcript
  return viewOf(id).runStartedAt === null && items[items.length - 1]?.kind === 'run'
}

/**
 * 输入框上方是否存在附加块：整轮状态条 / 目标条 / 排队中的跟进消息。
 *
 * 会话流底部的留白据此确定。下方紧邻附加块时贴近该块，间距与输入框上方
 * 各块之间的间距相同；下方直接是输入框时需为正文留出较大间距。
 * 两者相差一个量级，使用同一个值会使一种情况过窄、另一种情况过宽。
 */
export function composerStackAbove(): boolean {
  return (
    hasRunStatus() ||
    state.followUps.length > 0 ||
    (state.goal !== null && state.goal.status !== 'completed')
  )
}

/** 主会话与子会话共用收尾判据；lastRunId 在仅有后台子任务时重建为 null。 */
export function runClosed(): boolean {
  return conversationRunClosed(state.activeConversation)
}

/**
 * 当前会话是否有一轮在运行。
 *
 * 发送消息是否排队只由它判定，不由忙闲状态判定：忙态包含运行中的子 agent，而服务端的判据是
 * 是否存在 run（`runs.hasRun`）。乐观队列卡与卡上的档位标签必须读取同一判据，
 * 各写一份必然出现界面显示排队、而服务端已开始新一轮的不一致。
 */
export function hasRun(): boolean {
  return isRunning() && !runClosed()
}

/**
 * 该会话账本的当前进度。只用作需要重新获取的信号，不用于显示。
 *
 * 运行面板显示账本的当前状态，而账本在一轮之内持续变化：每落库一步
 * `runs.step_count` 加一，provider 每次回报 usage 都会更新金额并新增一行逐请求记录。
 * 重新获取的判据只包含会话与忙闲时，该轮执行完毕之前面板停留在开始执行时的快照。
 *
 * 四个分量各对应一类落库：`lastRunId` 与忙闲对 `runs` 行的起止，
 * `transcript.length` 对 `steps` 行（一条 step 一个条目），
 * `usage.turns.length` 对 provider 的每次 usage 回报。
 * 不要改用当前请求投影的内容时刻：它每到达一帧就变化一次，会使重新获取的频率升至 token 级别。
 */
export function ledgerRevision(): string {
  const marks = [
    state.lastRunId ?? '',
    isRunning() ? '1' : '0',
    transcript().length,
    view().usage?.turns.length ?? 0,
  ]
  return marks.join(':')
}

/** 记录或清除会话的运行状态。幂等，重复到达的忙闲事件不会写入两行。 */
function markBusy(id: string, busy: boolean): void {
  setState('busyConversations', (list) =>
    busy ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id),
  )
}

/**
 * 按回车时乐观设置的忙态：会话 id → 设置该忙态的 `message.send` 的 `clientRequestId`。
 *
 * 这不是第二份忙闲记录：忙闲状态仍只有 `busyConversations` 一张表，此处只记录
 * 各乐观忙态由哪条指令设置。指令被拒时服务端从未置忙，不会有 `conversation.busy` 来冲销它，
 * 因此冲销时必须识别对应的指令：收到任何拒绝即置闲，会清除该会话实际正在运行的一轮的忙态。
 *
 * 乐观忙态只保留到服务端写入该会话的忙闲状态为止（`settleBusy` / `syncBusy`），此后以服务端为准。
 */
const prepaidBusy = new Map<string, string>()

/**
 * 乐观置忙：用户按下回车，界面立刻进入执行态，不等服务端回执。
 *
 * 会话已在运行时不记录：该忙态由服务端写入，即使本条指令被拒也不应修改它。
 */
export function prepayBusy(id: string, requestId: string): void {
  if (!isConversationRunning(id)) prepaidBusy.set(id, requestId)
  markBusy(id, true)
}

/** 服务端已裁决该会话的忙闲状态。乐观忙态到此结束，此后到达的拒绝回执不再冲销它。 */
export function settleBusy(id: string, busy: boolean): void {
  prepaidBusy.delete(id)
  markBusy(id, busy)
}

/** 握手快照：服务端当前的全部忙态，整表替换，全部乐观忙态随之作废。 */
export function syncBusy(ids: readonly string[]): void {
  prepaidBusy.clear()
  setState('busyConversations', [...ids])
}

/**
 * 指令被拒时，冲销它设置的乐观忙态。
 *
 * 按 `clientRequestId` 匹配，无法匹配时不做修改：未携带该键的指令（`followup.steer`、
 * `conversation.interrupt`）被拒时，会话中运行的是其他轮次。
 */
export function refundBusy(requestId: string | undefined): void {
  if (!requestId) return
  for (const [id, prepaid] of prepaidBusy) {
    if (prepaid !== requestId) continue
    prepaidBusy.delete(id)
    markBusy(id, false)
    return
  }
}
