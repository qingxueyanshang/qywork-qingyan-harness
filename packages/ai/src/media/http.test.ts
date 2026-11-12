/**
 * 用本机接口验证按静默计算的期限、生成请求不设上限、失败判定与报错措辞、失败码与对话请求同一分类（`errors.ts` 的 `httpFailureCode`，
 * 查询与下载阶段的 404 除外）、
 * 提交被限流、请求未发出与素材上传暂时不可用时按 2 秒起加倍的间隔重试（假计时器推进等待）、结果未知不重试、下载重试及取消，
 * 以及在正文中给出错误码的上游（MiniMax、可灵、百炼、火山方舟、Gemini API 的适配器，按接口地址判定上游的 OpenAI 形状出图，
 * 与 `errors.ts` 的 `upstreamFailureCode`）在提交与查询中按其错误码重试或不重试，以及百炼视频适配器的临时上传
 * （`adapters/dashscope.ts` 经 `send` 调用 `providers/openai-compat.ts` 的 `uploadDashScopeMedia`）的重试与 OSS 以 403 拒绝时的重新取凭证，
 * 以及重试等待、重新取凭证与上游状态变化（`task.ts` 的 `waitTask`）的日志带上运行的日志标识（`reportingRetries`）、
 * 不含密钥与提示词，不调用付费接口。
 */
import { afterAll, afterEach, beforeAll, expect, jest, spyOn, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '@qywork/core'
import { classifyProviderError } from '../errors.ts'
import { download, postJson, reportingRetries, send, sendJson, transientFailure } from './http.ts'
import { buildMediaAdapter } from './index.ts'
import { MediaError } from './types.ts'

let server: ReturnType<typeof Bun.serve>
let hits: string[] = []
let reply: (req: Request) => Response | Promise<Response> = () => Response.json({})
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      hits.push(req.method)
      return reply(req)
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
/**
 * 重试的等待由假计时器推进，不实际等待。`send` 在进入每次等待之前记录一条 `log.warn`，以它的条数判定已进入第几次等待；
 * 请求与响应仍经由本机接口完成，`turn` 让出事件循环使其完成。随机延后取 0，等待时长即间隔表的数值。
 */
function retryClock() {
  jest.useFakeTimers()
  const random = spyOn(Math, 'random').mockReturnValue(0)
  const warn = spyOn(log, 'warn').mockImplementation(() => {})
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    warnings: () => warn.mock.calls.map((call) => String(call[1])),
    turn,
    /** 等到 `send` 第 `n` 次进入重试等待。 */
    async waiting(n: number) {
      // 让出次数的上限只决定失败时多久报告。不要调小：上传数 MB 文件的请求在机器负载高时需要数万次让出才完成。
      for (let i = 0; i < 200_000 && warn.mock.calls.length < n; i++) await turn()
      expect(warn.mock.calls).toHaveLength(n)
    },
    /** 推进 `ms` 毫秒；推进到差 1 毫秒时确认请求数未变，即等待未满不发出请求。 */
    async elapse(ms: number) {
      const before = hits.length
      jest.advanceTimersByTime(ms - 1)
      for (let i = 0; i < 50; i++) await turn()
      expect(hits).toHaveLength(before)
      jest.advanceTimersByTime(1)
    },
    restore() {
      jest.useRealTimers()
      random.mockRestore()
      warn.mockRestore()
    },
  }
}
/** 被限流、请求未发出或上传暂时不可用后的五次等待：与对话请求的重发相同，2 秒起每次加倍，不超过 30 秒。 */
const BACKOFF = [2_000, 4_000, 8_000, 16_000, 30_000] as const
const BACKOFF_EXHAUSTED = '；已自动重试 5 次，仍失败'
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

/**
 * 上传在提交生成之前，连接中断不会重复提交或计费：与对话请求的重发相同，按 2 秒起加倍的间隔重试 5 次，用尽后仍报告未提交生成。
 * 原始失败形状：上传的连接失败按 30 秒、2 分钟、5 分钟重试，短时断网要等约 7 分半才报告失败。
 */
