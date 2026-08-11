/**
 * 应用状态。
 *
 * 用 Solid 的 `createStore` 而不是把整个 transcript 塞进一个 signal——
 * 这正是选 Solid 的理由：模型每吐一个 token，只有那一条 step 的 text 字段变化，
 * 只有绑定它的那个文本节点会更新。长会话（几百条 step）下滚动依然不掉帧，
 * 不需要给列表做 memo 化。
 */

import type {
  ActionDescriptor,
  AgentEvent,
  Conversation,
  GitStateEvent,
  RunUsage,
  ServerCapabilities,
  StopReason,
  TodoItem,
  ToolOutcomeWire,
} from '@qywork/core'
import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { type ConnectionState, QyClient } from './client.ts'

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

/** 命令面板开关等纯 UI 状态用 signal，不进 store。 */
export const [paletteOpen, setPaletteOpen] = createSignal(false)

/**
 * 右侧面板当前视图。`null` = 收起。
 *
 * 曾经这里有 `'preview'` 这个合法值，但 `SidePanel` 的 `<Switch>` 里没有对应的
 * `Match`——设成它的结果是面板展开、内容空白。预览现在是「文件」视图的一个子状态
 * （由 `previewPath` 决定），不再是并列的第四个视图：它本来就是从文件树点进去的，
 * 做成并列项会让「返回文件树」没有自然的落点。
 */
export type PanelView = 'files' | 'git' | 'team'
export const [sidePanel, setSidePanel] = createSignal<PanelView | null>(null)

/**
 * 上一次看的视图。
 *
 * 顶栏只有一个按钮负责「展开 / 收起」，展开时要回到用户上次待的地方而不是
 * 一律跳回文件——否则在变更视图里手滑收起，再展开就得重新点一次 tab。
 */
const [lastPanelView, setLastPanelView] = createSignal<PanelView>('files')
export function togglePanel(): void {
  if (sidePanel()) {
    setLastPanelView(sidePanel() as PanelView)
    setSidePanel(null)
  } else {
    setSidePanel(lastPanelView())
  }
}
export function openPanel(view: PanelView): void {
  setLastPanelView(view)
  setSidePanel(view)
}

export const [pairOpen, setPairOpen] = createSignal(false)
export const [settingsOpen, setSettingsOpen] = createSignal(false)
export const [workspaceSheetOpen, setWorkspaceSheetOpen] = createSignal(false)
export const [previewPath, setPreviewPath] = createSignal<string | null>(null)

/** 当前工作区。会话按工作区分表，看不到自己在哪个工作区时数据像是丢了。 */
export interface WorkspaceInfo {
  id: string
  root: string
  name: string
}
export const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null)

export const client = new QyClient({
  onState: (s, detail) => setState({ connection: s, connectionDetail: detail ?? '' }),
  onCapabilities: (caps) => setState('capabilities', caps),
  onResync: () => {
    // 缺口补不上：清空本地投影重新拉，而不是带着一个不完整的 transcript 继续。
    void reloadActiveConversation()
  },
  onEvent: (ev) => applyEvent(ev),
  onRejected: (frame) => setState('notice', { message: frame.message, reason: frame.reason }),
})

