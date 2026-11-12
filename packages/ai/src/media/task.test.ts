/**
 * 覆盖 `task.ts` 的 `waitTask`、`afterSubmit`，查询暂时失败与上游状态变化的日志带上运行的日志标识（`http.ts` 的 `reportingRetries`），
 * 以及取得任务号之后的失败保留诊断与失败码、上游报告的任务失败的诊断取自该次查询的答复（`http.ts` 的 `recordingAnswers`）。
 */
import { expect, jest, spyOn, test } from 'bun:test'
import { log } from '@qywork/core'
import { getJson, reportingRetries } from './http.ts'
import { afterSubmit, type TaskState, waitTask } from './task.ts'
import { MediaError } from './types.ts'

test('进入轮询之前已中止时不再查询远端', async () => {
  const abort = new AbortController()
  const reason = new Error('已停止')
  abort.abort(reason)
  let queries = 0
  await expect(
    waitTask(
      async () => {
        queries++
        return { state: 'pending', status: 'queued' }
      },
      { signal: abort.signal },
    ),
  ).rejects.toBe(reason)
  expect(queries).toBe(0)
})

test('状态回调中停止时立即退出，不因错过中止事件阻塞于轮询间隔', async () => {
  const abort = new AbortController()
  const reason = new Error('已停止')
  let queries = 0
  await expect(
    waitTask(
      async () => {
        queries++
        return { state: 'pending', status: 'queued' }
      },
      { signal: abort.signal, onStatus: () => abort.abort(reason) },
    ),
  ).rejects.toBe(reason)
  expect(queries).toBe(1)
})

/**
 * 云端按失败码替换运营方一侧的原文（`MediaError.code`）。上游报告的任务失败没有状态码，原因提及余额或额度用尽时同样记为额度用尽，
 * 否则云端把运营方的余额原文显示给用户。
 */
test('上游报告的任务失败提及余额不足时失败码为额度用尽，其余失败没有失败码', async () => {
  const fail = (message: string): Promise<MediaError> =>
    waitTask(async (): Promise<TaskState> => ({ state: 'failed', message }), {
      signal: new AbortController().signal,
    }).then(
      () => {
        throw new Error('应以远端失败结束')
      },
      (err: unknown) => err as MediaError,
    )
  const quota = await fail('账户余额不足')
  expect(quota.message).toBe('远端任务失败：账户余额不足')
  expect(quota.code).toBe('insufficient_quota')
  expect((await fail('内容不合规')).code).toBeUndefined()
})

test('查询暂时失败在 600 秒内不结束等待，成功查询重新计时；持续失败或其他查询错误结束等待并保留任务号', async () => {
  const original = globalThis.setTimeout
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
    original(fn, 1)) as typeof setTimeout)
  // 每次查询经过 1 分钟。
  let clock = 0
  const now = spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const abort = new AbortController()
    const add = spyOn(abort.signal, 'addEventListener')
    const remove = spyOn(abort.signal, 'removeEventListener')
    const transient = [
      new MediaError('网关错误', { status: 503, code: 'provider_unavailable' }),
      new MediaError('限流', { status: 429, code: 'rate_limited' }),
      new MediaError('连接被断开', {
        diagnostic: {
          stage: 'query',
          kind: 'connection',
          outcome: 'unknown',
          host: 'relay.test',
          elapsedMs: 1,
        },
      }),
    ]
    // 第 10 次查询返回排队中，第 20 次返回完成，其余为暂时失败：两段各连续失败 9 次，每段不足 600 秒，
    // 合计超过 600 秒，因此同时锁定成功查询重新计时。
    const states = [...Array(9).fill(false), true, ...Array(9).fill(false)]
    let queries = 0
    const done = await waitTask(
      async (): Promise<TaskState> => {
        clock += 60_000
        const ok = states[queries]
        const failure = transient[queries++ % transient.length]
        if (ok === false) throw failure
        return ok
          ? { state: 'pending', status: 'queued' }
          : { state: 'done', url: 'https://relay.test/v.mp4' }
      },
      { signal: abort.signal },
    )
    expect(done).toMatchObject({ state: 'done', url: 'https://relay.test/v.mp4' })
    expect(queries).toBe(states.length + 1)
    expect(remove.mock.calls.length).toBe(add.mock.calls.length)

    queries = 0
    const exhausted = afterSubmit('original', abort.signal, () =>
      waitTask(
        async () => {
          clock += 60_000
          queries++
          throw transient[0]
        },
        { signal: abort.signal },
      ),
    )
    await expect(exhausted).rejects.toMatchObject({
      pendingTaskId: 'original',
      message: expect.stringContaining('任务查询连续失败超过 600 秒'),
    })
    // 第 1 次失败开始计时，第 11 次失败时已满 600 秒。
    expect(queries).toBe(11)

    queries = 0
    const rejected = afterSubmit('original', abort.signal, () =>
      waitTask(
        async () => {
          queries++
          throw new MediaError('任务查询失败：HTTP 401 未授权', {
            status: 401,
            code: 'auth_failed',
          })
        },
        { signal: abort.signal },
      ),
    )
    await expect(rejected).rejects.toMatchObject({ pendingTaskId: 'original' })
    expect(queries).toBe(1)
  } finally {
    timers.mockRestore()
    now.mockRestore()
  }
})

