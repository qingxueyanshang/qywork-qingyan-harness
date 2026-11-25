/**
 * 隧道帧格式（`tunnel.ts`）：数据帧编解码、控制帧校验、窗口与分块、乱序关闭、握手声明的窗口（`peerWindows`）、
 * 整条隧道的排队量（`TunnelBudget`）与发送调度（`TunnelOutbound`：轮转、在途上限、按往返收放、控制帧不排队）。
 */
import { describe, expect, test } from 'bun:test'
import {
  decodeData,
  encodeData,
  parseControl,
  peerWindows,
  pumpBody,
  sendableCloseCode,
  TUNNEL_CHUNK,
  TUNNEL_DATA,
  TUNNEL_WINDOW,
  TunnelBudget,
  type TunnelControl,
  TunnelCredit,
  TunnelInbound,
  TunnelOutbound,
  tunnelHeaders,
} from './tunnel.ts'

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

function sourceOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0
  for await (const chunk of stream) total += chunk.length
  return total
}

/** 窗口耗尽后的第一次占用：发送方在这一次调用中暂停，`blocked` 随之完成。 */
class WatchedCredit extends TunnelCredit {
  readonly blocked = Promise.withResolvers<void>()
  private calls = 0

  override take(bytes: number): Promise<boolean> {
    if (++this.calls === TUNNEL_WINDOW / TUNNEL_CHUNK + 1) this.blocked.resolve()
    return super.take(bytes)
  }
}

