/**
 * 连接层：唯一的 `QyClient` 实例，以及把服务端事件折叠进 `state` 的 `applyEvent`。
 *
 * 会话投影（`reloadActiveConversation` 及其两个折叠辅助函数）也位于此处，
 * 而不在 `actions.ts`：断线重连后无法补齐缺口时须整段重新拉取，
 * 这是连接层自身的收尾动作。放到其他模块会使连接层反向依赖动作层，
 * 必须避免两个模块互相 import。
 */

import type {
  AgentEvent,
  CommandRejectedFrame,
  ContextBreakdown,
  ContextOmitted,
  ConversationChangesPageResponse,
  ConversationHistoryPageResponse,
  ConversationLiveSnapshot,
  EventEnvelope,
  FollowUp,
  Goal,
  Message,
  Run,
  Step,
} from '@qywork/core'
import { isNoticeStep } from '@qywork/core'
import { createEffect, createRoot, createSignal } from 'solid-js'
import { produce } from 'solid-js/store'
import { QyClient } from '../client.ts'
import { createFramer, createPacer } from '../stream-pace.ts'
import {
  type ChangeStep,
  type ChangesView,
  type ChangeTurn,
  type ConversationView,
  dropView,
  LOCAL_ID_PREFIX,
  openView,
  type RequestProjection,
  refundBusy,
  setState,
  settleBusy,
  state,
  syncBusy,
  type TranscriptItem,
} from './state.ts'
import { panelTabs, tabConversationId, workspace } from './ui.ts'

export const [extensionsRevision, setExtensionsRevision] = createSignal(0)
export function invalidateExtensions(): void {
  setExtensionsRevision((value) => value + 1)
}

export const client = new QyClient({
  onState: (s, detail) => setState({ connection: s, connectionDetail: detail ?? '' }),
  onCapabilities: (caps) => setState('capabilities', caps),
  // 握手携带的忙闲快照直接整表替换：它是服务端当前的完整状态，不是增量。
  onBusy: (ids) => syncBusy(ids),
  onResync: () => {
    // 无法补齐缺口：清空本地投影并重新拉取，不在不完整的 transcript 上继续。
    void reloadActiveConversation()
  },
  onStreamChanged: () => {
    /*
     * 桌面源码开发采用「前后端原子换代」：Vite 不先热替换页面，所有源码改动都先
     * 等待当前 run 执行完毕，再由 dev.ts 重启 sidecar。streamId 变更是后端换代完成的
     * 可靠信号，此时刷新整页，才会加载与后端同一版本源码的 UI。
     *
     * 不能把刷新挂到普通 reconnect 或 resync 上：网络闪断也会触发这两条路径，
     * 手机端与打包版不应因此整页刷新。
     */
    if (import.meta.env.DEV && import.meta.env.VITE_QYWORK_COORDINATED_RELOAD === '1') {
      location.reload()
    }
  },
  onEvent: (frame) => applyEvent(frame),
  onRejected: (frame) => applyRejected(frame),
})

/**
 * 把一条拒绝回执折叠进 `state`。
 *
 * 执行两项操作：显示提示（`notice`），以及冲销该指令预先设置的忙状态。被拒绝的指令
 * 服务端从未置忙，因此不会发送 `conversation.busy: false` 来清除按回车时乐观设置的忙状态，
 * 界面会一直停留在生成中，直到重连时由握手快照重置。
 *
 * 冲销按 `clientRequestId` 定位对应的忙状态，不按收到拒绝的会话定位：该会话可能
 * 确实正在运行其他轮次（例如被拒绝的是 `followup.steer`）。
 */
export function applyRejected(frame: CommandRejectedFrame): void {
  setState('notice', { message: frame.message, reason: frame.reason })
  refundBusy(frame.clientRequestId)
}

/*
 * 热更新替换本模块之前，关闭旧连接。
 *
 * vite 会重新执行整个模块并创建第二个 `QyClient`，而上一个实例的 WebSocket 仍处于连接状态。
 * 服务端按连接注册订阅者（`handshake.ts` 以 `ws.data.id` 为 key），两条连接即两份
 * 相同的事件流，回调的却是同一个 store：正文每个 token 显示两遍，末尾出现两条读数条。
 * 每修改一次代码就多一条连接，连接数持续累积。
 *
 * 一键脚本启动的就是 dev（`scripts/start.ps1` 两种模式都使用 vite dev server），
 * 因此该问题不只影响修改代码的人。此段无法由单元测试覆盖：`import.meta.hot`
 * 只在 vite 下存在，须通过实际热更新一次来验证。
 */
if (import.meta.hot) import.meta.hot.dispose(() => client.close())

/**
 * 正文的匀速呈现。缓冲区中始终只有当前末尾的 text step：
 * 任何写入 transcript 的事件都先 flush 一次，因此无需按 step 区分缓冲。
 * 编排逻辑位于 `stream-pace.ts`（可单独测试），此处只负责接线。
 */
function writeTail(key: string, chunk: string): void {
  if (!chunk) return
  const [cid, stepId] = key.split(SEP) as [string, string]
  setState(
    produce((s) => {
      const items = s.views[cid]?.transcript
      if (!items) return
      const last = items[items.length - 1]
      // 同一个 text step 持续追加：只修改该字段，只更新一个文本节点。
      if (last?.kind === 'text' && last.id === stepId) last.text += chunk
      else items.push({ id: stepId, kind: 'text', text: chunk })
    }),
  )
}

/**
 * 节拍器与合帧器的缓冲键：以会话 id 开头。
 *
 * 当前会话与右侧的子会话页同时接收增量，只按 stepId 区分时，两条会话的
 * step id 冲突会把文字写入另一条会话的正文。
 */
