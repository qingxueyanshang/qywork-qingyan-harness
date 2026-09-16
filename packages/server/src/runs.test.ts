/**
 * `runs.ts` 的并发边界。
 *
 * 覆盖范围：`RunManager` 的会话占位（reserve / release）、忙态的两问
 * （hasRun / isBusy）、忙闲广播（conversation.busy）与按会话中断
 * （interruptConversation）。指令入口那一层的回绝由 `goal-loop.test.ts` 覆盖，
 * 在跑表本身（`subagents.ts`）由 `delegate.test.ts` 覆盖，这里不重复。
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
   * 原始失败形状：`isBusy()` 检查与 `runs.register()` 之间隔着建 Session、
   * 读附件、等首个带 runId 的事件——好几个 await。桌面端与手机端几乎同时发消息时，
   * 两次检查都读到 false，因此两个 AgentLoop 对着同一个工作区一起写文件。
   *
   * 这里测的就是「检查与占位是不是同一个同步动作」，不测调用次数。
   */
  test('并发 reserve 只有第一个拿得到', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    const cv = 'cv_1' as never
    expect(runs.reserve(cv)).toBe(true)
    expect(runs.reserve(cv)).toBe(false)
    expect(runs.isBusy(cv)).toBe(true)
  })

  test('没跑起来时 release 要把会话放开 —— 否则它被永久锁死', () => {
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
 * 左栏那一行的转圈。
 *
 * 原始失败形状：只有**点开**的那条会话亮得起来——客户端只订阅当前会话，别的会话
 * 在跑，它一条事件都收不到。所以这几条测的是「忙闲广播不带会话归属」：带上就成了
 * 按订阅过滤，收得到的只剩已经知道自己在跑的那个客户端。
 */
describe('忙闲要播给所有人', () => {
  const frames = (bus: EventBus) => {
    const got: EventEnvelope<AgentEvent>[] = []
    bus.subscribe({
      id: 'sk',
      origin: 'desktop',
      // 明确「一条会话事件都不要」，与前端切项目时发的 subscribe([]) 同形状。
      conversations: new Set<ConversationId>(),
      send: (f) => got.push(f as EventEnvelope<AgentEvent>),
    })
    return got
  }

  test('占位到注销，两头各播一次，退订了会话的客户端照样收得到', () => {
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
    // 归属在事件体里，信封上不能有——信封上有就被订阅过滤挡掉了。
    expect(busy.every((f) => f.conversationId === undefined)).toBe(true)
    expect(busy.every((f) => (f.event as { conversationId: string }).conversationId === cv)).toBe(
      true,
    )
  })

  test('register 之后再 release 报的仍是「在跑」—— 现算，不认调用方给的值', () => {
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
 * 停止按钮按会话寻址：客户端手里没有 runId，也不该去判定哪一个仍未收尾。
 */
describe('按会话中断', () => {
  function running(runs: RunManager, cv: ConversationId, runId: string): AbortController {
    const controller = new AbortController()
    runs.reserve(cv)
    runs.register({ runId: runId as never, conversationId: cv, controller, startedAt: 0 })
    return controller
  }

  test('中断到的是这条会话的那一轮，别的会话不受影响', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    const mine = running(runs, 'cv_1' as ConversationId, 'rn_1')
    const other = running(runs, 'cv_2' as ConversationId, 'rn_2')

    expect(runs.interruptConversation('cv_1' as ConversationId)).toBe(true)
    expect(mine.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect((mine.signal.reason as { source: string }).source).toBe('user')
  })

  test('没有 run 在跑时返回 false —— 指令入口要据此回绝，不能静默', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    expect(runs.interruptConversation('cv_idle' as ConversationId)).toBe(false)

    const cv = 'cv_3' as ConversationId
    running(runs, cv, 'rn_3')
    runs.unregister('rn_3' as never)
    expect(runs.interruptConversation(cv)).toBe(false)
  })

  test('只占了位还没起 run 的会话中断不到 —— 占位没有可中断的执行', () => {
    const runs = new RunManager(null as never, new EventBus(), new SubagentRegistry())
    const cv = 'cv_4' as ConversationId
    runs.reserve(cv)
    expect(runs.isBusy(cv)).toBe(true)
    expect(runs.interruptConversation(cv)).toBe(false)
  })
})

/**
 * 忙态与起轮的闸拆成两问。
 *
 * 原始失败形状：子 agent 的生命期跟着会话，它在跑时会话是「忙」的（界面要显示、
 * 停止按钮要在），但那不是一轮 run——回执与用户的消息此时必须能起新一轮，
 * 用同一个判据的话它们会排进一个没有人会去消费的队列。
 */
describe('忙态含子 agent，起轮的闸不含', () => {
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

  test('只有子 agent 在跑：isBusy 真、hasRun 假、reserve 放行', () => {
    const { runs } = withSubagent()
    expect(runs.isBusy(cv)).toBe(true)
    expect(runs.hasRun(cv)).toBe(false)
    expect(runs.reserve(cv)).toBe(true)
  })

  test('握手快照把只有子 agent 在跑的会话也报出来', () => {
    const { runs } = withSubagent()
    expect(runs.busyConversations()).toEqual([cv])
  })

  test('子 agent 结束后忙态跟着落', () => {
    const { runs, table } = withSubagent()
    table.remove(cv, 'cv_child')
    expect(runs.isBusy(cv)).toBe(false)
    expect(runs.busyConversations()).toEqual([])
  })
})