function applyEvent(ev: AgentEvent): void {
  switch (ev.type) {
    case 'conversation.updated':
      setState(
        produce((s) => {
          const conv = s.conversations.find((c) => c.id === ev.conversationId)
          if (conv) {
            conv.model = ev.model
            conv.title = ev.title
          }
        }),
      )
      return

    case 'team.member':
      setState(
        produce((s) => {
          // 原地更新而不是追加：同一个成员会连发 spawned → working → done，
          // 追加的话面板上会出现同一个角色的三行。
          const i = s.teamMembers.findIndex((m) => m.memberId === ev.memberId)
          const next: TeamMemberState = {
            memberId: ev.memberId,
            roleName: ev.roleName,
            backend: ev.backend,
            phase: ev.phase,
            ...(ev.summary ? { summary: ev.summary } : {}),
          }
          if (i >= 0) s.teamMembers[i] = next
          else s.teamMembers.push(next)
        }),
      )
      return

    case 'todos':
      // 整表替换而不是合并：工具那边就是整表提交的，
      // 在这里做增量合并会让两端对「计划是什么」产生两种理解。
      setState('todos', ev.todos)
      return

    case 'run.started':
      setState(
        produce((s) => {
          s.running = true
          s.stopReason = null
          s.error = null
          s.notice = null
          s.fileChanges = []
          s.todos = []
          s.teamMembers = []
          s.lastRunId = ev.runId
          // 重试：把被接替那一轮的条目降透明度，而不是清空重来——
          // 清空会让用户失去「上次错在哪」的现场，那正是他点重试的原因。
          //
          // 范围只到**最后一条用户消息之后**：重试复用同一条用户消息，
          // 所以它之后的全部就是被接替的那轮。更早的轮次没有被接替，不能一起变灰；
          // 用户消息本身更不能——它没有被替代，只是被重新回答了一次。
          if (ev.retryOfRunId) {
            let start = s.transcript.length
            while (start > 0 && s.transcript[start - 1]!.kind !== 'user') start--
            for (let i = start; i < s.transcript.length; i++) {
              s.transcript[i]!.superseded = true
            }
          }
        }),
      )
      return

    case 'text.delta':
      setState(
        produce((s) => {
          const last = s.transcript[s.transcript.length - 1]
          // 同一条 text step 持续追加：只改这一个字段，只更新一个文本节点。
          if (last?.kind === 'text' && last.id === ev.stepId) {
            last.text += ev.delta
          } else {
            s.transcript.push({ id: ev.stepId, kind: 'text', text: ev.delta })
          }
        }),
      )
      return

    case 'thinking.delta':
      setState(
        produce((s) => {
          const last = s.transcript[s.transcript.length - 1]
          if (last?.kind === 'thinking') last.text += ev.delta
          else s.transcript.push({ id: `think_${Date.now()}`, kind: 'thinking', text: ev.delta })
        }),
      )
      return

    case 'tool.started':
      setState(
        produce((s) => {
          s.transcript.push({
            id: ev.stepId,
            kind: 'tool',
            text: '',
            toolName: ev.toolName,
            action: ev.action,
            status: 'running',
            batchId: ev.batchId,
            waveIndex: ev.waveIndex,
          })
        }),
      )
      return

    case 'tool.delta':
      setState(
        produce((s) => {
          const item = s.transcript.find((t) => t.id === ev.stepId)
          if (!item) return
          // 只留尾部：一次构建可能吐几万行，全存会把内存和渲染都拖垮。
          const next = (item.stdout ?? '') + ev.delta
          item.stdout = next.length > 8000 ? next.slice(-8000) : next
        }),
      )
      return

    case 'tool.finished':
      setState(
        produce((s) => {
          const item = s.transcript.find((t) => t.id === ev.stepId)
          if (!item) return
          item.status = ev.status === 'success' ? 'success' : 'failure'
          item.outcome = ev.outcome
          item.durationMs = ev.durationMs
        }),
      )
      return

    case 'file.changed':
      setState(
        produce((s) => {
          for (const c of ev.changes) {
            const existing = s.fileChanges.find((f) => f.path === c.path)
            if (existing) {
              existing.additions += c.additions
              existing.deletions += c.deletions
            } else {
              s.fileChanges.push({
                path: c.path,
                additions: c.additions,
                deletions: c.deletions,
                changeType: c.changeType,
              })
            }
          }
        }),
      )
      return

    case 'compaction':
      setState(
        produce((s) => {
          // 压缩是会话管理的可见事件，不能静默发生——用户需要知道
          // 「为什么模型突然不记得前面说过的话了」。
          const existing = s.transcript.find(
            (t) => t.kind === 'compaction' && t.compaction?.phase === 'started',
          )
          if (existing && ev.phase !== 'started') {
            existing.compaction = {
              phase: ev.phase,
              ...(ev.reasonCode ? { reasonCode: ev.reasonCode } : {}),
              ...(ev.manifest
                ? {
                    revision: ev.manifest.revision,
                    compactedMessages: Object.keys(ev.manifest.compactedRunSteps ?? {}).length,
                  }
                : {}),
            }
            return
          }
          s.transcript.push({
            id: `cmp_${Date.now()}`,
            kind: 'compaction',
            text: '',
            compaction: {
              phase: ev.phase,
              ...(ev.reasonCode ? { reasonCode: ev.reasonCode } : {}),
            },
          })
        }),
      )
      return

    case 'usage':
      setState('usage', ev.usage)
      return

    case 'context':
      setState('context', { tokens: ev.tokens, limit: ev.limit, percent: ev.percent })
      return

    case 'git.state':
      setState('git', {
        branch: ev.branch,
        upstream: ev.upstream,
        ahead: ev.ahead,
        behind: ev.behind,
        staged: ev.staged,
        unstaged: ev.unstaged,
        untracked: ev.untracked,
        conflicted: ev.conflicted,
      })
      return

    case 'permission.request':
      setState('permission', {
        requestId: ev.requestId,
        toolName: ev.toolName,
        action: ev.action,
        preview: ev.preview,
        expiresAt: ev.expiresAt,
      })
      return

    case 'permission.resolved':
      setState(
        produce((s) => {
          // 只有当前挂着的那条被消掉；后到的其他 resolved 不该关掉新弹出的请求。
          if (s.permission?.requestId === ev.requestId) s.permission = null
        }),
      )
      return

    case 'run.error':
      setState('error', { code: ev.code, message: ev.message, retryable: ev.retryable })
      return

    case 'run.finished':
      setState(
        produce((s) => {
          s.running = false
          s.stopReason = ev.stopReason
          s.usage = ev.usage
          s.permission = null
        }),
      )
      return

    default:
      return
  }
}