const SEP = String.fromCharCode(0)
const bufKey = (cid: string, ...rest: string[]): string => [cid, ...rest].join(SEP)

const schedule = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms)
  return () => clearInterval(t)
}

const pacer = createPacer({ write: writeTail, schedule, now: () => Date.now() })

/**
 * 将工具执行过程中的输出写入对应卡片。
 *
 * 只保留末尾：一次构建可能输出数万行，全部保存会使内存占用与渲染开销不可接受。
 * 截断在合帧之后执行：按到达逐段截断会使同一份文本反复重排。
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
 * 外部 CLI 节点执行过程中的输出，累积在该节点自身上。
 *
 * 键由会话、卡片、节点三段组成：一张图中可以有多个 CLI 节点同时运行，
 * 只按卡片区分时它们的输出会混为一段，无法区分来源。
 */
function appendNodeOutput(key: string, chunk: string): void {
  const [cid, stepId, nodeId] = key.split(SEP)
  setState(
    produce((s) => {
      const card = s.views[cid ?? '']?.transcript.find((t) => t.id === stepId)
      if (!card || !nodeId) return
      const next = (card.cliOutput?.[nodeId] ?? '') + chunk
      // 与工具卡的 stdout 使用同一上限：更多内容无法阅读，只会增加内存与渲染开销。
      card.cliOutput = {
        ...(card.cliOutput ?? {}),
        [nodeId]: next.length > 8000 ? next.slice(-8000) : next,
      }
    }),
  )
}
const nodeFrames = createFramer({ write: appendNodeOutput, schedule })

/**
 * 思考正文按 step 识别所属条目，不按「末项是否为思考」识别：同一次调用中出现第二段思考时，
 * 后者会把它合并进第一段，而两段是分别到达的。
 *
 * 使用合帧器而不逐条写入：思考 token 每秒数十到上百条，四条子会话流同时打开时每条都同步写入
 * store，标签预览、`<pre>` 重设、滚动到末尾各执行一遍，主线程被占满，其他页面的点击响应出现延迟。
 */
function appendThinking(key: string, chunk: string): void {
  const [cid, stepId] = key.split(SEP) as [string, string]
  setState(
    produce((s) => {
      const items = s.views[cid]?.transcript
      if (!items) return
      const last = items[items.length - 1]
      if (last?.kind === 'thinking' && last.id === stepId) last.text += chunk
      else items.push({ id: stepId, kind: 'thinking', text: chunk })
    }),
  )
}
const thinkFrames = createFramer({ write: appendThinking, schedule })

/**
 * 不写入 transcript 的事件：它们不应 flush 正文缓冲。
 *
 * `git.state` 由服务端在握手时、切换项目时以及 `.git/HEAD` 变化时广播，
 * 新连接的客户端只能从该广播取得分支名。若它触发 flush，
 * 正文缓冲中的数十个字会在切换分支时一次性输出，打断匀速呈现。
 *
 * 该名单宁短勿长。遗漏一项只会多 flush 一次（短暂停顿）；多写一项会使需要写入
 * transcript 的事件读到只输出了一部分的正文，造成顺序错乱，比停顿严重得多。
 */
const OFF_TRANSCRIPT: ReadonlySet<AgentEvent['type']> = new Set(['git.state', 'tool.generating'])

/** 丢弃积压内容。切换会话、整段重新拉取时使用：积压文字的归属已不存在。 */
export function discardPace(): void {
  pacer.discard()
  toolFrames.discard()
  nodeFrames.discard()
  thinkFrames.discard()
}

/**
 * 把一帧折叠进 `state`。
 *
 * 归属只在此处判定一次。事件体不带 `conversationId`，归属记录在信封上。
 * 它决定该帧折叠进哪条会话（`state.views` 的一个键）；表中不存在的会话
 * （既不是当前会话，也不是右侧打开的子会话页）的帧整帧丢弃。不能假定「服务端只推送
 * 已订阅的会话」：`subscribe` 指令发出到服务端处理之间存在无法消除的时间窗口，
 * 该窗口内旧会话的事件仍会推送。
 *
 * 三种折叠函数按会话分工：
 *
 * - `foldContent`：会话的内容，包括正文、思考、工具卡、图卡、收尾条。
 *   每条接收事件的会话分别折叠，当前会话与它派发的子会话同时运行是常态。
 * - `foldConversationRunState`：每条会话运行中的用量、静默时刻与重试次数，按 cid
 *   写入各自的 view；父子页据此共用同一个运行条组件。
 * - `foldRunState`：只有当前会话使用的上下文、待办面板、目标、跟进队列与文件变化。
 *
 * 不要在每个 case 中补充归属判断：三十个分支意味着三十处可能遗漏（B4）。分工只在此处判定。
 *
 * `conversation.updated` 与 `conversation.busy` 在归属判定之前处理。它们修改的是左栏的
 * 会话列表，不是某条会话的内容，对后台会话同样有意义（标题、模型、忙闲）。统一按
 * 当前会话丢弃会使后台会话的标题始终停留在「新对话」。它们自身携带 `conversationId`，
 * 应按 id 精确路由。
 */
