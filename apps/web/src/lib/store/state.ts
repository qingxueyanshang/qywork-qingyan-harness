/**
 * 应用状态的形状与那一份 store。
 *
 * 用 Solid 的 `createStore` 而不是把整个 transcript 塞进一个 signal——
 * 这正是选 Solid 的理由：模型每产出一个 token，只有那一条 step 的 text 字段变化，
 * 只有绑定它的那个文本节点会更新。长会话（几百条 step）下滚动依然不掉帧，
 * 不需要给列表做 memo 化。
 *
 * **这里只有形状和那一份实例，没有任何动作。** 谁改它见 `connection.ts`
 * （事件驱动）与 `actions.ts`（用户驱动）。
 */

import type {
  ActionDescriptor,
  Attachment,
  ContextBreakdown,
  ContextOmitted,
  Conversation,
  FollowUp,
  GitStateEvent,
  Goal,
  RunUsage,
  ServerCapabilities,
  StopReason,
  TodoItem,
  ToolOutcomeWire,
  WorkflowProjection,
} from '@qywork/core'
import { createStore, produce } from 'solid-js/store'
import type { ConnectionState } from '../client.ts'

export interface TranscriptItem {
  id: string
  kind: 'user' | 'text' | 'tool' | 'thinking' | 'compaction' | 'run'
  text: string
  /**
   * kind='run' 专有：这一轮的收尾读数（停止原因 + 真实用量 + 耗时）。
   *
   * **它必须是条目，不能是全局状态。** 挂在 `state.usage` / `state.stopReason`
   * 那几个全局字段上的话，整个会话只有一份：第二轮跑完把第一轮冲掉，刷新一次全没。
   * 而 run 行本来就逐轮落库（`runs` 表带 usage / stop_reason / created_at /
   * finished_at），投影层照着折回来即可。
   */
  run?: {
    runId: string
    stopReason: StopReason | null
    usage: RunUsage | null
    /** 本地时钟。回放历史时用落库的 created_at / finished_at，两者含义相同。 */
    startedAt: number
    /** null = 还在跑，读数条自己按帧走。 */
    endedAt: number | null
    /**
     * 报错正文。**读数条上「为什么停」那一格就用它**，没有才回落到停止原因的
     * 通用说法。落库在 `runs.error_message`，所以刷新之后还在——错误卡是活的
     * 全局单份状态，重连即丢，不能拿它当唯一落点。
     */
    errorMessage: string | null
  }
  /** kind='compaction' 专有 */
  compaction?: {
    phase: 'started' | 'done' | 'skipped' | 'failed'
    reasonCode?: string
    /** phase='done' 专有：摘要线跟着前移了，还是只收纳了工具正文。 */
    summarized?: boolean
    compactedMessages?: number
    revision?: number
  }
  /** kind='user' 专有：这条消息带的附件，只存定位事实不存字节。 */
  attachments?: Attachment[]
  /** kind='tool' 专有 */
  toolName?: string
  action?: ActionDescriptor
  /**
   * 调用参数。`tool.started` 带着它，`applyEvent` 必须留下：丢掉的话工具卡展开后
   * 只剩一句 `outcome.message`，那句话是标题行的复述，等于「展开了什么也没有」。
   * 改的 diff、跑的命令、读的范围全在这里面。
   */
  args?: Record<string, unknown>
  status?: 'running' | 'success' | 'failure'
  outcome?: ToolOutcomeWire
  durationMs?: number
  /** 长工具的中途输出 */
  stdout?: string
  /**
   * 派活那两个工具专有：这张图现在跑到哪了。派一件时只有一格。
   *
   * **流式期间来自事件，回放时另有来源。** 进度事件不落库，所以刷新之后
   * 这个字段是空的：一张图由 workflow transition 纯折叠重画，一次派活由那条
   * step 自己的状态与耗时重画——各管一段，不互相兜底。
   */
  nodes?: WorkflowNodeState[]
  /** 同一 workflow 的多次 tool step 由 transcript 纯折叠得到的累计视图。 */
  workflow?: WorkflowProjection
  /**
   * 运行中的内置子 agent 会话入口。切换会话后的回放从 step payload 恢复；工具收尾后
   * 同一个值在 outcome.data.conversationId，两个阶段只会有一个入口。
   */
  childConversationId?: string
  batchId?: string
  waveIndex?: number
}