// ───────────────────────── 动作 ─────────────────────────

export async function loadConversations(): Promise<void> {
  const res = await client.api<{ conversations: Conversation[] }>('/api/conversations')
  setState('conversations', res.conversations)
  if (!state.activeConversation && res.conversations[0]) {
    await selectConversation(res.conversations[0].id)
  }
}

export async function selectConversation(id: string): Promise<void> {
  setState({ activeConversation: id, transcript: [], fileChanges: [], error: null })
  client.subscribe([id])
  await reloadActiveConversation()
}

interface StoredMessage {
  id: string
  role: string
  content: string
  createdAt: number
}
interface StoredRun {
  id: string
  userMessageId: string | null
  createdAt: number
  stopReason: string | null
  status: string
  supersededBy: string | null
}
interface StoredStep {
  id: string
  seq: number
  kind: string
  toolName: string | null
  content: string | null
  payload: {
    kind: string
    args?: Record<string, unknown>
    outcome?: any
    action?: ActionDescriptor
  } | null
  status: string
  createdAt: number
}

/**
 * 重建完整会话投影。
 *
 * 必须把 **run 的 steps 也折回来**，而不是只拉 messages——工具调用只存在于 steps 里，
 * 单拉 messages 意味着刷新一次页面就丢掉全部工具卡，用户会以为 agent 什么都没干过。
 *
 * 折叠顺序沿用后端的口径：每条 user 消息之后，插入归属于它的那个 run 的 steps。
 */
async function reloadActiveConversation(): Promise<void> {
  const id = state.activeConversation
  if (!id) return

  const [{ messages }, { runs }] = await Promise.all([
    client.api<{ messages: StoredMessage[] }>(`/api/conversations/${id}/messages`),
    client.api<{ runs: StoredRun[] }>(`/api/conversations/${id}/runs`),
  ])

  // 并行取每个 run 的 steps：串行拉在有几十轮的会话上会明显卡顿。
  const stepsByRun = new Map<string, StoredStep[]>()
  await Promise.all(
    runs.map(async (r) => {
      const { steps } = await client.api<{ steps: StoredStep[] }>(`/api/runs/${r.id}/steps`)
      stepsByRun.set(r.id, steps)
    }),
  )

  const runsByUserMessage = new Map<string, StoredRun[]>()
  for (const r of runs) {
    if (!r.userMessageId) continue
    const list = runsByUserMessage.get(r.userMessageId) ?? []
    list.push(r)
    runsByUserMessage.set(r.userMessageId, list)
  }

  const items: TranscriptItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ id: m.id, kind: 'user', text: m.content })
      for (const r of runsByUserMessage.get(m.id) ?? []) {
        for (const s of stepsByRun.get(r.id) ?? []) {
          const item = stepToItem(s)
          if (item) items.push(r.supersededBy ? { ...item, superseded: true } : item)
        }
      }
    } else if (m.content.trim()) {
      // assistant 兜底消息：steps 里已有 text step 时会重复，
      // 所以只在这一轮没产出任何文本 step 时才补。
      const alreadyHasText = items[items.length - 1]?.kind === 'text'
      if (!alreadyHasText) items.push({ id: m.id, kind: 'text', text: m.content })
    }
  }

  setState('transcript', items)
}

