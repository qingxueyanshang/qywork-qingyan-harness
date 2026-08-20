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
  ContextBreakdown,
  ContextOmitted,
  EventEnvelope,
  Goal,
  RunUsage,
  StopReason,
  TodoItem,
} from '@qywork/core'
import { produce } from 'solid-js/store'
import { QyClient } from '../client.ts'
import { createPacer } from '../stream-pace.ts'
import {
  type PermissionAsk,
  setState,
  state,
  type TeamMemberState,
  type TranscriptItem,
} from './state.ts'
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
 * 归属在信封上。不能靠「服务端只会推我订阅的」：那个前提有一段物理上消不掉的
 * 窗口——`subscribe` 指令发出到服务端处理之间，旧会话还在推。
 * 表现就是切了会话、正文却是上一条的。
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
          conv.provider = ev.provider
          conv.model = ev.model
          conv.title = ev.title
          conv.updatedAt = ev.updatedAt
        }
      }),
    )
    return
  }

  // 归属不是当前会话的一律丢弃。没有归属的是工作区级事件（git 状态那类），放行。
  if (frame.conversationId && frame.conversationId !== state.activeConversation) return

  /*
   * **「有动静」的唯一落点，就是这里。**
   *
   * 判在入口而不是给三十个 case 各补一句：那是三十次忘记的机会（同下面归属校验
   * 那条理由）。语义也正好——一帧到了就是有动静，与它是哪种事件无关。
   */
  setState('lastEventAt', Date.now())

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
      // 在这里做增量合并会让两端对「待办清单是什么」产生两种理解。
      setState('todos', ev.todos)
      return

    case 'goal':
      // 整体替换：事件带的是账本刚变成的那个完整快照（revision 单调递增），
      // 挑字段合并会在这里造出第二种「目标现在是什么」的说法。
      setState('goal', ev.goal)
      return

    case 'run.started':
      setState(
        produce((s) => {
          s.running = true
          s.usage = null
          s.error = null
          s.notice = null
          s.fileChanges = []
          // **待办不清。** 它是这条会话的进度，不是这一轮的临时读数——
          // 一轮做三条、下一轮接着做第四条是常态。清了的表现是：中断再继续，
          // 清单整个消失，等模型下次整表提交才回来（`write_todos` 是整表语义，
          // 它不一定每轮都调）。清空的那几项都是「跑完就没意义」的东西
          // （用量、错误、这一轮改了哪些文件），待办不属于那一类。
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

    // 与 `text.delta` 同构：按 stepId 认自己那一条，不按「末条是不是思考」认。
    // 后者在同一次调用里出现第二段思考时会把它并进第一段，而那两段是分开到达的。
    case 'thinking.delta':
      setState(
        produce((s) => {
          const last = s.transcript[s.transcript.length - 1]
          if (last?.kind === 'thinking' && last.id === ev.stepId) last.text += ev.delta
          else s.transcript.push({ id: ev.stepId, kind: 'thinking', text: ev.delta })
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
              ...(ev.summarized === undefined ? {} : { summarized: ev.summarized }),
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
        source: ev.source,
        compactAt: ev.compactAt,
        breakdown: ev.breakdown,
        omitted: ev.omitted,
      })
      return

    case 'git.state':
      // 这是**工作区级**事件，走全局广播（没有会话可归属，总线对它一律放行）。
      // 同时开着多个项目时，别的项目那份分支名到了这里必须丢掉——
      // 它看起来完全合理，盖上去没人会怀疑它是别人的。
      if (ev.workspaceId !== workspace()?.id) return
      setState('git', { workspaceId: ev.workspaceId, branch: ev.branch })
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
      setState(
        produce((s) => {
          s.error = { code: ev.code, message: ev.message, retryable: ev.retryable }
          /*
           * **`run.error` 也是终态，必须把 running 放下来。**
           *
           * loop 内的错误后面跟着 `run.finished`，只看那一条也够；但 loop **之外**
           * 抛出的错误没有 run.finished——`run-control.ts` 的 catch 只 publish 了
           * run.error（没配 API key、档案解析失败都走那里），而那时 run 行可能
           * 根本没建出来，服务端没有「结束」可发。
           * 客户端的 running 是 `sendMessage` 乐观置上去的，这条 run.error 就是
           * 它唯一的终态信号。不放下来的表现是：错误卡说「还没配 API Key」，
           * 而发送按钮永久变成停止按钮，配好 key 也发不出下一条，只能刷新。
           *
           * 与 run.finished 同时到达也无妨——两者都置 false，幂等。
           */
          s.running = false
          s.permission = null
        }),
      )
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
              // 刚刚那条 `run.error` 的正文（恒在 finished 之前到）。服务端同时
              // 把它写进了 `runs.error_message`，刷新后由投影层原样折回来。
              errorMessage: s.error?.message ?? null,
            },
          })
          /*
           * **正文交接给了这一轮的条目，全局那份就得放下。**
           *
           * 不放的话同一句话同时挂在读数条和错误卡上——用户看到的是两遍。
           * 剩下的错误卡只服务「没有 run 收尾条可挂」的那一半（没配 key、
           * 档案解析失败），那些恰恰不会走到这里。
           */
          s.error = null
          s.usage = null
          s.runStartedAt = null
          s.lastEventAt = null
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
/** `GET /api/conversations/:id/context` 的回体，形状同 runtime 的 `ContextPanel`。 */
interface StoredContextPanel {
  total: number
  limit: number
  percent: number
  source: 'actual' | 'estimated'
  compactAt: number
  breakdown: ContextBreakdown
  omitted: ContextOmitted
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
  errorMessage: string | null
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
    /** kind='compaction' 专有，见 `StepPayload`。 */
    phase?: 'done' | 'skipped' | 'failed'
    summarized?: boolean
    reasonCode?: string
    compactedMessages?: number
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

  const [{ messages }, { runs }, ctx, goal, ask] = await Promise.all([
    client.api<{ messages: StoredMessage[] }>(`/api/conversations/${id}/messages`),
    client.api<{ runs: StoredRun[] }>(`/api/conversations/${id}/runs`),
    // 上下文面板从账本现算，**不要直接 `s.context = null`**：那样刷新一次、
    // 切一次会话面板就空了，而用户恰恰是回头看的时候才想知道被谁占的。
    // 拉失败不影响会话本身能不能打开，退化成没有面板。
    client
      .api<{ context: StoredContextPanel }>(`/api/conversations/${id}/context`)
      .then((r) => r.context)
      .catch(() => null),
    // 目标同理，而且更要紧：续起标记不落盘，进程重启之后账本里那个 active
    // 的目标不会自己再跑，只能等用户点继续。这里不读回来的话，界面上连
    // 「有一个目标停在这」都看不见——用户只会觉得它坏了。
    client
      .api<{ goal: Goal | null }>(`/api/conversations/${id}/goal`)
      .then((r) => r.goal)
      .catch(() => null),
    // 正在等拍板的那一次授权。同理，而且这一条不读回来的代价最重：
    // `permission.request` 只在发起那一刻广播一次，界面重建之后卡就没了，
    // 服务端那个 promise 还在等——一轮卡着不动、没有任何可点的东西，
    // 五分钟后按拒绝超时。
    client
      .api<{ permission: PermissionAsk | null }>(`/api/conversations/${id}/permission`)
      .then((r) => r.permission)
      .catch(() => null),
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
          for (const item of stepToItems(s)) {
            items.push(r.supersededBy ? { ...item, superseded: true } : item)
          }
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
              errorMessage: r.errorMessage,
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

  // 慢的那次请求不许写。快速连点 A→B 时两次重拉在飞，谁后返回谁盖上去——
  // 于是标题和订阅都在 B、正文却是 A 的。这正是信封带 conversationId 想根治的
  // 「切了会话、内容是上一条的」，在 REST 投影这条路上原样复活。
  if (state.activeConversation !== id) return

  /*
   * **run 作用域的状态一律从这里派生，不靠事件残留。**
   *
   * 这些字段（running / lastRunId / runStartedAt / todos / teamMembers /
   * usage / context / permission）是扁平的全局量，没有「属于哪条会话」这一维。
   * 切会话时若只重置 transcript，它们会连同上一条会话的 run 一起留在界面上；
   * 而 `applyEvent` 现在按 conversationId 丢弃非当前会话的事件，
   * 那条 run 的 `run.finished`——唯一把 running 置回 false 的地方——
   * **结构性地永远到不了**。表现是新会话里输入框永久卡在停止按钮上，
   * 点停止发出去的还是上一条会话的 runId，只能刷新页面。
   *
   * 所以不在 `selectConversation` 里补一张「还要重置哪些字段」的清单——
   * 那张清单每加一个字段就会漏一次。真源是 runs 表，而这里本来就在拉它。
   */
  const live = runs.find((r) => r.status === 'running') ?? null

  setState(
    produce((s) => {
      s.transcript = items
      s.running = live !== null
      s.lastRunId = live?.id ?? null
      s.runStartedAt = live ? live.createdAt : null
      // 重拉之后「上一次有动静」只能从此刻算起：这条会话之前收过什么事件，
      // 换页/重连之后已经无从得知，拿 `createdAt` 冒充会立刻谎报一个巨大的静默时长。
      s.lastEventAt = live ? Date.now() : null
      /*
       * 队友进度是这里**唯一**还在清空的一项，因为它确实无处可读：
       * `team.member` 只走事件，账本里没有表也没有列，编排器把成员状态放在
       * 一个跑完就消失的局部 Map 里。
       *
       * 代价是实打实的：Team 跑到一半切走再切回，已经报过进度的那几个成员
       * 整个消失，只有之后还会再报的那些才长回来。要根治得先让那份状态可读
       * （同 `RunManager.pendingFor`），不是在这里补一张回落清单。
       */
      s.teamMembers = []
      // 授权请求活在服务端内存里，不在账本里——但它**读得到**，所以照读，
      // 不是清空了等下一次事件（那一次永远不会再来，请求只发一次）。
      s.permission = ask
      /*
       * **用量跟着那一轮走，不清空。**
       *
       * 它不属于上面那几项：`runs` 行有这一列，而且是每收到一次 provider 的
       * usage 就写一次（`agent/loop.ts` 的 `saveUsage`），所以正在跑的那一轮
       * 此刻累计了多少，这里读得到。
       *
       * 清成 null 的表现是：跑了一半重连或切回来，读数条上的 `↓入 ↑出 / 命中 /
       * 金额` 整组消失，要等下一次模型调用回报 usage 才凭空长回来——一轮里
       * 这一等可能是几分钟，用户看到的是「数字自己丢了又自己回来」。
       */
      s.usage = live?.usage ?? null
      // **待办从账本投影回来，不新增持久化路径。**
      // 只活在 WS 事件里的话，刷新一次、切走再切回就没了。真源现成的：
      // `write_todos` 的每次调用本身就是一条 tool step，整表 todos 就在它的 args 里。
      // 取最后一条成功的那条即是当前清单——整表语义下，最后一次提交就是全部事实。
      s.todos = todosFromSteps(runs, stepsByRun)
      // 目标有自己的账本（`goal_events`），所以是读回来的，不像待办那样从
      // steps 里反推——反推等于给「目标现在是什么」造第二个真源。
      s.goal = goal
      // 上下文不在这一批里——它有账本可依（`provider_requests`），
      // 不是「run 内的易失投影」。
      // 新会话是 0%，不是没有面板——后端一条请求都没发也知道窗口有多大。
      // 只有这次拉取失败（上面 catch 成 null）才降级成不显示。
      s.context = ctx
        ? {
            tokens: ctx.total,
            limit: ctx.limit,
            percent: ctx.percent,
            source: ctx.source,
            compactAt: ctx.compactAt,
            breakdown: ctx.breakdown,
            omitted: ctx.omitted,
          }
        : null
    }),
  )
}

/**
 * 从落库的 steps 里投影出当前待办清单。
 *
 * **不新增持久化路径**（A2 第 5 问答「否」）。只活在 WS 事件里的话刷新即丢，
 * 而真源现成的：`write_todos` 每次调用本身就是一条 tool step，整表 todos
 * 就躺在它的 `args` 里。整表语义下**最后一次成功提交就是全部事实**，
 * 所以从后往前找第一条成功的即可，不需要合并、也不需要另建一张表。
 *
 * 按 run 顺序倒着扫：跨 run 的进度要延续——一轮做三条、下一轮接着做第四条是常态。
 */
function todosFromSteps(runs: StoredRun[], stepsByRun: Map<string, StoredStep[]>): TodoItem[] {
  for (let i = runs.length - 1; i >= 0; i--) {
    const steps = stepsByRun.get(runs[i]!.id) ?? []
    for (let j = steps.length - 1; j >= 0; j--) {
      const st = steps[j]!
      if (st.kind !== 'tool_action' || st.toolName !== 'write_todos') continue
      if (st.status !== 'success') continue
      const todos = st.payload?.args?.todos
      if (Array.isArray(todos)) return todos as TodoItem[]
    }
  }
  return []
}

/**
 * 一条 step 折成界面上的若干条。
 *
 * **一条 step 不等于一条界面条目**：`tool_action` 一条要展开成「思考 + 工具卡」两条。
 * 思考本身有自己的 step（`kind: 'thinking'`），但迁移 26 之前它寄生在批次首条工具行的
 * `content` 上，那些存量行只能从这里读——**漏掉任何一条的表现都是刷新一次页面、
 * 切一次会话，整轮思考就没了**，而思考恰恰是「模型为什么做了这些」的唯一现场。
 */
function stepToItems(s: StoredStep): TranscriptItem[] {
  if (s.kind === 'text') {
    return s.content ? [{ id: s.id, kind: 'text', text: s.content }] : []
  }
  if (s.kind === 'thinking') {
    return s.content ? [{ id: s.id, kind: 'thinking', text: s.content }] : []
  }
  // 压缩条必须在这里投影出来：压缩事件只活在连接期，不投影的话刷新一次
  // 「这里压缩过」就没了，而它恰恰是解释「上下文为什么降了」的唯一线索。
  if (s.kind === 'compaction') {
    const p = s.payload
    return [
      {
        id: s.id,
        kind: 'compaction',
        text: '',
        compaction: {
          // 终态取 payload 的 `phase`。旧行没有这个键，按 status 列回落——
          // 那时 skipped 与 failed 还共用一条通道，分不出来是历史事实。
          phase: p?.phase ?? (s.status === 'failure' ? 'failed' : 'done'),
          ...(p?.reasonCode ? { reasonCode: p.reasonCode } : {}),
          ...(p?.summarized === undefined ? {} : { summarized: p.summarized }),
          ...(p?.compactedMessages ? { compactedMessages: p.compactedMessages } : {}),
        },
      },
    ]
  }
  if (s.kind === 'tool_action') {
    const outcome = s.payload?.outcome
    const out: TranscriptItem[] = []
    // 迁移 26 之前的存量行：思考在这批工具**之前**发生，位置就在工具卡上面。
    // id 由 step id 派生——每次重拉都要算出同一个值，`reconcileRenderItems` 按 id 配对。
    // 新行走上面的 `kind === 'thinking'` 分支，这里恒为空。
    if (s.content?.trim()) out.push({ id: `think_${s.id}`, kind: 'thinking', text: s.content })
    // action 来自后端落库的解析结果，是这张卡的全部标题（动词 + 对象 + 目标）。
    // **`ToolSpec` 上 `actionKind` / `objectLabel` 都是必填，所以它一定在**——
    // 别为「万一没有」加回落：回落成 `execute` 的话，刷新一次页面一整轮的读文件
    // 全变成「执行」；回落成工具名则是给同一件事再造一套显示。
    out.push({
      id: s.id,
      kind: 'tool',
      text: '',
      toolName: s.toolName ?? '',
      ...(s.payload?.action ? { action: s.payload.action } : {}),
      ...(s.payload?.args ? { args: s.payload.args } : {}),
      status: s.status === 'success' ? 'success' : s.status === 'running' ? 'running' : 'failure',
      ...(outcome ? { outcome } : {}),
    })
    return out
  }
  return []
}
