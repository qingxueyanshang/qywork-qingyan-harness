/**
 * 覆盖 `adapters/qywork.ts`（云端生成协议，含按任务号确认的日志）与 `catalog.ts` 中云端规格的取得：参数表按原协议、报价按云端单价。
 * 云端是本文件中的模拟服务，按云端 `/v1/media/jobs` 的形状应答。
 */

import { afterAll, expect, jest, test } from 'bun:test'
import { formatLogLine, type LogRecord, type StoredMediaSpec, setLogSink } from '@qywork/core'
import { CLOUD_JOB_ID } from './adapters/qywork.ts'
import { lookupMediaModel, quoteMedia } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { MediaError, type MediaRunOptions } from './types.ts'

const submitted: { request: unknown; files: string[] }[] = []
/** `mj_progress` 的三次查询：云端在等待重试、上游报告排队、上游拒绝后失败。 */
const PROGRESS = [
  {
    status: 'running',
    phase: null,
    retry: { attempt: 1, max: 5, reason: 'HTTP 429 请求过多：busy' },
  },
  { status: 'running', phase: 'queued', retry: null },
  {
    status: 'failed',
    phase: null,
    retry: null,
    error: 'HTTP 429 请求过多：busy；已自动重试 5 次，仍失败',
  },
]
let polls = 0
/**
 * 提交后应答丢失的任务：云端以本机给出的任务号建立了任务（`established`），或查询本身失败（`broken`）；
 * 不在表中的任务号查询时答复 404。
 */
const answerLost = new Map<string, 'established' | 'broken'>()
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (req.headers.get('authorization') !== 'Bearer device-key')
      return new Response('unauthorized', { status: 401 })
    if (req.method === 'POST' && path === '/v1/media/jobs') {
      const form = await req.formData()
      const request = JSON.parse(String(form.get('request'))) as { id: string; model: string }
      submitted.push({ request, files: [...form.keys()].filter((k) => k !== 'request') })
      // 网关在云端处理完之后返回 502 错误页：本机得不到任务号，结果未知。
      if (request.model.startsWith('gateway-')) {
        if (request.model === 'gateway-established') answerLost.set(request.id, 'established')
        if (request.model === 'gateway-broken') answerLost.set(request.id, 'broken')
        return new Response('<html><title>502 Bad Gateway</title></html>', { status: 502 })
      }
      const id =
        request.model === 'lost'
          ? 'mj_lost'
          : request.model === 'progress'
            ? 'mj_progress'
            : 'mj_ok'
      return Response.json({ id, status: 'queued' }, { status: 201 })
    }
    const lost = answerLost.get(path.split('/')[4] ?? '')
    if (lost === 'broken') return new Response('busy', { status: 500 })
    if (lost === 'established' && path.endsWith('/files/0'))
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    if (lost === 'established')
      return Response.json({
        status: 'succeeded',
        error: null,
        unknownReason: null,
        credits: 0.2,
        files: 1,
      })
    if (path === '/v1/media/jobs/mj_progress') {
      const step = PROGRESS[Math.min(polls++, PROGRESS.length - 1)]!
      return Response.json({ error: null, unknownReason: null, credits: 0, files: 0, ...step })
    }
    if (path === '/v1/media/jobs/mj_ok')
      return Response.json({
        status: 'succeeded',
        error: null,
        unknownReason: null,
        credits: 0.4,
        files: 2,
      })
    if (path === '/v1/media/jobs/mj_lost')
      return Response.json({
        status: 'unknown',
        error: null,
        unknownReason: 'submit_lost',
        credits: 0,
        files: 0,
      })
    if (path.startsWith('/v1/media/jobs/mj_ok/files/'))
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { 'content-type': 'image/png' },
      })
    if (path === '/v1/media/jobs/mj_started/cancel')
      return Response.json(
        { error: { code: 'already_started', message: '上游已开始生成，无法撤销' } },
        { status: 409 },
      )
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => server.stop(true))

const spec: StoredMediaSpec = {
  cloud: { kind: 'openai_images', spec: { base: 'gpt-image-2' }, unit: 'image', unitPrice: 0.2 },
}
const adapter = (model: string) =>
  buildMediaAdapter({
    kind: 'qywork_images',
    model,
    apiKey: 'device-key',
    baseUrl: `http://127.0.0.1:${server.port}`,
    spec,
  })
