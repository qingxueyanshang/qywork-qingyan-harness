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
  ConversationHistoryPageResponse,
  EventEnvelope,
  FollowUp,
  Goal,
  RunUsage,
  StopReason,
  ToolOutcomeWire,
} from '@qywork/core'
import { createEffect, createRoot } from 'solid-js'
import { produce } from 'solid-js/store'
import { QyClient } from '../client.ts'
import { createFramer, createPacer } from '../stream-pace.ts'
import {
  dropView,
  markBusy,
  openView,
  setState,
  state,
  type TranscriptItem,
  type WorkflowNodeState,
} from './state.ts'
import { panelTabs, tabConversationId, workspace } from './ui.ts'

export const client = new QyClient({
  onState: (s, detail) => setState({ connection: s, connectionDetail: detail ?? '' }),
  onCapabilities: (caps) => setState('capabilities', caps),
  // 握手带的忙闲快照直接整表替换：它是服务端此刻的全部，不是一条增量。
  onBusy: (ids) => setState('busyConversations', [...ids]),
  onResync: () => {
    // 缺口补不上：清空本地投影重新拉，而不是带着一个不完整的 transcript 继续。
    void reloadActiveConversation()
  },
  onEvent: (frame) => applyEvent(frame),
  onRejected: (frame) => setState('notice', { message: frame.message, reason: frame.reason }),
})

/*
 * 热更新换掉这个模块之前，把旧连接关干净。
 *
 * vite 会重新执行整个模块，因此有了第二个 `QyClient`，而上一份那条 WebSocket 还连着。
 * 服务端按连接注册订阅者（`handshake.ts` 拿 `ws.data.id` 做 key），两条连接就是两份
 * 同样的事件流，回调的却是同一个 store——正文每个 token 显示两遍，末尾出现两条读数条。
 * 改一次代码多一条连接，越用越多。
 *
 * 一键脚本起的就是 dev（`scripts/start.ps1` 两种模式都挂 vite dev server），
 * 所以这条不是只影响改代码的人。**这段没有单元测试能覆盖**：`import.meta.hot`
 * 只在 vite 下存在，验证得靠真的热更新一次。
 */
if (import.meta.hot) import.meta.hot.dispose(() => client.close())

/**
 * 正文的匀速呈现。缓冲区里永远只有当前尾部那一段 text step——
 * **除 `text.delta` 外的任何事件都先冲一次**，所以不需要按 step 记账。
 * 编排逻辑在 `stream-pace.ts` 里（那边能测），这里只做接线。
 */
function writeTail(key: string, chunk: string): void {
  if (!chunk) return
  const [cid, stepId] = key.split(SEP) as [string, string]
  setState(
    produce((s) => {
      const items = s.views[cid]?.transcript
      if (!items) return
      const last = items[items.length - 1]
      // 同一条 text step 持续追加：只改这一个字段，只更新一个文本节点。
      if (last?.kind === 'text' && last.id === stepId) last.text += chunk
      else items.push({ id: stepId, kind: 'text', text: chunk })
    }),
  )
}

/**
 * 节拍器与合帧器的缓冲键：**会话 id 打头**。
 *
 * 当前会话和右侧那一页子会话同时在收增量，只按 stepId 记账的话两条会话的
 * step id 撞上就会把字写进另一条会话的正文里。
 */
const SEP = String.fromCharCode(0)
const bufKey = (cid: string, ...rest: string[]): string => [cid, ...rest].join(SEP)

const schedule = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms)
  return () => clearInterval(t)
}

const pacer = createPacer({ write: writeTail, schedule, now: () => Date.now() })

/**
 * 工具中途输出落进那张卡片。
 *
 * **只留尾部**：一次构建可能输出几万行，全存会让内存占用与渲染开销都不可接受。
 * 截断发生在合帧之后——按到达逐段截等于把同一份文本反复重排一遍。
 */
function appendStdout(key: string, chunk: string): void {
  const [cid, stepId] = key.split(SEP) as [string, string]
  setState(
    produce((s) => {
      const item = s.views[cid]?.transcript.find((t) => t.id === stepId)
      if (!item) return
      const next = (item.stdout ?? '') + chunk
      item.stdout = next.length > 8000 ? next.slice(-8000) : next
    }),
  )
}

const toolFrames = createFramer({ write: appendStdout, schedule })

/**
 * 外部 CLI 节点的中途输出，攒在它自己那个节点上。
 *
 * 键是「哪条会话 + 哪张卡 + 哪个节点」三段：一张图里可以有好几个 CLI 节点同时在跑，
 * 只按卡认的话它们的输出会混成一段，再也分不出谁是谁。
 */