export function applyEvent(frame: EventEnvelope<AgentEvent>): void {
  const ev = frame.event

  /*
   * 先处理服务端创建的会话：列表中尚无该会话，按信封归属路由必然整帧丢弃，
   * 而该事件的作用正是让左栏显示这条会话。
   *
   * 丢弃其他项目的会话：插入后它在列表中外观正常，无法看出它属于另一个项目。
   */
  if (ev.type === 'conversation.created') {
    if (ev.conversation.workspaceId !== workspace()?.id) return
    setState(
      produce((s) => {
        if (s.conversations.some((c) => c.id === ev.conversation.id)) return
        s.conversations.unshift(ev.conversation)
      }),
    )
    return
  }

  // 先处理会话属性变更：它按自身的 id 查找列表项，与当前会话无关。
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
   * 忙闲同样在归属判定之前处理，理由同上：它修改的是左栏的会话列表。
   */
  if (ev.type === 'conversation.busy') {
    settleBusy(ev.conversationId, ev.busy)
    return
  }

  /*
   * 内置浏览器能力：进程级事件，与握手中的 `capabilities.browser` 是同一份投影。
   *
   * 原生宿主在应用启动之后才连接，只依赖握手中的那一份时，界面要等到下一次重连
   * 才能显示浏览器入口。同样在归属判定之前处理：它不属于任何会话。
   */
  if (ev.type === 'browser.state') {
    setState('capabilities', (caps) => (caps ? { ...caps, browser: ev.browser } : caps))
    return
  }

  /*
   * 电脑控制能力与桌面占用快照：全局接收，目标快照自带所属会话。切换到后台会话时
   * 可以立即读取它的目标，运行条只使用当前会话的那一份。
   *
   * 目标应用以服务端推送的值为准，前端不自行推断何时清空：执行者释放、
   * 宿主断开、能力下线三条路径服务端都会推送 `null`，前后端各自判定必然在某条路径上不一致。
   */
  if (ev.type === 'desktop.state') {
    setState('capabilities', (caps) => (caps ? { ...caps, desktop: ev.desktop } : caps))
    return
  }
  if (ev.type === 'desktop.target') {
    setState('desktopTarget', ev.target)
    return
  }

  /*
   * 画布卡片的运行状态：工作区级事件，与 `git.state` 相同，丢弃其他项目的事件。
   * 在归属判定之前处理：它不属于任何会话，也不应 flush 正文缓冲。
   */
  if (ev.type === 'canvas.run') {
    if (ev.workspaceId === workspace()?.id) setState('canvasVersion', (n) => n + 1)
    return
  }

  const from = frame.conversationId
  // 没有归属的是工作区级事件（如 git 状态），按当前会话处理。
  const mine = !from || from === state.activeConversation
  if (from && !state.views[from]) return

  /*
   * 写入 transcript 的事件都要求此刻的界面内容完整：读数条、错误卡与
   * 工具卡读取同一份 transcript，不能读到只输出了一部分的正文。
   *
   * 增量事件不触发 flush：正文由节拍器输出，工具输出与思考由合帧器输出，它们触发 flush 等于
   * 关闭对应的缓冲层。`tool.delta` 尤其不能 flush 正文：它按 stepId 修改已存在的
   * 卡片，不改动 transcript 末项，没有顺序风险，且每秒可达数百条。
   */
  const streaming =
    ev.type === 'text.delta' || ev.type === 'tool.delta' || ev.type === 'thinking.delta'
  if (!streaming && !OFF_TRANSCRIPT.has(ev.type)) {
    pacer.flush()
    toolFrames.flush()
    nodeFrames.flush()
    thinkFrames.flush()
  }

  const cid = from ?? state.activeConversation
  if (cid) {
    foldContent(cid, ev)
    foldConversationRunState(cid, frame.seq, ev)
  }
  if (mine) foldRunState(ev)
}

/**
 * 折叠会话的内容。分工见 `applyEvent` 的说明。
 *
 * 每个写入点都先读取 `s.views[cid]`，读取不到时整条不写入：表由 `openView` 建立，
 * 而切换会话、关闭子会话页都会立即撤销表（`dropView`），撤销之后到达的帧
 * 已没有归属。
 */
