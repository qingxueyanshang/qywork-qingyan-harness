/**
 * 应用状态的形状与那一份 store。
 *
 * 用 Solid 的 `createStore` 而不是把整个 transcript 塞进一个 signal——
 * 这正是选 Solid 的理由：模型每吐一个 token，只有那一条 step 的 text 字段变化，
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
  GitStateEvent,
  PermissionScope,
  RunUsage,
  ServerCapabilities,
  StopReason,
  TodoItem,
  ToolOutcomeWire,
} from '@qywork/core'
import { createStore } from 'solid-js/store'
import type { ConnectionState } from '../client.ts'
import type { WorkspaceExtensions } from './settings.ts'

export interface TranscriptItem {
  id: string
  kind: 'user' | 'text' | 'tool' | 'thinking' | 'compaction' | 'run'
  text: string
  /**
   * kind='run' 专有：这一轮的收尾读数（停止原因 + 真实用量 + 耗时）。
   *
   * **它必须是条目，不能是全局状态。** 读数条原来读的是 `state.usage` /
   * `state.stopReason` 那几个全局字段，于是整个会话只有一份：第二轮跑完把第一轮
   * 冲掉，刷新一次全没。而 run 行本来就逐轮落库（`runs` 表带 usage / stop_reason /
   * created_at / finished_at），投影层只是从来没把它折回来。
   */
  run?: {
    runId: string
    stopReason: StopReason | null
    usage: RunUsage | null
    /** 本地时钟。回放历史时用落库的 created_at / finished_at，两者含义相同。 */
    startedAt: number
    /** null = 还在跑，读数条自己按帧走。 */
    endedAt: number | null
  }
  /** kind='compaction' 专有 */
  compaction?: {
    phase: 'started' | 'done' | 'failed'
    reasonCode?: string
    compactedMessages?: number
    revision?: number
  }
  /** kind='user' 专有：这条消息带的附件，只存定位事实不存字节。 */
  attachments?: Attachment[]
  /** kind='tool' 专有 */
  toolName?: string
  action?: ActionDescriptor
  /**
   * 调用参数。`tool.started` 早就带着它，但之前在 `applyEvent` 里被丢掉了——
   * 于是工具卡展开后只剩一句 `outcome.message`，那句话是标题行的复述，
   * 等于「展开了什么也没有」。改的 diff、跑的命令、读的范围全在这里面。
   */
  args?: Record<string, unknown>
  status?: 'running' | 'success' | 'failure'
  outcome?: ToolOutcomeWire
  durationMs?: number
  /** 长工具的中途输出 */
  stdout?: string
  batchId?: string
  waveIndex?: number
  /**
   * 该条目属于一个已被重试接替的 run。
   *
   * 这些步骤是**真实发生过的历史**（文件真的改了、命令真的跑了），所以照常完整
   * 渲染，只整段降透明度表达「已被接替」。折叠或隐藏它们会让用户看不到那次失败
   * 到底做了什么，而排查问题恰恰需要这段。
   */
  superseded?: boolean
}

export interface PermissionAsk {
  requestId: string
  toolName: string
  action: ActionDescriptor
  preview: string
  /** 可授予的范围，**由服务端给**。界面照它渲染按钮，不自己列一套。 */
  scopes: PermissionScope[]
  expiresAt: number
}

export interface AppState {
  connection: ConnectionState
  connectionDetail: string
  capabilities: ServerCapabilities | null
  /** 当前项目上装了什么。**按项目拉**（`/api/capabilities?ws=`），不来自握手。 */
  extensions: WorkspaceExtensions | null

  conversations: Conversation[]
  activeConversation: string | null

  transcript: TranscriptItem[]
  running: boolean
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
    source: 'actual' | 'estimated'
    breakdown: ContextBreakdown
    omitted: ContextOmitted
  } | null
  /** 当前待办清单。整表快照语义——每次 todos 事件整体替换。 */
  todos: TodoItem[]
  /** Agent Team 成员进展。按 memberId 去重、原地更新。 */
  teamMembers: TeamMemberState[]
  /** 当前会话最后一个 run，重试的目标。 */
  lastRunId: string | null
  /**
   * 运行中那一轮的开始时刻（本地时钟，毫秒）。
   *
   * **取本地收到事件的时刻，不取服务端时间戳**：这里要回答的是「我等了多久」，
   * 而不是「服务端算了多久」，两者在手机走蜂窝网时能差出好几百毫秒，
   * 而用户看的是自己那块表。跑完之后耗时归条目管，这里清空。
   */
  runStartedAt: number | null
  /**
   * 服务端拒绝指令的提示。
   *
   * 这是 fail-closed 在 UI 上的落点：拒绝必须被看见。只存最后一条——
   * 连续拒绝时用户需要的是「现在为什么不行」，不是一份历史。
   */
  notice: { message: string; reason: string } | null

  fileChanges: { path: string; additions: number; deletions: number; changeType: string }[]
  git: Omit<GitStateEvent, 'type'> | null

  permission: PermissionAsk | null
  error: { code: string; message: string; retryable: boolean } | null
}

const initial: AppState = {
  connection: 'connecting',
  connectionDetail: '',
  capabilities: null,
  extensions: null,
  conversations: [],
  activeConversation: null,
  transcript: [],
  running: false,
  usage: null,
  context: null,
  fileChanges: [],
  git: null,
  permission: null,
  error: null,
  todos: [],
  teamMembers: [],
  lastRunId: null,
  runStartedAt: null,
  notice: null,
}

export const [state, setState] = createStore<AppState>(initial)

/** team 运行时的成员状态。事件驱动写入，所以和 store 的形状放在一起。 */
export interface TeamMemberState {
  memberId: string
  roleName: string
  backend: string
  phase: 'spawned' | 'working' | 'blocked' | 'done' | 'failed'
  summary?: string
  /** 成员自己那条子会话。只有内置后端有——CLI 后端跑在进程外，没有会话。 */
  childConversationId?: string
}