function stepToItem(s: StoredStep): TranscriptItem | null {
  if (s.kind === 'text') {
    return s.content ? { id: s.id, kind: 'text', text: s.content } : null
  }
  if (s.kind === 'tool_action') {
    const outcome = s.payload?.outcome
    // action 来自后端落库的解析结果。存量行（本字段上线前写入的）没有它，
    // 回落成工具名本身——显示成工具名比一律显示「读取」诚实。
    const action = s.payload?.action ?? {
      kind: 'execute' as const,
      objectLabel: s.toolName ?? '',
      target: targetOf(s),
    }
    return {
      id: s.id,
      kind: 'tool',
      text: '',
      toolName: s.toolName ?? '',
      action,
      status: s.status === 'success' ? 'success' : s.status === 'running' ? 'running' : 'failure',
      ...(outcome ? { outcome } : {}),
    }
  }
  return null
}

function targetOf(s: StoredStep): string | null {
  const args = s.payload?.args
  if (!args) return null
  for (const key of ['path', 'file_path', 'pattern', 'command']) {
    const v = args[key]
    if (typeof v === 'string' && v) return v
  }
  return null
}

export async function newConversation(): Promise<void> {
  const { conversation } = await client.api<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  setState('conversations', (c) => [conversation, ...c])
  await selectConversation(conversation.id)
}

export function sendMessage(content: string): void {
  const id = state.activeConversation
  if (!id || !content.trim()) return
  setState(
    produce((s) => {
      // 乐观插入：用户按下回车立刻看到自己的消息，不等服务端回执。
      s.transcript.push({ id: `local_${Date.now()}`, kind: 'user', text: content })
      s.running = true
      s.error = null
    }),
  )
  client.send({
    type: 'message.send',
    clientRequestId: crypto.randomUUID(),
    conversationId: id as never,
    content,
  })
}

/**
 * 中断当前 run。
 *
 * 曾经这里发的是 `transcript.find(status === 'running').id`——那是**步骤 id**，
 * 不是 run id。服务端拿它查 run 查不到，于是静默什么也不做：
 * 中断按钮从来没生效过，而 UI 上完全看不出来。
 * 现在用 `run.started` 事件带回来的真实 runId。
 */
export function interrupt(): void {
  const runId = state.lastRunId
  if (!runId) return
  client.send({ type: 'run.interrupt', runId: runId as never })
}

/**
 * 重试最后一轮。
 *
 * 只在 run 已结束时可用——还在跑的必须先中断，否则两个 run 会同时改同一个工作区。
 * 这个判断服务端也会做一遍（并回 `conflict`），前端这层只是不让按钮白点。
 */
export function retryLastRun(): void {
  const runId = state.lastRunId
  if (!runId || state.running) return
  setState('error', null)
  client.send({
    type: 'run.retry',
    runId: runId as never,
    clientRequestId: crypto.randomUUID(),
  })
}

/**
 * 切换当前会话的模型。
 *
 * 只发指令、不改本地状态：等服务端的 `conversation.updated` 广播回来再更新。
 * 乐观更新在这里是错的——切换可能失败（会话已删），而模型显示错了会直接
 * 导致费用估算和能力预期都对不上。
 */
export function setModel(model: string): void {
  const id = state.activeConversation
  if (!id) return
  client.send({ type: 'conversation.setModel', conversationId: id as never, model })
}

/**
 * 手动压缩当前会话上下文。
 *
 * 与「provider 拒绝后自动压缩」并列的第二条入口。用户在长会话里主动点它，
 * 是为了在下一轮之前先把上下文腾出来，而不是等撞上限。
 *
 * 结果通过 compaction 事件回来（done / failed 都会回），所以这里不做乐观更新。
 */
export function compactContext(): void {
  const id = state.activeConversation
  if (!id || state.running) return
  client.send({ type: 'conversation.compact', conversationId: id as never })
}

export interface TeamMemberState {
  memberId: string
  roleName: string
  backend: string
  phase: 'spawned' | 'working' | 'blocked' | 'done' | 'failed'
  summary?: string
}

export interface TeamInfo {
  backends: string[]
  roles: { id: string; name: string; description: string; backend: string }[]
  plan: { id: string; roleId: string; task: string; needs?: string[] }[]
  error: string | null
}

export function loadTeam(): Promise<TeamInfo> {
  return client.api<TeamInfo>('/api/team')
}

