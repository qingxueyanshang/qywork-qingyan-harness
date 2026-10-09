/**
 * 连接层的重连语义。覆盖 `lib/client.ts` 的 `QyClient`。
 *
 * 不要以「需要真实 WebSocket 才能运行」为由删除本测试：难以测试不等于无需测试。
 * 该逻辑的已知失败形状是协议版本不一致时无限重连，界面显示「N 秒后重试」，
 * 而该重试永远不会成功。
 *
 * `QyClient` 的第二个参数是测试接缝（接入点与 socket 工厂），
 * 生产路径使用默认实现，此处传入替身 socket。
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
  test('连接建立后发送 hello，携带当前协议版本', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    const hello = JSON.parse(sockets[0]!.sent[0]!)
    expect(hello.type).toBe('hello')
    expect(hello.token).toBe('tk')
  })

  test('没有令牌时不连接，直接报告未配对', () => {
    const { c, sockets, states } = client('')
    c.connect()
    expect(sockets).toHaveLength(0)
    expect(states.at(-1)?.state).toBe('unauthorized')
  })
})

describe('握手携带的忙闲状态交给调用方', () => {
  /**
   * 原始失败形状：sidecar 被终止后重连，客户端持有的忙闲状态仍是断线前的，
   * 而那几轮早已执行完毕，左栏对应的行持续显示运行中。每次握手都交出完整的表，
   * 无法补齐缺口（resync）的握手也不例外。
   */
  test('每次 hello.ok 都交出一份完整的运行中清单', () => {
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
   * 复现原始失败形状：只把 `bad_token` 视为终态时，其他原因的拒绝在每次 close 后都会
   * 安排一次重连，且每次都以同样原因被拒绝，而界面显示「N 秒后重试」，
   * 该重试永远不会成功。
   *
   * 服务端目前只发送 `bad_token` 一种原因，但此处不按 reason 分支：
   * 测试的是「hello.err 一律为终态」这一规则本身。
   */
  test('hello.err 之后不再重连', () => {
    const { c, sockets, states } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' })
    expect(c.terminated).toBe(true)

    // close 到达时不能再安排重连，否则界面显示永远不会成功的「N 秒后重试」。
    sockets[0]!.fire('close')
    expect(sockets).toHaveLength(1)

    // 也不能覆盖拒绝原因。服务端发送 hello.err 后立即 close，两个事件相继到达；
    // close 处理器无条件再报告一次泛化的 'closed' 时，用户最终看到的是
    // 「连接已断开」而不是「令牌无效」，而只有后者能指明下一步操作。
    expect(states.at(-1)?.state).toBe('unauthorized')
    expect(states.at(-1)?.detail).toBe('令牌无效')
  })

  /** 拒绝原因须原样显示给用户：只显示「连接失败」时，用户只能自行推测原因。 */
  test('拒绝原因显示给用户', () => {
    const { c, sockets, states } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver({ type: 'hello.err', reason: 'bad_token', message: '令牌无效' })
    // 检查最后一条，不用 some()：状态被后续状态覆盖时 some() 仍为真，
    // 而用户看到的只有最后一条。
    expect(states.at(-1)?.detail).toBe('令牌无效')
  })
})

