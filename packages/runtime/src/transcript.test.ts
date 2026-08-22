/**
 * steps → 历史消息的投影。
 *
 * 覆盖范围：`transcript.ts` 全部（`stepsToUnits` + `stepsToWireMessages` +
 * `buildHistory`），以及 `store/repos.ts` 的 `settleRunningSteps`。
 *
 * ## 这一组要证伪的是什么
 *
 * 原始失败形状是实测出来的：运行库里
 * `SELECT role, COUNT(*) FROM messages GROUP BY role` 只回一行 `user`，
 * 而同一会话的 steps 有 20 条 text + 42 条 tool_action。模型第二轮起看到的
 * 输入字面上是「用户说了三次话，我一次都没回过」。
 *
 * 所以断言不能是「投影函数返回了几条消息」——那种断言在顺序错、配对错、
 * 重复注入这三种失败形状下**全都放行**。下面四组是叠加的，缺一放行一类 bug：
 * 结构（形状与精确条数）· 配对（provider 会不会收）· 复现（原始失败形状本身）·
 * 中断残留（波次 1 的成果不许被吞）。
 */

import { describe, expect, test } from 'bun:test'
import { stepStamp } from '@qywork/agent'
import type { WireMessage } from '@qywork/ai'
import type { MessageId, Step } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  finishRun,
  listSteps,
  markRunSuperseded,
  markStepExecuting,
  Store,
  settleRunningSteps,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { buildHistory, stepsToUnits, stepsToWireMessages } from './transcript.ts'

const noAttachments = async (content: string) => content

function step(over: Partial<Step>): Step {
  return {
    id: 'st' as never,
    runId: 'rn' as never,
    seq: 1,
    kind: 'tool_action',
    toolName: 'read_file',
    toolCallId: 'c1',
    providerBatchId: 'b1',
    callIndex: 0,
    executionWaveIndex: 0,
    executionStartedAt: null,
    content: null,
    payload: { kind: 'tool_result', args: { path: 'a.ts' }, outcome: { status: 'success' } },
    status: 'success',
    createdAt: 0,
    ...over,
  } as Step
}

/**
 * provider 侧的配对规则，写成断言。
 *
 * Anthropic 与多数兼容端点都要求：每条 assistant 的 tool_call 必须紧跟配对的
 * tool 结果，缺一条或多一条都是 400。把它做成校验器而不是「相信不会错」，
 * 是因为顺序/配对出问题时**子串断言完全看不出来**——请求体里确实「含」那段字。
 */
function assertPairs(messages: WireMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (!m.toolCalls?.length) continue
    const ids = m.toolCalls.map((c) => c.id)
    const following = messages.slice(i + 1, i + 1 + ids.length)
    expect(following.map((f) => f.role)).toEqual(ids.map(() => 'tool'))
    expect(following.map((f) => f.toolCallId)).toEqual(ids)
  }
  // 反过来也要成立：没有孤儿 tool 消息。
  const declared = new Set(messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []))
  for (const m of messages) {
    if (m.role === 'tool') expect(declared.has(m.toolCallId ?? '')).toBe(true)
  }
}

/**
 * 单元戳。
 *
 * 压缩按戳切界，所以这里钉两件事：**一个执行波次的全部消息共用一个戳**
 * （共戳即同进同出，tool_call 与 tool_result 永远不会被切开），
 * **戳取单元里最后一个 step 的 seq**（活的 transcript 那侧盖的是波次跑完时的
 * 高水位，两处必须是同一个数）。
 */