/**
 * 原始失败形状：查询暂时失败的日志只有原因，同时等待多个任务时无法判断属于哪一个。
 * 运行的日志标识（`reportingRetries` 登记的 `logFields`）附在该行上。本用例的日志照常写出（不替换 `log.warn`）。
 */
test('查询暂时失败的日志带上本次运行的日志标识', async () => {
  jest.useFakeTimers()
  const warn = spyOn(log, 'warn')
  try {
    let queries = 0
    const work = reportingRetries({ logFields: { job: 'mj_00000000000000a1' } }, () =>
      waitTask(
        async (): Promise<TaskState> => {
          if (queries++ === 0)
            throw new MediaError('任务查询失败：HTTP 429 请求过多：busy', {
              status: 429,
              code: 'rate_limited',
            })
          return { state: 'done', url: 'https://relay.test/v.mp4' }
        },
        { signal: new AbortController().signal },
      ),
    )
    for (let i = 0; i < 1000 && warn.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    jest.advanceTimersByTime(5_000)
    expect(await work).toMatchObject({ state: 'done' })
    expect(warn.mock.calls).toEqual([
      [
        'media',
        '任务查询失败：HTTP 429 请求过多：busy；继续查询原任务',
        { job: 'mj_00000000000000a1' },
      ],
    ])
  } finally {
    jest.useRealTimers()
    warn.mockRestore()
  }
})

/**
 * 原始失败形状：上游报告的状态（排队中、生成中）只进入卡片的内存状态，事后无法核对卡片显示过什么。
 * 状态变化时写一行日志，带运行的日志标识；同一状态连续出现时不重复写，与 `onStatus` 的回报次数相同。
 */
test('上游状态变化时写一行日志，带本次运行的日志标识；同一状态不重复写', async () => {
  jest.useFakeTimers()
  const info = spyOn(log, 'info')
  try {
    const states = ['queued', 'queued', 'running', 'running']
    const reported: string[] = []
    let queries = 0
    const logFields = { canvas: 'board.canvas.json', node: 'n1', record: 'generated/v.task.json' }
    const work = reportingRetries({ logFields }, () =>
      waitTask(
        async (): Promise<TaskState> => {
          const status = states[queries++]
          return status
            ? { state: 'pending', status }
            : { state: 'done', url: 'https://relay.test/v.mp4' }
        },
        { signal: new AbortController().signal, onStatus: (s) => reported.push(s) },
      ),
    )
    let finished = false
    work.then(
      () => {
        finished = true
      },
      () => {
        finished = true
      },
    )
    // 每让出一次事件循环推进 1 秒：查询间隔为 5 秒起乘以 1.5，四次等待合计不足 40 秒。
    for (let i = 0; i < 10_000 && !finished; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      jest.advanceTimersByTime(1_000)
    }
    expect(await work).toMatchObject({ state: 'done' })
    expect(info.mock.calls.filter(([scope]) => scope === 'media')).toEqual([
      ['media', '上游任务状态：queued', logFields],
      ['media', '上游任务状态：running', logFields],
    ])
    expect(reported).toEqual(['queued', 'running'])
  } finally {
    jest.useRealTimers()
    info.mockRestore()
  }
})

/**
 * 原始失败形状：任务号交出之后的失败被包装为「…（远端任务 X 仍可取回）」的新错误，原错误的诊断与失败码丢失，
 * 画布的运行记录没有失败码。包装保留两者，诊断的结果记为可取回；报错文字与改动前逐字相同，不带状态码。
 * 查询持续失败而结束等待时，报错带最后一次查询失败的诊断与失败码。不是接口错误的失败（保存任务记录失败）没有诊断。
 */
test('取得任务号之后的失败保留原错误的诊断与失败码，结果记为可取回；报错文字不变', async () => {
  const signal = new AbortController().signal
  const diagnostic = {
    stage: 'query' as const,
    kind: 'http' as const,
    outcome: 'rejected' as const,
    host: 'relay.test',
    elapsedMs: 3,
    status: 401,
  }
  const rejected = new MediaError('任务查询失败：HTTP 401 未授权：denied', {
    status: 401,
    code: 'auth_failed',
    diagnostic,
  })
  const caught = (work: Promise<unknown>) =>
    work.then(
      () => {
        throw new Error('应失败')
      },
      (err: unknown) => err as MediaError,
    )
  const wrapped = await caught(
    afterSubmit('task-1', signal, async () => {
      throw rejected
    }),
  )
  expect(wrapped.message).toBe('任务查询失败：HTTP 401 未授权：denied（远端任务 task-1 仍可取回）')
  expect(wrapped.pendingTaskId).toBe('task-1')
  expect(wrapped.code).toBe('auth_failed')
  expect(wrapped.diagnostic).toEqual({ ...diagnostic, outcome: 'available' })
  expect(wrapped.status).toBeUndefined()

  const saved = await caught(
    afterSubmit('task-1', signal, async () => {
      throw new Error('EACCES: permission denied')
    }),
  )
  expect(saved.message).toBe('EACCES: permission denied（远端任务 task-1 仍可取回）')
  expect([saved.diagnostic, saved.code]).toEqual([undefined, undefined])

  const original = globalThis.setTimeout
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
    original(fn, 1)) as typeof setTimeout)
  let clock = 0
  const now = spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const busy = new MediaError('任务查询失败：HTTP 503 服务不可用：busy', {
      status: 503,
      code: 'provider_unavailable',
      diagnostic: { ...diagnostic, status: 503 },
    })
    const exhausted = await caught(
      afterSubmit('task-2', signal, () =>
        waitTask(
          async () => {
            clock += 60_000
            throw busy
          },
          { signal },
        ),
      ),
    )
    expect(exhausted.message).toBe(
      '任务查询连续失败超过 600 秒，已停止等待：任务查询失败：HTTP 503 服务不可用：busy（远端任务 task-2 仍可取回）',
    )
    expect(exhausted.code).toBe('provider_unavailable')
    expect(exhausted.diagnostic).toEqual({ ...diagnostic, status: 503, outcome: 'available' })
  } finally {
    timers.mockRestore()
    now.mockRestore()
  }
})

