/** 用本机接口验证按静默计算的期限、生成请求不设上限、失败判定与报错措辞、提交遇到 429 时的重发、下载重试及取消，不调用付费接口。 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { download, postJson, send, sendJson } from './http.ts'
import { MediaError } from './types.ts'

let server: ReturnType<typeof Bun.serve>
let hits: string[] = []
let reply: () => Response | Promise<Response> = () => Response.json({})
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      hits.push(req.method)
      return reply()
    },
  })
})
afterAll(() => server.stop(true))
afterEach(() => {
  hits = []
})
const url = () => `http://127.0.0.1:${server.port}/image`
const signal = () => new AbortController().signal
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function failure(work: Promise<unknown>): Promise<MediaError> {
  try {
    await work
  } catch (err) {
    expect(err).toBeInstanceOf(MediaError)
    return err as MediaError
  }
  throw new Error('应返回请求诊断')
}

/**
 * 原始失败形状：同步生图请求在远端仍在生成时被本地的固定期限中断，已计费的结果无法取回。
 * 生成请求不设静默上限，只在收到响应、连接被关闭、用户停止时结束。
 */
test('生成请求在远端返回之前一直等待；连接被关闭时立即失败，标为结果未知且没有静默上限', async () => {
  reply = async () => {
    await delay(300)
    return Response.json({ data: [] })
  }
  expect(await postJson(url(), {}, {}, signal())).toEqual({ data: [] })
  expect(hits).toEqual(['POST'])

  const closing = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: (socket) => void socket.end() },
  })
  try {
    const error = await failure(
      postJson(`http://127.0.0.1:${closing.port}/image`, {}, {}, signal()),
    )
    expect(error.diagnostic).toMatchObject({
      stage: 'generate',
      kind: 'connection',
      outcome: 'unknown',
    })
    expect(error.diagnostic?.timeoutMs).toBeUndefined()
    expect(error.message).toBe('连接被断开；远端结果未知')
  } finally {
    closing.stop(true)
  }
})

/**
 * 原始失败形状：中转站关闭空闲连接，复用连接池中这条连接发出的生成请求立即 ECONNRESET，
 * 标为结果未知。每次请求新建连接时不存在可复用的失效连接。
 */
test('每次请求新建连接，不复用连接池中的空闲连接', async () => {
  const ports: number[] = []
  const peer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      ports.push(srv.requestIP(req)?.port ?? 0)
      return Response.json({})
    },
  })
  try {
    const at = `http://127.0.0.1:${peer.port}/videos`
    await postJson(at, {}, {}, signal())
    await send(at, { method: 'GET' }, signal())
    expect(ports).toHaveLength(2)
    expect(ports[0]).not.toBe(ports[1])
  } finally {
    peer.stop(true)
  }
})

test.each([false, true])(
  '静默超过上限即中止，包含响应体阶段=%s，标为超时并保留请求标识',
  async (body) => {
    reply = async () => {
      if (!body) {
        await delay(300)
        return Response.json({})
      }
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
            await delay(300)
            try {
              controller.enqueue(new TextEncoder().encode('}'))
              controller.close()
            } catch {}
          },
        }),
        { headers: { 'x-request-id': 'req-body' } },
      )
    }
    const error = await failure(send(url(), { method: 'GET' }, signal(), { idleMs: 80 }))
    expect(error.diagnostic).toMatchObject({
      stage: 'query',
      kind: 'timeout',
      outcome: 'unknown',
      timeoutMs: 80,
    })
    if (body) expect(error.diagnostic?.requestId).toBe('req-body')
    expect(error.message).toBe('任务查询失败：连续 0.08 秒未收到数据')
    expect(hits).toEqual(['GET'])
  },
)

test('数据持续到达时不中止：总时长超过静默上限仍读完响应体', async () => {
  reply = () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 6; i++) {
            controller.enqueue(new TextEncoder().encode(String(i)))
            await delay(50)
          }
          controller.close()
        },
      }),
    )
  const res = await send(url(), { method: 'GET' }, signal(), { stage: 'download', idleMs: 150 })
  expect(await res.text()).toBe('012345')
})