describe('数据帧', () => {
  test('编码后解码得到相同的类型、sid 与负载', () => {
    const frame = encodeData(TUNNEL_DATA.text, 0xfffffffe, new TextEncoder().encode('你好'))
    const decoded = decodeData(frame)
    expect(decoded?.kind).toBe(TUNNEL_DATA.text)
    expect(decoded?.sid).toBe(0xfffffffe)
    expect(new TextDecoder().decode(decoded?.payload)).toBe('你好')
  })

  test('负载为某个大缓冲区中的一段时，解码使用该段的偏移', () => {
    const frame = encodeData(TUNNEL_DATA.body, 3, bytes(4, 9))
    const big = new Uint8Array(100)
    big.set(frame, 50)
    const decoded = decodeData(big.subarray(50, 50 + frame.length))
    expect(decoded?.sid).toBe(3)
    expect([...(decoded?.payload ?? [])]).toEqual([9, 9, 9, 9])
  })

  test('长度不足 5 字节或类型未知时返回 null', () => {
    expect(decodeData(new Uint8Array(4))).toBeNull()
    expect(decodeData(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull()
  })
})

describe('控制帧', () => {
  test('字段齐全且类型正确时通过', () => {
    const frame: TunnelControl = {
      type: 'http.open',
      sid: 1,
      method: 'GET',
      path: '/m',
      headers: [['accept', 'text/html']],
    }
    expect(parseControl(JSON.stringify(frame))).toEqual(frame)
    expect(parseControl('{"type":"close","sid":2}')).toEqual({ type: 'close', sid: 2 })
  })

  test('类型未登记、字段缺失或类型不符时返回 null', () => {
    expect(parseControl('not json')).toBeNull()
    expect(parseControl('{"type":"unknown"}')).toBeNull()
    expect(parseControl('{"type":"toString"}')).toBeNull()
    expect(parseControl('{"type":"end"}')).toBeNull()
    expect(parseControl('{"type":"end","sid":"1"}')).toBeNull()
    expect(parseControl('{"type":"end","sid":1.5}')).toBeNull()
    expect(parseControl('{"type":"http.head","sid":1,"status":200,"headers":[["a"]]}')).toBeNull()
    expect(parseControl('{"type":"close","sid":1,"code":"x"}')).toBeNull()
    expect(parseControl('{"type":"hello","protocol":2,"key":"k","remote":"false"}')).toBeNull()
  })

  test('hello 的 remote 可省略（协议 2 的电脑端）；support.changed 不带字段', () => {
    expect(parseControl('{"type":"hello","protocol":2,"key":"k"}')).toEqual({
      type: 'hello',
      protocol: 2,
      key: 'k',
    })
    expect(parseControl('{"type":"hello","protocol":2,"key":"k","remote":false}')).toEqual({
      type: 'hello',
      protocol: 2,
      key: 'k',
      remote: false,
    })
    expect(parseControl('{"type":"support.changed"}')).toEqual({ type: 'support.changed' })
    expect(parseControl('{"type":"announcements.changed"}')).toEqual({
      type: 'announcements.changed',
    })
  })

  test('http.open 与 ws.open 的 path 不以 / 开头时返回 null', () => {
    for (const path of ['@127.0.0.1:9/x', 'x', '', '\\x']) {
      const open = { type: 'http.open', sid: 1, method: 'GET', path, headers: [] }
      expect(parseControl(JSON.stringify(open))).toBeNull()
      expect(
        parseControl(JSON.stringify({ type: 'ws.open', sid: 1, path, headers: [] })),
      ).toBeNull()
    }
    expect(parseControl('{"type":"ws.open","sid":1,"path":"/stream?x=1","headers":[]}')).toEqual({
      type: 'ws.open',
      sid: 1,
      path: '/stream?x=1',
      headers: [],
    })
  })
})

test('转发的请求头去除逐跳头、host、content-length 与 WebSocket 握手头', () => {
  const headers = new Headers({
    host: 'abc.example.com',
    connection: 'Upgrade',
    upgrade: 'websocket',
    'content-length': '12',
    'sec-websocket-key': 'k',
    'content-type': 'application/json',
    authorization: 'Bearer t',
  })
  expect(Object.fromEntries(tunnelHeaders(headers))).toEqual({
    'content-type': 'application/json',
    authorization: 'Bearer t',
  })
})

test('不可由应用发送的关闭码转交时记为 1000', () => {
  expect(sendableCloseCode(1006)).toBe(1000)
  expect(sendableCloseCode(undefined)).toBe(1000)
  expect(sendableCloseCode(4401)).toBe(4401)
})

describe('窗口', () => {
  test('超过单帧上限的块按上限分块发送，读完后发送 end', async () => {
    const frames: Uint8Array[] = []
    const controls: TunnelControl[] = []
    const ok = await pumpBody(sourceOf(bytes(TUNNEL_CHUNK * 2 + 10)), 5, new TunnelCredit(), {
      data: (f) => frames.push(f),
      control: (c) => controls.push(c),
    })
    expect(ok).toBe(true)
    expect(frames.map((f) => decodeData(f)?.payload.length)).toEqual([
      TUNNEL_CHUNK,
      TUNNEL_CHUNK,
      10,
    ])
    expect(controls).toEqual([{ type: 'end', sid: 5 }])
  })

  test('窗口耗尽时暂停读取数据源，归还后继续', async () => {
    const credit = new WatchedCredit()
    const sent: number[] = []
    let pulls = 0
    const total = TUNNEL_WINDOW + TUNNEL_CHUNK * 2
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++
          if (pulls * TUNNEL_CHUNK > total) controller.close()
          else controller.enqueue(bytes(TUNNEL_CHUNK))
        },
      },
      { highWaterMark: 0 },
    )
    const done = pumpBody(source, 1, credit, {
      data: (f) => sent.push(decodeData(f)?.payload.length ?? 0),
      control: () => {},
    })
    await credit.blocked.promise
    const sentBefore = sent.reduce((a, b) => a + b, 0)
    expect(sentBefore).toBe(TUNNEL_WINDOW)
    // 暂停期间只多读取了正在等待窗口的那一块。
    expect(pulls).toBe(TUNNEL_WINDOW / TUNNEL_CHUNK + 1)

    credit.grant(TUNNEL_CHUNK * 2)
    expect(await done).toBe(true)
    expect(sent.reduce((a, b) => a + b, 0)).toBe(total)
  })

  test('等待窗口期间流被关闭时返回 false、取消数据源且不发送 end', async () => {
    const credit = new WatchedCredit()
    const controls: TunnelControl[] = []
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes(TUNNEL_CHUNK))
      },
      cancel() {
        cancelled = true
      },
    })
    const done = pumpBody(source, 1, credit, { data: () => {}, control: (c) => controls.push(c) })
    await credit.blocked.promise
    credit.close()
    expect(await done).toBe(false)
    expect(cancelled).toBe(true)
    expect(controls).toEqual([])
  })

  /**
   * 原始失败形状：在途上限由全部流共享，3 条流各有不足 128 KB 在途时都无法取得归还，全部停止，255 秒后被断开。
   * 读取量达到粒度（128 KB 与窗口四分之一中的较小者）或排队读空时归还。
   */
  test('接收端读取的字节累计到 128 KB 与窗口四分之一中的较小者，或排队读空时归还', async () => {
    const granted: number[] = []
    const inbound = new TunnelInbound(
      (n) => granted.push(n),
      () => {},
    )
    const step = 128 * 1024
    for (let i = 0; i < step / TUNNEL_CHUNK + 1; i++) {
      expect(inbound.push(bytes(TUNNEL_CHUNK))).toBe(true)
    }
    inbound.end()
    expect(await readAll(inbound.readable)).toBe(step + TUNNEL_CHUNK)
    expect(granted).toEqual([step, TUNNEL_CHUNK])
    granted.length = 0
    const small = new TunnelInbound(
      (n) => granted.push(n),
      () => {},
      4 * TUNNEL_CHUNK,
    )
    small.push(bytes(TUNNEL_CHUNK / 2))
    small.end()
    await readAll(small.readable)
    expect(granted).toEqual([TUNNEL_CHUNK / 2])
  })

  test('发送端不遵守窗口时 push 返回 false', () => {
    const inbound = new TunnelInbound(
      () => {},
      () => {},
    )
    for (let i = 0; i < TUNNEL_WINDOW / TUNNEL_CHUNK; i++) {
      expect(inbound.push(bytes(TUNNEL_CHUNK))).toBe(true)
    }
    expect(inbound.push(bytes(1))).toBe(false)
  })

  /**
   * 原始失败形状：远程打开 Word 文件时字体文件（约 10 MB）经隧道传输，本机响应体的块大小不按单帧上限对齐，
   * 发送端在窗口余量不足一帧时仍发出整帧，云端排队超过窗口后关闭该流，预览显示「Failed to fetch」。
   */
  test('数据源的块不按单帧上限对齐、接收端暂未读取时，发出的字节不超过窗口，之后完整送达', async () => {
    const credit = new TunnelCredit()
    const inbound = new TunnelInbound(
      (n) => credit.grant(n),
      () => {},
    )
    const total = TUNNEL_WINDOW * 3 + 123
    const piece = 100_000
    let pulled = 0
    let sent = 0
    let refused = false
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = Math.min(piece, total - pulled)
        if (size <= 0) return controller.close()
        pulled += size
        controller.enqueue(bytes(size))
      },
    })
    const pumped = pumpBody(source, 4, credit, {
      data: (f) => {
        const d = decodeData(f)
        if (!d) return
        sent += d.payload.length
        if (!inbound.push(d.payload)) refused = true
      },
      control: (c) => {
        if (c.type === 'end') inbound.end()
      },
    })
    // 接收端尚未读取：发送端停在窗口用尽处。
    for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve))
    expect(refused).toBe(false)
    expect(sent).toBeGreaterThan(TUNNEL_WINDOW - TUNNEL_CHUNK)
    expect(sent).toBeLessThanOrEqual(TUNNEL_WINDOW)

    expect(await readAll(inbound.readable)).toBe(total)
    expect(await pumped).toBe(true)
    expect(refused).toBe(false)
  })

  test('发送端与接收端经同一个窗口相连时，大于窗口的数据完整送达', async () => {
    const credit = new TunnelCredit()
    const inbound = new TunnelInbound(
      (n) => credit.grant(n),
      () => {},
    )
    const total = TUNNEL_WINDOW * 3 + 123
    const pumped = pumpBody(sourceOf(bytes(total)), 9, credit, {
      data: (f) => {
        const d = decodeData(f)
        if (d && !inbound.push(d.payload)) throw new Error('超过窗口')
      },
      control: (c) => {
        if (c.type === 'end') inbound.end()
      },
    })
    expect(await readAll(inbound.readable)).toBe(total)
    expect(await pumped).toBe(true)
  })
})

