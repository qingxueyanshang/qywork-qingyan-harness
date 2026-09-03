/**
 * 连接层的重连语义。覆盖 `lib/client.ts` 的 `QyClient`。
 *
 * 这个文件存在本身就是一条记录：这块逻辑之前**一直没有测试**，理由是
 * 「要真 WebSocket 才能跑」。那是把「这块难测」当成了「不用测」——
 * 而它出过一个 bug：协议版本对不上时无限重连，界面显示成「N 秒后重试」，
 * 一个永远不会好的稍后重试。
 *
 * 现在 `QyClient` 的第二个参数是接缝（接入点 + socket 工厂），
 * 生产路径走默认实现，这里传一个假 socket。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, CommandRejectedFrame, ConversationId, EventEnvelope } from '@qywork/core'
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
  const resyncs: number[] = []
  const streamChanges: number[] = []
  const busy: ConversationId[][] = []
  const c = new QyClient(
    {
      onEvent: (f) => frames.push(f),
      onState: (state, detail) => states.push({ state, ...(detail ? { detail } : {}) }),
      onResync: () => resyncs.push(1),
      onStreamChanged: () => streamChanges.push(1),
      onCapabilities: () => {},
      onBusy: (ids) => busy.push(ids),
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
  return { c, sockets, states, frames, rejected, resyncs, streamChanges, busy }
}

describe('握手', () => {
  test('连上就发 hello，带当前协议版本', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    const hello = JSON.parse(sockets[0]!.sent[0]!)
    expect(hello.type).toBe('hello')
    expect(hello.token).toBe('tk')
  })

  test('没有令牌就不连，直接报未配对', () => {
    const { c, sockets, states } = client('')
    c.connect()
    expect(sockets).toHaveLength(0)
    expect(states.at(-1)?.state).toBe('unauthorized')
  })
})

describe('握手报的忙闲要交出去', () => {
  /**
   * 原始失败形状：sidecar 被杀之后重连，客户端手里那份忙闲还是断线前的——
   * 那几轮早跑完了，左栏对应的行会一直转下去。**每次握手都整表交出**，
   * 缺口补不上（resync）的那次也不例外。
   */
  test('每次 hello.ok 都交出一份完整的在跑清单', () => {
    const { c, sockets, busy } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({
      type: 'hello.ok',
      capabilities: {},
      currentSeq: 0,
      resync: false,
      busyConversations: ['cv_a', 'cv_b'],
    })
    expect(busy).toEqual([['cv_a', 'cv_b'] as ConversationId[]])

    sockets[0]!.deliver({
      type: 'hello.ok',
      capabilities: {},
      currentSeq: 9,
      resync: true,
      busyConversations: [],
    })
    expect(busy.at(-1)).toEqual([])
  })
})