test('上传的连接失败和无效响应均不误报生成结果未知，连接失败按 2 秒起加倍的间隔重试', async () => {
  let connections = 0
  const closed = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket) => {
        connections++
        hits.push('POST')
        socket.end()
      },
    },
  })
  const clock = retryClock()
  try {
    const work = failure(
      sendJson(`http://127.0.0.1:${closed.port}/upload`, { method: 'POST' }, signal(), {
        stage: 'upload',
      }),
    )
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    const error = await work
    expect(connections).toBe(6)
    expect(error.diagnostic).toMatchObject({
      stage: 'upload',
      kind: 'connection',
      outcome: 'rejected',
    })
    expect(error.message).toContain('未提交生成')
    expect(error.message).toEndWith(BACKOFF_EXHAUSTED)
  } finally {
    clock.restore()
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
 * 素材上传得到接口的 408 / 5xx 答复：接口已答复，不是连接失败，与连接失败分开计数；次数与间隔与对话请求对 5xx 的重发相同。
 * 原始失败形状：按 30 秒、2 分钟、5 分钟重试，上传服务持续 503 时约 7 分半后才报告失败。
 */
test('上传得到 503 时按 2 秒起加倍的间隔重试 5 次，用尽后报告已做的重试', async () => {
  const clock = retryClock()
  try {
    reply = () => new Response('busy', { status: 503 })
    const work = failure(sendJson(url(), { method: 'POST' }, signal(), { stage: 'upload' }))
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    const error = await work
    expect(hits).toHaveLength(6)
    expect(error.message).toBe(
      `素材上传失败，未提交生成：HTTP 503 服务不可用：busy${BACKOFF_EXHAUSTED}`,
    )
    expect(error.retryReceipt).toBe(BACKOFF_EXHAUSTED.slice(1))
    expect(error.code).toBe('provider_unavailable')
  } finally {
    clock.restore()
  }
})

/**
 * 网关错误不能证明计费请求没有到达上游；保留 HTTP 状态和服务商原文，不自动重新提交。
 * 生成的 5xx 与 408 判为结果未知，不按暂时故障的间隔重试：重新提交可能重复计费。
 */
test('接口答复的错误与网关的结果未知分开报告，保留原文且生成只 POST 一次', async () => {
  for (const [status, content, outcome, message] of [
    [
      503,
      '{"error":{"message":"No available compatible accounts","type":"api_error"}}',
      'rejected',
      'HTTP 503 服务不可用：No available compatible accounts',
    ],
    // 原始失败形状：中转站对审核未通过的出图请求返回 502 与接口错误对象，曾判为结果未知。
    [
      502,
      '{"error":{"message":"提示词未过审","type":"new_api_error"}}',
      'rejected',
      'HTTP 502 网关错误：提示词未过审',
    ],
    [
      500,
      '{"code":"InternalError","message":"internal"}',
      'rejected',
      'HTTP 500 服务器内部错误：internal',
    ],
    [
      504,
      '{"message":"Endpoint request timed out"}',
      'unknown',
      'HTTP 504 网关超时：Endpoint request timed out；远端结果未知',
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
  expect(hits).toEqual(Array(11).fill('POST'))
})

const limited = () =>
  new Response('{"message":"Requests rate limit exceeded, please try again later."}', {
    status: 429,
    headers: { 'retry-after': '0' },
  })

/**
 * 原始失败形状：画布批量出图时千问图像接口对并发的提交返回 429「Requests rate limit exceeded」，卡片直接记为失败。
 * 429 表示未受理。接口立即答复拒绝，生成的提交按对话请求重发的次数与间隔重试；等待未满时不发出请求。
 * 按 30 秒、2 分钟、5 分钟的间隔重试时，用尽约 7 分半。
 */
test('生成遇到限流按 2 秒起加倍的间隔重试，受理后返回结果；每次等待的开始与结束各回报一次', async () => {
  const clock = retryClock()
  try {
    let left = 3
    reply = () => (left-- > 0 ? limited() : Response.json({ output: { task_id: 't-1' } }))
    const reports: unknown[] = []
    const failures: unknown[] = []
    const work = reportingRetries(
      {
        onRetry: (retry, failure) => {
          reports.push(retry)
          failures.push(failure?.status)
        },
      },
      () => postJson(url(), {}, {}, signal()),
    )
    for (const [i, ms] of BACKOFF.slice(0, 3).entries()) {
      await clock.waiting(i + 1)
      expect(hits).toHaveLength(i + 1)
      await clock.elapse(ms)
    }
    expect(await work).toEqual({ output: { task_id: 't-1' } })
    expect(hits).toEqual(['POST', 'POST', 'POST', 'POST'])
    expect(clock.warnings()[0]).toContain('2 秒后第 1 次重试')
    expect(clock.warnings()[2]).toContain('8 秒后第 3 次重试')
    const reason = 'HTTP 429 请求过多：Requests rate limit exceeded, please try again later.'
    expect(reports).toEqual([
      { attempt: 1, max: 5, reason },
      null,
      { attempt: 2, max: 5, reason },
      null,
      { attempt: 3, max: 5, reason },
      null,
    ])
    // 进入等待时同时交出引起等待的失败，等待结束时没有失败。
    expect(failures).toEqual([429, undefined, 429, undefined, 429, undefined])
  } finally {
    clock.restore()
  }
})

test('重试用尽后报告原文与已做的重试，判为被拒绝；上传同样重试；查询不在此重试', async () => {
  const clock = retryClock()
  try {
    reply = limited
    const work = failure(postJson(url(), {}, {}, signal()))
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    const error = await work
    expect(error.message).toBe(
      `HTTP 429 请求过多：Requests rate limit exceeded, please try again later.${BACKOFF_EXHAUSTED}`,
    )
    expect(error.retryReceipt).toBe(BACKOFF_EXHAUSTED.slice(1))
    expect(error.diagnostic).toMatchObject({ stage: 'generate', status: 429, outcome: 'rejected' })
    expect(hits).toHaveLength(6)

    hits = []
    let left = 1
    reply = () => (left-- > 0 ? limited() : Response.json({}))
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'a.png')
    const upload = send(url(), { method: 'POST', body: form }, signal(), { stage: 'upload' })
    // 上传被限流与提交被限流相同。
    await clock.waiting(6)
    await clock.elapse(BACKOFF[0])
    expect((await upload).status).toBe(200)
    expect(hits).toEqual(['POST', 'POST'])

    hits = []
    reply = limited
    const query = await failure(sendJson(url(), { method: 'GET' }, signal()))
    expect(query.status).toBe(429)
    expect(hits).toEqual(['GET'])
  } finally {
    clock.restore()
  }
})

/**
 * Retry-After 的规则与对话请求的重发相同（`resendDelay`）：按其等待，不短于退避间隔，不超过 60 秒。
 * 原始失败形状：生成对 Retry-After 取不超过 30 秒，对话完全按其等待，两处规则不同。
 */
test('限流时按 Retry-After 等待：长于 60 秒时等待 60 秒，短于退避间隔时按退避间隔', async () => {
  const clock = retryClock()
  try {
    const waits = ['90', '1', '10']
    reply = () => {
      const after = waits.shift()
      return after === undefined
        ? Response.json({ ok: true })
        : new Response('slow down', { status: 429, headers: { 'retry-after': after } })
    }
    const work = postJson(url(), {}, {}, signal())
    await clock.waiting(1)
    await clock.elapse(60_000)
    // 第 2 次的退避间隔 4 秒长于 Retry-After 1 秒。
    await clock.waiting(2)
    await clock.elapse(BACKOFF[1])
    // 第 3 次的退避间隔 8 秒短于 Retry-After 10 秒。
    await clock.waiting(3)
    await clock.elapse(10_000)
    expect(await work).toEqual({ ok: true })
    expect(hits).toHaveLength(4)
  } finally {
    clock.restore()
  }
})

/**
 * 原始失败形状：限流与请求未发出共用一个计数。先被限流一次、之后连接被拒绝时，连接失败的第一次等待跳过第一档，
 * 上限少一次，回执把限流的那次也计入。
 */
test('限流与请求未发出交替出现时各自计数：间隔、上限与回执都按该类已做的重试计算', async () => {
  const clock = retryClock()
  const own = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => limited() })
  const host = `127.0.0.1:${own.port}`
  try {
    const reports: ({ attempt: number; max: number } | null)[] = []
    const work = failure(
      reportingRetries({ onRetry: (retry) => reports.push(retry) }, () =>
        postJson(`http://${host}/image`, {}, {}, signal()),
      ),
    )
    // 第一次请求被限流；等待期间关闭接口，其后的请求连接被拒绝。
    await clock.waiting(1)
    await own.stop(true)
    await clock.elapse(BACKOFF[0])
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 2)
      await clock.elapse(ms)
    }
    expect((await work).message).toBe(`无法连接 ${host}${BACKOFF_EXHAUSTED}`)
    expect(reports.flatMap((r) => (r ? [[r.attempt, r.max]] : []))).toEqual([
      [1, 5],
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ])
    expect(clock.warnings()[1]).toContain('2 秒后第 1 次重试')
  } finally {
    await own.stop(true)
    clock.restore()
  }
})

/**
 * 原始失败形状：各协议的适配器不经同一处接通重试回报时，漏掉的协议在重试期间仍显示提交中。
 * 回报在 `buildMediaAdapter` 统一接通，适配器的请求不需要各自传递。
 */