test.each([false, true])(
  '素材上传无响应有默认期限，包含响应体阶段=%s，且明确未提交生成',
  async (body) => {
    const original = globalThis.setTimeout
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms: number,
    ) => original(fn, ms === 300_000 ? 80 : ms)) as typeof setTimeout)
    reply = async () => {
      if (!body) {
        await delay(300)
        return Response.json({ url: 'https://example.com/image.png' })
      }
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
            await delay(300)
            try {
              controller.close()
            } catch {}
          },
        }),
      )
    }
    try {
      const error = await failure(
        sendJson(url(), { method: 'POST', body: 'file' }, signal(), { stage: 'upload' }),
      )
      expect(error.diagnostic).toMatchObject({
        stage: 'upload',
        kind: 'timeout',
        outcome: 'rejected',
        timeoutMs: 300_000,
      })
      expect(error.message).toBe('素材上传失败，未提交生成：连续 300 秒未收到数据')
      expect(hits).toEqual(['POST'])
    } finally {
      timers.mockRestore()
    }
  },
)

test('上传的连接失败和无效响应均不误报生成结果未知', async () => {
  const closed = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: (socket) => void socket.end() },
  })
  try {
    const error = await failure(
      sendJson(`http://127.0.0.1:${closed.port}/upload`, { method: 'POST' }, signal(), {
        stage: 'upload',
      }),
    )
    expect(error.diagnostic).toMatchObject({
      stage: 'upload',
      kind: 'connection',
      outcome: 'rejected',
    })
    expect(error.message).toContain('未提交生成')
  } finally {
    closed.stop(true)
  }
  reply = () => new Response('<html>bad gateway</html>')
  const invalid = await failure(sendJson(url(), { method: 'POST' }, signal(), { stage: 'upload' }))
  expect(invalid.diagnostic).toMatchObject({
    stage: 'upload',
    kind: 'response',
    outcome: 'rejected',
  })
  expect(invalid.message).toBe('素材上传失败，未提交生成：响应无法解析')
})

/**
 * 网关错误不能证明计费请求没有到达上游；保留 HTTP 状态和服务商原文，不自动重新提交。
 */
test('客户端拒绝与网关结果未知分开报告，保留原文且生成只 POST 一次', async () => {
  for (const [status, content, outcome, message] of [
    [
      503,
      '{"error":{"message":"No available compatible accounts","type":"api_error"}}',
      'unknown',
      'HTTP 503 服务不可用：No available compatible accounts；远端结果未知',
    ],
    [400, 'bad input', 'rejected', 'HTTP 400 请求无效：bad input'],
    [502, 'gateway', 'unknown', 'HTTP 502 网关错误：gateway；远端结果未知'],
    [408, 'timeout', 'unknown', 'HTTP 408 请求超时：timeout；远端结果未知'],
    [418, 'teapot', 'rejected', 'HTTP 418 请求被拒绝：teapot'],
    // 原始失败形状：正文首尾带不换行空格，按原文解析失败，界面显示整段 JSON。
    [
      400,
      '\u00a0{"code":400,"error_detail":"视频时长不符合当前模型要求","message":"视频时长不符合当前模型要求"}\u00a0',
      'rejected',
      'HTTP 400 请求无效：视频时长不符合当前模型要求',
    ],
    // 原始失败形状：网关的 HTML 错误页按原文截取前 500 个字符，界面显示页面源码。
    [
      502,
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n',
      'unknown',
      'HTTP 502 网关错误：502 Bad Gateway；远端结果未知',
    ],
    [200, '<html>', 'unknown', '响应无法解析；远端结果未知'],
  ] as const) {
    reply = () => new Response(content, { status })
    const error = await failure(postJson(url(), {}, {}, signal()))
    expect(error.diagnostic).toMatchObject({ status, outcome })
    expect(error.message).toBe(message)
  }
  expect(hits).toEqual(['POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST'])
})