function foldContent(cid: string, ev: AgentEvent): void {
  switch (ev.type) {
    case 'team.member':
      setState(
        produce((s) => {
          const card = s.views[cid]?.transcript.find((t) => t.id === ev.stepId)
          if (!card) return
          // 整体替换而不修改字段：卡片按 `nodes` 的引用重新渲染，连线随状态一同更新。
          card.nodes = { ...(card.nodes ?? {}), [ev.nodeId]: ev.state }
        }),
      )
      if (NODE_SETTLED.has(ev.state.phase)) void refreshLatestChangeTurn(cid)
      return

    case 'message.injected':
      setState(
        produce((s) => {
          // id 使用 stepId：与刷新后 `stepToItems` 重建的条目同源，不会短暂出现重复。
          // 形态也按 `origin` 区分，与 `stepToItems` 规则相同：只在一处区分时，实时渲染为气泡、
          // 刷新后同一条变为回执行。
          s.views[cid]?.transcript.push(
            ev.origin
              ? { id: ev.stepId, kind: 'receipt', text: ev.content, origin: ev.origin }
              : {
                  id: ev.stepId,
                  kind: 'user',
                  text: ev.content,
                  ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
                },
          )
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
          v.runUserMessageId = ev.userMessageId
          /*
           * 对齐本轮回答所对应的用户气泡。
           *
           * 界面上按回车发送的气泡由客户端乐观插入，带有 `local_` 前缀的本地 id；
           * 而目标自动继续、定时触发、跟进消息自动发送三条路径没有客户端动作，气泡只能来自该
           * 事件。两种情况按同一规则处理：末条气泡带有本地 id 且正文一致时才把 id
           * 替换为账本中的真值，否则补充一条；补充后实时状态与刷新后从账本投影的状态
           * id 相同。
           *
           * 本地 id 条件不能省略。只比较正文时，若同一会话中重复发送同一段正文
           * （定时任务每次发送同一句 prompt），第二轮会认领上一轮已落库的
           * 气泡，界面上缺少本轮的用户消息。
           *
           * 由回执发起的轮次不做对齐：它没有乐观插入的气泡可对齐，形态也不是气泡。
           */
          if (ev.userMessage && ev.userMessageId && ev.userMessage.origin) {
            v.transcript.push({
              id: ev.userMessageId,
              kind: 'receipt',
              text: ev.userMessage.content,
              origin: ev.userMessage.origin,
            })
          } else if (ev.userMessage && ev.userMessageId) {
            let last = v.transcript.length - 1
            while (last >= 0 && v.transcript[last]!.kind !== 'user') last--
            const hit = last >= 0 ? v.transcript[last]! : null
            if (hit?.id.startsWith(LOCAL_ID_PREFIX) && hit.text === ev.userMessage.content) {
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

    // 思考与正文分别合帧，先到达的先写入：正文到达时先写入缓冲中的思考，反之亦然，
    // 否则同一次回复中的「思考 → 正文 → 第二段思考」会以错误顺序写入。
    case 'text.delta':
      thinkFrames.flush()
      pacer.push(bufKey(cid, ev.stepId), ev.delta)
      return

    case 'thinking.delta':
      pacer.flush()
      thinkFrames.push(bufKey(cid, ev.stepId), ev.delta)
      return

    case 'run.retrying': {
      if (ev.failedThinkingStepIds.length === 0) return
      const failed = new Set<string>(ev.failedThinkingStepIds)
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          // 重发事件携带 AgentLoop 本次尝试实际创建的 step id。不能按「末尾的思考」删除：
          // 同一 run 的前几个工具轮也有已完成的思考，按位置删除会把有效内容一并删除。
          v.transcript = v.transcript.filter(
            (item) => item.kind !== 'thinking' || !failed.has(item.id),
          )
        }),
      )
      return
    }

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
      nodeFrames.push(bufKey(cid, ev.stepId, ev.nodeId), ev.delta)
      return

    case 'tool.finished':
      if (
        [
          'import_skill',
          'write_skill',
          'move_skill',
          'write_mcp_server',
          'move_mcp_server',
        ].includes(
          state.views[cid]?.transcript.find((item) => item.id === ev.stepId)?.toolName ?? '',
        )
      )
        invalidateExtensions()
      setState(
        produce((s) => {
          const v = s.views[cid]
          const item = v?.transcript.find((t) => t.id === ev.stepId)
          if (!v || !item) return
          item.status = ev.status === 'success' ? 'success' : 'failure'
          item.outcome = ev.outcome
          item.durationMs = ev.durationMs
          // 变更面板已读取过时才追加；未读取过的在打开时从账本整页读取。没有用户消息的轮次
          // 服务端也不计入（`listConversationChangesPage` 只选择有 user_message_id 的 run）。
          if (v.changes && v.runUserMessageId && ev.outcome.fileChanges?.length) {
            const message = v.transcript.find((t) => t.id === v.runUserMessageId)
            appendChange(
              v.changes,
              {
                userMessageId: v.runUserMessageId,
                text: message?.text ?? '',
                origin: message?.kind === 'receipt' ? (message.origin ?? null) : null,
              },
              {
                id: ev.stepId,
                toolName: item.toolName ?? '',
                ...(item.args ? { args: item.args } : {}),
                fileChanges: ev.outcome.fileChanges,
                via: null,
              },
            )
          }
        }),
      )
      return

    case 'compaction':
      setState(
        produce((s) => {
          const items = s.views[cid]?.transcript
          if (!items) return
          // 压缩是会话管理的可见事件，不能静默发生：用户需要据此了解
          // 模型为何不再记得之前的对话内容。
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
           * 不要在此处清除「运行中」。终态由服务端的 `conversation.busy`
           * 给出：loop 之外抛出的错误（未配置 API key、档案解析失败）没有
           * `run.finished`，但 `run-control.ts` 的 finally 必定执行 unregister /
           * release，这两处是忙闲的唯一裁决点。在此处补充客户端判断，
           * 会使「哪条会话在运行」形成第二份记录。
           */
        }),
      )
      return

    case 'run.finished':
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          // 收尾读数写入为一个条目，不写入全局字段：每轮一条，
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
              // 前一条 `run.error` 的正文（总是在 finished 之前到达）。服务端同时
              // 将它写入 `runs.error_message`，刷新后由投影层原样恢复。
              errorMessage: v.error?.message ?? null,
            },
          })
          /*
           * 错误正文已交给本轮的条目，须清除会话上的错误。
           *
           * 不清除时同一句话同时显示在读数条与错误卡上，用户会看到两遍。
           * 错误卡只用于没有 run 收尾条可附加的情况（未配置 key、
           * 档案解析失败），这些情况不会执行到此处。
           */
          v.error = null
          v.runStartedAt = null
        }),
      )
      // 本轮执行完毕，重新读取该轮的变更：实时回执逐条追加，无法折叠出整轮的净效果。
      void refreshLatestChangeTurn(cid)
      return

    default:
      return
  }
}

/**
 * 把一条事件折叠进当前请求投影。序号不大于投影当前序号的事件一律丢弃：
 * 快照与实时事件经由同一路径进入，先后只由序号裁决（见 `RequestProjection.seq`）。
 */
function writeRequest(
  cid: string,
  seq: number,
  next: (prev: RequestProjection | null) => RequestProjection | null,
  generatingToolCall?: boolean,
): void {
  setState(
    produce((s) => {
      const v = s.views[cid]
      if (!v) return
      if (v.request && seq <= v.request.seq) return
      const request = next(v.request)
      v.request = request
      if (generatingToolCall !== undefined) v.generatingToolCall = generatingToolCall
    }),
  )
}

