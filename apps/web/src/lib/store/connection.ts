/**
 * 连接层：那一个 `QyClient`，以及把服务端事件折进 `state` 的 `applyEvent`。
 *
 * 会话投影（`reloadActiveConversation` 及其两个折叠助手）也在这里，
 * 而不是在 `actions.ts`：**断线重连后补不上缺口时要整段重拉**，
 * 那是连接层自己的收尾动作。放到别处就得让连接层反向依赖动作层，
 * 两个模块互相 import 是一定要避免的。
 */

import type {
  ActionDescriptor,
  AgentEvent,
  Attachment,
  EventEnvelope,
  RunUsage,
  StopReason,
} from '@qywork/core'
import { produce } from 'solid-js/store'
import { QyClient } from '../client.ts'
import { createPacer } from '../stream-pace.ts'
import { setState, state, type TeamMemberState, type TranscriptItem } from './state.ts'
import { workspace } from './ui.ts'

export const client = new QyClient({
  onState: (s, detail) => setState({ connection: s, connectionDetail: detail ?? '' }),
  onCapabilities: (caps) => setState('capabilities', caps),
  onResync: () => {
    // 缺口补不上：清空本地投影重新拉，而不是带着一个不完整的 transcript 继续。
    void reloadActiveConversation()
  },
  onEvent: (frame) => applyEvent(frame),
  onRejected: (frame) => setState('notice', { message: frame.message, reason: frame.reason }),
})

/**
 * 正文的匀速呈现。缓冲区里永远只有当前尾部那一段 text step——
 * **除 `text.delta` 外的任何事件都先冲一次**，所以不需要按 step 记账。
 * 编排逻辑在 `stream-pace.ts` 里（那边能测），这里只做接线。
 */
function writeTail(stepId: string, chunk: string): void {
  if (!chunk) return
  setState(
    produce((s) => {
      const last = s.transcript[s.transcript.length - 1]
      // 同一条 text step 持续追加：只改这一个字段，只更新一个文本节点。
      if (last?.kind === 'text' && last.id === stepId) last.text += chunk
      else s.transcript.push({ id: stepId, kind: 'text', text: chunk })
    }),
  )
}

const pacer = createPacer({
  write: writeTail,
  schedule: (fn, ms) => {
    const t = setInterval(fn, ms)
    return () => clearInterval(t)
  },
})

/** 丢掉积压。换会话、整段重拉时用——那段字的归属已经不存在了。 */
export function discardPace(): void {
  pacer.discard()
}

/**
 * 把一帧折进 `state`。
 *
 * ## 归属校验只判一次，就在这里
 *
 * 下面三十个 case 里的绝大多数（`text.delta` / `tool.*` / `usage` / `run.*`）写的都是
 * **当前会话**那一份 transcript 和 run 状态，而事件体自己不带 `conversationId`——
 * 归属在信封上。上一版没有这道校验，靠的是「服务端只会推我订阅的」，
 * 而那个前提有一段物理上消不掉的窗口：`subscribe` 指令发出到服务端处理之间，
 * 旧会话还在推。表现就是切了会话、正文却是上一条的。
 *
 * **不给每个 case 补判断**——三十个分支就是三十次忘记的机会（B4）。入口判一次。
 *
 * ## `conversation.updated` 在校验之前处理
 *
 * 它改的是左栏那份**列表**，不是 transcript，对后台会话同样有意义（标题、模型）。
 * 一刀切按当前会话丢，会让后台会话的标题永远停在「新对话」。
 * 它自己带着 `conversationId`，本来就该按 id 精确路由。
 */
