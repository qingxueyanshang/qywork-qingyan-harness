/**
 * 连接层的重连语义。覆盖 `lib/client.ts` 的 `QyClient`。
 *
 * 这个文件存在本身就是一条记录：这块逻辑之前**一直没有测试**，理由是
 * 「要真 WebSocket 才能跑」。那是把「这块难测」当成了「不用测」——
 * 而它恰恰出过一个 bug：协议版本对不上时无限重连，界面显示成「N 秒后重试」，
 * 一个永远不会好的稍后重试。
 *
 * 现在 `QyClient` 的第二个参数是接缝（接入点 + socket 工厂），
 * 生产路径走默认实现，这里传一个假 socket。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, CommandRejectedFrame, EventEnvelope } from '@qywork/core'
import { PROTOCOL_VERSION } from '@qywork/core'
import { QyClient, type SocketLike } from './client.ts'

class FakeSocket implements SocketLike {
  readonly sent: string[] = []
  readonly readyState = 1
  closed = false
  private readonly handlers = new Map<string, ((e: { data?: unknown }) => void)[]>()

  addEventListener(type: string, fn: (e: { data?: unknown }) => void): void {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  fire(type: string, data?: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn({ data })
  }
  deliver(msg: unknown): void {
    this.fire('message', JSON.stringify(msg))
  }
}

function client(token = 'tk') {
  const sockets: FakeSocket[] = []
  const states: { state: string; detail?: string }[] = []
  const frames: EventEnvelope<AgentEvent>[] = []
  const rejected: CommandRejectedFrame[] = []
  const c = new QyClient(
    {
      onEvent: (f) => frames.push(f),
      onState: (state, detail) => states.push({ state, ...(detail ? { detail } : {}) }),
      onResync: () => {},
      onCapabilities: () => {},
      onRejected: (f) => rejected.push(f),
    },
    {
      endpoint: { base: 'http://127.0.0.1:7717', token, origin: 'desktop' },
      open: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
    },
  )
  return { c, sockets, states, frames, rejected }
}

describe('握手', () => {
  test('连上就发 hello，带当前协议版本', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    const hello = JSON.parse(sockets[0]!.sent[0]!)
    expect(hello.type).toBe('hello')
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(hello.token).toBe('tk')
  })

  test('没有令牌就不连，直接报未配对', () => {
    const { c, sockets, states } = client('')
    c.connect()
    expect(sockets).toHaveLength(0)
    expect(states.at(-1)?.state).toBe('unauthorized')
  })
})

describe('握手被拒是终态', () => {
  /**
   * 复现原始失败形状：`protocol_mismatch` 曾经不算终态，于是每次 close
   * 都会排一次重连，永远失败。
   */
  test('protocol_mismatch 之后不再重连', () => {
    const { c, sockets, states } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({
      type: 'hello.err',
      reason: 'protocol_mismatch',
      message: '服务端协议版本 1，客户端 2',
    })
    expect(c.terminated).toBe(true)

    // close 到来时不能再排重连——排了就是那个永远好不了的「N 秒后重试」。
    sockets[0]!.fire('close')
    expect(states.at(-1)?.state).toBe('closed')
    expect(sockets).toHaveLength(1)
  })

  test('bad_token 同样是终态', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' })
    expect(c.terminated).toBe(true)
    sockets[0]!.fire('close')
    expect(sockets).toHaveLength(1)
  })

  /** 拒绝的原因要原样带给用户——只说「连接失败」等于让他自己猜。 */
  test('拒绝原因显示给用户', () => {
    const { c, sockets, states } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' })
    expect(states.some((s) => s.detail === '令牌无效')).toBe(true)
  })
})