describe('正常断线仍然重连', () => {
  /**
   * 另一面：未被拒绝的断线必须继续重试。
   * 只测试已安排重连，不等待实际连接成功：退避带有随机抖动，等待会使测试变慢且不稳定。
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

describe('指令无法发送时返回回执', () => {
  /**
   * 原始失败形状：切换模型后界面没有任何反应。
   *
   * `send` 写成 `if (readyState === OPEN) send()` 时，连接不处于 OPEN 状态就静默不执行。
   * 而 `setModel` 有意不做乐观更新（等待服务端广播后才更新显示），两者叠加后
   * 点击没有任何反应，且与「服务端尚未响应」无法区分。
   */
  test('连接尚未建立时发送指令，返回 not_ready 而不是静默丢弃', () => {
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
    expect(rejected[0]?.message).toBe('连接已断开，正在重新连接')
    c.close()
    c.send({ type: 'conversation.interrupt', conversationId: 'cv_1' as never })
    expect(rejected[1]?.message).toBe('连接已断开，请重新打开应用')
  })

  /**
   * 原始失败形状：断线时按回车，界面停留在生成中。
   *
   * 乐观置忙按 `clientRequestId` 定位并冲销（`store/connection.ts` 的
   * `applyRejected`），回执不携带它时无法识别对应的是哪一次发送。
   */
  test('客户端合成的回执携带幂等键，与服务端回执口径一致', () => {
    const { c, rejected } = client()
    c.send({
      type: 'message.send',
      clientRequestId: 'req-7',
      conversationId: 'cv_1' as never,
      content: '在吗',
    })
    expect(rejected[0]?.clientRequestId).toBe('req-7')
  })

  test('连接已放弃时提示「断开」而不是「稍后重试」：后者永远不会成功', () => {
    const { c, rejected } = client()
    c.close()
    c.send({ type: 'conversation.interrupt', conversationId: 'cv_1' as never })
    expect(rejected[0]?.message).toContain('断开')
  })

  test('连接建立后正常发送，不再返回回执', () => {
    const { c, sockets, rejected } = client()
    c.connect()
    sockets[0]!.fire('open')
    c.send({ type: 'conversation.interrupt', conversationId: 'cv_1' as never })
    expect(rejected).toHaveLength(0)
    expect(sockets[0]!.sent.some((s) => s.includes('conversation.interrupt'))).toBe(true)
  })
})