/**
 * 原始失败形状：画布批量出图时千问图像接口对并发的提交返回 429「Requests rate limit exceeded」，卡片直接记为失败。
 * 429 表示未受理，生成与上传按 Retry-After 重发；查询只发一次，由调用方按自己的间隔重发。
 */
test('生成与上传遇到 429 按 Retry-After 重发直到受理；次数用尽后报告原文且判为被拒绝；查询不在此重发', async () => {
  const limited = () =>
    new Response('{"message":"Requests rate limit exceeded, please try again later."}', {
      status: 429,
      headers: { 'retry-after': '0' },
    })
  let left = 2
  reply = () => (left-- > 0 ? limited() : Response.json({ output: { task_id: 't-1' } }))
  expect(await postJson(url(), {}, {}, signal())).toEqual({ output: { task_id: 't-1' } })
  expect(hits).toEqual(['POST', 'POST', 'POST'])

  hits = []
  left = 1
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'a.png')
  const uploaded = await send(url(), { method: 'POST', body: form }, signal(), { stage: 'upload' })
  expect(uploaded.status).toBe(200)
  expect(hits).toEqual(['POST', 'POST'])

  hits = []
  reply = limited
  const error = await failure(postJson(url(), {}, {}, signal()))
  expect(error.message).toBe(
    'HTTP 429 请求过多：Requests rate limit exceeded, please try again later.',
  )
  expect(error.diagnostic).toMatchObject({ stage: 'generate', status: 429, outcome: 'rejected' })
  expect(hits).toHaveLength(6)

  hits = []
  const query = await failure(sendJson(url(), { method: 'GET' }, signal()))
  expect(query.status).toBe(429)
  expect(hits).toEqual(['GET'])
})

/** 连接未建立时请求没有发出：端口拒绝连接与 TLS 握手失败均为被拒绝，不显示 Bun 的英文提示。 */
test('连接被拒绝或 TLS 握手失败时请求未发出，判为被拒绝', async () => {
  const refused = await failure(postJson('http://127.0.0.1:1/image', {}, {}, signal()))
  expect(refused.diagnostic).toMatchObject({
    kind: 'connection',
    outcome: 'rejected',
    code: 'ConnectionRefused',
  })
  expect(refused.message).toBe('无法连接 127.0.0.1:1')

  const plain = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: (socket) => void socket.end('HTTP/1.1 200 OK\r\n\r\n') },
  })
  try {
    const host = `127.0.0.1:${plain.port}`
    const tls = await failure(postJson(`https://${host}/image`, {}, {}, signal()))
    expect(tls.diagnostic).toMatchObject({ kind: 'connection', outcome: 'rejected' })
    expect(tls.message).toBe(`与 ${host} 的 TLS 握手失败`)
  } finally {
    plain.stop(true)
  }
})

test('查询失败带「任务查询失败」前缀，下载失败带「结果下载失败」前缀', async () => {
  reply = () => Response.json({ error: { message: 'task not found' } }, { status: 404 })
  const query = await failure(send(url(), { method: 'GET' }, signal()))
  expect(query.message).toBe('任务查询失败：HTTP 404 未找到：task not found')
  const fetched = await failure(download(url(), signal()))
  expect(fetched.message).toBe('结果下载失败：HTTP 404 未找到：task not found')
})

test('下载遇到暂时错误只重试 GET，保留服务商已经返回产物的事实', async () => {
  reply = () => new Response('temporary', { status: 503 })
  const error = await failure(download(url(), signal()))
  expect(hits).toEqual(['GET', 'GET', 'GET'])
  expect(error.diagnostic).toMatchObject({
    stage: 'download',
    outcome: 'available',
    status: 503,
    timeoutMs: 120_000,
  })
})

test('用户停止立即结束，不误报本地超时也不触发重试', async () => {
  const controller = new AbortController()
  reply = async () => {
    await delay(200)
    return Response.json({})
  }
  const reason = new Error('用户停止')
  const work = postJson(url(), {}, {}, controller.signal)
  setTimeout(() => controller.abort(reason), 30)
  await expect(work).rejects.toBe(reason)
  expect(hits).toEqual(['POST'])
})
