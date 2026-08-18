/**
 * `runs.ts` 的并发边界。
 *
 * 覆盖范围：`RunManager` 的会话占位（reserve / release / isBusy）与待应答授权的读回
 * （pendingFor）。授权的应答链路由 `e2e.test.ts` 走真实链路覆盖，这里不重复。
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

/**
 * 授权请求只广播一次，而界面会重建（切走再切回、断线补不上缺口整条重拉）。
 * 重建那一侧只能回头来问——问不到的表现是：一轮卡着不动、没有任何可点的东西，
 * 五分钟后按拒绝超时，而服务端那个 promise 一直在等。
 */
describe('待应答的授权要问得到', () => {
  const bus = { publish: () => {} } as never

  test('发起之后按会话读得回来，字段够画那张卡', () => {
    const runs = new RunManager(null as never, bus)
    void runs.requestPermission({
      runId: 'rn_1' as never,
      conversationId: 'cv_1' as never,
      toolName: 'run_command',
      scope: 'run:npm test',
      preview: 'npm test',
      action: { kind: 'run', objectLabel: '命令', target: 'npm test' } as never,
    })

    const ask = runs.pendingFor('cv_1' as never)
    expect(ask?.toolName).toBe('run_command')
    expect(ask?.preview).toBe('npm test')
    // 按钮照服务端给的档位渲染，少了它界面就没有可点的东西。
    expect(ask?.scopes.length).toBeGreaterThan(0)
    expect(ask?.expiresAt).toBeGreaterThan(Date.now())
    // 别的会话不该看见它。
    expect(runs.pendingFor('cv_2' as never)).toBe(null)

    runs.resolvePermission(ask!.requestId, false, 'desktop')
    expect(runs.pendingFor('cv_1' as never)).toBe(null)
  })

  test('没人在等就是 null，不是抛错', () => {
    const runs = new RunManager(null as never, bus)
    expect(runs.pendingFor('cv_1' as never)).toBe(null)
  })
})
