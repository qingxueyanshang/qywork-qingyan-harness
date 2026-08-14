/**
 * 握手时的「我停在哪」。
 *
 * 覆盖范围：`handshake.ts` 的补发分支与 `commandShell` 能力上报
 * （令牌校验由 `e2e.test.ts` 走真连接覆盖）；`canInstall` 那条顺带覆盖
 * `api/host.ts` 的判据——它必须与安装路由是同一个函数。
 *
 * 这份测试锁的是一条用户可见的链路：**sidecar 重启之后，重连的客户端必须被告知
 * 要重拉全量**。不告知的代价是界面永远停在断线那一刻——那一轮一直显示执行中，
 * 而账本里它在新进程启动时就被 `recoverStaleRuns` 判成中断了。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, ConversationId, HelloFrame } from '@qywork/core'
import type { ServerWebSocket } from 'bun'
import { EventBus } from './bus.ts'
import type { SocketData } from './deps.ts'
import { handleHello } from './handshake.ts'

const c1 = 'cv_one' as ConversationId
const delta = (s: string): AgentEvent =>
  ({ type: 'text.delta', runId: 'run_x', stepId: 'st_x', delta: s }) as AgentEvent

interface HelloOk {
  type: string
  streamId: string
  currentSeq: number
  resync: boolean
  capabilities: {
    commandShell: { path: string | null; reason: string; canInstall: boolean }
  }
}

/** 最小假 socket：只需要 `data` / `send` / `close`。 */
function fakeSocket() {
  const sent: string[] = []
  const ws = {
    data: { id: 'sk_1', authed: false, origin: 'desktop' } as SocketData,
    send: (s: string) => sent.push(s),
    close: () => {},
  } as unknown as ServerWebSocket<SocketData>
  return {
    ws,
    sent,
    ok: () => JSON.parse(sent[0]!) as HelloOk,
    backlog: () => sent.slice(1).map((s) => JSON.parse(s) as { seq: number }),
  }
}

function shake(bus: EventBus, frame: Omit<HelloFrame, 'type' | 'token' | 'origin'>) {
  const sock = fakeSocket()
  handleHello(
    sock.ws,
    { type: 'hello', token: 'tk', origin: 'desktop', ...frame },
    {
      bus,
      token: 'tk',
      unsubscribers: new Map(),
      config: { active: { provider: 'p', model: 'm' }, providers: {} },
    },
  )
  return sock
}

describe('断线重连的位置', () => {
  test('同一条流、缺口在窗口内 —— 逐条补，不 resync', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    bus.publish(delta('b'), c1)

    const sock = shake(bus, { resume: { streamId: bus.streamId, lastSeq: 1 } })
    expect(sock.ok().resync).toBe(false)
    expect(sock.backlog().map((f) => f.seq)).toEqual([2])
  })

  /**
   * **原始失败形状**：重启后 `seq` 从 0 重新数，上一版拿 `lastSeq >= seq` 判成
   * 「已是最新」，于是 resync 为假、补发零条，客户端不会去重拉——那一轮的终态
   * 就此永远到不了界面。
   */
  test('服务端重启过（换了流）—— 必须 resync，而不是判成已是最新', () => {
    const before = new EventBus()
    for (let i = 0; i < 800; i++) before.publish(delta(String(i)), c1)

    const after = new EventBus()
    const sock = shake(after, { resume: { streamId: before.streamId, lastSeq: 800 } })
    expect(sock.ok().resync).toBe(true)
    expect(sock.backlog()).toEqual([])
  })

  test('首连不带位置 —— 不 resync，也不补发', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    const sock = shake(bus, {})
    expect(sock.ok().resync).toBe(false)
    expect(sock.backlog()).toEqual([])
  })

  test('hello.ok 报的是本进程这条流的身份，客户端据此判断要不要重拉', () => {
    const bus = new EventBus()
    expect(shake(bus, {}).ok().streamId).toBe(bus.streamId)
  })
})

describe('能力上报', () => {
  /**
   * `commandShell` 必须**在握手里就有消费者可读的三格**。
   *
   * 这条不是形式检查：`ServerCapabilities` 上一版有过 `pty` / `git` / `fileWatch`
   * 三个布尔，全被删掉，理由是**没有任何客户端读它们**（`transport.ts` 注释）。
   * 所以这一格的验收是「设置页那一行能据此渲染」——
   * 有路径就显示路径，没有就显示原因，`canInstall` 决定按钮出不出现。
   */
  test('commandShell 报路径、原因与能不能一键装', () => {
    const caps = shake(new EventBus(), {}).ok().capabilities
    expect(caps.commandShell).toBeDefined()
    const sh = caps.commandShell
    // 本机装了 Git Bash，所以这里必然是有路径的那一支；两支的不变式分开写。
    if (sh.path === null) expect(sh.reason.length).toBeGreaterThan(0)
    else expect(sh.path.toLowerCase()).toContain('bash')
    expect(typeof sh.canInstall).toBe('boolean')
  })

  test('canInstall 与安装路由用同一个判据', async () => {
    // 分开算的表现是「界面上有按钮、点下去回 409」——B5 明令不做那种按钮。
    const caps = shake(new EventBus(), {}).ok().capabilities
    const { canInstallShell } = await import('./api/host.ts')
    expect(caps.commandShell.canInstall).toBe(canInstallShell())
  })
})
