/** 用本机接口验证按静默计算的期限、生成请求不设上限、下载重试及取消，不调用付费接口。 */
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
    expect(error.message).toContain('远端结果未知')
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
    expect(error.message).toBe('连续 0.08 秒未收到数据')
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

test('HTTP 400 是明确拒绝，502 与无效 JSON 均不能确认远端结果', async () => {
  for (const [status, content, outcome] of [
    [400, 'bad input', 'rejected'],
    [502, 'gateway', 'unknown'],
    [200, '<html>', 'unknown'],
  ] as const) {
    reply = () => new Response(content, { status })
    const error = await failure(postJson(url(), {}, {}, signal()))
    expect(error.diagnostic).toMatchObject({ status, outcome })
  }
  expect(hits).toEqual(['POST', 'POST', 'POST'])
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
