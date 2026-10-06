/**
 * `runs.ts` 的并发边界。
 *
 * 覆盖范围：`RunManager` 的会话占位（reserve / release）、忙态的两项查询
 * （hasRun / isBusy）、忙闲广播（conversation.busy）与按会话中断
 * （interruptConversation）。指令入口层的拒绝由 `goal-loop.test.ts` 覆盖，
 * 运行表本身（`subagents.ts`）由 `delegate.test.ts` 覆盖，这里不重复。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import { EventBus } from './bus.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

describe('更新与新任务互斥', () => {
  test('占位、运行、子任务、跟进队列全部结束后才允许退出', () => {
    const subagents = new SubagentRegistry()
    const runs = new RunManager(null as never, new EventBus(), subagents)
    const cv = 'cv_update' as ConversationId
    runs.reserve(cv)
    expect(runs.claimUpdate()).toBe(false)
    runs.register({
      conversationId: cv,
      runId: 'rn_update' as never,
      controller: new AbortController(),
      startedAt: 0,
    })
    expect(runs.claimUpdate()).toBe(false)
    runs.unregister('rn_update' as never)
    subagents.add(cv, 'child', { name: 'child', kind: 'temp', controller: new AbortController() })
    expect(runs.claimUpdate()).toBe(false)
    subagents.remove(cv, 'child')
    runs.enqueue(cv, { id: 'queued', content: 'pending', steer: false })
    expect(runs.claimUpdate()).toBe(false)
    runs.takeNext(cv)
    runs.arm(cv, { goalId: 'goal-update', revision: 1 })
    expect(runs.claimUpdate()).toBe(false)
    runs.disarm(cv)
    expect(runs.claimUpdate()).toBe(true)
    expect(runs.reserve(cv)).toBe(false)
    expect(runs.reserve('another' as ConversationId)).toBe(false)
    runs.cancelUpdate()
    expect(runs.reserve(cv)).toBe(true)
  })
})

describe('同会话只允许一个 run', () => {
  /**
   * 原始失败形状：`isBusy()` 检查与 `runs.register()` 之间隔着创建 Session、
   * 读取附件、等待首个带 runId 的事件等多个 await。桌面端与手机端几乎同时发送消息时，
   * 两次检查都读到 false，两个 AgentLoop 因此同时写入同一个工作区。
   *
   * 此处测试检查与占位是否为同一个同步操作，不测试调用次数。
   */
  test('并发 reserve 只有第一个能够取得', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    const cv = 'cv_1' as never
    expect(runs.reserve(cv)).toBe(true)
    expect(runs.reserve(cv)).toBe(false)
    expect(runs.isBusy(cv)).toBe(true)
  })

  test('未能启动运行时 release 必须释放会话，否则会话被永久锁定', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    const cv = 'cv_2' as never
    expect(runs.reserve(cv)).toBe(true)
    runs.release(cv)
    expect(runs.isBusy(cv)).toBe(false)
    expect(runs.reserve(cv)).toBe(true)
  })

  test('不同会话互不影响', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    expect(runs.reserve('cv_a' as never)).toBe(true)
    expect(runs.reserve('cv_b' as never)).toBe(true)
  })
})

/**
 * 左栏会话行的运行指示。
 *
 * 原始失败形状：只有**已打开**的会话能显示忙态：客户端只订阅当前会话，其他会话
 * 运行时它收不到任何事件。因此这几条用例测试忙闲广播不带会话归属：带上归属即
 * 按订阅过滤，只有已打开该会话的客户端能收到。
 */