function appendNodeOutput(key: string, chunk: string): void {
  const [cid, stepId, memberId] = key.split(SEP)
  setState(
    produce((s) => {
      const card = s.views[cid ?? '']?.transcript.find((t) => t.id === stepId)
      const node = card?.nodes?.find((n) => n.nodeId === memberId)
      if (!node) return
      const next = (node.output ?? '') + chunk
      // 与工具卡的 stdout 同一个上限：再多也读不完，只会推高内存与渲染开销。
      node.output = next.length > 8000 ? next.slice(-8000) : next
    }),
  )
}
const nodeFrames = createFramer({ write: appendNodeOutput, schedule })

/**
 * 不落 transcript 的事件——它们不该冲正文缓冲。
 *
 * `git.state` 由服务端在握手时、切项目时、以及 `.git/HEAD` 变了的时候广播——
 * 新连上的客户端只能从这条广播拿到分支名，没有别的取法。让它冲缓冲的话，
 * 正文攒着的几十个字会在切分支那一下一次性排空，界面上是匀速输出一阵、再突进一次。
 *
 * **这份名单宁可短。** 漏一条只是多冲一次（顿一下）；多写一条会让真正要落
 * transcript 的事件看到一段放了一半的正文，那是顺序错乱，比顿挫严重得多。
 */
const OFF_TRANSCRIPT: ReadonlySet<AgentEvent['type']> = new Set(['git.state'])

/**
 * 「正在重连」那句话的收场信号：重发的那一次真的开始出数据了，或者整轮结束了。
 *
 * 服务端不发配对的「重发结束」事件，理由在 `RunRetryingEvent` 上。所以收场判据
 * 只有这一张表 + 入口那一处判断；**不要散到各 case 里**，那是三十次忘记的机会。
 * 工作区级事件（git 状态、文件变更）不在表里：它们与这一轮的模型输出无关，
 * 算进去的话后台一次文件改动就把这句话抹掉了。
 */
const RESUMED: ReadonlySet<AgentEvent['type']> = new Set([
  'thinking.delta',
  'text.delta',
  'tool.started',
  'run.error',
  'run.finished',
])

/** 丢掉积压。换会话、整段重拉时用——那段字的归属已经不存在了。 */
export function discardPace(): void {
  pacer.discard()
  toolFrames.discard()
  nodeFrames.discard()
}

/**
 * 把一帧折进 `state`。
 *
 * **归属只判一次，就在这里。** 事件体自己不带 `conversationId`——归属在信封上。
 * 它决定这一帧折进哪一条会话那一份（`state.views` 的一个键）；表里没有这一条的
 * （既不是当前会话，也不是右侧开着的子会话页）**整帧丢弃**。不能假定「服务端只推
 * 已订阅的会话」：`subscribe` 指令发出到服务端处理之间有一段消不掉的窗口，
 * 那一段里旧会话还在推。
 *
 * **两条折法，按会话分工：**
 *
 * - `foldContent`——这条会话**是什么**：正文、思考、工具卡、图卡、待办、收尾条。
 *   每条收着事件的会话各折各的，当前会话和它派出去的子会话同时在跑是常态。
 * - `foldRunState`——**这一轮跑得怎么样**：用量、上下文、当前会话待办面板、目标、
 *   跟进队列、重发、这一轮改了哪些文件。只折当前会话那一条：子会话页没有运行读数
 *   与输入框，
 *   折过去等于让另一条会话的数字改写用户正看着的这一份，而界面上没有一处说得出这是谁的。
 *
 * **不给每个 case 补判断**——三十个分支就是三十次忘记的机会（B4）。分工只在这里判。
 *
 * **`conversation.updated` 与 `conversation.busy` 在归属之前处理。** 它们改的是左栏那份
 * **列表**，不是某一条会话的内容，对后台会话同样有意义（标题、模型、忙闲）。一刀切按
 * 当前会话丢，会让后台会话的标题永远停在「新对话」。它们自己带着 `conversationId`，
 * 本来就该按 id 精确路由。
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

  /*
   * 忙闲同样在归属之前处理，理由和上面那条一样：它改的是左栏那份**列表**。
   *
   * **也在 `lastEventAt` 之前**：别的会话开跑不是这条会话「有动静」，
   * 算进去的话，静默检测会被后台会话持续刷新，「链路断了」永远报不出来。
   */
  if (ev.type === 'conversation.busy') {
    markBusy(ev.conversationId, ev.busy)
    return
  }

  const from = frame.conversationId
  // 没有归属的是工作区级事件（git 状态那类），按当前会话算。
  const mine = !from || from === state.activeConversation
  if (from && !state.views[from]) return

  /*
   * **「有动静」的唯一落点，就是这里。**
   *
   * 判在入口而不是给三十个 case 各补一句：那是三十次忘记的机会（同上面归属那条理由）。
   * 语义也正好——一帧到了就是有动静，与它是哪种事件无关。
   *
   * **只认当前会话那条**：子会话在后台收着事件，不说明用户正看着的这一轮还在出数据。
   */
  if (mine) {
    setState('lastEventAt', Date.now())
    // 收场判据的唯一落点，理由见 `RESUMED`。
    if (state.retry && RESUMED.has(ev.type)) setState('retry', null)
  }

  /*
   * 要落 transcript 的事件都意味着「这一刻的界面要是完整的」——读数条、错误卡、
   * 工具卡读的是同一份 transcript，不能让它们看到一段放了一半的正文。
   *
   * **两种增量事件自己不冲**：正文由节拍器放，工具输出由合帧器放，它们冲自己等于
   * 把那一层直接关掉。`tool.delta` 尤其不能冲正文——它按 stepId 改的是已经存在的
   * 那张卡片，不动 transcript 末项，没有顺序风险，而它一秒有几百条。
   */
  if (ev.type !== 'text.delta' && ev.type !== 'tool.delta' && !OFF_TRANSCRIPT.has(ev.type)) {
    pacer.flush()
    toolFrames.flush()
    nodeFrames.flush()
  }

  const cid = from ?? state.activeConversation
  if (cid) foldContent(cid, ev)
  if (mine) foldRunState(ev)
}