describe('乱序关闭', () => {
  test('数据尚未读完时收到 close：丢弃排队的数据，读取方收到错误', async () => {
    const inbound = new TunnelInbound(
      () => {},
      () => {},
    )
    inbound.push(bytes(10))
    inbound.fail(new Error('对端已关闭'))
    inbound.push(bytes(10))
    await expect(readAll(inbound.readable)).rejects.toThrow('对端已关闭')
  })

  test('end 之后到达的数据被忽略', async () => {
    const inbound = new TunnelInbound(
      () => {},
      () => {},
    )
    inbound.push(bytes(10))
    inbound.end()
    inbound.push(bytes(10))
    expect(await readAll(inbound.readable)).toBe(10)
  })

  test('消费方取消后通知一次，之后到达的数据被忽略', async () => {
    let cancelled = 0
    const inbound = new TunnelInbound(
      () => {},
      () => {
        cancelled++
      },
    )
    inbound.push(bytes(10))
    await inbound.readable.cancel()
    expect(inbound.push(bytes(10))).toBe(true)
    inbound.fail(new Error('x'))
    expect(cancelled).toBe(1)
  })
})

describe('握手声明的窗口', () => {
  test('按对端声明取流窗口与整条隧道的上限；未声明或小于一帧时为缺省值', () => {
    expect(peerWindows({ window: 4 << 20, connectionWindow: 16 << 20 })).toEqual({
      stream: 4 << 20,
      connection: 16 << 20,
    })
    expect(peerWindows({})).toEqual({ stream: TUNNEL_WINDOW, connection: Number.POSITIVE_INFINITY })
    expect(peerWindows({ window: 10, connectionWindow: 0 })).toEqual({
      stream: TUNNEL_WINDOW,
      connection: Number.POSITIVE_INFINITY,
    })
  })

  test('hello 与 welcome 的窗口字段为可选整数', () => {
    expect(
      parseControl(JSON.stringify({ type: 'welcome', window: 1, connectionWindow: 2 })),
    ).not.toBeNull()
    expect(parseControl(JSON.stringify({ type: 'welcome' }))).not.toBeNull()
    expect(parseControl(JSON.stringify({ type: 'welcome', window: '1' }))).toBeNull()
  })

  test('流窗口按声明值：大于缺省窗口的数据在不归还的情况下发出', async () => {
    const credit = new TunnelCredit(4 * TUNNEL_WINDOW)
    let sent = 0
    const pumped = pumpBody(sourceOf(bytes(3 * TUNNEL_WINDOW)), 1, credit, {
      data: (f) => {
        sent += decodeData(f)?.payload.length ?? 0
      },
      control: () => {},
    })
    expect(await pumped).toBe(true)
    expect(sent).toBe(3 * TUNNEL_WINDOW)
  })
})

