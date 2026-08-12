/**
 * WebSocket 握手：验令牌、验协议版本、报能力。
 *
 * 拒连的两种原因都是终态——令牌不对重连一万次带的还是同一个令牌，
 * 协议版本不对要改的是某一端的代码。客户端据此不再退避重连。
 */

import type { EventEnvelope, HelloFrame } from '@qywork/core'
import { PROTOCOL_VERSION } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { detectSandbox } from '@qywork/tools'
import type { ServerWebSocket } from 'bun'
import type { EventBus } from './bus.ts'
import type { SocketData } from './deps.ts'

export function handleHello(
  ws: ServerWebSocket<SocketData>,
  frame: HelloFrame,
  deps: {
    bus: EventBus
    token: string
    unsubscribers: Map<string, () => void>
    /** 传的是运行中的那一份（`/api/config` 的 PUT 会就地改它），不是启动时的快照。 */
    config: QyConfig
  },
) {
  if (frame.token !== deps.token) {
    ws.send(JSON.stringify({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' }))
    ws.close(1008, 'unauthorized')
    return
  }
  if (frame.protocolVersion !== PROTOCOL_VERSION) {
    ws.send(
      JSON.stringify({
        type: 'hello.err',
        reason: 'protocol_mismatch',
        message: `服务端协议版本 ${PROTOCOL_VERSION}，客户端 ${frame.protocolVersion}`,
      }),
    )
    ws.close(1008, 'protocol')
    return
  }

  ws.data.authed = true
  ws.data.origin = frame.origin

  // 断线补发：缺口在保留窗口内就逐条补，超出就让客户端重拉全量。
  let resync = false
  let backlog: EventEnvelope[] = []
  if (typeof frame.lastSeq === 'number') {
    const replay = deps.bus.replayFrom(frame.lastSeq)
    if (replay === null) resync = true
    else backlog = replay
  }

  const off = deps.bus.subscribe({
    id: ws.data.id,
    origin: frame.origin,
    conversations: new Set(frame.subscribe ?? []),
    send: (f) => ws.send(JSON.stringify(f)),
  })
  deps.unsubscribers.set(ws.data.id, off)

  ws.send(
    JSON.stringify({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '0.1.0',
      sessionId: ws.data.id,
      currentSeq: deps.bus.currentSeq,
      resync,
      /*
       * **只报进程级的能力。** 插件 / MCP / 编排后端是按工作区的，而这条连接
       * 横跨用户开着的所有项目——报在这里就等于「A 项目的插件显示在 B 项目上」，
       * 而且只有重连时才会更新。它们改由 `/api/capabilities?ws=` 回答。
       */
      capabilities: {
        sandbox: sandboxCapability(),
        mode: deps.config.mode ?? 'auto',
      },
    }),
  )

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