describe('可折单元的戳', () => {
  test('一个波次的 assistant 与它的 tool 结果共用一个戳', () => {
    const units = stepsToUnits([
      step({ seq: 1, kind: 'text', content: '先读两个文件。', toolName: null, toolCallId: null }),
      step({ seq: 2, toolCallId: 'A', callIndex: 0 }),
      step({ seq: 3, toolCallId: 'B', callIndex: 1 }),
    ])
    expect(units).toHaveLength(1)
    expect(units[0]!.stamp).toBe(stepStamp('rn', 3))
    expect(units[0]!.messages.map((m) => m._step)).toEqual([
      stepStamp('rn', 3),
      stepStamp('rn', 3),
      stepStamp('rn', 3),
    ])
  })

  test('不同波次各自一个戳，且按 seq 递增', () => {
    const units = stepsToUnits([
      step({ seq: 1, providerBatchId: 'b1', toolCallId: 'A' }),
      step({ seq: 2, providerBatchId: 'b2', toolCallId: 'B' }),
    ])
    expect(units.map((u) => u.stamp)).toEqual([stepStamp('rn', 1), stepStamp('rn', 2)])
    expect(units[0]!.stamp < units[1]!.stamp).toBe(true)
  })

  test('尾部的纯文本自成一个单元，戳取它自己的 seq', () => {
    const units = stepsToUnits([
      step({ seq: 1, toolCallId: 'A', callIndex: 0 }),
      step({ seq: 2, kind: 'text', content: '说完了。', toolName: null, toolCallId: null }),
    ])
    expect(units).toHaveLength(2)
    expect(units[1]!.stamp).toBe(stepStamp('rn', 2))
  })

  test('归属消息 id 与戳一起盖上，跨 run 投影回历史后定位不变', () => {
    const units = stepsToUnits([step({ seq: 5, toolCallId: 'A', callIndex: 0 })], {
      messageId: 'ms_001' as MessageId,
    })
    for (const m of units[0]!.messages) {
      expect(m._messageId).toBe('ms_001')
      expect(m._step).toBe(stepStamp('rn', 5))
    }
  })
})

describe('steps 投影', () => {
  test('结构与精确条数：user 之后是 assistant(toolCalls) + 每个调用一条 tool', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, kind: 'text', content: '我先读两个文件。', toolName: null, toolCallId: null }),
      step({ seq: 2, toolCallId: 'A', callIndex: 0, content: '思考正文' }),
      step({ seq: 3, toolCallId: 'B', callIndex: 1 }),
    ])

    // 精确条数是抓「重复注入」的唯一手段——多折一遍照样能通过子串断言。
    expect(out).toHaveLength(3)
    expect(out[0]!.role).toBe('assistant')
    expect(out[0]!.toolCalls?.map((c) => c.id)).toEqual(['A', 'B'])
    expect(out[0]!.content).toBe('我先读两个文件。')
    expect(out[1]!.role).toBe('tool')
    expect(out[2]!.role).toBe('tool')
    assertPairs(out)
  })

  /**
   * DeepSeek 类兼容端点要求带 tool_calls 的 assistant 消息原样回传
   * `reasoning_content`，**否则后续轮次 400**（`ai/types.ts` 与
   * `openai-compat.ts` 都记着这条，标注「这不是可选优化」）。
   */
  test('思考正文从批次首条读回，挂在 assistant 上', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, toolCallId: 'A', callIndex: 0, content: '让我先看看这个文件。' }),
      step({ seq: 2, toolCallId: 'B', callIndex: 1 }),
    ])
    expect(out[0]!.reasoningContent).toBe('让我先看看这个文件。')
  })

  test('callIndex 决定顺序，不是落库顺序', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, toolCallId: 'B', callIndex: 1 }),
      step({ seq: 2, toolCallId: 'A', callIndex: 0 }),
    ])
    expect(out[0]!.toolCalls?.map((c) => c.id)).toEqual(['A', 'B'])
    assertPairs(out)
  })

  test('不同 batch 不合并成一个 assistant 轮', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, providerBatchId: 'b1', toolCallId: 'A' }),
      step({ seq: 2, providerBatchId: 'b2', toolCallId: 'B' }),
    ])
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(2)
    assertPairs(out)
  })

  /** 恢复路径整体替换 payload，`args` 被抹掉——投影不能因此崩，也不能编参数。 */
  test('孤儿 payload（args 被抹）投影成空参数 + failure，不编造', () => {
    const out = stepsToWireMessages([
      step({
        seq: 1,
        status: 'failure',
        payload: {
          kind: 'tool_result',
          outcome: { status: 'failure', executed: true, message: '结果未知' },
        },
      }),
    ])
    expect(out[0]!.toolCalls?.[0]?.arguments).toEqual({})
    expect(JSON.parse(String(out[1]!.content)).status).toBe('failure')
  })
})