const run = (model: string, opts: Partial<MediaRunOptions> = {}) =>
  adapter(model).run(
    {
      operation: 'generate',
      prompt: '猫',
      inputs: [{ role: 'reference', bytes: new Uint8Array([1]), mime: 'image/png', path: '' }],
      params: { n: 2 },
    },
    { signal: new AbortController().signal, ...opts },
  )

test('云端规格：参数表与操作按原协议取得，协议为云端协议；发送前按云端单价报价', () => {
  const s = lookupMediaModel('cloud-image', 'qywork_images', spec)
  expect(s.kind).toBe('qywork_images')
  expect(s.operations).toEqual(['generate', 'edit'])
  expect(s.params.map((p) => p.name)).toContain('n')
  expect(quoteMedia(s, { n: 3 }, { images: 0, videos: 0 })).toEqual({
    cost: 0.6000000000000001,
    currency: 'CREDIT',
  })
})

test('提交到云端任务接口，任务号由本机生成；取回全部结果文件；金额取云端回报的扣费', async () => {
  const result = await run('cloud-image')
  expect(submitted.at(-1)).toEqual({
    request: {
      id: expect.stringMatching(CLOUD_JOB_ID),
      model: 'cloud-image',
      operation: 'generate',
      prompt: '猫',
      params: { n: 2 },
      mimes: ['image/png'],
    },
    files: ['input.reference'],
  })
  expect(result.files).toHaveLength(2)
  expect(result.files[0]?.mime).toBe('image/png')
  expect(result.usage).toEqual({ images: 2, billed: { amount: 0.4, currency: 'CREDIT' } })
})

test('云端任务结果不明时以终态失败返回原因，不带任务号（云端已退回，不再接续）', async () => {
  const err = await run('lost').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(MediaError)
  expect((err as MediaError).message).toContain('结果不明，积分已退回：提交时连接中断')
  expect((err as MediaError).pendingTaskId).toBeUndefined()
})

/**
 * 原始失败形状：云端任务的 `queued` / `running`（云端是否已向上游提交）被当作上游的排队中 / 生成中回报，
 * 云端一侧的重试没有回报，失败原因多出「远端任务失败」前缀，三处都与本机直连不同。
 */
test('云端回报的重试等待与上游状态原样交给调用方，云端任务自身的状态不当作上游状态；失败原因不加前缀', async () => {
  jest.useFakeTimers()
  try {
    const retries: unknown[] = []
    const statuses: string[] = []
    let settled = false
    const work = adapter('progress')
      .run(
        { operation: 'generate', prompt: '猫', inputs: [], params: {} },
        {
          signal: new AbortController().signal,
          onRetry: (retry) => retries.push(retry),
          onStatus: (status) => statuses.push(status),
        },
      )
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true
      })
    // 查询间隔由假计时器推进；请求与响应经本机接口完成，每次推进后让出事件循环。
    for (let i = 0; i < 5000 && !settled; i++) {
      jest.advanceTimersByTime(100)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const err = await work
    expect(retries).toEqual([{ attempt: 1, max: 5, reason: 'HTTP 429 请求过多：busy' }, null])
    expect(statuses).toEqual(['queued'])
    expect(err).toBeInstanceOf(MediaError)
    expect((err as MediaError).message).toBe('HTTP 429 请求过多：busy；已自动重试 5 次，仍失败')
    expect((err as MediaError).pendingTaskId).toBeUndefined()
  } finally {
    jest.useRealTimers()
  }
})

/**
 * 原始失败形状：云端已建立任务并扣费，应答没有到达本机（网关错误页），本机没有任务号，结果无法取回。
 * 任务号由本机生成：应答丢失时按任务号查询一次，云端已建立则取回结果。
 */
test('提交后应答丢失：按本机生成的任务号查询到云端任务时按已提交继续，取回结果', async () => {
  const tasks: string[] = []
  const result = await run('gateway-established', { onTask: (id) => void tasks.push(id) })
  const id = (submitted.at(-1)?.request as { id: string }).id
  expect(answerLost.get(id)).toBe('established')
  expect(tasks).toEqual([id])
  expect(result.files).toHaveLength(1)
  expect(result.usage?.billed).toEqual({ amount: 0.2, currency: 'CREDIT' })
})

test('提交后应答丢失：云端答复任务不存在时判为未受理，原因写明任务未建立、未扣费', async () => {
  const err = await run('gateway-missing').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(MediaError)
  expect((err as MediaError).message).toBe('HTTP 502 网关错误：502 Bad Gateway；任务未建立，未扣费')
  expect((err as MediaError).diagnostic).toMatchObject({ stage: 'generate', outcome: 'rejected' })
  expect((err as MediaError).pendingTaskId).toBeUndefined()
})