/**
 * 原始失败形状：每条流的窗口相同时，接收端一条隧道的内存按「窗口 × 流数」增长（流数上限 256）。
 * 整条隧道的排队量超过本端声明的上限时，判定对端违反协议。
 */
describe('整条隧道的排队量', () => {
  test('各流排队之和超过上限时 push 返回 false；读取与中止后归还', async () => {
    const budget = new TunnelBudget(3 * TUNNEL_CHUNK)
    const window = 4 * TUNNEL_CHUNK
    const a = new TunnelInbound(
      () => {},
      () => {},
      window,
      budget,
    )
    const b = new TunnelInbound(
      () => {},
      () => {},
      window,
      budget,
    )
    expect(a.push(bytes(TUNNEL_CHUNK))).toBe(true)
    expect(a.push(bytes(TUNNEL_CHUNK))).toBe(true)
    expect(b.push(bytes(TUNNEL_CHUNK))).toBe(true)
    expect(budget.queued).toBe(3 * TUNNEL_CHUNK)
    const reader = a.readable.getReader()
    await reader.read()
    expect(budget.queued).toBe(2 * TUNNEL_CHUNK)
    expect(b.push(bytes(TUNNEL_CHUNK))).toBe(true)
    expect(b.push(bytes(1))).toBe(false)
    b.fail(new Error('x'))
    expect(budget.queued).toBe(TUNNEL_CHUNK)
  })
})

