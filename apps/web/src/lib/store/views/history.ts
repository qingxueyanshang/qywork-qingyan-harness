/**
 * 会话流的读取：按页读取账本并折叠进视图（子会话页的首页、更早的分页），当前会话的整段重载，
 * 以及两类加载失败共用的重试入口。
 */

import type {
  BackgroundCommand,
  ContextBreakdown,
  ContextOmitted,
  ConversationHistoryPageResponse,
  ConversationLiveSnapshot,
  FollowUp,
  Goal,
  Message,
  Run,
  Step,
} from '@qywork/core'
import { isNoticeStep } from '@qywork/core'
import { produce } from 'solid-js/store'
import { client } from '../client.ts'
import { report } from '../client-log.ts'
import { discardPace } from '../events/pace.ts'
import {
  type ConversationView,
  openView,
  type RequestProjection,
  setState,
  state,
  type TranscriptItem,
} from '../state.ts'

/** `GET /api/conversations/:id/context` 的响应体，结构与 runtime 的 `ContextPanel` 相同。 */
interface StoredContextPanel {
  source: 'actual' | 'projected' | 'estimated'
  total: number
  limit: number
  percent: number
  compactAt: number
  breakdown: ContextBreakdown
  omitted: ContextOmitted
}

/** 一条会话的三类落库事实：消息、run、每个 run 的 steps。 */
interface Folded {
  messages: Message[]
  runs: Run[]
  stepsByRun: Map<string, Step[]>
}

interface HistoryPage extends Folded {
  todos: ConversationHistoryPageResponse['todos']
  /** 本页引用但不在本页中的 workflow 首次派发，见 `ConversationHistoryPageResponse`。 */
  workflowStarts: Step[]
  earlierTurns: ConversationHistoryPageResponse['earlierTurns']
  nextCursor: string | null
  /** 运行状态与当前请求的只读快照；没有 run 运行时 `runId` 为 null。 */
  live: ConversationLiveSnapshot
}

/**
 * 把刷新快照折叠为投影。阶段由时刻派生，四条判据与实时事件一一对应：
 * 有退避截止点表示等待重试，有内容时刻表示正在输出内容，有响应头表示等待内容，其余表示刚发出。
 *
 * 已失败且不在等待重试的请求不生成投影。它是本轮最后一次请求，
 * 重发预算已耗尽，显示「正在请求」与事实不符；收尾条随后连同停止原因写入会话流。
 */
function projectLive(live: ConversationLiveSnapshot): RequestProjection | null {
  const r = live.request
  if (!r) return null
  if ((r.status === 'rejected' || r.status === 'uncertain') && r.backoffUntil === null) return null
  const phase =
    r.backoffUntil !== null
      ? 'backoff'
      : r.lastContentAt !== null
        ? 'content'
        : r.headersAt !== null
          ? 'headers'
          : 'sent'
  return {
    requestId: r.requestId,
    attempt: r.attempt,
    max: r.max,
    recovering: r.recovering,
    retryReason: r.retryReason ?? null,
    phase,
    backoffUntil: r.backoffUntil,
    sentAt: r.sentAt,
    headersAt: r.headersAt,
    lastContentAt: r.lastContentAt,
    lastContentKind: r.lastContentKind ?? null,
    lastVisibleAt: r.lastVisibleAt ?? null,
  }
}

/**
 * 把快照写入一条会话的实时读数，返回轮次身份是否写入。
 *
 * 请求进度与轮次身份分别按 `liveSeq` 与 `runSeq` 裁决，序号小于对应序号的部分不写入：
 * 加载期间先到达的实时事件比它新，其中包括「没有运行中的轮次」的快照之后才到达的 `run.started`。
 *
 * 运行中的轮次只取快照的 `runId`（服务端 `RunManager` 的当前轮次），不按 runs 行的状态列推断：
 * 服务进程崩溃后账本中的行可能仍处于 `running`。快照所指的仍是视图已在跟踪的那一轮时，
 * 保留已记录的开始时刻与已收到的用量。
 */
