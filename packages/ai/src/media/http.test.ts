/** 用本机接口验证按静默计算的期限、生成请求不设上限、失败判定与报错措辞、下载重试及取消，不调用付费接口。 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { download, postJson, send } from './http.ts'
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

/**
 * 原始失败形状：中转站没有可用账号时 0.5 秒内返回 503，卡片却显示「远端结果未知，请勿自动重新生成」。
 * 收到错误状态即为被拒绝，报错只写状态码名称与服务商原文；只有响应无法解析时远端结果未知。
 */
test('HTTP 错误状态均为被拒绝，报错为状态码名称加服务商原文；响应无法解析时远端结果未知', async () => {
  for (const [status, content, outcome, message] of [
    [
      503,
      '{"error":{"message":"No available compatible accounts","type":"api_error"}}',
      'rejected',
      'HTTP 503 服务不可用：No available compatible accounts',
    ],
    [400, 'bad input', 'rejected', 'HTTP 400 请求无效：bad input'],
    [502, 'gateway', 'rejected', 'HTTP 502 网关错误：gateway'],
    [418, 'teapot', 'rejected', 'HTTP 418 请求被拒绝：teapot'],
    [200, '<html>', 'unknown', '响应无法解析；远端结果未知'],
  ] as const) {
    reply = () => new Response(content, { status })
    const error = await failure(postJson(url(), {}, {}, signal()))
    expect(error.diagnostic).toMatchObject({ status, outcome })
    expect(error.message).toBe(message)
  }
  expect(hits).toEqual(['POST', 'POST', 'POST', 'POST', 'POST'])
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