describe('历史装配', () => {
  function fixture() {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const ask = (text: string) =>
      appendMessage(store, { conversationId: conv.id, role: 'user', content: text }).id
    const run = (userMessageId: MessageId) =>
      createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: `c${Math.random()}`,
        userMessageId,
        messageIdUpperBound: userMessageId,
      })
    return { store, conv, ws, ask, run }
  }

  /**
   * **原始失败形状的直接复现。**
   *
   * 第一轮跑完之后，第二轮装配出的历史里必须有 assistant 内容。
   * 实测库里 messages 表只有 user 行，这条断言在修复前必红。
   */
  test('第二轮的历史里有第一轮的 assistant 与工具结果', async () => {
    const { store, conv, ask, run } = fixture()
    const m1 = ask('帮我做一个我的世界游戏')
    const r1 = run(m1)
    appendStep(store, { runId: r1.id, seq: 1, kind: 'text', content: '已完成骨架。' })
    const tool = appendStep(store, {
      runId: r1.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'write_file',
      toolCallId: 'A',
      providerBatchId: 'b1',
      callIndex: 0,
      status: 'running',
      payload: { kind: 'tool_call', args: { path: 'main.js' } },
    })
    settleToolStep(store, tool.id, 'success', {
      kind: 'tool_result',
      args: { path: 'main.js' },
      outcome: { status: 'success', executed: true, message: '写入 main.js' },
    })
    finishRun(store, r1.id, { status: 'done', stopReason: 'completed' })

    const m2 = ask('继续')
    const history = await buildHistory(store, conv.id, m2, noAttachments)

    expect(history.some((m) => m.role === 'assistant')).toBe(true)
    expect(history.some((m) => m.role === 'tool')).toBe(true)
    expect(JSON.stringify(history)).toContain('写入 main.js')
    assertPairs(history)
    // 两条 user + 一条 assistant(text 与 toolCalls 合流) + 一条 tool。
    expect(history.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(history).toHaveLength(4)
  })

  /**
   * 前端对 superseded 是「打标仍渲染」给人看；模型侧只有折或不折。
   * 照抄前端会让模型看到「失败尝试 + 重试」两遍同一件事。
   */
  test('被接替的 run 不折进历史', async () => {
    const { store, conv, ask, run } = fixture()
    const m1 = ask('跑一下')
    const failed = run(m1)
    appendStep(store, { runId: failed.id, seq: 1, kind: 'text', content: '第一次尝试的结论' })
    // `markRunSuperseded` 只对已终结的 run 生效（还在跑的应当先中断再重试，
    // 否则两个 run 会同时往同一个工作区写文件）。生产路径也是这个顺序。
    finishRun(store, failed.id, { status: 'failed', stopReason: 'provider_error' })
    const retry = run(m1)
    expect(markRunSuperseded(store, failed.id, retry.id)).toBe(true)
    appendStep(store, { runId: retry.id, seq: 1, kind: 'text', content: '重试之后的结论' })

    const history = await buildHistory(store, conv.id, m1, noAttachments)
    const text = JSON.stringify(history)
    expect(text).toContain('重试之后的结论')
    expect(text).not.toContain('第一次尝试的结论')
  })

  /**
   * **中断残留。** 波次 1 已成功、波次 2 被掐断留下 running 行。
   *
   * 整批跳过是崩溃窗口的窄守卫，但一个 batchId 覆盖整个模型回合——
   * 如果 `settleRunningSteps` 不工作，跳过会连带吞掉波次 1 已经写盘的结果，
   * 而那正是「工具白跑、文件重读」这个要治的病在中断场景的复发。
   */
  test('中断后：孤儿落终态、配对完整、已成功的结果仍在', async () => {
    const { store, conv, ask, run } = fixture()
    const m1 = ask('批量改文件')
    const r1 = run(m1)
    const done = appendStep(store, {
      runId: r1.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_file',
      toolCallId: 'A',
      providerBatchId: 'b1',
      callIndex: 0,
      status: 'running',
      payload: { kind: 'tool_call', args: { path: 'a.ts' } },
    })
    settleToolStep(store, done.id, 'success', {
      kind: 'tool_result',
      args: { path: 'a.ts' },
      outcome: { status: 'success', executed: true, message: '写入 a.ts' },
    })
    // 波次 2：进了执行器就被掐断。
    const orphan = appendStep(store, {
      runId: r1.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'write_file',
      toolCallId: 'B',
      providerBatchId: 'b1',
      callIndex: 1,
      status: 'running',
      payload: { kind: 'tool_call', args: { path: 'b.ts' } },
    })
    markStepExecuting(store, orphan.id)

    settleRunningSteps(store, r1.id)
    finishRun(store, r1.id, { status: 'interrupted', stopReason: 'user_interrupt' })

    const m2 = ask('接着来')
    const history = await buildHistory(store, conv.id, m2, noAttachments)

    assertPairs(history)
    // 已经写盘的那条不许消失。
    expect(JSON.stringify(history)).toContain('写入 a.ts')
    // 被掐断的那条如实说「可能已执行、结果未知」，不说「没执行」。
    const unknown = history.find((m) => m.role === 'tool' && m.toolCallId === 'B')
    expect(JSON.parse(String(unknown?.content)).executed).toBe(true)
  })

  /** 未进执行器就被中断的，如实标「没执行」——不能和「结果未知」混成一种。 */
  test('未进执行器的中断标 executed=false', async () => {
    const { store, ask, run } = fixture()
    const m1 = ask('跑')
    const r1 = run(m1)
    appendStep(store, {
      runId: r1.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      toolCallId: 'A',
      providerBatchId: 'b1',
      callIndex: 0,
      status: 'running',
      payload: { kind: 'tool_call', args: { command: 'ls' } },
    })
    settleRunningSteps(store, r1.id)

    const out = stepsToWireMessages(listSteps(store, r1.id))
    expect(JSON.parse(String(out[1]!.content)).executed).toBe(false)
  })
})