function restoreLive(
  v: ConversationView,
  live: ConversationLiveSnapshot,
  runs: readonly Run[],
): boolean {
  const row = live.runId ? (runs.find((r) => r.id === live.runId) ?? null) : null
  const same = live.runId !== null && v.runId === live.runId
  if (live.seq >= v.liveSeq) {
    v.liveSeq = live.seq
    v.usage = same ? v.usage : (row?.usage ?? null)
    v.request = live.runId ? projectLive(live) : null
    v.generatingToolCall = v.request?.lastContentKind === 'tool_arguments'
  }
  if (live.seq < v.runSeq) return false
  v.runSeq = live.seq
  v.runId = live.runId
  // 账本中的开始时刻取服务端时钟，换算为本机时刻后才与本机时钟比较。
  v.runStartedAt = same ? v.runStartedAt : row ? client.localTime(row.createdAt) : null
  v.runUserMessageId = same ? v.runUserMessageId : (row?.userMessageId ?? null)
  return true
}

/** 将一页折叠为会话流：首次派发先进入会话流，其自身的行由 workflow 折叠隐藏，只用于完整渲染 workflow 卡片。 */
function foldPage(page: HistoryPage): TranscriptItem[] {
  return [...page.workflowStarts.flatMap(stepToItems), ...foldTranscript(page)]
}

/** 同一压缩记录只向前推进，历史快照不能覆盖加载期间到达的新进度或终态。 */
export function latestCompaction(
  current: TranscriptItem['compaction'],
  incoming: NonNullable<TranscriptItem['compaction']>,
): NonNullable<TranscriptItem['compaction']> {
  const rank = (c: NonNullable<TranscriptItem['compaction']>) =>
    c.phase !== 'started' ? 3 : c.stage === 'saving' ? 2 : c.stage === 'summarizing' ? 1 : 0
  return current && rank(current) > rank(incoming) ? current : incoming
}

function mergeHistoryItems(items: TranscriptItem[], current: TranscriptItem[]): TranscriptItem[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  const merged = items.map((item) =>
    item.compaction
      ? { ...item, compaction: latestCompaction(byId.get(item.id)?.compaction, item.compaction) }
      : item,
  )
  const known = new Set(items.map((item) => item.id))
  return [...merged, ...current.filter((item) => !known.has(item.id))]
}

// 每页最多十轮；服务端还按步骤预算收缩轮次数，避免工具密集的会话一次加载过多记录。
const HISTORY_PAGE_SIZE = 10
/** 历史与变更分页共用的请求时限。 */
export const HISTORY_TIMEOUT_MS = 15_000

interface HistoryLease {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  timedOut: boolean
}

/** 同一会话同一时刻只允许一个分页请求进行中；新请求会取消旧请求。 */
const historyLoads = new Map<string, HistoryLease>()
let activeHistoryLease: HistoryLease | null = null

function beginHistoryLoad(id: string): HistoryLease {
  historyLoads.get(id)?.controller.abort()
  const lease: HistoryLease = {
    controller: new AbortController(),
    timer: null,
    timedOut: false,
  }
  lease.timer = setTimeout(() => {
    lease.timedOut = true
    lease.controller.abort()
  }, HISTORY_TIMEOUT_MS)
  historyLoads.set(id, lease)
  return lease
}

function finishHistoryLoad(id: string, lease: HistoryLease): void {
  if (lease.timer) clearTimeout(lease.timer)
  if (historyLoads.get(id) === lease) historyLoads.delete(id)
}

/** 取消该会话进行中的分页请求。视图撤销时调用：响应已没有可写入的视图。 */
export function abortHistoryLoad(id: string): void {
  historyLoads.get(id)?.controller.abort()
}

function canceledByNewerRequest(lease: HistoryLease): boolean {
  return lease.controller.signal.aborted && !lease.timedOut
}

function historyErrorMessage(error: unknown, lease: HistoryLease): string {
  if (lease.timedOut) return '加载历史记录超时，请重试'
  return error instanceof Error ? error.message : String(error)
}