/** 启动一轮编排。目标之外的一切来自工作区的 .qy/team.json —— 配置只有一个来源。 */
export function runTeam(goal: string): void {
  const id = state.activeConversation
  if (!id || state.running) return
  setState(
    produce((s) => {
      s.teamMembers = []
      s.running = true
      s.error = null
    }),
  )
  client.send({
    type: 'team.run',
    conversationId: id as never,
    goal,
    clientRequestId: crypto.randomUUID(),
  })
}

export interface ModelOption {
  id: string
  label: string
  provider: string
  /** false = 内置目录里没有，来自用户自己配的档案（自建端点 / 中转）。 */
  known: boolean
}

/** 模型列表按需拉取：不是每个会话都会点开选择器，没必要开屏就请求。 */
export async function loadModels(): Promise<ModelOption[]> {
  const res = await client.api<{ models: ModelOption[] }>('/api/models')
  return res.models
}

/** 当前会话正在用的模型。会话不存在时返回 null，不编一个默认值糊弄。 */
export function activeModel(): string | null {
  const id = state.activeConversation
  if (!id) return null
  return state.conversations.find((c) => c.id === id)?.model ?? null
}

// ───────────────────────── 配置 ─────────────────────────

/** 档案的对外形状：明文 key 不出服务进程，只回「有没有」。 */
export interface RedactedProfile {
  kind: string
  model: string
  apiKeyEnv?: string
  baseUrl?: string
  maxOutputTokens?: number
  hasApiKey: boolean
  /** 保存时原样回传，避免把 `qy probe` 的实测结果洗掉。 */
  capabilities?: unknown
  headers?: Record<string, string>
}
export interface RedactedConfig {
  active: string
  profiles: Record<string, RedactedProfile>
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  mode?: 'auto' | 'full'
  additionalDirectories?: string[]
  envAllowList?: string[]
  classifierProfile?: string
}
export interface ConfigPayload {
  path: string
  config: RedactedConfig
  notices: string[]
  problems: string[]
}

export function loadServerConfig(): Promise<ConfigPayload> {
  return client.api<ConfigPayload>('/api/config')
}

/**
 * 把 `client.api` 抛出来的错误还原成人能读的一句话。
 *
 * `client.api` 的消息是 `<状态码> <路径>: <响应体前 200 字>`——响应体是 JSON。
 * 原样显示等于把接口细节甩给用户。这里只取其中真正说明原因的字段
 * （`problems` 数组或 `message`），取不到才回落到原文——**回落到原文而不是
 * 一句「操作失败」**：原文再难看也带着信息，泛化的失败提示一点都不带。
 */
export function explainApiError(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  const at = raw.indexOf('{')
  if (at >= 0) {
    try {
      const body = JSON.parse(raw.slice(at)) as { problems?: string[]; message?: string }
      if (body.problems?.length) return body.problems.join('；')
      if (body.message) return body.message
    } catch {
      // 响应体被 client.api 截断到 200 字时会解析失败，走回落。
    }
  }
  return raw || fallback
}

/**
 * 保存配置。
 *
 * 服务端会先 `diagnoseConfig` 再落盘，有致命问题回 422 且**不写**。
 *
 * 422 由 `client.api` 抛成 `Error`，消息形如
 * `422 /api/config: {"error":"invalid","problems":[...]}`——直接显示给用户
 * 是一串原始 JSON。这里把 `problems` 挖出来还原成人话：保存失败必须说清
 * **哪一条**不合格，「保存失败」和一坨 JSON 是同一个层次的不可用。
 */
export async function saveServerConfig(config: RedactedConfig): Promise<ConfigPayload> {
  try {
    await client.api<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    })
  } catch (e) {
    throw new Error(explainApiError(e, '保存失败'))
  }
  return loadServerConfig()
}

export function loadWorkspace(): Promise<WorkspaceInfo> {
  return client.api<WorkspaceInfo>('/api/workspace')
}

/**
 * 本机已知的工作区列表（账本里出现过的）。
 *
 * 用来做「最近打开」——不必每次都开目录选择器翻一遍。
 */
export interface KnownWorkspace {
  id: string
  rootPath: string
  name: string
  lastOpenedAt: number
}
export function loadKnownWorkspaces(): Promise<{ workspaces: KnownWorkspace[]; current: string }> {
  return client.api<{ workspaces: KnownWorkspace[]; current: string }>('/api/workspaces')
}

// ───────────────────────── 插件安装 ─────────────────────────

