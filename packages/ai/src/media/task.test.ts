import { expect, spyOn, test } from 'bun:test'
import { afterSubmit, waitTask } from './task.ts'
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

test('查询暂时失败不结束等待，远端完成后返回结果；其他查询错误结束等待并保留任务号', async () => {
  const original = globalThis.setTimeout
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
    original(fn, 1)) as typeof setTimeout)
  try {
    const abort = new AbortController()
    const add = spyOn(abort.signal, 'addEventListener')
    const remove = spyOn(abort.signal, 'removeEventListener')
    const transient = [
      new MediaError('网关错误', { status: 503 }),
      new MediaError('限流', { status: 429 }),
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
    let queries = 0
    const done = await waitTask(
      async () => {
        const failure = transient[queries++ % transient.length]
        if (queries <= 12) throw failure
        return { state: 'done', url: 'https://relay.test/v.mp4' }
      },
      { signal: abort.signal },
    )
    expect(done).toMatchObject({ state: 'done', url: 'https://relay.test/v.mp4' })
    expect(queries).toBe(13)
    expect(remove.mock.calls.length).toBe(add.mock.calls.length)

    queries = 0
    const rejected = afterSubmit('original', abort.signal, () =>
      waitTask(
        async () => {
          queries++
          throw new MediaError('任务查询失败：HTTP 401 未授权', { status: 401 })
        },
        { signal: abort.signal },
      ),
    )
    await expect(rejected).rejects.toMatchObject({ pendingTaskId: 'original' })
    expect(queries).toBe(1)
  } finally {
    timers.mockRestore()
  }
})