/**
 * 每页只请求一个接口：服务端按完整的 user turn 一次返回 messages/runs/steps，
 * 请求数不随页面大小变化。
 */
async function fetchConversationPage(
  id: string,
  before: string | null,
  signal: AbortSignal,
): Promise<HistoryPage> {
  const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) })
  if (before) query.set('before', before)
  const page = await client.api<ConversationHistoryPageResponse>(
    `/api/conversations/${id}/history?${query}`,
    { signal },
  )
  const stepsByRun = new Map<string, Step[]>()
  for (const raw of page.steps) {
    const step = raw
    const list = stepsByRun.get(step.runId) ?? []
    list.push(step)
    stepsByRun.set(step.runId, list)
  }
  return {
    messages: page.messages,
    runs: page.runs,
    stepsByRun,
    todos: page.todos,
    workflowStarts: page.workflowStarts,
    earlierTurns: page.earlierTurns,
    nextCursor: page.nextCursor,
    live: page.live,
  }
}

/**
 * 折叠为会话流。当前会话与右侧面板中的只读子会话共用此函数：
 * 两处分别实现时，工具卡的折叠规则会逐渐不一致。
 */
function foldTranscript({ messages, runs, stepsByRun }: Folded): TranscriptItem[] {
  const runsByUserMessage = new Map<string, Run[]>()
  for (const r of runs) {
    if (!r.userMessageId) continue
    const list = runsByUserMessage.get(r.userMessageId) ?? []
    list.push(r)
    runsByUserMessage.set(r.userMessageId, list)
  }

  const items: TranscriptItem[] = []
  const maintenance = runs.filter((run) => run.userMessageId === null)
  let maintenanceIndex = 0
  const appendMaintenance = (before: number) => {
    while (
      maintenanceIndex < maintenance.length &&
      maintenance[maintenanceIndex]!.createdAt < before
    ) {
      const run = maintenance[maintenanceIndex++]!
      items.push(...(stepsByRun.get(run.id) ?? []).flatMap(stepToItems))
    }
  }
  for (const m of messages) {
    appendMaintenance(m.createdAt)
    // 回执与用户输入都是 user 角色，且都能发起轮次：条目形态按 origin 区分，其下的
    // run 与 steps 按相同方式折叠。
    items.push(
      m.origin
        ? { id: m.id, kind: 'receipt', text: m.content, origin: m.origin }
        : {
            id: m.id,
            kind: 'user',
            text: m.content,
            ...(m.attachments?.length ? { attachments: m.attachments } : {}),
          },
    )
    for (const r of runsByUserMessage.get(m.id) ?? []) {
      for (const s of stepsByRun.get(r.id) ?? []) {
        for (const item of stepToItems(s)) {
          items.push(item)
        }
      }
      // 本轮的收尾读数，随 steps 一同折叠：它与工具卡属于同一类条目，
      // 实际发生过且已落库，刷新后必须保留。缺少它时，每轮的花费、运行时长与
      // 停止原因在刷新后只剩最后一轮（且是实时状态中的那一份，重连即丢失）。
      //
      // 尚未结束的 run（进程被终止、正在运行）不折叠：它没有终态，
      // 生成一条 `endedAt: null` 的条目会使读数条持续按运行中计时。
      if (r.finishedAt !== null) {
        items.push({
          id: `run_${r.id}`,
          kind: 'run',
          text: '',
          run: {
            runId: r.id,
            stopReason: r.stopReason,
            usage: r.usage,
            startedAt: r.createdAt,
            endedAt: r.finishedAt,
            errorMessage: r.errorMessage,
          },
        })
      }
    }
  }
  appendMaintenance(Number.POSITIVE_INFINITY)
  return items
}

/**
 * 只读投影另一条会话，供右侧面板中的子会话页使用。
 *
 * 子 agent 的会话不在会话列表中（`source` 记录其种类），打开它的唯一入口是工具卡上
 * 返回的 id。本函数只读取最新一页历史；事件订阅由 `syncViews` 按右侧面板中打开的
 * 子会话页维护。
 */
