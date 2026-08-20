/**
 * WebSocket 握手：验令牌、报能力。
 *
 * 拒连只有一种原因，而且是终态——重连一万次带的还是同一个令牌，
 * 客户端据此不再退避重连。
 *
 * **这里不验协议版本。** 手写版本号想挡的漂移（客户端与 sidecar 不是同一批出的）
 * 已经从源头消灭：开发时两端都从同一棵源码树跑（`scripts/dev.ts`），
 * 打包时出自同一次构建。完整理由写在 `HelloFrame` 的注释里。
 */

import type { EventEnvelope, HelloFrame, HelloOkFrame } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { detectSandbox } from '@qywork/tools'
import type { ServerWebSocket } from 'bun'
import pkg from '../package.json' with { type: 'json' }
import { probeEnvironment } from './api/host.ts'
import type { EventBus, Subscriber } from './bus.ts'
import type { SocketData } from './deps.ts'
import type { RunManager } from './runs.ts'

/**
 * 本包版本。**真源是根 `VERSION`**，由 `bun run scripts/sync-version.ts` 灌进
 * 各包的 package.json；手写字面量不在那个脚本的覆盖范围里，升版本时会原地不动。
 */
const PKG_VERSION: string = pkg.version

export function handleHello(
  ws: ServerWebSocket<SocketData>,
  frame: HelloFrame,
  deps: {
    bus: EventBus
    token: string
    unsubscribers: Map<string, () => void>
    /** 传的是运行中的那一份（`/api/config` 的 PUT 会就地改它），不是启动时的快照。 */
    config: QyConfig
    /** 报「此刻哪几条会话在跑」的那份权威，见 `busyConversations`。 */
    runs: RunManager
  },
) {
  if (frame.token !== deps.token) {
    ws.send(JSON.stringify({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' }))
    ws.close(1008, 'unauthorized')
    return
  }
  ws.data.authed = true
  ws.data.origin = frame.origin

  /*
   * **先建订阅，再算补发。** 顺序不是风格问题：补发要按这个客户端订了哪些会话
   * 过滤，而订阅集就是过滤的判据。反着写的话补发那条路上根本没有判据可用——
   * 重连一次就把窗口里所有会话的事件灌进当前界面。
   *
   * `?? null` 而不是 `?? []`：没声明过订阅 = 全收（首连时界面还没选会话），
   * 空数组 = 明确不要任何会话事件。两者不是同一件事，见 `Subscriber.conversations`。
   */
  const subscriber: Subscriber = {
    id: ws.data.id,
    origin: frame.origin,
    conversations: frame.subscribe ? new Set(frame.subscribe) : null,
    send: (f) => ws.send(JSON.stringify(f)),
  }
  const off = deps.bus.subscribe(subscriber)
  deps.unsubscribers.set(ws.data.id, off)

  // 断线补发：缺口在保留窗口内就逐条补，补不上就让客户端重拉全量。
  // 「补不补得上」全由 `replayFrom` 裁决（含「这是不是我这条流上的位置」），
  // 这里只负责把结论转成帧上的两个字段。
  let resync = false
  let backlog: EventEnvelope[] = []
  if (frame.resume) {
    const replay = deps.bus.replayFrom(frame.resume, subscriber)
    if (replay === null) resync = true
    else backlog = replay
  }

  const ok: HelloOkFrame = {
    type: 'hello.ok',
    serverVersion: PKG_VERSION,
    sessionId: ws.data.id,
    streamId: deps.bus.streamId,
    currentSeq: deps.bus.currentSeq,
    resync,
    /*
     * 在跑的会话**逐条报出来**，此后由 `conversation.busy` 事件维持。
     * 少了这一份，缺口补不上（`resync`）的那次重连之后，客户端手里还是断线前
     * 那份——那几轮早跑完了，左栏却会一直转下去。
     */
    busyConversations: deps.runs.busyConversations(),
    /*
     * **只报进程级的能力。** 插件 / MCP / 编排后端是按工作区的，而这条连接
     * 横跨用户开着的所有项目——报在这里就等于「A 项目的插件显示在 B 项目上」，
     * 而且只有重连时才会更新。它们改由 `/api/capabilities?ws=` 回答。
     */
    capabilities: {
      sandbox: sandboxCapability(),
      // 同样**每次握手重新探测**：装完之后重连一下就该显示出来，
      // 而不是让用户重启整个服务——他不会知道要重启。这几个探针都不缓存。
      environment: probeEnvironment(),
      mode: deps.config.mode ?? 'auto',
    },
  }
  ws.send(JSON.stringify(ok))

  for (const f of backlog) ws.send(JSON.stringify(f))
}

/**
 * 沙箱状态的握手形态。
 *
 * `detectSandbox()` 自己带缓存，所以每次握手都调不额外起进程；
 * 但**必须每次握手都重新取**而不是在 serve 启动时算一次存下来——
 * 那样一来「装上 bwrap 之后重连一下就生效」这件事就不成立了，
 * 用户得重启整个服务，而他不会知道要重启。
 */
export function sandboxCapability(): { backend: string; active: boolean; reason: string } {
  const s = detectSandbox()
  return { backend: s.backend, active: s.active, reason: s.reason }
}