test('经 buildMediaAdapter 构造的适配器在提交被限流时向 onRetry 回报，适配器不传递回调', async () => {
  const clock = retryClock()
  try {
    let left = 1
    reply = () => (left-- > 0 ? limited() : Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }))
    const reports: unknown[] = []
    const work = buildMediaAdapter({
      kind: 'openai_images',
      model: 'gpt-image-2',
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    }).run(
      { operation: 'generate', prompt: '猫', inputs: [], params: {} },
      { signal: signal(), onRetry: (retry) => reports.push(retry) },
    )
    await clock.waiting(1)
    await clock.elapse(BACKOFF[0])
    expect((await work).files).toHaveLength(1)
    expect(reports).toEqual([
      {
        attempt: 1,
        max: 5,
        reason: 'HTTP 429 请求过多：Requests rate limit exceeded, please try again later.',
      },
      null,
    ])
  } finally {
    clock.restore()
  }
})

/** 日志中不得出现的特征串：接口密钥与提示词。 */
const KEY_MARK = 'sk-key-mark-7c41e9'
const PROMPT_MARK = '提示词特征串-prompt-mark-9d2e'

/**
 * 原始失败形状：重试日志的字段只有阶段与主机，同时运行多个任务时无法判断一条重试属于哪一张卡、哪一个任务。
 * 日志标识（`logFields`）经 `buildMediaAdapter` 接通的异步上下文附在重试日志上，适配器不传递；日志不含接口密钥与提示词。
 * 本用例的日志照常写出（不替换 `log.warn`）。
 */
test('重试等待的日志带上本次运行的日志标识，不含接口密钥与提示词', async () => {
  jest.useFakeTimers()
  const random = spyOn(Math, 'random').mockReturnValue(0)
  const warn = spyOn(log, 'warn')
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
  try {
    let left = 1
    reply = () => (left-- > 0 ? limited() : Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] }))
    const logFields = { canvas: 'board.canvas.json', node: 'n1', record: 'generated/a.task.json' }
    const work = buildMediaAdapter({
      kind: 'openai_images',
      model: 'gpt-image-2',
      apiKey: KEY_MARK,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    }).run(
      { operation: 'generate', prompt: PROMPT_MARK, inputs: [], params: {} },
      { signal: signal(), logFields },
    )
    for (let i = 0; i < 20_000 && warn.mock.calls.length === 0; i++) await turn()
    jest.advanceTimersByTime(BACKOFF[0])
    expect((await work).files).toHaveLength(1)
    expect(warn.mock.calls).toEqual([
      [
        'media',
        'HTTP 429 请求过多：Requests rate limit exceeded, please try again later.；2 秒后第 1 次重试',
        { stage: 'generate', host: `127.0.0.1:${server.port}`, ...logFields },
      ],
    ])
    const written = JSON.stringify(warn.mock.calls)
    expect(written).not.toContain(KEY_MARK)
    expect(written).not.toContain(PROMPT_MARK)
  } finally {
    jest.useRealTimers()
    random.mockRestore()
    warn.mockRestore()
  }
})

/** 用户在等待期间停止：等待立即结束，以停止原因拒绝，之后不再发出请求。 */
test('重试等待期间停止即结束，不再发出请求', async () => {
  const clock = retryClock()
  try {
    reply = limited
    const controller = new AbortController()
    const reason = new Error('用户停止')
    const reports: unknown[] = []
    const work = reportingRetries({ onRetry: (retry) => reports.push(retry) }, () =>
      postJson(url(), {}, {}, controller.signal),
    ).catch((err: unknown) => err)
    await clock.waiting(1)
    controller.abort(reason)
    expect(await work).toBe(reason)
    // 等待被中止时不回报结束：请求没有重新发出。
    expect(reports).toHaveLength(1)
    jest.advanceTimersByTime(600_000)
    for (let i = 0; i < 50; i++) await clock.turn()
    expect(hits).toEqual(['POST'])
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    clock.restore()
  }
})

/**
 * 额度、余额或配额用尽同样返回 429，等待不会改变结果：只发送一次，立即判为被拒绝。错误码与原文取自 OpenAI 与百炼的错误码文档；
 * 百炼 `Throttling.AllocationQuota` 一个错误码对应限流与免费额度用尽两种原因，按原文区分。
 */
test.each([
  [
    'OpenAI 额度用尽',
    '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
  ],
  [
    '百炼预付费欠费',
    '{"code":"PrepaidBillOverdue","message":"The prepaid bill is overdue.","request_id":"r"}',
  ],
  [
    '百炼预算用尽',
    '{"code":"BudgetLimitExceeded","message":"The budget configured in Budget Management has been exhausted.","request_id":"r"}',
  ],
  [
    '百炼免费额度用尽',
    '{"code":"Throttling.AllocationQuota","message":"Free allocated quota exceeded.","request_id":"r"}',
  ],
  ['中转站余额不足', '{"error":{"message":"用户额度不足，剩余额度：0","type":"new_api_error"}}'],
] as const)('429 正文为「%s」：额度类只发送一次，不重试', async (_, body) => {
  reply = () => new Response(body, { status: 429, headers: { 'retry-after': '0' } })
  const error = await failure(postJson(url(), {}, {}, signal()))
  expect(error.diagnostic).toMatchObject({ status: 429, outcome: 'rejected' })
  expect(hits).toHaveLength(1)
})

test.each([
  [
    '百炼按分钟分配的限额',
    '{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded, please increase your quota limit.","request_id":"r"}',
  ],
  [
    '中转站上游限流',
    '{"error":{"message":"Upstream rate limit exceeded, please retry later","type":"rate_limit_error"}}',
  ],
] as const)('429 正文为「%s」：限流类重试 5 次', async (_, body) => {
  const clock = retryClock()
  try {
    reply = () => new Response(body, { status: 429, headers: { 'retry-after': '0' } })
    const work = failure(postJson(url(), {}, {}, signal()))
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    expect((await work).diagnostic).toMatchObject({ status: 429, outcome: 'rejected' })
    expect(hits).toHaveLength(6)
  } finally {
    clock.restore()
  }
})

/**
 * 连接未建立时请求没有发出：端口拒绝连接与 TLS 握手失败均为被拒绝，不显示 Bun 的英文提示。
 * 请求未发出不会重复提交，与对话请求的重发相同，按 2 秒起加倍的间隔重试 5 次。
 * 原始失败形状：请求未发出时按 30 秒、2 分钟、5 分钟重试，短时断网约 7 分半后才报告失败。
 */
