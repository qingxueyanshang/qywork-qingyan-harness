import { expect, spyOn, test } from 'bun:test'
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
