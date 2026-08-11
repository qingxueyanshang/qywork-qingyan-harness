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
  Conversation,
  GitStateEvent,
  RunUsage,
  ServerCapabilities,
  StopReason,
  TodoItem,
  ToolOutcomeWire,
} from '@qywork/core'
import { createStore } from 'solid-js/store'
import type { ConnectionState } from '../client.ts'

export interface TranscriptItem {
  id: string
  kind: 'user' | 'text' | 'tool' | 'thinking' | 'compaction'
  text: string
  /** kind='compaction' 专有 */
  compaction?: {
    phase: 'started' | 'done' | 'failed'
    reasonCode?: string
    compactedMessages?: number
    revision?: number
  }
  /** kind='tool' 专有 */
  toolName?: string
  action?: ActionDescriptor
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
  expiresAt: number
}

export interface AppState {
  connection: ConnectionState
  connectionDetail: string
  capabilities: ServerCapabilities | null

  conversations: Conversation[]
  activeConversation: string | null

  transcript: TranscriptItem[]
  running: boolean
  stopReason: StopReason | null
  usage: RunUsage | null
  context: { tokens: number; limit: number; percent: number } | null
  /** 当前计划清单。整表快照语义——每次 todos 事件整体替换。 */
  todos: TodoItem[]
  /** Agent Team 成员进展。按 memberId 去重、原地更新。 */
  teamMembers: TeamMemberState[]
  /** 当前会话最后一个 run，重试的目标。 */
  lastRunId: string | null
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
  conversations: [],
  activeConversation: null,
  transcript: [],
  running: false,
  stopReason: null,
  usage: null,
  context: null,
  fileChanges: [],
  git: null,
  permission: null,
  error: null,
  todos: [],
  teamMembers: [],
  lastRunId: null,
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
}