/** 图卡上的一个节点。 */
export interface WorkflowNodeState {
  nodeId: string
  /** 派给谁：角色 id 或 `cli:<id>`。 */
  agent: string
  /** 显示用的名字：角色名或「厂商 + CLI 名」。 */
  label: string
  phase: 'spawned' | 'working' | 'done' | 'failed' | 'skipped'
  /** done/failed 时那一段产出的开头，卡上只显示这一截。 */
  summary?: string
  /** 点开看它那条会话。外部 CLI 没有子会话，这个字段缺席。 */
  conversationId?: string
  /**
   * 外部 CLI 节点运行期间写出来的输出（`team.output` 攒起来的）。
   *
   * **只有外部 CLI 有**：内置子 agent 的过程在它那条子会话里。**不落库**，
   * 刷新之后这里是空的，那时看的是落库的终态产出——与图卡的状态同一条口径。
   */
  output?: string
  durationMs?: number
}

/**
 * 一条会话此刻的样子。
 *
 * **按会话 id 存一张表（`views`），当前会话只是其中一个键。** 右侧面板那一页看的是
 * 另一条会话——派活起的子会话，它和当前会话同时在收事件。单例的时候两条会话的正文
 * 会写进同一个数组，而界面上没有任何地方说得出哪一段是谁的。
 *
 * 表里只放**这条会话是什么**，不放运行读数。子会话页除了 transcript 也显示它自己的
 * 待办，所以清单跟会话 id 存；用量、上下文、目标、跟进队列仍只有当前会话消费者，
 * 不在这里复制。
 */
export interface ConversationView {
  transcript: TranscriptItem[]
  /** 这条会话自己的待办投影；子会话页只读展示，绝不混进父会话的全局面板。 */
  todos: TodoItem[]
  /**
   * 历史 REST 的纯界面态。正文真源仍是 messages/runs/steps，这里只回答：
   * 请求在不在飞、还能不能往前翻、失败后该重试哪一页。
   */
  history: {
    loading: 'initial' | 'older' | null
    nextCursor: string | null
    error: { phase: 'initial' | 'older'; message: string } | null
  }
  /**
   * 这一轮什么时候开始的（本地时钟，毫秒）。`null` = 没在跑。
   *
   * **取本地收到事件的时刻，不取服务端时间戳**：这里要回答的是用户等待时长，
   * 而不是服务端计算时长，两者在手机走蜂窝网时能差出好几百毫秒，
   * 而用户看的是本机时钟。跑完之后耗时归条目管，这里清空。
   */
  runStartedAt: number | null
  /**
   * 这条会话最后一次报错。
   *
   * 收尾条的报错正文从这里取，所以它必须跟着会话走：单例的话，子会话报的错
   * 会写进当前会话的收尾条。
   */
  error: { code: string; message: string } | null
}

/** 一条还没建过表的会话读到的那份。冻结，写点一律经 `openView`。 */
const EMPTY_VIEW: ConversationView = Object.freeze({
  transcript: Object.freeze([]) as unknown as TranscriptItem[],
  todos: Object.freeze([]) as unknown as TodoItem[],
  history: Object.freeze({ loading: null, nextCursor: null, error: null }),
  runStartedAt: null,
  error: null,
})

export interface AppState {
  connection: ConnectionState
  connectionDetail: string
  capabilities: ServerCapabilities | null

  conversations: Conversation[]
  activeConversation: string | null