/**
 * 装一个插件 = 把一个**本机已存在的目录**复制进 `.qy/plugins/`。
 *
 * 没有 registry，所以没有「从市场安装」；也刻意不做 `git clone <任意 URL>`——
 * 那等于「从网上取一段代码，下次加载就跑它」。用户先自己 clone、看过内容，
 * 再把目录指给这里，中间那一步「你看到了自己装的是什么」值这条命令的成本。
 */
export function installPlugin(path: string): Promise<{ ok: boolean; id: string }> {
  return scheduleWrite('/api/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}
export function uninstallPlugin(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ───────────────────────── 桌面外壳 ─────────────────────────

/**
 * 切换工作区需要**换掉整个 sidecar**，而进程管理只有桌面外壳做得到。
 *
 * Web 端（浏览器 / 手机）连的是一个已经起好的服务，它没有、也不该有
 * 重启宿主进程的能力。所以这里如实返回 false，让界面把原因说出来，
 * 而不是给一个点了没反应的按钮——那正是这轮返工要消灭的东西。
 */
export function isDesktopShell(): boolean {
  return typeof (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ === 'object'
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as
    | TauriInternals
    | undefined
  if (!internals) return Promise.reject(new Error('不在桌面端，无法切换工作区'))
  return internals.invoke(cmd, args) as Promise<T>
}

/** 打开系统目录选择器。用户取消时返回 null——取消不是错误。 */
export function pickWorkspace(): Promise<string | null> {
  return tauriInvoke<string | null>('pick_workspace')
}

/**
 * 切到另一个工作区。
 *
 * 成功之后**窗口会被重建**，所以这个 Promise 之后的代码不保证还在跑。
 * 界面上不要在它后面接「切换成功」的提示——那条提示大概率来不及显示。
 */
export function switchWorkspace(path: string): Promise<void> {
  return tauriInvoke<void>('switch_workspace', { path })
}

// ───────────────────────── 定时任务 ─────────────────────────

export interface ScheduleItem {
  id: string
  title: string
  prompt: string
  kind: 'interval' | 'daily'
  everyMinutes?: number
  atHour?: number
  atMinute?: number
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastRunConversationId?: string
  lastError?: string
  nextRunAt: number | null
  due: boolean
}
export interface SchedulesPayload {
  schedules: ScheduleItem[]
  /** 由服务端下发而不是每个客户端各写一遍：这是功能前提，不是补充说明。 */
  runtimeOnly: string
}

export function loadSchedules(): Promise<SchedulesPayload> {
  return client.api<SchedulesPayload>('/api/schedules')
}

async function scheduleWrite<T>(path: string, init: RequestInit): Promise<T> {
  try {
    return await client.api<T>(path, init)
  } catch (e) {
    throw new Error(explainApiError(e, '操作失败'))
  }
}

export function createSchedule(s: Partial<ScheduleItem>): Promise<{ schedule: ScheduleItem }> {
  return scheduleWrite('/api/schedules', { method: 'POST', body: JSON.stringify(s) })
}
export function updateSchedule(
  id: string,
  s: Partial<ScheduleItem>,
): Promise<{ schedule: ScheduleItem }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(s) })
}
export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return scheduleWrite(`/api/schedules/${id}`, { method: 'DELETE' })
}
/** 立刻跑一次。**不推进** lastRunAt——试跑不该顶掉当天的自动触发。 */
export function runScheduleNow(id: string): Promise<{ ok: boolean; conversationId: string }> {
  return scheduleWrite(`/api/schedules/${id}/run`, { method: 'POST' })
}

export interface TeamRaw {
  path: string
  exists: boolean
  raw: string
}
export function loadTeamRaw(): Promise<TeamRaw> {
  return client.api<TeamRaw>('/api/team/raw')
}
export async function saveTeamRaw(raw: string): Promise<{ ok: boolean }> {
  try {
    return await client.api<{ ok: boolean }>('/api/team/raw', {
      method: 'PUT',
      body: JSON.stringify({ raw }),
    })
  } catch (e) {
    throw new Error(explainApiError(e, '保存失败'))
  }
}

export function resolvePermission(granted: boolean, scopeId: string): void {
  const ask = state.permission
  if (!ask) return
  client.send({
    type: 'permission.resolve',
    requestId: ask.requestId,
    granted,
    ...(granted ? { scopeId } : {}),
  })
  setState('permission', null)
}