test('连接被拒绝或 TLS 握手失败时请求未发出，判为被拒绝并按 2 秒起加倍的间隔重试', async () => {
  const clock = retryClock()
  const plain = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: (socket) => void socket.end('HTTP/1.1 200 OK\r\n\r\n') },
  })
  try {
    const refusing = failure(postJson('http://127.0.0.1:1/image', {}, {}, signal()))
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    const refused = await refusing
    expect(refused.diagnostic).toMatchObject({
      kind: 'connection',
      outcome: 'rejected',
      code: 'ConnectionRefused',
    })
    expect(refused.message).toBe(`无法连接 127.0.0.1:1${BACKOFF_EXHAUSTED}`)

    const host = `127.0.0.1:${plain.port}`
    const handshake = failure(postJson(`https://${host}/image`, {}, {}, signal()))
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 6)
      await clock.elapse(ms)
    }
    const tls = await handshake
    expect(tls.diagnostic).toMatchObject({ kind: 'connection', outcome: 'rejected' })
    expect(tls.message).toBe(`与 ${host} 的 TLS 握手失败${BACKOFF_EXHAUSTED}`)
  } finally {
    clock.restore()
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

/**
 * 同一个上游答复，生成请求的失败码与对话请求的分类相同（`classifyProviderError`），重试与云端的文字都按它判断。
 * 原始失败形状：生成一侧自行判断状态码，403 `billing_error`（中转站的余额耗尽）按状态码判为鉴权失败，对话一侧判为额度用尽。
 * 生成一侧另对全部状态码判定额度（百炼以 400 `Arrearage` 报告欠费），该项不与对话比较。
 */
test.each([
  [403, 'insufficient_quota', '{"error":{"type":"billing_error","message":"分组余额不足"}}'],
  [403, 'auth_failed', '{"error":{"type":"permission_error","message":"no access"}}'],
  [401, 'auth_failed', '{"error":{"message":"Incorrect API key provided"}}'],
  [402, 'insufficient_quota', '{"error":{"message":"payment required"}}'],
  [429, 'rate_limited', '{"error":{"message":"slow down","type":"rate_limit_error"}}'],
  [400, 'invalid_request', '{"error":{"message":"size 不合法"}}'],
  [400, 'provider_unavailable', '{"error":{"message":"上游负载已饱和，请稍后再试"}}'],
  [503, 'provider_unavailable', '{"error":{"message":"No available compatible accounts"}}'],
] as const)('HTTP %d 归为 %s：生成请求的失败码与对话请求相同', async (status, code, body) => {
  reply = () => new Response(body, { status })
  const error = await failure(send(url(), { method: 'GET' }, signal()))
  const chat = classifyProviderError(
    'openai_chat_completions',
    { status, ...(JSON.parse(body) as object), message: body },
    null,
    body,
  )
  expect(error.code).toBe(code)
  expect(chat.code).toBe(code)
})

/**
 * 原始失败形状：失败码只按状态码归类，结果下载或任务查询得到 404（结果已过期、地址失效、任务不存在）时记为型号不存在。
 * 查询与下载阶段的 404 记为请求被拒绝；提交阶段的 404 仍为型号不存在，与对话请求相同。
 * 三个阶段的报错文字、请求次数与诊断的结果都与改动前相同：404 在任何阶段都不重试（下载只重试暂时失败）。
 */
test('查询与下载阶段的 404 记为请求被拒绝，提交阶段仍为型号不存在；重试判定与报错文字不变', async () => {
  const body = '{"error":{"message":"not found"}}'
  reply = () => new Response(body, { status: 404 })
  const submitted = await failure(send(url(), { method: 'POST' }, signal()))
  const chat = classifyProviderError(
    'openai_chat_completions',
    { status: 404, ...(JSON.parse(body) as object), message: body },
    null,
    body,
  )
  expect([submitted.code, chat.code]).toEqual(['model_not_found', 'model_not_found'])
  expect(submitted.message).toBe('HTTP 404 未找到：not found')
  expect(hits).toEqual(['POST'])

  hits = []
  const query = await failure(send(url(), { method: 'GET' }, signal()))
  expect(query.code).toBe('invalid_request')
  expect(query.message).toBe('任务查询失败：HTTP 404 未找到：not found')
  expect(query.diagnostic).toMatchObject({ stage: 'query', outcome: 'rejected', status: 404 })
  expect(transientFailure(query)).toBe(false)
  expect(hits).toEqual(['GET'])

  hits = []
  const fetched = await failure(download(url(), signal()))
  expect(fetched.code).toBe('invalid_request')
  expect(fetched.message).toBe('结果下载失败：HTTP 404 未找到：not found')
  expect(fetched.diagnostic).toMatchObject({ stage: 'download', outcome: 'available', status: 404 })
  expect(transientFailure(fetched)).toBe(false)
  expect(hits).toEqual(['GET'])
})

test('额度判定覆盖全部状态码：百炼以 400 Arrearage 报告欠费时为额度用尽，不重试', async () => {
  reply = () =>
    Response.json(
      {
        code: 'Arrearage',
        message: 'Access denied, please make sure your account is in good standing.',
      },
      { status: 400 },
    )
  const error = await failure(postJson(url(), {}, {}, signal()))
  expect(error.code).toBe('insufficient_quota')
  expect(hits).toHaveLength(1)
})

/** MiniMax 语音的成功答复：音频为 hex，`base_resp.status_code` 为 0。 */
const minimaxSpoken = () =>
  Response.json({
    data: { audio: Buffer.from('ID3').toString('hex') },
    base_resp: { status_code: 0, status_msg: 'success' },
  })
const minimaxStatus = (status_code: number, status_msg: string) =>
  Response.json({ base_resp: { status_code, status_msg } })
const speak = () =>
  buildMediaAdapter({
    kind: 'minimax_speech',
    model: 'speech-2.8-hd',
    apiKey: 'k',
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
  }).run({ operation: 'speech', prompt: 'x', inputs: [], params: {} }, { signal: signal() })

/**
 * MiniMax 在 HTTP 200 的正文中报告失败（`base_resp.status_code`）。错误码含义取自 MiniMax 错误码文档：1002 请求频率超限，1008 余额不足。
 * 原始失败形状：正文中的失败不经过重试判定，1002 限流时不重试，直接失败；1008 余额不足时没有失败码，云端不替换。
 */
test('MiniMax 正文报告 1002 限流时按限流重试，受理后返回结果；1008 余额不足为额度用尽，不重试', async () => {
  const clock = retryClock()
  try {
    let left = 2
    reply = () => (left-- > 0 ? minimaxStatus(1002, 'rate limit') : minimaxSpoken())
    const reports: unknown[] = []
    const work = buildMediaAdapter({
      kind: 'minimax_speech',
      model: 'speech-2.8-hd',
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    }).run(
      { operation: 'speech', prompt: 'x', inputs: [], params: {} },
      { signal: signal(), onRetry: (retry) => reports.push(retry) },
    )
    for (const [i, ms] of BACKOFF.slice(0, 2).entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    expect((await work).files).toHaveLength(1)
    expect(hits).toHaveLength(3)
    expect(reports[0]).toEqual({ attempt: 1, max: 5, reason: '接口拒绝生成：1002：rate limit' })

    hits = []
    reply = () => minimaxStatus(1008, 'insufficient balance')
    const quota = await failure(speak())
    expect(hits).toHaveLength(1)
    expect(quota.code).toBe('insufficient_quota')
    expect(quota.message).toBe('接口拒绝生成：1008：insufficient balance')
    expect(quota.diagnostic).toMatchObject({ stage: 'generate', outcome: 'rejected', status: 200 })
  } finally {
    clock.restore()
  }
})

/** 文档没有写明为限流或额度的错误码不归类：保留原文，不重试。 */
test('MiniMax 正文报告未收录的错误码（2013 参数异常）时保留原文，不重试', async () => {
  reply = () => minimaxStatus(2013, 'invalid params')
  const error = await failure(speak())
  expect(hits).toHaveLength(1)
  expect(error.code).toBeUndefined()
  expect(error.message).toBe('接口拒绝生成：2013：invalid params')
})

/**
 * 可灵以 HTTP 429 同时报告限流与欠费，业务码区分两者。错误码含义取自可灵开放平台错误码文档：1302 API请求过快，超过平台速率限制；
 * 1102 资源包已用完/已过期。原始失败形状：429 一律按限流重试 5 次，资源包用尽时约一分钟后才报告失败，云端显示「上游请求过多」。
 */
test('可灵 429 业务码 1302 为限流，重试；1102 资源包用完为额度用尽，不重试', async () => {
  const clock = retryClock()
  try {
    const answers = [
      Response.json({ code: 1302, message: 'too many requests' }, { status: 429 }),
      Response.json({ code: 1102, message: 'resource pack exhausted' }, { status: 429 }),
    ]
    reply = () => answers.shift() ?? new Response('', { status: 500 })
    const work = failure(
      buildMediaAdapter({
        kind: 'kling_videos',
        model: 'kling-3.0',
        apiKey: 'k',
        baseUrl: `http://127.0.0.1:${server.port}`,
      }).run(
        { operation: 'text_to_video', prompt: 'x', inputs: [], params: {} },
        { signal: signal() },
      ),
    )
    await clock.waiting(1)
    await clock.elapse(BACKOFF[0])
    const error = await work
    expect(hits).toEqual(['POST', 'POST'])
    expect(error.code).toBe('insufficient_quota')
    expect(error.message).toBe('HTTP 429 请求过多：resource pack exhausted')
  } finally {
    clock.restore()
  }
})

/**
 * 百炼 `Throttling.AllocationQuota` 的 `You exceeded your current quota` 在百炼错误码文档中是 TPS / TPM 限流，
 * 与 OpenAI 额度用尽的原文相同；按百炼的错误码归类为限流并重试。百炼同步出图在 HTTP 200 而没有图片、正文带错误码时按接口拒绝处理。
 */
test('百炼同步出图：429 的 TPM 限流重试，200 正文带 Throttling 错误码重试，Arrearage 为额度用尽', async () => {
  const clock = retryClock()
  try {
    const answers = [
      Response.json(
        {
          code: 'Throttling.AllocationQuota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
        { status: 429 },
      ),
      Response.json({ code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' }),
      Response.json({
        code: 'Arrearage',
        message: 'Access denied, please make sure your account is in good standing.',
      }),
    ]
    reply = () => answers.shift() ?? new Response('', { status: 500 })
    const work = failure(
      buildMediaAdapter({
        kind: 'dashscope_images',
        model: 'qwen-image-3.0',
        apiKey: 'k',
        baseUrl: `http://127.0.0.1:${server.port}`,
      }).run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() }),
    )
    // 两类原因（错误状态与 200 正文）都是限流，同一计数：第 1、2 次等待。
    await clock.waiting(1)
    await clock.elapse(BACKOFF[0])
    await clock.waiting(2)
    await clock.elapse(BACKOFF[1])
    const error = await work
    expect(hits).toEqual(['POST', 'POST', 'POST'])
    expect(error.code).toBe('insufficient_quota')
    expect(error.message).toBe(
      '接口没有返回图片：Arrearage Access denied, please make sure your account is in good standing.',
    )
  } finally {
    clock.restore()
  }
})

/** 火山方舟视频任务：错误正文为 `{ error: { code, message, type } }`，取值取自火山方舟错误码文档。 */
const arkVideo = (resumeTaskId?: string) =>
  buildMediaAdapter({
    kind: 'ark_videos',
    model: 'doubao-seedance',
    apiKey: 'k',
    baseUrl: `http://127.0.0.1:${server.port}/api/v3`,
  }).run(
    { operation: 'text_to_video', prompt: 'x', inputs: [], params: {} },
    { signal: signal(), ...(resumeTaskId ? { resumeTaskId } : {}) },
  )
const arkError = (status: number, code: string, message: string, type: string) =>
  Response.json({ error: { code, message, param: '', type } }, { status })

/**
 * 原始失败形状：火山方舟以 403 报告欠费，按状态码归为鉴权失败，云端显示「上游拒绝访问」；以 429 报告额度用尽与用量上限，
 * 按状态码归为限流，重试 5 次后显示「上游请求过多」。
 */
test.each([
  [
    403,
    'AccountOverdueError',
    'The request failed because your account has an overdue balance. Request ID: r.',
    'Forbidden',
  ],
  [
    403,
    'OperationDenied.ServiceOverdue',
    'Operation is denied because your account balance is overdue, please go to the Volc Trading Center to recharge.',
    'Forbidden',
  ],
  [
    429,
    'AccountQuotaExceeded',
    'The request has exceeded the quota. Request id: r.',
    'TooManyRequests',
  ],
  [
    429,
    'SetLimitExceeded',
    'Your account [a] has reached the set usage limit for the [m] model, and the model service has been paused. Request ID: r.',
    'TooManyRequests',
  ],
  [
    429,
    'QuotaExceeded',
    'Your account [a] has exhausted its free trial quota for the [m] model. Request ID: r.',
    'TooManyRequests',
  ],
] as const)(
  '火山方舟视频提交 %d %s 为额度用尽，只发送一次，不重试',
  async (status, code, message, type) => {
    reply = () => arkError(status, code, message, type)
    const error = await failure(arkVideo())
    expect(hits).toEqual(['POST'])
    expect(error.code).toBe('insufficient_quota')
    expect(error.diagnostic).toMatchObject({ status, outcome: 'rejected' })
  },
)

/** 火山方舟 `QuotaExceeded` 的「The request has exceeded the quota」是排队中的任务数超过限制，文档要求稍后重试。 */
test('火山方舟视频提交 429 QuotaExceeded 的排队任务数超限为限流，按 2 秒起加倍的间隔重试 5 次', async () => {
  const clock = retryClock()
  try {
    reply = () =>
      arkError(
        429,
        'QuotaExceeded',
        'The request has exceeded the quota. Request ID: r.',
        'TooManyRequests',
      )
    const work = failure(arkVideo())
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    const error = await work
    expect(hits).toHaveLength(6)
    expect(error.code).toBe('rate_limited')
    expect(error.retryReceipt).toBe('已自动重试 5 次，仍失败')
  } finally {
    clock.restore()
  }
})

/**
 * 查询请求同样按上游的错误码归类。原始失败形状：可灵以 429 + 1102（资源包已用完）答复查询时按限流继续查询 10 分钟；
 * 429 + 1302（请求过快）是暂时失败，继续查询原任务。
 */
test('可灵查询 429 + 1302 继续查询，429 + 1102 资源包用完立即结束等待，任务保留可取回', async () => {
  const clock = retryClock()
  try {
    const answers = [
      Response.json({ code: 1302, message: 'too many requests' }, { status: 429 }),
      Response.json({ code: 1102, message: 'resource pack exhausted' }, { status: 429 }),
    ]
    reply = () => answers.shift() ?? new Response('', { status: 500 })
    const work = failure(
      buildMediaAdapter({
        kind: 'kling_videos',
        model: 'kling-3.0',
        apiKey: 'k',
        baseUrl: `http://127.0.0.1:${server.port}`,
      }).run(
        { operation: 'text_to_video', prompt: 'x', inputs: [], params: {} },
        { signal: signal(), resumeTaskId: 'kt-1' },
      ),
    )
    // 查询的暂时失败记录一条日志后按 5 秒的间隔继续查询。
    await clock.waiting(1)
    jest.advanceTimersByTime(5_000)
    const error = await work
    expect(hits).toEqual(['GET', 'GET'])
    expect(error.pendingTaskId).toBe('kt-1')
    expect(error.message).toBe(
      '任务查询失败：HTTP 429 请求过多：resource pack exhausted（远端任务 kt-1 仍可取回）',
    )
  } finally {
    clock.restore()
  }
})

/**
 * 可灵以 429 报告账户异常（1100）与触发 IP 白名单策略（1304），文档没有写为限流。
 * 原始失败形状：按 429 重试 5 次后显示「上游请求过多」。
 */
test.each([
  [1100, 'account abnormal'],
  [1304, 'ip whitelist'],
] as const)('可灵 429 业务码 %d 为鉴权失败，只发送一次，不重试', async (code, message) => {
  reply = () => Response.json({ code, message }, { status: 429 })
  const error = await failure(
    buildMediaAdapter({
      kind: 'kling_videos',
      model: 'kling-3.0',
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${server.port}`,
    }).run(
      { operation: 'text_to_video', prompt: 'x', inputs: [], params: {} },
      { signal: signal() },
    ),
  )
  expect(hits).toEqual(['POST'])
  expect(error.code).toBe('auth_failed')
})

/**
 * MiniMax 在 HTTP 200 的正文中报告的错误码，含义取自 MiniMax 错误码文档：2056 超出M Plan资源限制（等待下一个时间段），
 * 2067 套餐额度已用完，1004 未授权，2049 无效的 API Key。原始失败形状：没有失败码，云端不替换上游原文。
 */
test.each([
  [2056, 'usage limit exceeded', 'insufficient_quota'],
  [2067, 'token plan exhausted', 'insufficient_quota'],
  [1004, 'login fail', 'auth_failed'],
  [2049, 'invalid api key', 'auth_failed'],
] as const)('MiniMax 正文报告 %d 时只发送一次，不重试', async (code, message, expected) => {
  reply = () => minimaxStatus(code, message)
  const error = await failure(speak())
  expect(hits).toEqual(['POST'])
  expect(error.code).toBe(expected)
})

/** MiniMax 2046 / 2047 为用量与连接数增长超限，2062 为 M Plan 速率限制，2064 为服务集群负载较高，文档要求降低频率或稍后重试。 */
test.each([2046, 2047, 2062, 2064] as const)(
  'MiniMax 正文报告 %d 时按限流重试，受理后返回结果',
  async (code) => {
    const clock = retryClock()
    try {
      let left = 1
      reply = () => (left-- > 0 ? minimaxStatus(code, 'retry later') : minimaxSpoken())
      const work = speak()
      await clock.waiting(1)
      await clock.elapse(BACKOFF[0])
      expect((await work).files).toHaveLength(1)
      expect(hits).toEqual(['POST', 'POST'])
    } finally {
      clock.restore()
    }
  },
)

/**
 * Gemini API 文档：429 `RESOURCE_EXHAUSTED` 是超过速率限制，按指数退避重试。正文的原文与 OpenAI 额度用尽相同时，
 * 按原文判定会归为额度用尽而不重试；错误码先于原文判定。
 */
test('Gemini 出图 429 RESOURCE_EXHAUSTED 为限流，原文与额度用尽相同时仍按限流重试', async () => {
  const clock = retryClock()
  try {
    reply = () =>
      Response.json(
        {
          error: {
            code: 429,
            message: 'You exceeded your current quota, please check your plan and billing details.',
            status: 'RESOURCE_EXHAUSTED',
          },
        },
        { status: 429 },
      )
    const work = failure(
      buildMediaAdapter({
        kind: 'gemini_images',
        model: 'gemini-image',
        apiKey: 'k',
        baseUrl: `http://127.0.0.1:${server.port}/v1beta`,
      }).run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() }),
    )
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    const error = await work
    expect(hits).toHaveLength(6)
    expect(error.code).toBe('rate_limited')
  } finally {
    clock.restore()
  }
})

