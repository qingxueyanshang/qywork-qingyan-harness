/**
 * 隧道帧格式（`tunnel.ts`）：数据帧编解码、控制帧校验、窗口与分块、乱序关闭。
 */
import { describe, expect, test } from 'bun:test'
import {
  decodeData,
  encodeData,
  parseControl,
  pumpBody,
  sendableCloseCode,
  TUNNEL_CHUNK,
  TUNNEL_DATA,
  TUNNEL_WINDOW,
  type TunnelControl,
  TunnelCredit,
  TunnelInbound,
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
  })
})

test('转发的请求头去掉逐跳头、host、content-length 与 WebSocket 握手头', () => {
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

  test('窗口用完时暂停读取数据源，归还后继续', async () => {
    const credit = new TunnelCredit()
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
    await Bun.sleep(20)
    const sentBefore = sent.reduce((a, b) => a + b, 0)
    expect(sentBefore).toBe(TUNNEL_WINDOW)
    // 暂停期间只多读了正在等待窗口的那一块。
    expect(pulls).toBe(TUNNEL_WINDOW / TUNNEL_CHUNK + 1)

    credit.grant(TUNNEL_CHUNK * 2)
    expect(await done).toBe(true)
    expect(sent.reduce((a, b) => a + b, 0)).toBe(total)
  })

  test('等待窗口期间流被关闭时返回 false、取消数据源且不发送 end', async () => {
    const credit = new TunnelCredit()
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
    await Bun.sleep(10)
    credit.close()
    expect(await done).toBe(false)
    expect(cancelled).toBe(true)
    expect(controls).toEqual([])
  })

  test('接收端读取的字节累计到窗口的四分之一时归还', async () => {
    const granted: number[] = []
    const inbound = new TunnelInbound(
      (n) => granted.push(n),
      () => {},
    )
    const quarter = TUNNEL_WINDOW / 4
    for (let i = 0; i < quarter / TUNNEL_CHUNK + 1; i++) {
      expect(inbound.push(bytes(TUNNEL_CHUNK))).toBe(true)
    }
    inbound.end()
    expect(await readAll(inbound.readable)).toBe(quarter + TUNNEL_CHUNK)
    expect(granted).toEqual([quarter])
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