describe('握手被拒是终态', () => {
  /**
   * 复现原始失败形状：只把 `bad_token` 当终态的话，别的原因每次 close 都会再排
   * 一次重连、每次都被同样地拒掉，而界面显示「N 秒后重试」——一个永远不会好的
   * 稍后重试。
   *
   * 服务端目前只发 `bad_token` 一种，但**这里不按 reason 分支**：
   * 认的是「hello.err 一律终态」这条规则本身。
   */
  test('hello.err 之后不再重连', () => {
    const { c, sockets, states } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' })
    expect(c.terminated).toBe(true)

    // close 到来时不能再排重连——排了就是那个永远好不了的「N 秒后重试」。
    sockets[0]!.fire('close')
    expect(sockets).toHaveLength(1)

    // **而且不能把原因盖掉。** 服务端发完 hello.err 立刻 close，两个事件前后脚到；
    // close 处理器无条件再报一次泛化的 'closed' 的话，用户最终看到的是
    // 「连接已断开」而不是「令牌无效」——后者才说得出下一步该干什么。
    expect(states.at(-1)?.state).toBe('unauthorized')
    expect(states.at(-1)?.detail).toBe('令牌无效')
  })

  /** 拒绝的原因要原样带给用户——只说「连接失败」等于让他自己猜。 */
  test('拒绝原因显示给用户', () => {
    const { c, sockets, states } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' })
    // 看**最后**一条，不是 some()：被后面的状态盖掉时 some() 照样为真，
    // 而用户看到的只有最后那条。
    expect(states.at(-1)?.detail).toBe('令牌无效')
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
   * `send` 写成 `if (readyState === OPEN) send()` 的话，不在 OPEN 就静默什么也不做。
   * 而 `setModel` 刻意不做乐观更新（等服务端广播回来才改显示），两件事叠起来
   * 就是「点了，界面一动不动」，和「服务端还没回」完全无法区分。
   */
  test('连接还没建立时发指令，回 not_ready 而不是静默吞掉', () => {
    const { c, rejected } = client()
    c.send({
      type: 'conversation.setModel',
      conversationId: 'cv_1' as never,
      provider: 'p',
      model: 'm',
    })
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
   * 拆成 `event` + `seq` 交出去的话，消费方拿不到归属，只能假定收到的都属于
   * 已订阅的会话——而 `subscribe` 指令的往返窗口让这个前提不成立。
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

/**
 * 投递必须幂等。
 *
 * 原始失败形状：一整轮的正文每个 token 显示两遍（「语法检查检查通过、通过」），
 * 同一轮出现两条读数条，第二条 0.0s——因为第一条已经把 `runStartedAt` 清掉了。
 * 两条来源都会造成它：断线补发与实时流交叠，以及同一个 client 建了两条连接。
 */
describe('同一个位置只交出去一次', () => {
  const deliverAt = (s: (typeof FakeSocket)['prototype'], seq: number, delta: string) =>
    s.deliver({
      seq,
      at: 1,
      conversationId: 'cv_a',
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_1', delta },
    })

  test('见过的 seq 直接丢掉', () => {
    const { c, sockets, frames } = client()
    c.connect()
    sockets[0]!.fire('open')
    deliverAt(sockets[0]!, 1, '甲')
    deliverAt(sockets[0]!, 2, '乙')
    // 补发窗口与实时流交叠，这两条是重合的那一段。
    deliverAt(sockets[0]!, 1, '甲')
    deliverAt(sockets[0]!, 2, '乙')
    expect(frames.map((f) => (f.event as { delta: string }).delta)).toEqual(['甲', '乙'])
    c.close()
  })

  test('已经连上了就不再建第二条连接', () => {
    const { c, sockets } = client()
    c.connect()
    c.connect()
    expect(sockets).toHaveLength(1)
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
   * 空集被 `this.subscribed.length` 判掉、不写进 hello 帧的话，服务端会当成
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

/**
 * 重连时报的「客户端停在哪一条」。
 *
 * 位置离开流身份没有意义：sidecar 一重启 seq 就从 0 重新数，只报一个数字会被
 * 服务端判成「已是最新」。那条判断在服务端（`bus.replayFrom`），这里守的是
 * 客户端这一半——**报上去的必须是当前这条流上的坐标**。
 */
describe('断线重连报的位置', () => {
  const helloOf = (s: FakeSocket) => JSON.parse(s.sent.find((x) => x.includes('"hello"')) as string)
  const helloOk = (streamId: string, currentSeq: number, resync = false) => ({
    type: 'hello.ok',
    capabilities: {},
    streamId,
    currentSeq,
    resync,
  })

  test('首连不带 resume —— 还没握过手，手上没有任何流的坐标', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    expect('resume' in helloOf(sockets[0]!)).toBe(false)
    c.close()
  })

  test('收过帧之后重连，带上流身份 + 最后一条 seq', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver(helloOk('stream-a', 0))
    sockets[0]!.deliver({
      seq: 12,
      at: 1,
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_1', delta: '喂' },
    })
    sockets[0]!.fire('close')

    c.connect()
    sockets[1]!.fire('open')
    expect(helloOf(sockets[1]!).resume).toEqual({ streamId: 'stream-a', lastSeq: 12 })
    c.close()
  })

  /**
   * **原始失败形状的客户端一半**：sidecar 重启后 hello.ok 换了流身份，
   * 而客户端手上还揣着上一代的 `lastSeq=12`。再断一次线时若把这个数报上去，
   * 服务端就得替一个不属于自己的坐标做判断。
   */
  test('服务端换了流，位置跟着对齐到新流 —— 不把上一代的数字报过去', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver(helloOk('stream-a', 0))
    sockets[0]!.deliver({
      seq: 12,
      at: 1,
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_1', delta: '喂' },
    })
    sockets[0]!.fire('close')

    // 重启后的 sidecar：新流、seq 从头数起，并要求整段重拉。
    c.connect()
    sockets[1]!.fire('open')
    sockets[1]!.deliver(helloOk('stream-b', 3, true))
    sockets[1]!.fire('close')

    c.connect()
    sockets[2]!.fire('open')
    expect(helloOf(sockets[2]!).resume).toEqual({ streamId: 'stream-b', lastSeq: 3 })
    c.close()
  })

  test('服务端说 resync，就要通知调用方整段重拉', () => {
    const { c, sockets, resyncs } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver(helloOk('stream-a', 40, true))
    expect(resyncs).toHaveLength(1)
    c.close()
  })

  test('首连不算换代；重连到另一条服务端事件流才通知换代', () => {
    const { c, sockets, streamChanges } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver(helloOk('stream-a', 0))
    expect(streamChanges).toHaveLength(0)

    // 普通断线仍连回同一个 sidecar，不该刷新整页。
    sockets[0]!.fire('close')
    c.connect()
    sockets[1]!.fire('open')
    sockets[1]!.deliver(helloOk('stream-a', 0))
    expect(streamChanges).toHaveLength(0)

    // sidecar 安全重启后 streamId 变化，只通知一次；页面据此加载同一代前端。
    sockets[1]!.fire('close')
    c.connect()
    sockets[2]!.fire('open')
    sockets[2]!.deliver(helloOk('stream-b', 0))
    expect(streamChanges).toHaveLength(1)
    c.close()
  })
})