/**
 * OpenAI 形状的出图协议按接口地址判定上游：发往火山方舟的地址时按火山方舟的错误码归类，
 * 429 `SetLimitExceeded`（已达到设置的模型用量上限值）为额度用尽；地址不属于任何已收录的上游时按 429 归为限流。
 */
test('OpenAI 形状的出图发往火山方舟时按火山方舟的错误码归类，429 SetLimitExceeded 不重试', async () => {
  const local = `http://127.0.0.1:${server.port}`
  const realFetch = globalThis.fetch
  const routed = spyOn(globalThis, 'fetch').mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) =>
    realFetch(
      String(input).replace('https://ark.cn-beijing.volces.com', local),
      init,
    )) as typeof fetch)
  try {
    reply = () =>
      arkError(
        429,
        'SetLimitExceeded',
        'Your account [a] has reached the set usage limit for the [m] model, and the model service has been paused. Request ID: r.',
        'TooManyRequests',
      )
    const error = await failure(
      buildMediaAdapter({
        kind: 'openai_images',
        model: 'doubao-seedream',
        apiKey: 'k',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      }).run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() }),
    )
    expect(hits).toEqual(['POST'])
    expect(error.code).toBe('insufficient_quota')
  } finally {
    routed.mockRestore()
  }
})

/** 百炼临时上传凭证中的 OSS 地址：必须为 `https://*.aliyuncs.com`，经拦截的 fetch 转到本机接口的 `/oss`。 */
const OSS_HOST = 'bucket.oss-cn-beijing.aliyuncs.com'
const DASHSCOPE_POLICY = {
  data: {
    policy: 'policy',
    signature: 'signature',
    upload_dir: 'dashscope-instant/test',
    upload_host: `https://${OSS_HOST}`,
    oss_access_key_id: 'test',
    x_oss_object_acl: 'private',
    x_oss_forbid_overwrite: 'true',
  },
}
const OSS_BUSY =
  '<Error><Code>ServiceUnavailable</Code><Message>Please try again later.</Message></Error>'
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])