export async function loadConversationView(id: string): Promise<void> {
  openView(id)
  setState('views', id, 'history', {
    loading: 'initial',
    nextCursor: null,
    earlierTurns: [],
    error: null,
  })
  const lease = beginHistoryLoad(id)
  try {
    const page = await fetchConversationPage(id, null, lease.controller.signal)
    if (canceledByNewerRequest(lease)) return
    const items = foldPage(page)
    setState(
      produce((s) => {
        const v = s.views[id]
        if (!v) return
        // 按 id 合并加载期间到达的事件；正文以账本为准，压缩保留较新的阶段。
        v.transcript = mergeHistoryItems(items, v.transcript)
        v.history = {
          loading: null,
          nextCursor: page.nextCursor,
          earlierTurns: page.earlierTurns,
          error: null,
        }
        restoreLive(v, page.live, page.runs)
      }),
    )
  } catch (error) {
    if (canceledByNewerRequest(lease)) return
    setState(
      produce((s) => {
        const v = s.views[id]
        if (!v) return
        v.history.loading = null
        v.history.error = { phase: 'initial', message: historyErrorMessage(error, lease) }
      }),
    )
  } finally {
    finishHistoryLoad(id, lease)
  }
}

/**
 * 在会话流顶部补充一页更早的记录。只做前插并按 id 去重，加载期间到达的实时事件仍保留在末尾。
 * 滚动锚点由拥有滚动容器的组件补偿，此处只负责账本投影。
 */
export async function loadOlderConversation(id: string): Promise<boolean> {
  const current = state.views[id]
  const before = current?.history.nextCursor ?? null
  if (!current || !before || current.history.loading) return false

  setState('views', id, 'history', 'loading', 'older')
  setState('views', id, 'history', 'error', null)
  const lease = beginHistoryLoad(id)
  try {
    const page = await fetchConversationPage(id, before, lease.controller.signal)
    if (canceledByNewerRequest(lease)) return false
    const items = foldPage(page)
    setState(
      produce((s) => {
        const v = s.views[id]
        if (!v) return
        v.transcript = mergeHistoryItems(items, v.transcript)
        v.history = {
          loading: null,
          nextCursor: page.nextCursor,
          earlierTurns: page.earlierTurns,
          error: null,
        }
      }),
    )
    return true
  } catch (error) {
    if (canceledByNewerRequest(lease)) return false
    setState(
      produce((s) => {
        const v = s.views[id]
        if (!v) return
        v.history.loading = null
        v.history.error = { phase: 'older', message: historyErrorMessage(error, lease) }
      }),
    )
    return false
  } finally {
    finishHistoryLoad(id, lease)
  }
}

/** 初次加载失败与「更早记录」加载失败共用一个重试入口。 */
export async function retryConversationHistory(id: string): Promise<void> {
  const error = state.views[id]?.history.error
  if (error?.phase === 'older') {
    await loadOlderConversation(id)
    return
  }
  if (state.activeConversation === id) await reloadActiveConversation()
  else await loadConversationView(id)
}

/**
 * 重建会话的最新一页投影。
 *
 * 必须同时折叠 run 的 steps，不能只拉取 messages：工具调用只存在于 steps 中，
 * 只拉取 messages 时刷新一次页面就会丢失全部工具卡，界面显示为 agent 未执行任何操作。
 *
 * 折叠顺序沿用后端的口径：每条 user 消息之后插入归属于它的 run 的 steps。
 */