describe('忙闲状态广播给所有客户端', () => {
  const frames = (bus: EventBus) => {
    const got: EventEnvelope<AgentEvent>[] = []
    bus.subscribe({
      id: 'sk',
      origin: 'desktop',
      // 明确声明不接收任何会话事件，与前端切换项目时发送的 subscribe([]) 形状相同。
      conversations: new Set<ConversationId>(),
      send: (f) => got.push(f as EventEnvelope<AgentEvent>),
    })
    return got
  }

  test('从占位到注销，首尾各广播一次，已退订该会话的客户端同样能收到', () => {
    const bus = new EventBus()
    const got = frames(bus)
    const runs = new RunManager(null as never, bus, new SubagentRegistry())
    const cv = 'cv_1' as ConversationId

    runs.reserve(cv)
    runs.register({
      runId: 'rn_1' as never,
      conversationId: cv,
      controller: null as never,
      startedAt: 0,
    })
    runs.unregister('rn_1' as never)

    const busy = got.filter((f) => f.event.type === 'conversation.busy')
    expect(busy.map((f) => (f.event as { busy: boolean }).busy)).toEqual([true, true, false])
    // 归属位于事件体中，信封上不能带归属：信封带归属时会被订阅过滤拦截。
    expect(busy.every((f) => f.conversationId === undefined)).toBe(true)
    expect(busy.every((f) => (f.event as { conversationId: string }).conversationId === cv)).toBe(
      true,
    )
  })

  test('register 之后再 release 报告的仍是「运行中」：实时计算，不采用调用方传入的值', () => {
    const bus = new EventBus()
    const got = frames(bus)
    const runs = new RunManager(null as never, bus, new SubagentRegistry())
    const cv = 'cv_2' as ConversationId

    runs.reserve(cv)
    runs.register({
      runId: 'rn_2' as never,
      conversationId: cv,
      controller: null as never,
      startedAt: 0,
    })
    runs.release(cv)

    const busy = got.filter((f) => f.event.type === 'conversation.busy')
    expect((busy[busy.length - 1]?.event as { busy: boolean }).busy).toBe(true)
    expect(runs.busyConversations()).toEqual([cv])
  })
})

/**
 * 停止按钮按会话寻址：客户端没有 runId，也不应判定哪一轮尚未结束。
 */
describe('按会话中断', () => {
  function running(runs: RunManager, cv: ConversationId, runId: string): AbortController {
    const controller = new AbortController()
    runs.reserve(cv)
    runs.register({ runId: runId as never, conversationId: cv, controller, startedAt: 0 })
    return controller
  }

  test('中断作用于该会话的当前轮次，其他会话不受影响', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    const mine = running(runs, 'cv_1' as ConversationId, 'rn_1')
    const other = running(runs, 'cv_2' as ConversationId, 'rn_2')

    expect(runs.interruptConversation('cv_1' as ConversationId)).toBe(true)
    expect(mine.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect((mine.signal.reason as { source: string }).source).toBe('user')
  })

  test('没有运行中的 run 时返回 false：指令入口须据此拒绝，不能静默', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    expect(runs.interruptConversation('cv_idle' as ConversationId)).toBe(false)

    const cv = 'cv_3' as ConversationId
    running(runs, cv, 'rn_3')
    runs.unregister('rn_3' as never)
    expect(runs.interruptConversation(cv)).toBe(false)
  })

  test('只有占位、尚未启动 run 的会话无法中断：占位没有可中断的执行', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    const cv = 'cv_4' as ConversationId
    runs.reserve(cv)
    expect(runs.isBusy(cv)).toBe(true)
    expect(runs.interruptConversation(cv)).toBe(false)
  })
})

/**
 * 忙态与启动轮次的检查拆分为两项查询。
 *
 * 原始失败形状：子 agent 的生命期跟随会话，它运行时会话处于忙碌状态（界面需要显示、
 * 停止按钮需要存在），但它不是一轮 run：此时回执与用户的消息必须能启动新一轮，
 * 使用同一判据时，它们会排入一个无人消费的队列。
 */
describe('忙态包含子 agent，启动轮次的检查不包含', () => {
  const cv = 'cv_sub' as ConversationId

  function withSubagent(): { runs: RunManager; table: SubagentRegistry } {
    const table = new SubagentRegistry()
    const runs = new RunManager(null as never, new EventBus(), table)
    table.add(cv, 'cv_child', {
      name: '临时',
      kind: 'temp',
      controller: new AbortController(),
    })
    return { runs, table }
  }

  test('只有子 agent 运行中：isBusy 为真、hasRun 为假、reserve 放行', () => {
    const { runs } = withSubagent()
    expect(runs.isBusy(cv)).toBe(true)
    expect(runs.hasRun(cv)).toBe(false)
    expect(runs.reserve(cv)).toBe(true)
  })

  test('握手快照同样报告只有子 agent 运行中的会话', () => {
    const { runs } = withSubagent()
    expect(runs.busyConversations()).toEqual([cv])
  })

  test('子 agent 结束后忙态随之解除', () => {
    const { runs, table } = withSubagent()
    table.remove(cv, 'cv_child')
    expect(runs.isBusy(cv)).toBe(false)
    expect(runs.busyConversations()).toEqual([])
  })
})