/**
 * 百炼视频任务，参考视频经临时上传：本机接口依次答复取凭证（`policies`）与 OSS 上传（`uploads`），各自用完后答复成功；
 * 其后提交、查询到成功并下载。返回运行结果、OSS 每次收到的文件内容、取凭证次数与提交次数。
 * `as` 替换接口密钥、提示词与运行的日志标识。
 */
async function dashScopeUpload(
  answers: {
    policies: (() => Response)[]
    uploads: (() => Response)[]
  },
  as: { apiKey?: string; prompt?: string; logFields?: Record<string, string>; bytes?: number } = {},
) {
  const local = `http://127.0.0.1:${server.port}`
  const dir = await mkdtemp(join(tmpdir(), 'dashscope-upload-'))
  const path = join(dir, 'clip.mp4')
  // 默认 3 MB：大于一个读取分片，文件内容不完整时可以区分。不核对文件内容的用例用 `bytes` 取较小的文件。
  const video = new Uint8Array(as.bytes ?? 3 * 1024 * 1024).map((_, i) => (i * 31 + 7) % 251)
  await writeFile(path, video)
  const received: Buffer[] = []
  let submitted = 0
  let policies = 0
  reply = async (req) => {
    const { pathname } = new URL(req.url)
    if (pathname === '/api/v1/uploads') {
      policies++
      return answers.policies.shift()?.() ?? Response.json(DASHSCOPE_POLICY)
    }
    if (pathname === '/oss') {
      const file = (await req.formData()).get('file') as File
      received.push(Buffer.from(await file.arrayBuffer()))
      return answers.uploads.shift()?.() ?? new Response('')
    }
    if (pathname.endsWith('/video-synthesis')) {
      submitted++
      return Response.json({ output: { task_id: 't-1', task_status: 'PENDING' } })
    }
    if (pathname === '/api/v1/tasks/t-1') {
      return Response.json({ output: { task_status: 'SUCCEEDED', video_url: `${local}/out.mp4` } })
    }
    return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
  }
  const realFetch = globalThis.fetch
  const routed = spyOn(globalThis, 'fetch').mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) =>
    realFetch(String(input).replace(`https://${OSS_HOST}/`, `${local}/oss`), init)) as typeof fetch)
  const run = buildMediaAdapter({
    kind: 'dashscope_videos',
    model: 'wan3.0-video',
    apiKey: as.apiKey ?? 'k',
    baseUrl: local,
  })
    .run(
      {
        operation: 'video_to_video',
        prompt: as.prompt ?? 'x',
        inputs: [{ role: 'video', bytes: video, mime: 'video/mp4', path }],
        params: {},
      },
      { signal: signal(), ...(as.logFields ? { logFields: as.logFields } : {}) },
    )
    .finally(() => routed.mockRestore())
  return { run, video, received, policies: () => policies, submitted: () => submitted }
}

