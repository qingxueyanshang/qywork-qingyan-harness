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

test('连续查询失败有限重试并保留任务，成功查询会重置计数，长期真实排队不判失败', async () => {
  const original = globalThis.setTimeout
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
    original(fn, 1)) as typeof setTimeout)
  try {
    for (const states of [
      [false, false, false],
      [false, false, true, false, false, true, true, true, false, false, false],
    ]) {
      const abort = new AbortController()
      const add = spyOn(abort.signal, 'addEventListener')
      const remove = spyOn(abort.signal, 'removeEventListener')
      let queries = 0
      const run = afterSubmit('original', abort.signal, () =>
        waitTask(
          async () => {
            if (!states[queries++]) throw new MediaError('网关错误', { status: 503 })
            return { state: 'pending', status: 'queued' }
          },
          { signal: abort.signal },
        ),
      )
      await expect(run).rejects.toMatchObject({
        pendingTaskId: 'original',
        message: expect.stringContaining('连续 3 次任务查询失败'),
      })
      expect(queries).toBe(states.length)
      expect(remove.mock.calls.length).toBe(add.mock.calls.length)
      add.mockRestore()
      remove.mockRestore()
    }
  } finally {
    timers.mockRestore()
  }
})