export async function reloadActiveConversation(): Promise<void> {
  const id = state.activeConversation
  if (!id) return
  discardPace()
  activeHistoryLease?.controller.abort()
  const lease = beginHistoryLoad(id)
  activeHistoryLease = lease
  // 新视图没有属于自己的辅助快照，不能暂时显示上一个会话的数据。
  if (state.views[id]?.history.loading === 'unloaded') {
    setState({ context: null, contextError: null, goal: null, todos: [] })
  }
  const initialContext = state.context
  const initialGoal = state.goal
  const initialQueue = state.followUps
  const initialQueueLength = initialQueue.length
  const initialCommands = state.backgroundCommands
  const current = () =>
    state.activeConversation === id &&
    activeHistoryLease === lease &&
    !lease.controller.signal.aborted
  setState('views', id, 'history', {
    loading: 'initial',
    nextCursor: null,
    earlierTurns: [],
    error: null,
  })

  try {
    // 各份投影并行读取、分别发布。正文只依赖历史，辅助接口缓慢或失败不阻塞它。
    // 共用本次加载租约：切换会话、重试与超时仍从同一个出口取消全部请求。
    await Promise.all([
      fetchConversationPage(id, null, lease.controller.signal).then((folded) => {
        if (!current()) return
        const items = foldPage(folded)
        // 正文已可翻页，后续的历史请求不应取消尚在读取的辅助快照。
        if (historyLoads.get(id) === lease) historyLoads.delete(id)
        setState(
          produce((s) => {
            const v = s.views[id]
            if (!v) return
            if (restoreLive(v, folded.live, folded.runs)) s.lastRunId = folded.live.runId
            v.transcript = mergeHistoryItems(items, v.transcript)
            v.history = {
              loading: null,
              nextCursor: folded.nextCursor,
              earlierTurns: folded.earlierTurns,
              error: null,
            }
            v.error = null
            // 待办仍由 steps 的同一账本投影恢复。
            s.todos = folded.todos
          }),
        )
      }),
      client
        .api<{ context: StoredContextPanel }>(`/api/conversations/${id}/context`, {
          signal: lease.controller.signal,
        })
        .then(
          (r) => ({ ctx: r.context, error: null }),
          (e: unknown) => ({ ctx: null, error: e instanceof Error ? e.message : String(e) }),
        )
        .then(({ ctx, error }) => {
          // 请求期间已有实时事件写入时，较早发起的快照不得覆盖该投影。
          if (!current() || state.context !== initialContext) return
          setState(
            produce((s) => {
              s.contextError = error
              s.context = ctx
                ? {
                    tokens: ctx.total,
                    source: ctx.source,
                    limit: ctx.limit,
                    percent: ctx.percent,
                    compactAt: ctx.compactAt,
                    breakdown: ctx.breakdown,
                    omitted: ctx.omitted,
                  }
                : null
            }),
          )
        }),
      client
        .api<{ goal: Goal | null }>(`/api/conversations/${id}/goal`, {
          signal: lease.controller.signal,
        })
        // 目标与队列读取失败时整次加载失败，由历史记录的报错与重试显示：
        // 按空处理会使已设定的目标与排队的消息从界面上消失，且没有任何提示。
        .then((r) => r.goal)
        .then((goal) => {
          if (current() && state.goal === initialGoal)
            setState(
              produce((s) => {
                s.goal = goal
              }),
            )
        }),
      client
        .api<{ queue: FollowUp[] }>(`/api/conversations/${id}/queue`, {
          signal: lease.controller.signal,
        })
        .then((r) => r.queue)
        .then((queue) => {
          if (
            current() &&
            state.followUps === initialQueue &&
            state.followUps.length === initialQueueLength
          ) {
            setState('followUps', queue)
          }
        }),
      // 读取失败同样使整次加载失败，理由同队列：按空处理时正在运行的后台命令从界面上消失。
      client
        .api<{ commands: BackgroundCommand[] }>(`/api/conversations/${id}/commands`, {
          signal: lease.controller.signal,
        })
        .then((r) => {
          // 请求期间已有实时快照写入时，较早发起的读取不得覆盖它。
          if (current() && state.backgroundCommands === initialCommands) {
            setState('backgroundCommands', r.commands)
          }
        }),
    ])
  } catch (error) {
    if (canceledByNewerRequest(lease)) return
    if (state.activeConversation === id) {
      const message = historyErrorMessage(error, lease)
      setState(
        produce((s) => {
          const v = s.views[id]
          if (!v) return
          v.history.loading = null
          v.history.error = { phase: 'initial', message }
        }),
      )
      report('warn', '历史记录加载失败', { message })
    }
  } finally {
    finishHistoryLoad(id, lease)
    if (activeHistoryLease === lease) activeHistoryLease = null
  }
}