/**
 * 原始失败形状：上游报告的任务失败没有请求诊断，画布的运行记录没有失败码与阶段。
 * 诊断取自报告失败的那次查询的答复（主机、用时、状态码），阶段为查询，结果为 `failed`（远端受理后报告失败）；
 * 原文提及余额不足时失败码为额度用尽。报错文字不变，不附带任务号（终态）。
 */
test('上游报告的任务失败带上该次查询的诊断，结果为远端受理后失败；报错文字不变', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json({ status: 'failed', message: '账户余额不足' }),
  })
  const signal = new AbortController().signal
  try {
    const failed = await afterSubmit('task-3', signal, () =>
      waitTask(
        async (): Promise<TaskState> => {
          const body = await getJson(`http://127.0.0.1:${server.port}/tasks/task-3`, {}, signal)
          return { state: 'failed', message: String(body.message) }
        },
        { signal },
      ),
    ).then(
      () => {
        throw new Error('应以远端失败结束')
      },
      (err: unknown) => err as MediaError,
    )
    expect(failed.message).toBe('远端任务失败：账户余额不足')
    expect(failed.pendingTaskId).toBeUndefined()
    expect(failed.code).toBe('insufficient_quota')
    expect(failed.diagnostic).toEqual({
      stage: 'query',
      kind: 'http',
      outcome: 'failed',
      host: `127.0.0.1:${server.port}`,
      elapsedMs: expect.any(Number),
      timeoutMs: 60_000,
      status: 200,
    })
  } finally {
    server.stop(true)
  }
})
