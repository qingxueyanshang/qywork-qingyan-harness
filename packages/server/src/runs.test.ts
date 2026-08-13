/**
 * `runs.ts` 的并发边界。
 *
 * 覆盖范围：`RunManager` 的会话占位（reserve / release / isBusy）。
 * 权限授权与补发那几段由 `e2e.test.ts` 走真实链路覆盖，这里不重复。
 */

import { describe, expect, test } from 'bun:test'
import { RunManager } from './runs.ts'

describe('同会话只允许一个 run', () => {
  /**
   * 原始失败形状：`isBusy()` 检查与 `runs.register()` 之间隔着建 Session、
   * 读附件、等首个带 runId 的事件——好几个 await。桌面端与手机端几乎同时发消息时，
   * 两次检查都读到 false，于是两个 AgentLoop 对着同一个工作区一起写文件。
   *
   * 这里测的就是「检查与占位是不是同一个同步动作」，不测调用次数。
   */
  test('并发 reserve 只有第一个拿得到', () => {
    const runs = new RunManager(null as never, null as never)
    const cv = 'cv_1' as never
    expect(runs.reserve(cv)).toBe(true)
    expect(runs.reserve(cv)).toBe(false)
    expect(runs.isBusy(cv)).toBe(true)
  })

  test('没跑起来时 release 要把会话放开 —— 否则它被永久锁死', () => {
    const runs = new RunManager(null as never, null as never)
    const cv = 'cv_2' as never
    expect(runs.reserve(cv)).toBe(true)
    runs.release(cv)
    expect(runs.isBusy(cv)).toBe(false)
    expect(runs.reserve(cv)).toBe(true)
  })

  test('不同会话互不影响', () => {
    const runs = new RunManager(null as never, null as never)
    expect(runs.reserve('cv_a' as never)).toBe(true)
    expect(runs.reserve('cv_b' as never)).toBe(true)
  })
})