describe('正常断线仍然重连', () => {
  /**
   * 反过来的那一半：**没有被拒的断线必须继续重试**。
   * 只测「排了重连」而不等它真的连上——退避有随机抖动，等它等于让测试变慢又变脆。
   */
  test('握手成功之后断线，不是终态', () => {
    const { c, sockets, states } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({
      type: 'hello.ok',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      currentSeq: 0,
      resync: false,
    })
    expect(states.at(-1)?.state).toBe('ready')

    sockets[0]!.fire('close')
    expect(c.terminated).toBe(false)
    expect(states.at(-1)?.state).toBe('reconnecting')
    c.close()
  })
})

describe('指令发不出去要有回执', () => {
  /**
   * **原始失败形状**：切模型点了没反应。
   *
   * `send` 曾经是 `if (readyState === OPEN) send()`——不在 OPEN 就静默什么也不做。
   * 而 `setModel` 刻意不做乐观更新（等服务端广播回来才改显示），两件事叠起来
   * 就是「点了，界面一动不动」，和「服务端还没回」完全无法区分。
   */
  test('连接还没建立时发指令，回 not_ready 而不是静默吞掉', () => {
    const { c, rejected } = client()
    c.send({ type: 'conversation.setModel', conversationId: 'cv_1' as never, model: 'm' })
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBe('not_ready')
    expect(rejected[0]?.command).toBe('conversation.setModel')
  })

  test('连接已放弃时说的是「断开」，不是「稍后重试」——后者永远不会好', () => {
    const { c, rejected } = client()
    c.close()
    c.send({ type: 'run.interrupt', runId: 'run_1' as never })
    expect(rejected[0]?.message).toContain('断开')
  })

  test('连上之后照常发出，不再有回执', () => {
    const { c, sockets, rejected } = client()
    c.connect()
    sockets[0]!.fire('open')
    c.send({ type: 'run.interrupt', runId: 'run_1' as never })
    expect(rejected).toHaveLength(0)
    expect(sockets[0]!.sent.some((s) => s.includes('run.interrupt'))).toBe(true)
  })
})

describe('事件交出的是整个信封', () => {
  /**
   * 归属会话在信封上，不在事件体里（`text.delta` 这些串台主力都不带）。
   * 拆成 `event` + `seq` 交出去的话，消费方拿不到归属，只能盲信
   * 「我收到的都是我订阅的」——而 `subscribe` 指令的往返窗口让这个前提不成立。
   */
  test('conversationId 随帧交给消费方', () => {
    const { c, sockets, frames } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({
      seq: 7,
      at: 1,
      conversationId: 'cv_a',
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_1', delta: '喂' },
    })
    expect(frames).toHaveLength(1)
    expect(String(frames[0]?.conversationId)).toBe('cv_a')
    expect(frames[0]?.seq).toBe(7)
    c.close()
  })
})

describe('订阅在重连时原样带回去', () => {
  const helloOf = (s: FakeSocket) => JSON.parse(s.sent.find((x) => x.includes('"hello"')) as string)

  test('订了具体会话，重连的 hello 帧带着它', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    c.subscribe(['cv_a'])
    sockets[0]!.fire('close')

    // 退避有随机抖动，不等它自己重连——直接再连一次，验的是 hello 的内容。
    c.connect()
    sockets[1]!.fire('open')
    expect(helloOf(sockets[1]!).subscribe).toEqual(['cv_a'])
    c.close()
  })

  /**
   * **原始失败形状**：切完项目再断一次网，串台全回来了。
   *
   * 空集曾经被 `this.subscribed.length` 判掉、不写进 hello 帧，服务端于是当成
   * 「没声明过」给全订阅——而切项目时前端发的正是 `subscribe([])`。
   */
  test('明确退订（空集）也要带上，不能被压成「没说过」', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    c.subscribe([])
    sockets[0]!.fire('close')

    c.connect()
    sockets[1]!.fire('open')
    expect(helloOf(sockets[1]!).subscribe).toEqual([])
    c.close()
  })

  test('从没声明过就不带这个字段 —— 首连时界面还没选会话', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    expect('subscribe' in helloOf(sockets[0]!)).toBe(false)
    c.close()
  })
})