/**
 * 每条已订阅会话各自的运行中读数。它与正文同样按 cid 归属，主会话与子会话
 * 因此能复用同一个状态条，而不会把父会话的 token、请求阶段或重试次数显示为子会话的读数。
 *
 * `generatingToolCall` 随同一批事件更新：它表示最后一段内容是否为工具参数，
 * 与阶段不是同一个问题，因此保留为独立字段，但只由此处写入。
 */
function foldConversationRunState(cid: string, seq: number, ev: AgentEvent): void {
  switch (ev.type) {
    case 'run.started':
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          v.usage = null
          v.request = null
          v.generatingToolCall = false
        }),
      )
      return

    case 'run.request':
      writeRequest(
        cid,
        seq,
        (prev) => ({
          requestId: ev.requestId,
          attempt: ev.attempt,
          max: ev.max,
          phase: ev.phase,
          // 发出即结束等待：清除截止点，保留次数。
          backoffUntil: null,
          sentAt:
            ev.phase === 'sent'
              ? ev.at
              : prev?.requestId === ev.requestId
                ? (prev?.sentAt ?? null)
                : null,
          headersAt: ev.phase === 'headers' ? ev.at : null,
          lastContentAt: null,
          lastContentKind: null,
          lastVisibleAt: null,
          seq,
        }),
        false,
      )
      return

    case 'run.retrying':
      writeRequest(
        cid,
        seq,
        () => ({
          requestId: ev.requestId,
          attempt: ev.attempt,
          max: ev.max,
          phase: 'backoff',
          backoffUntil: ev.at + ev.backoffMs,
          sentAt: null,
          headersAt: null,
          lastContentAt: null,
          lastContentKind: null,
          lastVisibleAt: null,
          seq,
        }),
        false,
      )
      return

    case 'thinking.delta':
    case 'text.delta':
    case 'tool.generating': {
      const kind =
        ev.type === 'thinking.delta'
          ? 'thinking'
          : ev.type === 'text.delta'
            ? 'text'
            : 'tool_arguments'
      /*
       * 内容事件不带 requestId，因此只更新已有投影的阶段与最后内容时刻。
       * 没有投影时不生成请求阶段：这表示 `run.request` 尚未到达（首屏加载期间），
       * 补充 requestId 与次数属于编造；内容类型仍可供当前思考折叠显示。
       */
      writeRequest(
        cid,
        seq,
        (prev) =>
          prev
            ? {
                ...prev,
                phase: 'content',
                lastContentAt: ev.at,
                lastContentKind: kind,
                lastVisibleAt:
                  ev.type === 'tool.generating' || ev.delta.length === 0
                    ? prev.lastVisibleAt
                    : ev.at,
                seq,
              }
            : null,
        ev.type === 'tool.generating',
      )
      return
    }

    case 'usage':
      setState('views', cid, 'usage', ev.usage)
      return

    case 'tool.started':
      setState('views', cid, 'generatingToolCall', false)
      return

    case 'run.error':
    case 'run.finished':
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          if (ev.type === 'run.finished') v.usage = null
          v.request = null
          v.generatingToolCall = false
        }),
      )
      return

    default:
      return
  }
}

/**
 * 当前会话独有的外围状态：待办、目标、跟进队列、上下文与本轮修改的文件。
 *
 * 只有当前会话的事件会执行到此处，原因见 `applyEvent`。
 */
function foldRunState(ev: AgentEvent): void {
  switch (ev.type) {
    case 'queue.changed':
      // 整体替换：服务端发送的是队列的当前完整状态，本地的乐观卡片按相同 id 被覆盖。
      setState('followUps', ev.queue)
      return

    case 'message.injected':
      // 移除对应卡片：队列的权威仍是 `queue.changed`，此处提前移除是为了
      // 避免卡片与气泡同时出现（服务端两条事件之间间隔一次落库）。
      setState('followUps', (list) => list.filter((f) => f.id !== ev.followUpId))
      return

    case 'todos':
      // 整表替换而不合并：工具一侧按整表提交，
      // 在此处做增量合并会使两端对待办清单的内容产生两种理解。
      setState('todos', ev.todos)
      return

    case 'goal':
      // 整体替换：事件携带账本更新后的完整快照（revision 单调递增），
      // 按字段合并会在此处形成第二种目标状态。
      setState('goal', ev.goal)
      return

    case 'run.started':
      setState(
        produce((s) => {
          s.notice = null
          s.fileChanges = []
          // 不清除待办：它是会话的进度，不是本轮的临时读数，
          // 一轮完成三项、下一轮继续第四项是常态。清除后，中断再继续时
          // 清单会整体消失，直到模型下次整表提交才恢复（`write_todos` 是整表语义，
          // 不一定每轮都调用）。此处清空的都是「执行完毕即失效」的读数
          // （用量、错误、本轮修改的文件），待办不属于此类。
          s.lastRunId = ev.runId
        }),
      )
      return

    case 'file.changed':
      setState(
        produce((s) => {
          // 即使 `changes` 为空也要递增版本：空数组表示执行类工具使文件快照失效，
          // 但没有可靠的逐路径增删明细，不能为刷新 UI 伪造一条变更。
          s.fileVersion += 1
          s.fileChanges.push(...ev.changes)
        }),
      )
      return

    case 'context':
      setState('context', {
        source: ev.source,
        tokens: ev.tokens,
        limit: ev.limit,
        percent: ev.percent,
        compactAt: ev.compactAt,
        breakdown: ev.breakdown,
        omitted: ev.omitted,
        unmeasuredVideos: ev.unmeasuredVideos ?? 0,
      })
      return

    case 'git.state':
      // 这是工作区级事件，经由全局广播（没有会话可归属，总线对它一律放行）。
      // 同时打开多个项目时，必须丢弃其他项目的分支名：
      // 它的外观完全正常，覆盖后无法看出它属于其他项目。
      if (ev.workspaceId !== workspace()?.id) return
      setState('git', { workspaceId: ev.workspaceId, branch: ev.branch })
      return

    default:
      return
  }
}

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
  nextCursor: string | null
  /** 运行中的轮次与当前请求的只读快照；没有 run 运行时为 null。 */
  live: ConversationLiveSnapshot | null
}

