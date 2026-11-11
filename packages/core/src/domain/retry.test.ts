/**
 * 暂时故障的重试间隔、重发的退避与 Retry-After、可取消的等待。覆盖 `domain/retry.ts`。
 *
 * 等待使用假计时器推进，不实际等待 30 秒以上。
 */

import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test'
import {
  resendDelay,
  retryScheduleText,
  TRANSIENT_RETRY_DELAYS_MS,
  transientRetryDelay,
  waitOrAbort,
} from './retry.ts'

afterEach(() => {
  jest.useRealTimers()
})

describe('重试间隔', () => {
  test('依次为 30 秒、2 分钟、5 分钟，共 3 次', () => {
    expect(TRANSIENT_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 300_000])
    expect(retryScheduleText()).toBe('30 秒、2 分钟、5 分钟')
    expect(retryScheduleText(2)).toBe('30 秒、2 分钟')
  })

  /** 抖动只向后延：同一批同时被拒的请求错开数秒，不早于间隔表。 */
  test('在间隔之上随机延后至多十分之一', () => {
    const at = (retry: number, r: number, retryAfterMs: number | null = null) => {
      const random = spyOn(Math, 'random').mockReturnValue(r)
      const wait = transientRetryDelay(retry, retryAfterMs)
      random.mockRestore()
      return wait
    }
    expect([at(0, 0), at(0, 1)]).toEqual([30_000, 33_000])
    expect([at(1, 0), at(2, 0)]).toEqual([120_000, 300_000])
  })

  test('Retry-After 更长时按其等待，不超过间隔表的最大值；更短时按间隔表', () => {
    const at = (retry: number, retryAfterMs: number) => {
      const random = spyOn(Math, 'random').mockReturnValue(0)
      const wait = transientRetryDelay(retry, retryAfterMs)
      random.mockRestore()
      return wait
    }
    expect(at(0, 90_000)).toBe(90_000)
    expect(at(0, 3_600_000)).toBe(300_000)
    expect(at(1, 1_000)).toBe(120_000)
  })
})

describe('重发的等待', () => {
  const at = (resends: number, retryAfterMs: number | null, r = 0) => {
    const random = spyOn(Math, 'random').mockReturnValue(r)
    const wait = resendDelay(resends, retryAfterMs)
    random.mockRestore()
    return wait
  }

  test('没有 Retry-After 时 2 秒起每次加倍，不超过 30 秒，随机延后至多十分之一', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => at(n, null))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ])
    expect(at(0, null, 1)).toBe(2_200)
  })

  /**
   * 对话请求与生成的重试共用这一规则。原始失败形状：对话完全按 Retry-After 等待（给出 0 秒时立即重发，
   * 给出 10 分钟时等待 10 分钟），生成取不超过 30 秒，两处规则不同。
   */
  test('有 Retry-After 时按其等待，不短于退避间隔，不超过 60 秒', () => {
    expect(at(0, 10_000)).toBe(10_000)
    expect(at(0, 0)).toBe(2_000)
    expect(at(2, 1_000)).toBe(8_000)
    expect(at(0, 600_000)).toBe(60_000)
  })
})

describe('可取消的等待', () => {
  test('到时即结束', async () => {
    jest.useFakeTimers()
    let done = false
    const waiting = waitOrAbort(30_000, new AbortController().signal).then(() => {
      done = true
    })
    jest.advanceTimersByTime(29_999)
    await Promise.resolve()
    expect(done).toBe(false)
    jest.advanceTimersByTime(1)
    await waiting
    expect(done).toBe(true)
  })

  /** 用户停止时等待立即结束并清除计时器，停止之后不再发出请求。 */
  test('停止时立即以停止原因结束，计时器随之清除', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    const waiting = waitOrAbort(300_000, controller.signal)
    expect(jest.getTimerCount()).toBe(1)
    controller.abort({ source: 'user' })
    expect(await waiting.catch((reason: unknown) => reason)).toEqual({ source: 'user' })
    expect(jest.getTimerCount()).toBe(0)
  })

  test('已停止时不开始等待', async () => {
    const controller = new AbortController()
    controller.abort('stopped')
    expect(await waitOrAbort(30_000, controller.signal).catch((reason: unknown) => reason)).toBe(
      'stopped',
    )
  })
})