/**
 * 原始失败形状：百炼的临时上传直接调用 fetch，取凭证被限流或上传到 OSS 得到 503 时一次失败即整张卡失败。
 * 两次请求经 `send`（阶段为上传）：与其他上游的素材上传同样按 2 秒起加倍的间隔重试；重试时同一份表单重新发出，
 * OSS 第二次收到的文件内容完整。
 */
test('百炼临时上传：取凭证被限流、上传到 OSS 得到 503 时各自重试，重试发出的文件内容完整，受理后提交生成', async () => {
  const clock = retryClock()
  try {
    const upload = await dashScopeUpload({
      policies: [
        () =>
          Response.json(
            {
              code: 'Throttling.RateQuota',
              message: 'Requests rate limit exceeded, please try again later.',
            },
            { status: 429 },
          ),
      ],
      uploads: [() => new Response(OSS_BUSY, { status: 503 })],
    })
    await clock.waiting(1)
    await clock.elapse(BACKOFF[0])
    await clock.waiting(2)
    await clock.elapse(BACKOFF[0])
    const result = await upload.run
    expect(result.files[0]?.bytes).toEqual(MP4)
    expect(clock.warnings()).toEqual([
      '素材上传失败，未提交生成：HTTP 429 请求过多：Requests rate limit exceeded, please try again later.；2 秒后第 1 次重试',
      `素材上传失败，未提交生成：HTTP 503 服务不可用：${OSS_BUSY}；2 秒后第 1 次重试`,
    ])
    expect(upload.received).toHaveLength(2)
    for (const bytes of upload.received) expect(bytes.equals(Buffer.from(upload.video))).toBe(true)
    expect(upload.submitted()).toBe(1)
  } finally {
    clock.restore()
  }
})

/**
 * 上传到 OSS 持续得到 503：重试 5 次后报告原文与已做的重试，判为上传阶段被拒绝，不提交生成。
 * 诊断中的主机是 OSS 的主机（云端 `shownReason` 按它把文字中的主机名替换为「上游接口」）。
 */
test('百炼临时上传重试用尽：报告「素材上传失败，未提交生成」与已做的重试，诊断为 OSS 主机，不提交生成', async () => {
  const clock = retryClock()
  try {
    // 六次上传只核对次数，不核对文件内容，用小文件。
    const upload = await dashScopeUpload(
      {
        policies: [],
        uploads: Array.from({ length: 6 }, () => () => new Response(OSS_BUSY, { status: 503 })),
      },
      { bytes: 64 * 1024 },
    )
    for (const [i, ms] of BACKOFF.entries()) {
      await clock.waiting(i + 1)
      await clock.elapse(ms)
    }
    const error = await failure(upload.run)
    expect(error.message).toBe(
      `素材上传失败，未提交生成：HTTP 503 服务不可用：${OSS_BUSY}${BACKOFF_EXHAUSTED}`,
    )
    expect(error.retryReceipt).toBe(BACKOFF_EXHAUSTED.slice(1))
    expect(error.code).toBe('provider_unavailable')
    expect(error.diagnostic).toMatchObject({ stage: 'upload', outcome: 'rejected', host: OSS_HOST })
    expect(upload.received).toHaveLength(6)
    expect(upload.submitted()).toBe(0)
  } finally {
    clock.restore()
  }
})

/** OSS 拒绝上传凭证时的答复：凭证中的签名策略已过期。 */
const OSS_EXPIRED =
  '<Error><Code>AccessDenied</Code><Message>Invalid according to Policy: Policy expired.</Message></Error>'

/**
 * 原始失败形状：OSS 以 403 拒绝上传（凭证过期、签名失效）时按鉴权失败立即失败，整张卡失败，云端提示上游密钥无效。
 * 重新取一次凭证后再上传：取凭证两次，第二次上传的文件内容完整，受理后提交生成。重新取凭证不经 `send` 的重试，没有等待与重试回报。
 */
test('百炼临时上传：OSS 以 403 拒绝时重新取一次凭证后上传，第二次上传的文件内容完整，受理后提交生成', async () => {
  const clock = retryClock()
  try {
    const upload = await dashScopeUpload({
      policies: [],
      uploads: [() => new Response(OSS_EXPIRED, { status: 403 })],
    })
    const result = await upload.run
    expect(result.files[0]?.bytes).toEqual(MP4)
    expect(upload.policies()).toBe(2)
    expect(upload.received).toHaveLength(2)
    expect(upload.received[1]?.equals(Buffer.from(upload.video))).toBe(true)
    expect(upload.submitted()).toBe(1)
    expect(clock.warnings()).toEqual([])
  } finally {
    clock.restore()
  }
})