/**
 * 把刷新快照折叠为投影。阶段由时刻派生，四条判据与实时事件一一对应：
 * 有退避截止点表示等待重试，有内容时刻表示正在输出内容，有响应头表示等待内容，其余表示刚发出。
 *
 * 已失败且不在等待重试的请求不生成投影。它是本轮最后一次请求，
 * 重发预算已耗尽，显示「正在请求」与事实不符；收尾条随后会带着停止原因写入会话流。
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
    phase,
    backoffUntil: r.backoffUntil,
    sentAt: r.sentAt,
    headersAt: r.headersAt,
    lastContentAt: r.lastContentAt,
    lastContentKind: r.lastContentKind ?? null,
    lastVisibleAt: r.lastVisibleAt ?? null,
    seq: live.seq,
  }
}

/**
 * 把快照写入一条会话的投影。
 *
 * 序号小于现有投影的快照整体丢弃：加载期间先到达的实时事件比它新。
 * `live` 为 null 表示服务端当前没有该会话的 run，投影随之清空。
 */
function restoreRequest(v: ConversationView, live: ConversationLiveSnapshot | null): void {
  if (!live) {
    v.request = null
    v.generatingToolCall = false
    return
  }
  if (v.request && live.seq < v.request.seq) return
  v.request = projectLive(live)
  v.generatingToolCall = v.request?.lastContentKind === 'tool_arguments'
}

/** 将一页折叠为会话流：首次派发先进入会话流，其自身的行由 workflow 折叠隐藏，只用于完整渲染 workflow 卡片。 */
function foldPage(page: HistoryPage): TranscriptItem[] {
  return [...page.workflowStarts.flatMap(stepToItems), ...foldTranscript(page)]
}

// 600 轮、16.9 MiB 量级会话的实测：每页 30 轮时首屏虽能在 400ms 内显示第一行，
// 但后续 Markdown 挂载仍占用主线程约 2.8s，快速切换到下一条会话时需要等待。每页 10 轮可将单页
// 控制在约 300 KiB；历史记录完整保留，只缩小向前加载的粒度。
const HISTORY_PAGE_SIZE = 10
const HISTORY_TIMEOUT_MS = 15_000

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
  for (const m of messages) {
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
    error: null,
  })
  const lease = beginHistoryLoad(id)
  try {
    const page = await fetchConversationPage(id, null, lease.controller.signal)
    if (canceledByNewerRequest(lease)) return
    const items = foldPage(page)
    const live = state.busyConversations.includes(id)
      ? (page.runs.find((run) => run.status === 'running') ?? null)
      : null
    setState(
      produce((s) => {
        const v = s.views[id]
        if (!v) return
        // 建表到本次拉取返回之间到达的条目接在后面，按 id 去重。同一个 step
        // 两边都有时以账本为准：事件中的版本可能只输出了一部分（正文仍在流式输出）。
        const known = new Set(items.map((i) => i.id))
        v.transcript = [...items, ...v.transcript.filter((i) => !known.has(i.id))]
        v.history = { loading: null, nextCursor: page.nextCursor, error: null }
        restoreRequest(v, page.live)
        if (live) {
          v.runStartedAt ??= live.createdAt
          v.usage ??= live.usage
        } else if (!s.busyConversations.includes(id)) {
          v.runStartedAt = null
          v.usage = null
        }
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

// ───────────────────────── 变更面板 ─────────────────────────

const CHANGES_PAGE_SIZE = 10
/** 派发任务的节点进入这些状态后不再写入文件。 */
const NODE_SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'skipped', 'interrupted'])

async function fetchChangesPage(
  id: string,
  before: string | null,
  limit = CHANGES_PAGE_SIZE,
): Promise<Pick<ChangesView, 'turns' | 'totals' | 'nextCursor'>> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (before) query.set('before', before)
  const page = await client.api<ConversationChangesPageResponse>(
    `/api/conversations/${id}/changes?${query}`,
    { signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) },
  )
  return { turns: page.turns, totals: page.totals, nextCursor: page.nextCursor }
}

/**
 * 重新读取最新一轮及整条会话的合计。两处调用：
 *
 * - 派发任务的节点进入终态：子 agent 的写入位于其自身的子会话中，父会话收不到对应回执；
 *   外部 CLI 的写入记录在该节点上。两者都由服务端投影归入父轮次。
 * - 本轮执行完毕：实时回执逐条追加，记录的是每次报告的内容；而面板上的一行
 *   是整轮的净效果（`foldFileChanges`），一轮中先创建后删除的路径会立即从行上消失，
 *   合计却仍计入它。服务端的数据两处都已折叠，重新读取一次即可统一为折叠后的口径。
 *
 * `limit=1` 取得最新一个有写入的轮次：本轮有写入时即为本轮；否则取得更早的轮次，替换后不产生变化。
 * 未打开过变更面板的会话没有该表，立即返回，不发送请求。
 */
async function refreshLatestChangeTurn(id: string): Promise<void> {
  const changes = state.views[id]?.changes
  if (!changes || changes.loading !== null) return
  try {
    const page = await fetchChangesPage(id, null, 1)
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (!c) return
        c.totals = page.totals
        for (const turn of page.turns) {
          const at = c.turns.findIndex((t) => t.userMessageId === turn.userMessageId)
          if (at >= 0) c.turns[at] = turn
          else c.turns.unshift(turn)
        }
      }),
    )
  } catch (error) {
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (c) c.error = changesErrorMessage(error)
      }),
    )
  }
}

function changesErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return '加载历史记录超时，请重试'
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把一条写入合并进变更面板。相同 id 不重复加入：首页请求进行中到达的事件会与响应重叠。
 * 本轮尚无分节时新建一节放在最前：实时到达的写入必定属于最新的轮次。
 */
function appendChange(
  changes: ChangesView,
  seed: Pick<ChangeTurn, 'userMessageId' | 'text' | 'origin'>,
  step: ChangeStep,
): void {
  if (changes.turns.some((t) => t.steps.some((s) => s.id === step.id))) return
  let turn = changes.turns.find((t) => t.userMessageId === seed.userMessageId)
  if (!turn) {
    turn = { ...seed, createdAt: Date.now(), steps: [] }
    changes.turns.unshift(turn)
  }
  turn.steps.push(step)
  for (const c of step.fileChanges) {
    if (!changes.totals.paths.includes(c.path)) changes.totals.paths.push(c.path)
    changes.totals.additions += c.additions ?? 0
    changes.totals.deletions += c.deletions ?? 0
  }
}

/**
 * 变更面板首页。面板打开时调用；已读取或正在读取时不再读取，之后由实时追加保持更新。
 * 失败后再次调用即重试：从首页重新开始，已加载的更早分页由哨兵重新读取。
 *
 * 写入时以账本页为准：请求期间实时追加的写入按 step id 去重后合并回去，
 * 合计取账本值再加上未合并的条目，与 `loadOlderConversation` 的去重口径相同。
 */
export async function loadConversationChanges(id: string): Promise<void> {
  const current = state.views[id]
  if (!current) return
  if (current.changes && (current.changes.loading !== null || current.changes.error === null))
    return
  if (current.changes) {
    setState('views', id, 'changes', { loading: 'initial', error: null })
  } else {
    setState('views', id, 'changes', {
      turns: [],
      totals: { paths: [], additions: 0, deletions: 0 },
      nextCursor: null,
      loading: 'initial',
      error: null,
    })
  }
  try {
    const page = await fetchChangesPage(id, null)
    setState(
      produce((s) => {
        const changes = s.views[id]?.changes
        if (!changes) return
        const known = new Set(page.turns.flatMap((t) => t.steps.map((step) => step.id)))
        const pending = changes.turns.map((turn) => ({
          turn,
          steps: turn.steps.filter((step) => !known.has(step.id)),
        }))
        changes.turns = page.turns
        changes.totals = page.totals
        changes.nextCursor = page.nextCursor
        changes.loading = null
        for (const { turn, steps } of pending) {
          for (const step of steps) appendChange(changes, turn, step)
        }
      }),
    )
  } catch (error) {
    setState(
      produce((s) => {
        const changes = s.views[id]?.changes
        if (!changes) return
        changes.loading = null
        changes.error = changesErrorMessage(error)
      }),
    )
  }
}

/** 再向前读取一页写入过文件的轮次。没有更早的轮次或正在读取时直接返回 false。 */
export async function loadOlderConversationChanges(id: string): Promise<boolean> {
  const changes = state.views[id]?.changes
  if (!changes || changes.loading !== null || !changes.nextCursor) return false
  const before = changes.nextCursor
  setState('views', id, 'changes', { loading: 'older', error: null })
  try {
    const page = await fetchChangesPage(id, before)
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (!c) return
        c.turns.push(...page.turns)
        c.nextCursor = page.nextCursor
        c.loading = null
      }),
    )
    return true
  } catch (error) {
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (!c) return
        c.loading = null
        c.error = changesErrorMessage(error)
      }),
    )
    return false
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
 * 正在接收事件的会话：当前会话，以及右侧打开的子会话页。
 *
 * 表的键与报告给服务端的订阅集是同一份派生值，不在两处分别记录：已报告但未建表的
 * 会话，事件到达时会被整帧丢弃（`applyEvent` 的归属判定）；已建表但未报告的会话，
 * 收不到任何内容。两者都由此处生成。
 *
 * 先建表后撤表：中间状态下两条会话都在表中，优于先撤后建时两条都不在表中的状态，
 * 后者在该时刻到达的帧会被丢弃。
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
  // 未变化时不报告：本函数既由下方的 effect 触发，也在切换会话的路径上被显式调用一次，
  // 同一组会话报告两次只会产生两条无效指令。
  const line = [...want].sort().join(',')
  if (line === reported) return
  reported = line
  client.subscribe([...want])
}

/*
 * 打开的页面由 `ui.ts` 中的信号描述，因此订阅集在此处跟随该信号更新。
 * 不能反过来由 `ui.ts` 调用此处：连接层已经引用了它（`workspace`），必须避免两个模块
 * 互相 import。切换会话的路径另有一次显式调用，原因见 `selectConversation`。
 */