export function applyEvent(frame: EventEnvelope<AgentEvent>): void {
  const ev = frame.event

  // 会话属性变更先处理：它按自己的 id 找列表项，和「当前是哪条」无关。
  if (ev.type === 'conversation.updated') {
    pacer.flush()
    setState(
      produce((s) => {
        const conv = s.conversations.find((c) => c.id === ev.conversationId)
        if (conv) {
          conv.model = ev.model
          conv.effort = ev.effort
          conv.title = ev.title
        }
      }),
    )
    return
  }

  // 归属不是当前会话的一律丢弃。没有归属的是工作区级事件（git 状态那类），放行。
  if (frame.conversationId && frame.conversationId !== state.activeConversation) return

  // 正文之外的一切都意味着「这一刻的界面要是完整的」——读数条、错误卡、
  // 工具卡读的是同一份 transcript，不能让它们看到一段放了一半的正文。
  if (ev.type !== 'text.delta') pacer.flush()

  switch (ev.type) {
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
            ...(ev.childConversationId ? { childConversationId: ev.childConversationId } : {}),
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
          s.usage = null
          s.error = null
          s.notice = null
          s.fileChanges = []
          s.todos = []
          s.teamMembers = []
          s.lastRunId = ev.runId
          s.runStartedAt = Date.now()
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
      pacer.push(ev.stepId, ev.delta)
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
            args: ev.args,
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
                    compactedMessages: ev.manifest.compactedMessageCount,
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
      setState('context', {
        tokens: ev.tokens,
        limit: ev.limit,
        percent: ev.percent,
        breakdown: ev.breakdown,
      })
      return

    case 'git.state':
      // 这是**工作区级**事件，走全局广播（没有会话可归属，总线对它一律放行）。
      // 同时开着多个项目时，别的项目那份状态到了这里必须丢掉——
      // 它的分支名和改动数看起来完全合理，盖上去没人会怀疑它是别人的。
      if (ev.workspaceId !== workspace()?.id) return
      setState('git', {
        workspaceId: ev.workspaceId,
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
        scopes: ev.scopes,
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
          s.permission = null
          // 收尾读数**落成一条条目**，不再写回全局字段：一轮一条，
          // 刷新后由 `reloadActiveConversation` 从 run 行原样重建。
          s.transcript.push({
            id: `run_${ev.runId}`,
            kind: 'run',
            text: '',
            run: {
              runId: ev.runId,
              stopReason: ev.stopReason,
              usage: ev.usage,
              startedAt: s.runStartedAt ?? Date.now(),
              endedAt: Date.now(),
            },
          })
          s.usage = null
          s.runStartedAt = null
        }),
      )
      return

    default:
      return
  }
}

interface StoredMessage {
  id: string
  role: string
  content: string
  attachments?: Attachment[]
  createdAt: number
}
interface StoredRun {
  id: string
  userMessageId: string | null
  createdAt: number
  /** null = 这一轮还没收尾（正在跑，或进程被杀）。 */
  finishedAt: number | null
  stopReason: StopReason | null
  status: string
  usage: RunUsage | null
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
export async function reloadActiveConversation(): Promise<void> {
  const id = state.activeConversation
  if (!id) return
  // 整段重拉之前把积压**丢掉而不是冲出去**：那段字属于重拉之前的那份
  // transcript，冲进来只会在新投影的末尾多出一截无主的正文。
  discardPace()

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
      items.push({
        id: m.id,
        kind: 'user',
        text: m.content,
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      })
      for (const r of runsByUserMessage.get(m.id) ?? []) {
        for (const s of stepsByRun.get(r.id) ?? []) {
          const item = stepToItem(s)
          if (item) items.push(r.supersededBy ? { ...item, superseded: true } : item)
        }
        // 这一轮的收尾读数。**跟着 steps 一起折回来**——它和工具卡是同一类东西：
        // 真实发生过、落了库、刷新后必须还在。少了它，「这一轮花了多少、跑了多久、
        // 为什么停」在刷新后就只剩最后一轮（而且是活的那一份，重连即丢）。
        //
        // 还没收尾的 run（进程被杀、正在跑）不折：它没有终态，
        // 造一条 `endedAt: null` 的条目会让读数条以为还在跑，永远滴答下去。
        if (r.finishedAt !== null) {
          items.push({
            id: `run_${r.id}`,
            kind: 'run',
            text: '',
            ...(r.supersededBy ? { superseded: true } : {}),
            run: {
              runId: r.id,
              stopReason: r.stopReason,
              usage: r.usage,
              startedAt: r.createdAt,
              endedAt: r.finishedAt,
            },
          })
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
      ...(s.payload?.args ? { args: s.payload.args } : {}),
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