  /**
   * 收着事件的那几条会话，按 id。键 = 当前会话 + 右侧开着的那几页子会话，
   * 与 `client.subscribe` 报上去的那一组同源（见 `connection.ts` 的订阅集）。
   */
  views: Record<string, ConversationView>
  /**
   * 正在跑的会话 id。**「谁在跑」全仓只有这一份账**，当前那条在不在跑由
   * `isRunning()` 从这里派生，不另记一个布尔。
   *
   * 记的是**一张表而不是一个布尔**：左栏要为列表里每一条画状态，而客户端只订阅
   * 当前会话的事件——布尔只答得了当前打开的这条，别的会话在跑与否，
   * 界面上无从得知。这张表由工作区级的 `conversation.busy` 事件维持，
   * 快照在握手里给（`HelloOkFrame.busyConversations`）。
   */
  busyConversations: string[]
  /**
   * 运行中那一轮的实时用量。**只在运行期有意义**——跑完由 `run.finished`
   * 落进那一轮的条目里，这里清空。收尾读数不再有第二份全局账。
   */
  usage: RunUsage | null
  /**
   * 上下文占用。`breakdown` 回答「被谁占的」，`omitted` 回答「什么被拿掉了」——
   * 只有前者是半张账：用户看到占用下降却不知道降在哪里。
   *
   * `source` 必须显示出来。总数是实测还是估算，直接决定这个数字能不能拿来做决定。
   */
  context: {
    tokens: number
    limit: number
    percent: number
    source: 'actual' | 'projected' | 'estimated'
    /** 越过它就会在下一次发送前压一次。读数条上那道刻度。 */
    compactAt: number
    breakdown: ContextBreakdown
    omitted: ContextOmitted
  } | null
  /**
   * 当前会话排着的跟进消息。整表快照语义——`queue.changed` 每次整体替换。
   *
   * 真源在服务端进程内（`RunManager`），这里只是它的投影：入队时先乐观加一条
   * （id 用 `clientRequestId`，与服务端同源），随后被快照整体覆盖。
   * 不维护本地增量——两份增量账在「服务端按 id 去重掉一条」时必然分叉。
   */
  followUps: FollowUp[]
  /** 当前待办清单。整表快照语义——每次 todos 事件整体替换。 */
  todos: TodoItem[]
  /**
   * 当前目标。**同时只有一个**，null = 这条会话没立过目标。
   *
   * 它比 run 活得久：一轮跑完自动再起一轮就是照着它跑的。所以既由 `goal` 事件
   * 实时更新，也在重拉会话时从账本读回来——只靠事件的话刷新一次就看不见了，
   * 而看不见的自动循环，用户无从判断它还在不在跑。
   */
  goal: Goal | null
  /** 当前会话最后一个 run，重试的目标。 */
  lastRunId: string | null
  /**
   * 这一轮最后一次收到事件的时刻（本地时钟，毫秒）。
   *
   * 它与 `ConversationView.runStartedAt` 回答的是两件事：那个说「这轮跑了多久」，这个说
   * 「多久没动静了」。**只有后者能区分「还在想」和「链路断了」**——实测一次断流里
   * 服务端 262 秒一个字节都没收到，而界面靠总耗时只能显示一个越走越大的数字，
   * 配着一句「正在思考…」，两者都没说出真相。
   *
   * 不需要新协议字段：每一帧的到达时刻，客户端本地就有。
   */
  lastEventAt: number | null
  /**
   * 正在原样重发第几次，以及上限。`null` = 没在重发。
   *
   * **纯显示态，真源在服务端**（`agent/loop.ts` 的尝试循环）。上限也由事件带过来，
   * 不在前端写第二份。它由新那次的第一条输出收场，收场判据只有 `connection.ts`
   * 入口那一处——散到各 case 里就是三十次忘记清的机会。
   */
  retry: { attempt: number; max: number } | null
  /**
   * 服务端拒绝指令的提示。
   *
   * 这是 fail-closed 在 UI 上的落点：拒绝必须被看见。只存最后一条——
   * 连续拒绝时用户需要的是「现在为什么不行」，不是一份历史。
   */
  notice: { message: string; reason: string } | null

  fileChanges: { path: string; additions: number; deletions: number; changeType: string }[]
  git: Omit<GitStateEvent, 'type'> | null
}

const initial: AppState = {
  connection: 'connecting',
  connectionDetail: '',
  capabilities: null,
  conversations: [],
  activeConversation: null,
  views: {},
  busyConversations: [],
  usage: null,
  context: null,
  fileChanges: [],
  git: null,
  followUps: [],
  todos: [],
  goal: null,
  lastRunId: null,
  lastEventAt: null,
  retry: null,
  notice: null,
}

export const [state, setState] = createStore<AppState>(initial)

/**
 * 某条会话此刻的样子。没建过表的回那份冻结的空视图——调用点因此不必各写一遍
 * `?? []`，而漏写一次的表现是整个界面白屏。
 */
export function viewOf(id: string | null): ConversationView {
  return (id && state.views[id]) || EMPTY_VIEW
}

/** 当前会话那一份。界面上绝大多数地方要的是这个。 */
export function view(): ConversationView {
  return viewOf(state.activeConversation)
}

/** 当前会话的正文流。 */
export function transcript(): TranscriptItem[] {
  return view().transcript
}

/**
 * 建一条会话的表（幂等）。**开始收它的事件之前必须先建**：
 * 表里没有这一条时事件整帧丢弃（见 `connection.ts` 的归属判定）。
 */
export function openView(id: string): void {
  if (state.views[id]) return
  setState('views', id, {
    transcript: [],
    todos: [],
    history: { loading: null, nextCursor: null, error: null },
    runStartedAt: null,
    error: null,
  })
}

/**
 * 撤掉一条会话的表：切走的那条、关掉的那一页子会话。
 *
 * **不留着**：一条跑过几百步的会话在表里就是几百个条目，留着等于每开一次子会话页
 * 就多占一份，而再打开时本来就要按 id 重拉一次。
 */