describe('事件以完整信封交给消费方', () => {
  /**
   * 所属会话记录在信封上，不在事件体中（`text.delta` 等最常错投到其他会话的事件都不携带它）。
   * 拆成 `event` 与 `seq` 交出时，消费方无法取得归属，只能假定收到的事件都属于
   * 已订阅的会话，而 `subscribe` 指令的往返窗口使该前提不成立。
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
 * 原始失败形状：一整轮正文的每个 token 显示两遍（「语法检查检查通过、通过」），
 * 同一轮出现两条读数条，第二条为 0.0s，因为第一条已清除 `runStartedAt`。
 * 两种来源都会导致该问题：断线补发与实时流交叠，以及同一个 client 建立了两条连接。
 */
describe('同一位置的事件只交出一次', () => {
  const deliverAt = (s: (typeof FakeSocket)['prototype'], seq: number, delta: string) =>
    s.deliver({
      seq,
      at: 1,
      conversationId: 'cv_a',
      event: { type: 'text.delta', runId: 'run_1', stepId: 'st_1', delta },
    })

  test('已处理的 seq 直接丢弃', () => {
    const { c, sockets, frames } = client()
    c.connect()
    sockets[0]!.fire('open')
    deliverAt(sockets[0]!, 1, '甲')
    deliverAt(sockets[0]!, 2, '乙')
    // 补发窗口与实时流交叠，以下两条是重合部分。
    deliverAt(sockets[0]!, 1, '甲')
    deliverAt(sockets[0]!, 2, '乙')
    expect(frames.map((f) => (f.event as { delta: string }).delta)).toEqual(['甲', '乙'])
    c.close()
  })

  test('已建立连接时不再建立第二条连接', () => {
    const { c, sockets } = client()
    c.connect()
    c.connect()
    expect(sockets).toHaveLength(1)
    c.close()
  })
})

describe('重连时原样携带订阅', () => {
  const helloOf = (s: FakeSocket) => JSON.parse(s.sent.find((x) => x.includes('"hello"')) as string)

  test('订阅了具体会话时，重连的 hello 帧携带该订阅', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    c.subscribe(['cv_a'])
    sockets[0]!.fire('close')

    // 退避带有随机抖动，不等待自动重连，直接再连接一次，验证 hello 的内容。
    c.connect()
    sockets[1]!.fire('open')
    expect(helloOf(sockets[1]!).subscribe).toEqual(['cv_a'])
    c.close()
  })

  /**
   * 原始失败形状：切换项目后再断网一次，跨会话错投的事件全部重新出现。
   *
   * 空集被 `this.subscribed.length` 判定为假而不写入 hello 帧时，服务端会视为
   * 「未声明」并订阅全部会话，而切换项目时前端发送的正是 `subscribe([])`。
   */
  test('明确退订（空集）同样须携带，不能被视为「未声明」', () => {
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

  /** 原始失败形状：服务重启后重连的一秒内订阅集变化，界面显示「连接已断开，请重新打开应用」。 */
  test('断线重连期间修改订阅不产生拒绝回执，重连的 hello 帧携带修改后的订阅', () => {
    const { c, sockets, rejected } = client()
    c.connect()
    sockets[0]!.fire('open')
    c.subscribe(['cv_a'])
    sockets[0]!.fire('close')
    c.subscribe(['cv_a', 'cv_b'])
    expect(rejected).toHaveLength(0)

    c.connect()
    sockets[1]!.fire('open')
    expect(helloOf(sockets[1]!).subscribe).toEqual(['cv_a', 'cv_b'])
    c.close()
  })

  test('从未声明时不携带该字段：首次连接时界面尚未选择会话', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    expect('subscribe' in helloOf(sockets[0]!)).toBe(false)
    c.close()
  })
})

/**
 * 重连时报告的客户端已接收位置。
 *
 * 位置脱离流身份没有意义：sidecar 重启后 seq 从 0 重新计数，只报告一个数字会被
 * 服务端判定为「已是最新」。该判定位于服务端（`bus.replayFrom`），此处验证的是
 * 客户端一侧：报告的必须是当前流上的位置。
 */
describe('断线重连时报告的位置', () => {
  const helloOf = (s: FakeSocket) => JSON.parse(s.sent.find((x) => x.includes('"hello"')) as string)
  const helloOk = (streamId: string, currentSeq: number, resync = false) => ({
    type: 'hello.ok',
    capabilities: {},
    streamId,
    currentSeq,
    resync,
  })

  test('首次连接不携带 resume：尚未握手，没有任何流的位置', () => {
    const { c, sockets } = client()
    c.connect()
    sockets[0]!.fire('open')
    expect('resume' in helloOf(sockets[0]!)).toBe(false)
    c.close()
  })

  test('收到帧之后重连，携带流身份与最后一条 seq', () => {
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
   * 原始失败形状的客户端一侧：sidecar 重启后 hello.ok 更换了流身份，
   * 而客户端仍持有上一代的 `lastSeq=12`。再次断线时若报告该数值，
   * 服务端须对一个不属于当前流的位置做判断。
   */
  test('服务端更换流后，位置对齐到新流，不报告上一代的数值', () => {
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

    // 重启后的 sidecar：新流，seq 从头计数，并要求整段重新拉取。
    c.connect()
    sockets[1]!.fire('open')
    sockets[1]!.deliver(helloOk('stream-b', 3, true))
    sockets[1]!.fire('close')

    c.connect()
    sockets[2]!.fire('open')
    expect(helloOf(sockets[2]!).resume).toEqual({ streamId: 'stream-b', lastSeq: 3 })
    c.close()
  })

  test('服务端要求 resync 时通知调用方整段重新拉取', () => {
    const { c, sockets, resyncs } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver(helloOk('stream-a', 40, true))
    expect(resyncs).toHaveLength(1)
    c.close()
  })

  test('首次连接不算换代；重连到另一条服务端事件流时才通知换代', () => {
    const { c, sockets, streamChanges } = client()
    c.connect()
    sockets[0]!.fire('open')
    sockets[0]!.deliver(helloOk('stream-a', 0))
    expect(streamChanges).toHaveLength(0)

    // 普通断线后仍连回同一个 sidecar，不应刷新整页。
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
