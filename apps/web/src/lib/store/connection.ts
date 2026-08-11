/**
 * 连接层：那一个 `QyClient`，以及把服务端事件折进 `state` 的 `applyEvent`。
 *
 * 会话投影（`reloadActiveConversation` 及其两个折叠助手）也在这里，
 * 而不是在 `actions.ts`：**断线重连后补不上缺口时要整段重拉**，
 * 那是连接层自己的收尾动作。放到别处就得让连接层反向依赖动作层，
 * 两个模块互相 import 是一定要避免的。
 */

import type { ActionDescriptor, AgentEvent } from '@qywork/core'
import { produce } from 'solid-js/store'
import { QyClient } from '../client.ts'
import { setState, state, type TeamMemberState, type TranscriptItem } from './state.ts'

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
export async function reloadActiveConversation(): Promise<void> {
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