/**
 * 这条会话**是什么**。见 `applyEvent` 里那段分工。
 *
 * 每个写点都先取 `s.views[cid]`，取不到就整条不落：表在 `openView` 建，
 * 而切走一条会话、关掉一页子会话都会当场撤表（`dropView`），撤表之后到达的那几帧
 * 已经没有归属可言。
 */
function foldContent(cid: string, ev: AgentEvent): void {
  switch (ev.type) {
    case 'todos':
      // 每条会话各收自己的整表。父会话另投影到 `state.todos` 给全局面板消费；
      // 子会话只读这里这一份，不能把它的事件写进父面板。
      setState('views', cid, 'todos', ev.todos)
      return

    case 'team.member':
      // 进度落到那张图卡上。**没带 stepId 就整条丢弃**：一条会话里可能有好几张图卡，
      // 认不出是哪一张时挂在任意一张上，用户看到的是另一件事的进度。
      if (!ev.stepId) return
      setState(
        produce((s) => {
          const card = s.views[cid]?.transcript.find((t) => t.id === ev.stepId)
          if (!card) return
          const nodes = card.nodes ?? []
          // 原地更新而不是追加：同一个节点会连发 spawned → working → done，
          // 追加的话图上会出现同一个节点的三份。
          const i = nodes.findIndex((n) => n.nodeId === ev.memberId)
          // 子会话 id 要逐条保留。它在 `working` 那条补上来，后面每条都得带着——
          // 不带的话 `done` 到达时这一格重新变回点不开的。外部 CLI 那几格没有这个字段。
          const child = ev.childConversationId ?? nodes[i]?.conversationId
          const next: WorkflowNodeState = {
            nodeId: ev.memberId,
            agent: nodes[i]?.agent ?? ev.roleName,
            label: ev.roleName,
            phase: ev.phase,
            ...(ev.summary ? { summary: ev.summary } : {}),
            ...(child ? { conversationId: child } : {}),
          }
          if (i >= 0) nodes[i] = next
          else nodes.push(next)
          card.nodes = nodes
        }),
      )
      return

    case 'message.injected':
      setState(
        produce((s) => {
          // id 用 stepId——与刷新后 `stepToItems` 重建出来的那条同源，不会闪重。
          s.views[cid]?.transcript.push({
            id: ev.stepId,
            kind: 'user',
            text: ev.content,
            ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
          })
        }),
      )
      return

    case 'run.started':
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          v.error = null
          v.runStartedAt = Date.now()
          /*
           * 对齐这一轮回答的那条用户气泡。
           *
           * 界面上按回车那一条是客户端乐观插进去的，带的是本地 id；而目标续起、
           * 定时触发、跟进消息火发这三条路没有客户端动作，气泡只能从这条事件来。
           * 两种情况用同一条规则收：正文对得上就把 id 换成账本里的真值，
           * 对不上就补一条——补完之后活的这份与刷新后从账本投影出来的那份同 id。
           */
          if (ev.userMessage && ev.userMessageId) {
            let last = v.transcript.length - 1
            while (last >= 0 && v.transcript[last]!.kind !== 'user') last--
            const hit = last >= 0 ? v.transcript[last]! : null
            if (hit && hit.text === ev.userMessage.content) {
              hit.id = ev.userMessageId
            } else {
              v.transcript.push({
                id: ev.userMessageId,
                kind: 'user',
                text: ev.userMessage.content,
                ...(ev.userMessage.attachments?.length
                  ? { attachments: ev.userMessage.attachments }
                  : {}),
              })
            }
          }
        }),
      )
      return

    case 'text.delta':
      pacer.push(bufKey(cid, ev.stepId), ev.delta)
      return

    // 与 `text.delta` 同构：按 stepId 认自己那一条，不按「末条是不是思考」认。
    // 后者在同一次调用里出现第二段思考时会把它并进第一段，而那两段是分开到达的。
    case 'thinking.delta':
      setState(
        produce((s) => {
          const items = s.views[cid]?.transcript
          if (!items) return
          const last = items[items.length - 1]
          if (last?.kind === 'thinking' && last.id === ev.stepId) last.text += ev.delta
          else items.push({ id: ev.stepId, kind: 'thinking', text: ev.delta })
        }),
      )
      return

    case 'tool.started':
      setState(
        produce((s) => {
          s.views[cid]?.transcript.push({
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
      toolFrames.push(bufKey(cid, ev.stepId), ev.delta)
      return

    case 'team.output':
      // 认不出是哪张卡就整条丢弃，与 `team.member` 同一条理由。
      if (!ev.stepId) return
      nodeFrames.push(bufKey(cid, ev.stepId, ev.memberId), ev.delta)
      return

    case 'tool.finished':
      setState(
        produce((s) => {
          const item = s.views[cid]?.transcript.find((t) => t.id === ev.stepId)
          if (!item) return
          item.status = ev.status === 'success' ? 'success' : 'failure'
          item.outcome = ev.outcome
          item.durationMs = ev.durationMs
        }),
      )
      return

    case 'compaction':
      setState(
        produce((s) => {
          const items = s.views[cid]?.transcript
          if (!items) return
          // 压缩是会话管理的可见事件，不能静默发生——用户需要知道
          // 「为什么模型突然不记得前面说过的话了」。
          const existing = items.find(
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
          items.push({
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

    case 'run.error':
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          v.error = { code: ev.code, message: ev.message }
          /*
           * **不要在这里把「在跑」放下来。** 终态由服务端的 `conversation.busy`
           * 给：loop 之外抛出的错误（没配 API key、档案解析失败）没有
           * `run.finished`，但 `run-control.ts` 的 finally 一定会走 unregister /
           * release，那两处就是忙闲的唯一裁决点。在这里补一个客户端判断，
           * 「谁在跑」就有了第二本账。
           */
        }),
      )
      return

    case 'run.finished':
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          // 收尾读数**落成一条条目**，不再写回全局字段：一轮一条，
          // 刷新后由 `reloadActiveConversation` 从 run 行原样重建。
          v.transcript.push({
            id: `run_${ev.runId}`,
            kind: 'run',
            text: '',
            run: {
              runId: ev.runId,
              stopReason: ev.stopReason,
              usage: ev.usage,
              startedAt: v.runStartedAt ?? Date.now(),
              endedAt: Date.now(),
              // 刚刚那条 `run.error` 的正文（恒在 finished 之前到）。服务端同时
              // 把它写进了 `runs.error_message`，刷新后由投影层原样折回来。
              errorMessage: v.error?.message ?? null,
            },
          })
          /*
           * **正文交接给了这一轮的条目，会话上那份就得放下。**
           *
           * 不放的话同一句话同时挂在读数条和错误卡上——用户看到的是两遍。
           * 剩下的错误卡只服务「没有 run 收尾条可挂」的那一半（没配 key、
           * 档案解析失败），那些不会走到这里。
           */
          v.error = null
          v.runStartedAt = null
        }),
      )
      return

    default:
      return
  }
}

/**
 * **这一轮跑得怎么样**：读数、待办、目标、跟进队列、重发、这一轮改了哪些文件。
 *
 * 只有当前会话那一条走到这里，理由见 `applyEvent`。
 */
function foldRunState(ev: AgentEvent): void {
  switch (ev.type) {
    case 'queue.changed':
      // 整体替换：服务端发的就是它此刻的全部，本地那几张乐观卡按同一个 id 被覆盖。
      setState('followUps', ev.queue)
      return

    case 'message.injected':
      // 摘掉那张卡：队列的权威仍是 `queue.changed`，这里先手一步是为了
      // 卡片与气泡不同时出现（服务端两条事件之间隔着一次落库）。
      setState('followUps', (list) => list.filter((f) => f.id !== ev.followUpId))
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
          s.usage = null
          s.notice = null
          s.fileChanges = []
          // **待办不清。** 它是这条会话的进度，不是这一轮的临时读数——
          // 一轮做三条、下一轮接着做第四条是常态。清了的表现是：中断再继续，
          // 清单整个消失，等模型下次整表提交才回来（`write_todos` 是整表语义，
          // 它不一定每轮都调）。清空的那几项都是「跑完就没意义」的读数
          // （用量、错误、这一轮改了哪些文件），待办不属于那一类。
          s.lastRunId = ev.runId
        }),
      )
      return

    /*
     * 断流后原样重发。这一格只改阶段那句话——失败那次的思考条目留在原地，
     * 它是用户判断「模型刚才想到哪了」的现场，抹掉它等于把重发变成一次静默倒带。
     */
    case 'run.retrying':
      setState('retry', { attempt: ev.attempt, max: ev.max })
      return

    case 'file.changed':
      setState(
        produce((s) => {
          // 即使 `changes` 为空也要推进：空数组表示执行类工具使文件快照失效，
          // 但没有可靠的逐路径增删明细，不能为刷新 UI 去伪造一条变更。
          s.fileVersion += 1
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

    case 'usage':
      setState('usage', ev.usage)
      return

    case 'context':
      setState('context', {
        tokens: ev.tokens,
        limit: ev.limit,
        percent: ev.percent,
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

    case 'run.finished':
      setState(
        produce((s) => {
          s.usage = null
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
  errorMessage: string | null
}
interface StoredStep {
  id: string
  runId: string
  seq: number
  kind: string
  toolName: string | null
  content: string | null
  payload: {
    kind: string
    args?: Record<string, unknown>
    outcome?: ToolOutcomeWire
    action?: ActionDescriptor
    childConversationId?: string
    /** kind='compaction' 专有，见 `StepPayload`。 */
    phase?: 'done' | 'skipped' | 'failed'
    summarized?: boolean
    reasonCode?: string
    compactedMessages?: number
    /** kind='user' 专有：注入消息带的附件，见 `StepPayload`。 */
    attachments?: Attachment[]
  } | null
  status: string
  createdAt: number
  /** 这次调用跑了多久。迁移 28 之前的行没有这个数。 */
  durationMs: number | null
}

/** 一条会话的三样落库事实：消息、run、每个 run 的 steps。 */
interface Folded {
  messages: StoredMessage[]
  runs: StoredRun[]
  stepsByRun: Map<string, StoredStep[]>
}

interface HistoryPage extends Folded {
  todos: ConversationHistoryPageResponse['todos']
  nextCursor: string | null
}

// 600 轮 / 16.9 MiB 级会话实测：30 轮首屏虽能在 400ms 内出现第一行，
// 但后续 Markdown 挂载仍会占主线程约 2.8s，快速点下一条会话要等。10 轮把单页
// 控制在约 300 KiB；历史一字不少，只把“继续往前读”的粒度收细。
const HISTORY_PAGE_SIZE = 10
const HISTORY_TIMEOUT_MS = 15_000

interface HistoryLease {
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | null
  timedOut: boolean
}

/** 同一会话同一时刻只允许一页在飞；新请求会撤掉旧请求。 */
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

function canceledByNewerRequest(lease: HistoryLease): boolean {
  return lease.controller.signal.aborted && !lease.timedOut
}

function historyErrorMessage(error: unknown, lease: HistoryLease): string {
  if (lease.timedOut) return '加载历史记录超时，请重试'
  return error instanceof Error ? error.message : String(error)
}

/**
 * 一页只走一个接口：服务端按完整 user turn 一次带回 messages/runs/steps。
 * 这条替掉旧的 `2 + runs.length` 个请求，页面大小不再决定请求个数。
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
  const stepsByRun = new Map<string, StoredStep[]>()
  for (const raw of page.steps) {
    const step = raw as unknown as StoredStep
    const list = stepsByRun.get(step.runId) ?? []
    list.push(step)
    stepsByRun.set(step.runId, list)
  }
  return {
    messages: page.messages,
    runs: page.runs,
    stepsByRun,
    todos: page.todos,
    nextCursor: page.nextCursor,
  }
}

/**
 * 折成会话流。**当前会话与右侧面板里那条只读子会话共用这一份**——
 * 两处各折一遍的话，工具卡的折叠口径迟早在两边漂开。
 */
function foldTranscript({ messages, runs, stepsByRun }: Folded): TranscriptItem[] {
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
            items.push(item)
          }
        }
        // 这一轮的收尾读数。**跟着 steps 一起折回来**——它和工具卡是同一类条目：
        // 真实发生过、落了库、刷新后必须还在。少了它，「这一轮花了多少、跑了多久、
        // 为什么停」在刷新后就只剩最后一轮（而且是活的那一份，重连即丢）。
        //
        // 还没收尾的 run（进程被杀、正在跑）不折：它没有终态，
        // 造一条 `endedAt: null` 的条目会让读数条一直按运行中计时。
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
    } else if (m.content.trim()) {
      // assistant 兜底消息：steps 里已有 text step 时会重复，
      // 所以只在这一轮没产出任何文本 step 时才补。
      const alreadyHasText = items[items.length - 1]?.kind === 'text'
      if (!alreadyHasText) items.push({ id: m.id, kind: 'text', text: m.content })
    }
  }
  return items
}

/**
 * 只读投影另一条会话，给右侧面板里的子会话页用。
 *
 * 子 agent 的会话不在会话列表里（`source='workflow'`），点开它的入口只有工具卡上
 * 带回来的那个 id；而它一旦跑完就不再有事件，投影一次即可，不需要订阅。
 */
export async function loadConversationView(id: string): Promise<void> {
  openView(id)
  setState('views', id, 'history', {
    loading: 'initial',
    nextCursor: null,
    error: null,
  })
  const lease = beginHistoryLoad(id)
  try {
    const page = await fetchConversationPage(id, null, lease.controller.signal)
    if (canceledByNewerRequest(lease)) return
    const items = foldTranscript(page)
    setState(
      produce((s) => {
        const v = s.views[id]
        if (!v) return
        // 建表到这一拉返回之间到达的那几条接在后面，按 id 去重。同一条 step
        // 两边都有时以账本那份为准：事件那份可能只放了一半（正文还在流）。
        const known = new Set(items.map((i) => i.id))
        v.transcript = [...items, ...v.transcript.filter((i) => !known.has(i.id))]
        v.todos = page.todos
        v.history = { loading: null, nextCursor: page.nextCursor, error: null }
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
 * 在流顶端补一页更早记录。只做前插且按 id 去重，加载期间到达的实时事件仍留在尾部。
 * 滚动锚点由拥有滚动容器的组件补偿，这里只负责账本投影。
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
    const items = foldTranscript(page)
    setState(
      produce((s) => {
        const v = s.views[id]
        if (!v) return
        const olderIds = new Set(items.map((item) => item.id))
        v.transcript = [...items, ...v.transcript.filter((item) => !olderIds.has(item.id))]
        v.history = { loading: null, nextCursor: page.nextCursor, error: null }
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

/** 初次加载失败与“更早记录”失败共用一个重试入口。 */
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
 * 哪几条会话正在收事件：当前会话，加上右侧开着的那几页子会话。
 *
 * **表的键与报给服务端的订阅集是同一份派生量**，不是两处各记一遍：报了却没建表的
 * 那条，事件到了会被整帧丢弃（`applyEvent` 的归属判定）；建了表却没报的那条，
 * 一个字都收不到。两边都从这里出。
 *
 * 建表在撤表之前：中间那一步里两条都在表上，比先撤后建那一瞬间一条都不在要好——
 * 后者那一瞬间到达的帧会被丢掉。
 */
let reported = ''

export function syncViews(): void {
  const want = new Set<string>()
  if (state.activeConversation) want.add(state.activeConversation)
  for (const t of panelTabs()) {
    if (t.kind === 'conversation') want.add(tabConversationId(t.id))
  }
  for (const id of want) openView(id)
  for (const id of Object.keys(state.views)) {
    if (want.has(id)) continue
    historyLoads.get(id)?.controller.abort()
    dropView(id)
  }
  // 没变就不报：这个函数既由下面那个 effect 触发，也在切会话那条路上被显式调一次，
  // 同一组会话报两遍只是两条白发的指令。
  const line = [...want].sort().join(',')
  if (line === reported) return
  reported = line
  client.subscribe([...want])
}

/*
 * 开着哪几页是 `ui.ts` 那边的信号，所以订阅集跟着它自己走一遍——
 * 不能反过来让 `ui.ts` 调这里：连接层已经引了它（`workspace`），两个模块互相 import
 * 是一定要避免的。切会话那条路另有一次显式调用，理由见 `selectConversation`。
 */
createRoot(() => createEffect(syncViews))

/**
 * 重建会话的最新一页投影。
 *
 * 必须把 **run 的 steps 也折回来**，而不是只拉 messages——工具调用只存在于 steps 里，
 * 单拉 messages 意味着刷新一次页面就丢掉全部工具卡，界面上等于 agent 什么都没做。
 *
 * 折叠顺序沿用后端的口径：每条 user 消息之后，插入归属于它的那个 run 的 steps。
 */
export async function reloadActiveConversation(): Promise<void> {
  const id = state.activeConversation
  if (!id) return
  // 整段重拉之前把积压**丢掉而不是冲出去**：那段字属于重拉之前的那份
  // transcript，冲进来只会在新投影的末尾多出一截无主的正文。
  discardPace()
  activeHistoryLease?.controller.abort()
  const lease = beginHistoryLoad(id)
  activeHistoryLease = lease
  setState('views', id, 'history', {
    loading: 'initial',
    nextCursor: null,
    error: null,
  })

  try {
    const [folded, ctx, goal, queue] = await Promise.all([
      fetchConversationPage(id, null, lease.controller.signal),
      // 上下文面板从账本现算，**不要直接 `s.context = null`**：那样刷新一次、
      // 切一次会话面板就空了，而用户是回头看的时候才想知道被谁占的。
      // 拉失败不影响会话本身能不能打开，退化成没有面板。
      client
        .api<{ context: StoredContextPanel }>(`/api/conversations/${id}/context`, {
          signal: lease.controller.signal,
        })
        .then((r) => r.context)
        .catch(() => null),
      // 目标同理，而且更要紧：续起标记不落盘，进程重启之后账本里那个 active
      // 的目标不会自己再跑，只能等用户点继续。这里不读回来的话，界面上连
      // 「有一个目标停在这」都看不见——用户只会觉得它坏了。
      client
        .api<{ goal: Goal | null }>(`/api/conversations/${id}/goal`, {
          signal: lease.controller.signal,
        })
        .then((r) => r.goal)
        .catch(() => null),
      // 排着的跟进消息。它只活在服务端进程里，刷新与重连之后卡片全靠这一拉重建；
      // 与 `queue.changed` 同源（都读 `RunManager`），不存在快照与增量各说各话。
      client
        .api<{ queue: FollowUp[] }>(`/api/conversations/${id}/queue`, {
          signal: lease.controller.signal,
        })
        .then((r) => r.queue)
        .catch(() => []),
    ])

    const { runs } = folded
    const items = foldTranscript(folded)

    // 慢的那次请求不许写。快速连点 A→B 时两次重拉在飞，谁后返回谁盖上去——
    // 因此标题和订阅都在 B、正文却是 A 的。这正是信封带 conversationId 想根治的
    // 「切了会话、内容是上一条的」，在 REST 投影这条路上原样复活。
    if (state.activeConversation !== id || canceledByNewerRequest(lease)) return

    /*
     * **run 作用域的状态一律从这里派生，不靠事件残留。**
     *
     * 这些字段（lastRunId / todos / usage / context）只有当前会话那一份，
     * 没有「属于哪条会话」这一维。切会话时若只重置正文流，它们会连同上一条会话的
     * run 一起留在界面上；而上一条会话的表在切走那一刻就撤了（`dropView`），
     * 它那条 run 的 `run.finished` **结构性地永远到不了**，
     * 因此它们再也不会被放下来。
     *
     * 所以不在 `selectConversation` 里补一张「还要重置哪些字段」的清单——
     * 那张清单每加一个字段就会漏一次。真源是 runs 表，而这里本来就在拉它。
     *
     * **「在不在跑」不在这张单子上**：`busyConversations` 本来就带着会话这一维，
     * 换一条会话读的就是另一格，没有什么需要重置。这里也不许照 runs 表补写一份
     * ——账本那行在服务进程崩过之后可能还挂着 `running`，照它写就会把界面永久
     * 钉在执行中，而 `RunManager` 早就没有这条 run 了。
     */
    const live = runs.find((r) => r.status === 'running') ?? null

    setState(
      produce((s) => {
        const v = s.views[id]
        if (v) {
          // 请求期间到达的实时事件接在账本页后面；同 id 以账本为准。
          const known = new Set(items.map((item) => item.id))
          v.transcript = [...items, ...v.transcript.filter((item) => !known.has(item.id))]
          v.history = { loading: null, nextCursor: folded.nextCursor, error: null }
          v.runStartedAt = live ? live.createdAt : null
          // 报错正文跟着收尾条走，重投之后那一条已经带上了它（`stepToItems` 那侧）。
          v.error = null
        }
        s.followUps = queue
        s.lastRunId = live?.id ?? null
        // 重拉之后「上一次有动静」只能从此刻算起：这条会话之前收过什么事件，
        // 换页/重连之后已经无从得知，拿 `createdAt` 冒充会立刻谎报一个巨大的静默时长。
        s.lastEventAt = live ? Date.now() : null
        /*
         * 重连计数是这里仅有的一处清空，因为它确实无处可读——它活在 `AgentLoop`
         * 的调用栈上，账本里没有表也没有列。
         *
         * 图卡的节点态**不在这里清**：它跟着 transcript 条目走，而条目是从账本重投
         * 出来的。重投之后仍在运行的那几个节点回落到 outcome 里的终态（跑完的那些），
         * 正在跑的那几个要等它们下一次报进度才长回来——代价照实说。
         */
        s.retry = null
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
        // **待办从同一份 steps 账本投影回来，不新增持久化路径。**
        // 只活在 WS 事件里的话，刷新一次、切走再切回就没了。`write_todos` step
        // 提交整表，之后明确绑定的成功 `subagent` step 推进单条；历史接口已按这个
        // 顺序折成当前快照，这里只接住，不在前端再猜一遍。
        s.todos = folded.todos
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
              compactAt: ctx.compactAt,
              breakdown: ctx.breakdown,
              omitted: ctx.omitted,
            }
          : null
      }),
    )
  } catch (error) {
    if (canceledByNewerRequest(lease)) return
    if (state.activeConversation === id) {
      setState(
        produce((s) => {
          const v = s.views[id]
          if (!v) return
          v.history.loading = null
          v.history.error = { phase: 'initial', message: historyErrorMessage(error, lease) }
        }),
      )
    }
  } finally {
    finishHistoryLoad(id, lease)
    if (activeHistoryLease === lease) activeHistoryLease = null
  }
}

/**
 * 一条 step 折成界面上的若干条。
 *
 * **一条 step 不等于一条界面条目**：`tool_action` 一条要展开成「思考 + 工具卡」两条。
 * 思考本身有自己的 step（`kind: 'thinking'`），但迁移 26 之前它寄生在批次首条工具行的
 * `content` 上，那些存量行只能从这里读——**漏掉任何一条的表现都是刷新一次页面、
 * 切一次会话，整轮思考就没了**，而思考是「模型为什么做了这些」的唯一现场。
 */
function stepToItems(s: StoredStep): TranscriptItem[] {
  if (s.kind === 'text') {
    return s.content ? [{ id: s.id, kind: 'text', text: s.content }] : []
  }
  if (s.kind === 'thinking') {
    return s.content ? [{ id: s.id, kind: 'thinking', text: s.content }] : []
  }
  // run 内注入的那句用户消息。刷新后要原位重建，`id` 用 stepId——
  // 与 `message.injected` 事件里那个是同一个值，因此不会闪出两条。
  if (s.kind === 'user') {
    const files = s.payload?.kind === 'user' ? s.payload.attachments : undefined
    return s.content
      ? [
          {
            id: s.id,
            kind: 'user',
            text: s.content,
            ...(files?.length ? { attachments: files } : {}),
          },
        ]
      : []
  }
  // 压缩条必须在这里投影出来：压缩事件只活在连接期，不投影的话刷新一次
  // 「这里压缩过」就没了，而它是解释「上下文为什么降了」的唯一线索。
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
      ...(s.payload?.childConversationId
        ? { childConversationId: s.payload.childConversationId }
        : {}),
      status: s.status === 'success' ? 'success' : s.status === 'running' ? 'running' : 'failure',
      ...(outcome ? { outcome } : {}),
      // 存量行没有这个数，那时不显示耗时——不为它编一个。
      ...(s.durationMs === null ? {} : { durationMs: s.durationMs }),
    })
    return out
  }
  return []
}