test('提交后应答丢失且查询失败：带任务号结束等待；之后取回时云端答复不存在为终态', async () => {
  const tasks: string[] = []
  const err = await run('gateway-broken', { onTask: (id) => void tasks.push(id) }).catch(
    (e: unknown) => e,
  )
  const id = (submitted.at(-1)?.request as { id: string }).id
  expect(tasks).toEqual([id])
  expect(err).toBeInstanceOf(MediaError)
  expect((err as MediaError).pendingTaskId).toBe(id)
  expect((err as MediaError).message).toBe(
    `任务查询失败：HTTP 500 服务器内部错误：busy（远端任务 ${id} 仍可取回）`,
  )
  // 取回：云端答复该任务不存在，任务没有建立，不再保留为可取回。
  answerLost.delete(id)
  const resumed = await run('x', { resumeTaskId: id }).catch((e: unknown) => e)
  expect(resumed).toBeInstanceOf(MediaError)
  expect((resumed as MediaError).message).toBe('任务未建立，未扣费')
  expect((resumed as MediaError).pendingTaskId).toBeUndefined()
})

/**
 * 原始失败形状：按任务号确认的经过不写日志，出现「已扣费而本机判为未建立」时本机没有可查的记录。
 * 确认的发起（带原始失败的诊断）与三种结论各写一行，取回时云端答复任务不存在同样写一行；都带任务号与运行的日志标识，
 * 不含设备密钥与提示词。日志经替换的 sink 记录，同时照常写到 stderr。
 */
test('提交结果未知后按任务号确认的经过写入日志：带任务号与日志标识，不含设备密钥与提示词', async () => {
  const records: LogRecord[] = []
  setLogSink((record) => {
    records.push(record)
    process.stderr.write(`${formatLogLine(record)}\n`)
  })
  try {
    const logFields = { canvas: 'board.canvas.json', node: 'n3', record: 'generated/c.task.json' }
    const prompt = '提示词特征串-cloud-mark-5e1f'
    const go = (model: string, opts: Partial<MediaRunOptions> = {}) =>
      adapter(model)
        .run(
          { operation: 'generate', prompt, inputs: [], params: {} },
          { signal: new AbortController().signal, logFields, ...opts },
        )
        .catch((e: unknown) => e)
    const lastId = () => (submitted.at(-1)?.request as { id: string }).id
    const unknown = {
      stage: 'generate',
      kind: 'http',
      outcome: 'unknown',
      host: `127.0.0.1:${server.port}`,
      status: 502,
    }
    const opening = (job: string) => ({
      level: 'warn' as const,
      scope: 'media',
      message:
        '提交结果未知，按任务号查询云端是否已建立任务：HTTP 502 网关错误：502 Bad Gateway；远端结果未知',
      fields: { ...logFields, job, diagnostic: expect.objectContaining(unknown) },
    })
    const line = (level: LogRecord['level'], message: string, job: string) => ({
      level,
      scope: 'media',
      message,
      fields: { ...logFields, job },
    })

    await go('gateway-established')
    const established = lastId()
    await go('gateway-missing')
    const missing = lastId()
    await go('gateway-broken')
    const broken = lastId()
    answerLost.delete(broken)
    await go('x', { resumeTaskId: broken })
    expect(
      records.map(({ level, scope, message, fields }) => ({ level, scope, message, fields })),
    ).toEqual([
      opening(established),
      line('info', '云端已建立该任务，按已提交继续等待', established),
      opening(missing),
      line('warn', '云端答复任务不存在，判为未受理：任务未建立，未扣费', missing),
      opening(broken),
      line(
        'warn',
        '按任务号确认失败，带任务号结束等待：任务查询失败：HTTP 500 服务器内部错误：busy',
        broken,
      ),
      line('warn', '云端答复任务不存在，判为任务未建立，未扣费', broken),
    ])
    const written = JSON.stringify(records)
    expect(written).not.toContain('device-key')
    expect(written).not.toContain(prompt)
  } finally {
    setLogSink(null)
  }
})

test('撤销：云端回答上游已开始生成时为 started（按结果计费）', async () => {
  expect(await adapter('x').cancel?.('mj_started', new AbortController().signal)).toBe('started')
})