/** 记录写入连接的帧：控制帧记类型，数据帧记 `sid` 与长度。 */
function recordingLink() {
  const sent: string[] = []
  return {
    sent,
    link: {
      send: (f: string | Uint8Array) => {
        if (typeof f === 'string') sent.push((JSON.parse(f) as TunnelControl).type)
        else {
          const d = decodeData(f)!
          sent.push(`${d.sid}:${d.payload.length}`)
        }
      },
    },
  }
}

/** 调度测试的帧为 64 KB：每条流只有第一帧在开头 64 KB 之内，不受在途上限限制。 */
const BIG = 64 * 1024
const frame = (sid: number, n = BIG) => encodeData(TUNNEL_DATA.body, sid, bytes(n))

describe('发送调度', () => {
  test('各流的请求体与响应体轮流发出；控制帧与 WebSocket 消息不排队', () => {
    const { sent, link } = recordingLink()
    const out = new TunnelOutbound(link, 2 * BIG, false)
    for (let i = 0; i < 3; i++) void out.data(frame(1))
    for (let i = 0; i < 3; i++) void out.data(frame(2))
    out.control({ type: 'end', sid: 9 })
    out.message(encodeData(TUNNEL_DATA.text, 7, bytes(3)))
    // 上限两帧：第一条流先发出两帧；第二条流开头的一帧不受上限限制、立即发出；控制帧与消息不等待。
    expect(sent).toEqual([`1:${BIG}`, `1:${BIG}`, `2:${BIG}`, 'end', '7:3'])
    // 归还后按轮转：先第一条流，再第二条流。
    out.acked(1, 2 * BIG)
    expect(sent.slice(5)).toEqual([`1:${BIG}`])
    out.acked(2, BIG)
    expect(sent.slice(6)).toEqual([`2:${BIG}`])
  })

  test('在途字节不超过对端的整条隧道窗口；流结束或被丢弃时归还其在途字节，排队的数据不再发送', async () => {
    const { sent, link } = recordingLink()
    const out = new TunnelOutbound(link, 2 * BIG, false)
    const a = out.data(frame(1))
    const b = out.data(frame(1))
    const c = out.data(frame(1))
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(out.state.inflight).toBe(2 * BIG)
    out.finish(1)
    expect(await c).toBe(false)
    expect(out.state.inflight).toBe(0)
    void out.data(frame(2))
    expect(sent).toEqual([`1:${BIG}`, `1:${BIG}`, `2:${BIG}`])
  })

  test('接口应答等小数据不排在大文件之后：流开头 64 KB 内的数据优先，且不受在途上限限制', () => {
    const { sent, link } = recordingLink()
    const out = new TunnelOutbound(link, 2 * BIG, false)
    for (let i = 0; i < 4; i++) void out.data(frame(1))
    expect(sent).toEqual([`1:${BIG}`, `1:${BIG}`])
    void out.data(frame(5, 300))
    expect(sent.at(-1)).toBe('5:300')
    expect(out.state.inflight).toBe(2 * BIG + 300)
  })

  test('没有在途数据时至少发出一帧', () => {
    const { sent, link } = recordingLink()
    const out = new TunnelOutbound(link, 10, false)
    void out.data(frame(1))
    expect(sent).toEqual([`1:${BIG}`])
  })

  /**
   * 原始失败形状：电脑上行 1 MB/s、两条下载时普通请求往返由 204 ms 增至 1.6–1.9 s：在途数据堆积在路由器与内核缓冲中。
   * 在途上限按送达速率与最小往返计算：没有瓶颈时逐步放大到对端窗口；出现瓶颈后，较早的高速率样本过期时降到「速率 × 最小往返 × 1.25」。
   */
  test('在途上限随送达速率与最小往返变化：不低于 128 KB，不超过对端窗口', () => {
    let now = 0
    const { link } = recordingLink()
    const out = new TunnelOutbound(link, 4 << 20, true, () => now)
    expect(out.state.limit).toBe(128 * 1024)
    const piece = 16 * 1024
    /** 排队的数据始终多于在途上限：发送方一直有数据可发。 */
    const refill = () => {
      while (out.state.inflight + piece <= out.state.limit) void out.data(frame(1, piece))
      for (let i = 0; i < 8; i++) void out.data(frame(1, piece))
    }
    out.rtt(500)
    refill()
    for (let i = 0; i < 40; i++) {
      now += 100
      out.acked(1, out.state.inflight)
      refill()
    }
    expect(out.state.limit).toBe(4 << 20)
    for (let i = 0; i < 120; i++) {
      now += 100
      out.acked(1, 100 * 1024)
      refill()
    }
    // 另加两帧的余量（发出一帧与归还的时间）。
    expect(Math.abs(out.state.limit - (1024 * 500 * 1.25 + 2 * TUNNEL_CHUNK))).toBeLessThan(piece)
  })

  /** 原始失败形状：3 条流共享 256 KB 的在途上限，各流在途都不足归还粒度，全部停止直到 255 秒后被断开。 */
  test('多条流共享在途上限时全部送达', async () => {
    const inbounds = new Map<number, TunnelInbound>()
    const out = new TunnelOutbound(
      {
        send: (f) => {
          if (typeof f === 'string') {
            const c = JSON.parse(f) as TunnelControl
            if (c.type === 'end') inbounds.get(c.sid)?.end()
            return
          }
          const d = decodeData(f)!
          if (!inbounds.get(d.sid)!.push(d.payload)) throw new Error('超过窗口')
        },
      },
      Number.POSITIVE_INFINITY,
      true,
    )
    const size = 300 * 1024
    const results = [1, 2, 3].map((sid) => {
      const credit = new TunnelCredit(4 * TUNNEL_WINDOW)
      inbounds.set(
        sid,
        new TunnelInbound(
          (n) => {
            credit.grant(n)
            out.acked(sid, n)
          },
          () => {},
          4 * TUNNEL_WINDOW,
        ),
      )
      const pumped = pumpBody(sourceOf(bytes(size)), sid, credit, out)
      return Promise.all([readAll(inbounds.get(sid)!.readable), pumped])
    })
    expect(await Promise.all(results)).toEqual([
      [size, true],
      [size, true],
      [size, true],
    ])
  })

  test('发送方收到 false 时停止读取数据源并取消', async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(bytes(TUNNEL_CHUNK))
      },
      cancel() {
        cancelled = true
      },
    })
    const controls: TunnelControl[] = []
    const ok = await pumpBody(source, 1, new TunnelCredit(), {
      data: () => Promise.resolve(false),
      control: (c) => controls.push(c),
    })
    expect(ok).toBe(false)
    expect(cancelled).toBe(true)
    expect(controls).toEqual([])
  })
})