/**
 * 重新取凭证后 OSS 仍以 403 拒绝：只重新取一次凭证，报错写明素材上传被拒绝与已重新获取凭证，失败码为 `invalid_request`
 * （云端按它显示上游的说明，不按鉴权失败显示「上游密钥无效」），诊断为 OSS 主机，不提交生成。
 */
test('百炼临时上传连续两次被 OSS 以 403 拒绝：只重新取一次凭证，报告素材上传被拒绝，不归为鉴权失败，不提交生成', async () => {
  const clock = retryClock()
  try {
    const upload = await dashScopeUpload({
      policies: [],
      uploads: [
        () => new Response(OSS_EXPIRED, { status: 403 }),
        () => new Response(OSS_EXPIRED, { status: 403 }),
      ],
    })
    const error = await failure(upload.run)
    expect(error.message).toBe(
      `素材上传失败，未提交生成：HTTP 403 禁止访问：${OSS_EXPIRED}；已重新获取上传凭证，仍被拒绝`,
    )
    expect(error.code).toBe('invalid_request')
    expect(error.status).toBe(403)
    expect(error.diagnostic).toMatchObject({ stage: 'upload', outcome: 'rejected', host: OSS_HOST })
    expect(upload.policies()).toBe(2)
    expect(upload.received).toHaveLength(2)
    expect(upload.submitted()).toBe(0)
    expect(clock.warnings()).toEqual([])
  } finally {
    clock.restore()
  }
})

/** OSS 以签名不一致拒绝时的答复：正文带有提交的签名与待签字符串。 */
const OSS_SIGNATURE =
  '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message>' +
  '<SignatureProvided>sig-mark-58c2</SignatureProvided><StringToSign>policy-mark-77d1</StringToSign></Error>'

/**
 * 原始失败形状：重新取凭证没有任何记录，事后无法判断一次上传是否被 OSS 拒绝过。
 * 重新取凭证时写一行：OSS 主机、OSS 的错误码与运行的日志标识；不写 OSS 的错误正文（其中的签名）、接口密钥与提示词。
 */
test('百炼临时上传被 OSS 以 403 拒绝后重新取凭证时写一行日志，只带主机、OSS 的错误码与日志标识', async () => {
  const info = spyOn(log, 'info')
  try {
    const logFields = { canvas: 'board.canvas.json', node: 'n2', record: 'clips/a.task.json' }
    const upload = await dashScopeUpload(
      { policies: [], uploads: [() => new Response(OSS_SIGNATURE, { status: 403 })] },
      { apiKey: KEY_MARK, prompt: PROMPT_MARK, logFields },
    )
    await upload.run
    expect(upload.policies()).toBe(2)
    expect(info.mock.calls.filter(([, message]) => message.includes('OSS'))).toEqual([
      [
        'media',
        '百炼临时上传被 OSS 以 403 拒绝，重新获取上传凭证后再上传',
        { host: OSS_HOST, ossCode: 'SignatureDoesNotMatch', ...logFields },
      ],
    ])
    const written = JSON.stringify(info.mock.calls)
    for (const mark of [KEY_MARK, PROMPT_MARK, 'sig-mark-58c2', 'policy-mark-77d1']) {
      expect(written).not.toContain(mark)
    }
  } finally {
    info.mockRestore()
  }
})

/**
 * 原始失败形状：本机直连时上游报告的状态只进入卡片的内存状态，事后无法核对卡片显示过什么。
 * 经 `buildMediaAdapter` 运行的百炼视频任务：状态变化时写一行，带运行的日志标识，同一状态不重复写；
 * 日志不含接口密钥与提示词。查询间隔（5 秒起乘以 1.5）由假计时器推进。
 */
test('本机直连的任务查询：上游状态变化时写一行日志，带日志标识，不含接口密钥与提示词', async () => {
  jest.useFakeTimers()
  const info = spyOn(log, 'info')
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
  const statusLines = () =>
    info.mock.calls.filter(([, message]) => String(message).startsWith('上游任务状态'))
  try {
    const local = `http://127.0.0.1:${server.port}`
    const states = ['PENDING', 'PENDING', 'RUNNING']
    reply = (req) => {
      const { pathname } = new URL(req.url)
      if (pathname.endsWith('/video-synthesis')) {
        return Response.json({ output: { task_id: 't-9', task_status: 'PENDING' } })
      }
      if (pathname === '/api/v1/tasks/t-9') {
        const status = states.shift()
        return Response.json({
          output: status
            ? { task_status: status }
            : { task_status: 'SUCCEEDED', video_url: `${local}/out.mp4` },
        })
      }
      return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
    }
    const logFields = { canvas: 'board.canvas.json', node: 'n3', record: 'clips/b.task.json' }
    const work = buildMediaAdapter({
      kind: 'dashscope_videos',
      model: 'wan3.0-video',
      apiKey: KEY_MARK,
      baseUrl: local,
    }).run(
      { operation: 'text_to_video', prompt: PROMPT_MARK, inputs: [], params: {} },
      { signal: signal(), logFields },
    )
    // 每让出一次事件循环只推进 25 毫秒，直到任务结束。不要按固定的让出次数判断「查询已答复、等待已开始」后一次推进整个间隔：
    // 机器负载高时答复晚于推进，其后登记的等待不再到期。请求在途时的静默上限（60 秒）同样由假计时器计时，推进过快会先触发它。
    let settled = false
    const done = work.finally(() => {
      settled = true
    })
    for (let i = 0; i < 20_000 && !settled; i++) {
      jest.advanceTimersByTime(25)
      await turn()
    }
    expect((await done).files).toHaveLength(1)
    expect(statusLines()).toEqual([
      ['media', '上游任务状态：PENDING', logFields],
      ['media', '上游任务状态：RUNNING', logFields],
    ])
    const written = JSON.stringify(info.mock.calls)
    expect(written).not.toContain(KEY_MARK)
    expect(written).not.toContain(PROMPT_MARK)
  } finally {
    jest.useRealTimers()
    info.mockRestore()
  }
})

/** 取凭证一步的 403 是接口密钥的问题：仍按鉴权失败处理，不重新取凭证，不上传。 */
test('百炼临时上传取凭证得到 403：按鉴权失败处理，不重新取凭证', async () => {
  const clock = retryClock()
  try {
    const upload = await dashScopeUpload({
      policies: [
        () =>
          Response.json(
            { code: 'InvalidApiKey', message: 'Invalid API-key provided.' },
            { status: 403 },
          ),
      ],
      uploads: [],
    })
    const error = await failure(upload.run)
    expect(error.code).toBe('auth_failed')
    expect(upload.policies()).toBe(1)
    expect(upload.received).toHaveLength(0)
  } finally {
    clock.restore()
  }
})