createRoot(() => createEffect(syncViews))

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
  // 整段重新拉取之前丢弃积压内容而不是 flush：积压文字属于重新拉取之前的
  // transcript，flush 只会在新投影的末尾多出一段没有归属的正文。
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
      // 上下文面板由账本即时计算，不要直接设置 `s.context = null`：否则刷新或
      // 切换会话后面板为空，而用户回看时才需要查询上下文的占用构成。
      // 拉取失败不影响会话本身能否打开，降级为不显示面板。
      client
        .api<{ context: StoredContextPanel }>(`/api/conversations/${id}/context`, {
          signal: lease.controller.signal,
        })
        .then((r) => r.context)
        .catch(() => null),
      // 目标同理且更为重要：自动继续标记不落盘，进程重启后账本中处于 active
      // 的目标不会自动继续执行，只能等待用户点击继续。此处不读取时，界面上
      // 无法显示存在一个已暂停的目标，用户会认为出现了故障。
      client
        .api<{ goal: Goal | null }>(`/api/conversations/${id}/goal`, {
          signal: lease.controller.signal,
        })
        .then((r) => r.goal)
        .catch(() => null),
      // 排队中的跟进消息。它只存在于服务端进程中，刷新与重连后卡片完全依靠本次拉取重建；
      // 与 `queue.changed` 同源（都读取 `RunManager`），快照与增量不会不一致。
      client
        .api<{ queue: FollowUp[] }>(`/api/conversations/${id}/queue`, {
          signal: lease.controller.signal,
        })
        .then((r) => r.queue)
        .catch(() => []),
    ])

    const { runs } = folded
    const items = foldPage(folded)

    // 较慢的请求不得写入。快速连续点击 A→B 时，两次重新拉取并发进行，后返回者覆盖先返回者，
    // 导致标题与订阅属于 B、正文却属于 A。这与信封携带 conversationId 所解决的
    // 「切换会话后内容仍属于上一条会话」是同一问题，出现在 REST 投影路径上。
    if (state.activeConversation !== id || canceledByNewerRequest(lease)) return

    /*
     * run 作用域的状态一律从此处派生，不依赖事件残留。
     *
     * 这些字段（lastRunId / todos / context）只有当前会话的一份，
     * 没有所属会话这一维度。切换会话时若只重置正文流，它们会连同上一条会话的
     * run 一起留在界面上；而上一条会话的表在切换时即被撤销（`dropView`），
     * 其 run 的 `run.finished` 在结构上不可能再到达，
     * 因此这些字段永远不会被清除。
     *
     * 所以不在 `selectConversation` 中维护一份「需要重置的字段」清单：
     * 每新增一个字段，该清单就可能遗漏一次。真源是 runs 表，而此处本身就在拉取它。
     *
     * 「是否在运行」不在此列：`busyConversations` 本身带有会话维度，
     * 切换会话即读取另一项，无需重置。此处也不得按 runs 表补写一份：
     * 服务进程崩溃后账本中的行可能仍处于 `running`，按它写入会使界面永久
     * 停留在执行中，而 `RunManager` 中早已没有该 run。
     */
    const live = state.busyConversations.includes(id)
      ? (runs.find((r) => r.status === 'running') ?? null)
      : null

    setState(
      produce((s) => {
        const v = s.views[id]
        if (v) {
          // 请求期间到达的实时事件接在账本页之后；相同 id 以账本为准。
          const known = new Set(items.map((item) => item.id))
          v.transcript = [...items, ...v.transcript.filter((item) => !known.has(item.id))]
          v.history = { loading: null, nextCursor: folded.nextCursor, error: null }
          v.runStartedAt = live ? live.createdAt : null
          v.runUserMessageId = live?.userMessageId ?? null
          v.usage = live?.usage ?? null
          // 当前请求的阶段、次数与内容时刻从同一份请求记录读取，不按重新拉取的时刻生成。
          restoreRequest(v, folded.live)
          // 报错正文随收尾条显示，重新投影后收尾条已携带它（见 `foldTranscript`）。
          v.error = null
        }
        s.followUps = queue
        s.lastRunId = live?.id ?? null
        // 待办从同一份 steps 账本投影得到，不新增持久化路径。
        // 若只存在于 WS 事件中，刷新或切换会话后再切回就会丢失。`write_todos` step
        // 提交整表，之后明确绑定的成功 `subagent` step 更新单项；历史接口已按此
        // 顺序折叠为当前快照，此处只接收，不在前端重新推算。
        s.todos = folded.todos
        // 目标有独立的账本（`goal_events`），因此直接读取，不像待办那样从
        // steps 反推：反推会为目标状态形成第二个真源。
        s.goal = goal
        // 上下文不从 steps 推算：它有独立的账本（`provider_requests`），
        // 不是 run 内的易失投影。
        // 新会话显示 0%，而不是不显示面板：后端未发送任何请求时也知道窗口大小。
        // 只有本次拉取失败（上方 catch 返回 null）时才降级为不显示。
        s.context = ctx
          ? {
              tokens: ctx.total,
              source: ctx.source,
              limit: ctx.limit,
              percent: ctx.percent,
              compactAt: ctx.compactAt,
              breakdown: ctx.breakdown,
              omitted: ctx.omitted,
              // 读取的是账本中的读数，不对应正在发送的请求，因此没有未计入的视频。
              unmeasuredVideos: 0,
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
    // 失败尝试中不完整的思考保留在账本中供诊断，但已被随后的重发取代。普通会话流只显示
    // 最终采用的生成；否则刷新后两段不完整的句子会重新出现，实时状态与回放状态也不一致。
    return s.status !== 'failure' && s.content
      ? [{ id: s.id, kind: 'thinking', text: s.content }]
      : []
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
        id: s.id,
        kind: 'compaction',
        text: '',
        compaction: {
          phase: p.phase,
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
    // action 来自后端落库的解析结果，是卡片的完整标题（动词 + 对象 + 目标）。
    // `ToolSpec` 的 `actionKind` / `objectLabel` 均为必填，因此 action 必定存在。
    // 不要为缺失情况添加回退：回退为 `execute` 会使刷新后整轮的读取文件操作
    // 全部显示为「执行」；回退为工具名则会为同一件事另造一套显示。
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
        // 存量行没有该数值，此时不显示耗时，不编造数值。
        ...(s.durationMs === null ? {} : { durationMs: s.durationMs }),
      },
    ]
  }
  return []
}
