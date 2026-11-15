/**
 * 连接层：为唯一的 `QyClient` 实例（`client.ts`）接入回调，并把收到的事件帧交给事件处理表
 * （`events/table.ts`）。
 */

import type { AgentEvent, CommandRejectedFrame, EventEnvelope } from '@qywork/core'
import { produce } from 'solid-js/store'
import type { ConnectionState } from '../client.ts'
import { wireClient } from './client.ts'
import type { Entry } from './events/handler.ts'
import { flushPace } from './events/pace.ts'
import { EVENT_HANDLERS } from './events/table.ts'
import { refundBusy, setState, state, syncBusy } from './state.ts'
import { reloadActiveConversation } from './views/history.ts'

/**
 * 连接状态写入 `state`。经 console 打开时本页在 iframe 中，握手被拒（电脑端重启后令牌改变）与断线重连时
 * 以 `qywork.connection` 通知 console：前者由 console 重新取得令牌并刷新本页，后者由 console 查询电脑是否
 * 仍在线、已移除时改为显示对应状态。消息只含状态名、不含令牌，因此不限定接收方的来源。
 */
export function onConnectionState(s: ConnectionState, detail?: string): void {
  setState({ connection: s, connectionDetail: detail ?? '' })
  if ((s === 'unauthorized' || s === 'reconnecting') && window.parent !== window) {
    window.parent.postMessage({ type: 'qywork.connection', state: s }, '*')
  }
}

wireClient({
  onState: onConnectionState,
  onCapabilities: (caps) => setState('capabilities', caps),
  // 握手携带的忙闲快照直接整表替换：它是服务端当前的完整状态，不是增量。
  onBusy: (ids) => syncBusy(ids),
  onResync: () => {
    // 无法补齐缺口：清空本地投影并重新拉取，不在不完整的 transcript 上继续。
    // 缺口两侧或新旧两段事件流的序号不可比较，实时读数的序号归零，由重新拉取的快照重新确定；
    // 不归零时，服务端重启后序号从头开始，新事件与新快照都会被判为旧数据而丢弃。
    setState(
      produce((s) => {
        for (const v of Object.values(s.views)) {
          v.liveSeq = 0
          v.runSeq = 0
        }
      }),
    )
    void reloadActiveConversation()
  },
  onStreamChanged: () => {
    /*
     * 桌面源码开发采用「前后端原子换代」：Vite 不先热替换页面，所有源码改动都先
     * 等待当前 run 执行完毕，再由 dev.ts 重启 sidecar。streamId 变更是后端换代完成的
     * 可靠信号，此时刷新整页，才会加载与后端同一版本源码的 UI。
     * 该标志由 dev.ts 设置，同时作用于 Vite 页面与 dev.ts 为远程访问构建的产物：
     * 开发实例的令牌在换代间不变，远程页面不会经 `unauthorized` 重新打开，只能在此刷新。
     *
     * 不能把刷新挂到普通 reconnect 或 resync 上：网络闪断也会触发这两条路径，
     * 手机端与打包版不应因此整页刷新。
     */
    if (import.meta.env.VITE_QYWORK_COORDINATED_RELOAD === '1') {
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

/** 未知事件类型的条目：没有处理器，只经过归属判定与 flush。 */
const UNKNOWN_EVENT: Entry<AgentEvent> = {}

/**
 * 把一帧交给该事件类型的条目，折叠进 `state`。
 *
 * 归属只在此处判定一次。事件体不带 `conversationId`，归属记录在信封上。
 * 它决定该帧折叠进哪条会话（`state.views` 的一个键）；表中不存在的会话
 * （既不是当前会话，也不是右侧打开的子会话页）的帧整帧丢弃。不能假定「服务端只推送
 * 已订阅的会话」：`subscribe` 指令发出到服务端处理之间存在无法消除的时间窗口，
 * 该窗口内旧会话的事件仍会推送。
 *
 * 条目按形状分工（`events/handler.ts`）：
 *
 * - `process`：不属于任何会话的事件，在归属判定之前处理，不 flush 缓冲。
 * - `conversation`：折叠进归属会话的视图。每条接收事件的会话分别折叠，当前会话与它派发的
 *   子会话同时运行是常态。
 * - `active`：只有当前会话使用的外围状态，帧属于当前会话或没有归属时调用。
 *
 * 处理器中不要再判断归属：分散到各处理器后每一处都可能遗漏（B4）。分工只在此处判定。
 *
 * 写入 transcript 的事件都要求此刻的界面内容完整：读数条、错误卡与工具卡读取同一份
 * transcript，不能读到只输出了一部分的正文。因此折叠之前先 flush 全部缓冲，条目标注
 * `flush: false` 的除外。
 */
export function applyEvent(frame: EventEnvelope<AgentEvent>): void {
  const ev = frame.event
  /*
   * 界面与服务端的版本可能不同步：远程访问时界面可能是按设备缓存的较早副本，应用更新后
   * 服务端会发送该界面不认识的事件类型。未知事件按会话事件的规则判定归属并 flush 缓冲，
   * 随后忽略，不得抛出。
   */
  const entry =
    (EVENT_HANDLERS as Partial<Record<string, Entry<AgentEvent>>>)[ev.type] ?? UNKNOWN_EVENT
  if ('process' in entry) {
    entry.process(ev, frame.seq)
    return
  }

  const from = frame.conversationId
  // 没有归属的是工作区级事件（如 git 状态），按当前会话处理。
  const mine = !from || from === state.activeConversation
  if (from && !state.views[from]) return

  if (entry.flush !== false) flushPace()

  const cid = from ?? state.activeConversation
  if (cid) entry.conversation?.(ev, cid, frame.seq)
  if (mine) entry.active?.(ev)
}