describe('思考的投影', () => {
  /**
   * 复现的是原始失败形状：迁移 26 之前思考寄生在批次首条工具行的 `content` 上，
   * 于是纯文本轮的思考无处可放、直接丢弃。
   *
   * 模型侧与界面侧口径**刻意不同**，这里锁的是模型侧：
   * 纯文本轮不带 `reasoningContent`——活的 transcript 只在有工具调用时才挂它
   * （`agent/loop.ts`），投影多带一份就与活的不同形，缓存前缀从那里断掉。
   */
  test('有工具调用时带上思考，纯文本轮不带', () => {
    const withTools = stepsToWireMessages([
      step({ id: 'st1' as never, seq: 1, kind: 'thinking', content: '先看文件' }),
      step({ id: 'st2' as never, seq: 2, kind: 'text', content: '我读一下' }),
      step({ id: 'st3' as never, seq: 3 }),
    ])
    expect(withTools[0]?.reasoningContent).toBe('先看文件')
    expect(withTools[0]?.content).toBe('我读一下')

    const textOnly = stepsToWireMessages([
      step({ id: 'st1' as never, seq: 1, kind: 'thinking', content: '想了想' }),
      step({ id: 'st2' as never, seq: 2, kind: 'text', content: '结论是这样' }),
    ])
    expect(textOnly).toHaveLength(1)
    expect(textOnly[0]?.content).toBe('结论是这样')
    expect(textOnly[0]?.reasoningContent).toBeUndefined()
  })

  /**
   * 轮内自动重发留下的死思考不进模型视图。
   *
   * 复现的是原始失败形状：断流重发**不换 run**，死掉那次与重发那次的思考落在
   * 同一个 run 的 step 表里且相邻。不排除的话两段无关生成会被拼成一条
   * `reasoningContent` 回传，与活侧不同形。
   */
  test('失败的思考 step 不进 reasoningContent', () => {
    const out = stepsToWireMessages([
      step({
        id: 'st1' as never,
        seq: 1,
        kind: 'thinking',
        content: '死掉那段',
        status: 'failure',
      }),
      step({ id: 'st2' as never, seq: 2, kind: 'thinking', content: '重发那段', status: 'done' }),
      step({ id: 'st3' as never, seq: 3 }),
    ])
    expect(out[0]?.reasoningContent).toBe('重发那段')
  })

  /**
   * 迁移 26 之前的行没有独立的 thinking step，思考在首条工具行的 `content` 里。
   * 这条回落删掉的后果不是显示问题：DeepSeek 类兼容端点对带 tool_calls 却没有
   * `reasoning_content` 的历史消息在第二轮直接 400。
   */
  test('存量行的思考仍从首条工具行读得回来', () => {
    const legacy = stepsToWireMessages([step({ id: 'st1' as never, seq: 1, content: '旧的思考' })])
    expect(legacy[0]?.reasoningContent).toBe('旧的思考')
  })
})