/**
 * 将一个 step 折叠为界面上的若干条目。
 *
 * 一个 step 不等于一个界面条目：不同 kind 投影为不同的会话条目。
 * 思考只来自独立的 `kind='thinking'`；迁移 37 已将旧工具行中的正文转换为该结构。
 */
function stepToItems(s: Step): TranscriptItem[] {
  if (s.kind === 'text') {
    return s.content ? [{ id: s.id, kind: 'text', text: s.content }] : []
  }
  if (s.kind === 'thinking') {
    if (!s.content) return []
    // 失败尝试中的思考在失败之前已显示给用户，回放时同样显示并标注已中断，与实时状态一致。
    return [
      {
        id: s.id,
        kind: 'thinking',
        text: s.content,
        ...(s.status === 'failure' ? { interrupted: true as const } : {}),
      },
    ]
  }
  // run 内注入的用户消息。刷新后须在原位置重建，`id` 使用 stepId：
  // 与 `message.injected` 事件中的 id 相同，因此不会短暂出现两条。
  if (s.kind === 'user') {
    const payload = s.payload?.kind === 'user' ? s.payload : undefined
    // 执行事实是交给模型的输入，不是会话内容。
    if (!s.content || isNoticeStep(s)) return []
    const origin = payload?.origin
    if (origin) return [{ id: s.id, kind: 'receipt', text: s.content, origin }]
    const files = payload?.attachments
    return [
      {
        id: s.id,
        kind: 'user',
        text: s.content,
        ...(files?.length ? { attachments: files } : {}),
      },
    ]
  }
  // 压缩条必须在此处投影：压缩事件只存在于连接期间，不投影时刷新一次
  // 压缩记录就会消失，而它是说明上下文占用下降原因的唯一依据。
  if (s.kind === 'compaction') {
    const p = s.payload
    if (p?.kind !== 'compaction' || !p.phase) return []
    return [
      {
        id: `cmp_${s.runId}_${s.seq}`,
        kind: 'compaction',
        text: '',
        compaction: {
          runId: s.runId,
          phase: p.phase,
          ...(p.stage ? { stage: p.stage } : {}),
          ...(p?.reasonCode ? { reasonCode: p.reasonCode } : {}),
          ...(p?.summarized === undefined ? {} : { summarized: p.summarized }),
          ...(p?.compactedMessages ? { compactedMessages: p.compactedMessages } : {}),
        },
      },
    ]
  }
  if (s.kind === 'tool_action') {
    const p =
      s.payload?.kind === 'tool_call' || s.payload?.kind === 'tool_result' ? s.payload : null
    const outcome = p?.kind === 'tool_result' ? p.outcome : undefined
    // action 来自后端落库的解析结果，是卡片的完整标题（开头、动词与对象）。
    // `ToolSpec` 的 `verb` 与 `category` 均为必填，因此 action 必定存在。
    // 不要为缺失情况添加回退：回退为 `execute` 会使刷新后整轮的读取文件操作
    // 全部显示为「执行」；回退为工具名则会使同一操作出现第二种显示。
    return [
      {
        id: s.id,
        kind: 'tool',
        text: '',
        toolName: s.toolName ?? '',
        ...(p?.action ? { action: p.action } : {}),
        ...(p?.args ? { args: p.args } : {}),
        ...(p?.nodes ? { nodes: p.nodes } : {}),
        status: s.status === 'success' ? 'success' : s.status === 'running' ? 'running' : 'failure',
        ...(outcome ? { outcome } : {}),
        ...(p?.kind === 'tool_result' && p.imagesUndelivered ? { imagesUndelivered: true } : {}),
        // 存量行没有该数值，此时不显示耗时，不编造数值。
        ...(s.durationMs === null ? {} : { durationMs: s.durationMs }),
      },
    ]
  }
  return []
}