export function dropView(id: string): void {
  if (!state.views[id]) return
  // 必须 `produce` + `delete`：store 的对象写点是**合并**语义，
  // 交回一个少了这个键的新对象不会把它删掉，那一份正文会原地留着。
  setState(
    'views',
    produce((all) => {
      delete all[id]
    }),
  )
}

/**
 * 当前会话在不在跑。**派生量**——真源是 `busyConversations`。
 *
 * 不要为它加一个 store 字段：一个乐观置上去的布尔和一张服务端维持的表，
 * 谁盖过谁只能靠每个写点自觉，那就是第二本账。
 */
export function isRunning(): boolean {
  const id = state.activeConversation
  return id !== null && state.busyConversations.includes(id)
}

/**
 * 整轮状态条这一轮挂不挂：有没做完的待办，或这一轮改过文件。
 *
 * 判据放在这里而不是组件里：`RunStatus` 按它决定挂不挂，`Transcript` 按它决定
 * 底部留多少白，两处是同一个判据。
 */
export function hasRunStatus(): boolean {
  return (
    isRunning() &&
    view().runStartedAt !== null &&
    (state.todos.some((t) => t.status !== 'completed') || state.fileChanges.length > 0)
  )
}

/**
 * 输入框上方除了输入框自己还挂着块：整轮状态条 / 目标条 / 排着的跟进消息。
 *
 * 会话流底部那段留白按它给。下面紧挨着一个块时贴住它——那一段是输入框上方
 * 这一列的缝，与块之间的缝同宽；下面直接是输入框时要留出正文的呼吸，
 * 两者差着一个量级，用同一个数会一头挤一头空。
 */
export function composerStackAbove(): boolean {
  return (
    hasRunStatus() ||
    state.followUps.length > 0 ||
    (state.goal !== null && state.goal.status !== 'completed')
  )
}

/**
 * 这一轮的收尾条已经落到流尾了。
 *
 * 收尾走两帧：`run.finished` 落下收尾条并把实时读数交接给它，随后
 * `conversation.busy` 才把这条会话放闲。只按 `isRunning()` 判活的那条读数条，
 * 中间那一帧里流尾同时挂着刚落下的收尾条和一条读数已经交接完的空壳。
 * 那一帧会被画出来：`run.finished` 这个任务里连带跑了正文的定稿重渲染
 * （33KB 实测 7.8ms），帧边界大概率就落在它之后。
 *
 * 按 runId 认，不按「末条是不是 run」认：重试时被接替那一轮的收尾条就在流尾，
 * 而新那一轮真的在跑。
 */
export function runClosed(): boolean {
  const t = transcript()
  const last = t[t.length - 1]
  return last?.kind === 'run' && last.run?.runId === state.lastRunId
}

/**
 * 这条会话的账本走到哪儿了。**只当「该重取了」的信号用，不是要显示的数。**
 *
 * 运行面板画的是账本此刻的样子，而账本在一轮之内一直在变：每落一步
 * `runs.step_count` 加一，每次 provider 回报 usage 就改一次金额、多一行逐请求记录。
 * 重取判据只报会话与忙闲的话，那一轮跑完之前面板停在开跑那一刻的快照上。
 *
 * 四个分量各对应一类落库：`lastRunId` 与忙闲对 `runs` 行的起止，
 * `transcript.length` 对 `steps` 行（一条 step 一个条目），
 * `usage.turns.length` 对 provider 的每次 usage 回报。
 * 不要换成 `lastEventAt`：它每来一帧就动一次，等于把重取拉到 token 频率。
 */
export function ledgerRevision(): string {
  const marks = [
    state.lastRunId ?? '',
    isRunning() ? '1' : '0',
    transcript().length,
    state.usage?.turns.length ?? 0,
  ]
  return marks.join(':')
}

/**
 * 这个文件被这一轮改过多少。**同样只当「该重取了」的信号用。**
 *
 * 主区打开的文件要跟着 agent 的改动重取，判据只报路径的话内容停在打开那一刻。
 * 取累计而不是 `fileChanges.length`：同一个文件改第二次是原地累加
 * （见 `applyEvent` 的 `file.changed` 分支），条目数不动。
 *
 * 边界：只认写类工具回报的改动，shell 里 sed 改的文件不在里面（同变更页）。
 */
export function fileRevision(path: string): string {
  const c = state.fileChanges.find((f) => f.path === path)
  return c ? `${c.additions}+${c.deletions}` : ''
}

/** 记下 / 抹掉「这条会话在跑」。幂等，重复到达的忙闲事件不会写出两行。 */
export function markBusy(id: string, busy: boolean): void {
  setState('busyConversations', (list) =>
    busy ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id),
  )
}
