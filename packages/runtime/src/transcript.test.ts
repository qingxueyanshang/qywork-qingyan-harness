/**
 * steps → 历史消息的投影。
 *
 * 覆盖范围：`transcript.ts` 全部（`stepsToUnits` + `stepsToWireMessages` +
 * `buildHistory`），以及 `store/repos.ts` 的 `settleRunningSteps`。
 *
 * 本组测试用于证伪以下问题。原始失败形状来自实测：运行库中
 * `SELECT role, COUNT(*) FROM messages GROUP BY role` 只返回一行 `user`，
 * 而同一会话的 steps 有 20 条 text 与 42 条 tool_action。从第二轮起，模型取得的
 * 输入中只有用户消息，没有任何助手回复。
 *
 * 因此断言不能是「投影函数返回了几条消息」：这种断言在顺序错误、配对错误、
 * 重复注入三种失败形状下全部通过。下面四组相互叠加，缺少任一组都会漏过一类缺陷：
 * 结构（形状与精确条数）· 配对（provider 是否接受）· 复现（原始失败形状本身）·
 * 中断残留（波次 1 的结果不得丢失）。
 */

import { describe, expect, test } from 'bun:test'
import { stepStamp } from '@qywork/agent'
import type { WireMessage } from '@qywork/ai'
import type { MessageId, RunContextSegment, Step } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  finishRun,
  listSteps,
  markStepExecuting,
  Store,
  settleRunningSteps,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { buildHistory, stepsToUnits, stepsToWireMessages } from './transcript.ts'

const noAttachments = async (content: string) => content

test('连续文本续写按密文快照保留每次生成的边界', () => {
  const reasoning = (id: string) => ({
    tokens: 0,
    items: [
      {
        type: 'reasoning',
        id,
        encrypted_content: `cipher-${id}`,
        summary: [],
      },
    ],
  })
  const messages = stepsToWireMessages([
    step({ seq: 1, kind: 'text', content: '前半段' }),
    step({
      seq: 2,
      kind: 'thinking',
      content: '',
      payload: { kind: 'response_reasoning', reasoning: reasoning('rs1') },
    }),
    step({ seq: 3, kind: 'text', content: '后半段' }),
    step({
      seq: 4,
      kind: 'thinking',
      content: '',
      payload: { kind: 'response_reasoning', reasoning: reasoning('rs2') },
    }),
  ])
  expect(
    messages.map((m) => ({ content: m.content, reasoning: m.responseReasoning, stamp: m._step })),
  ).toEqual([
    { content: '前半段', reasoning: reasoning('rs1'), stamp: stepStamp('rn', 2) },
    { content: '后半段', reasoning: reasoning('rs2'), stamp: stepStamp('rn', 4) },
  ])
})

test('思考密文从数据库步骤恢复，工具轮及纯文本轮原样保留，失败尝试排除', () => {
  const store = new Store({ path: ':memory:' })
  try {
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'grok-4.7' })
    const msg = appendMessage(store, { conversationId: conv.id, role: 'user', content: '读取' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'grok-4.7',
      clientRequestId: 'cipher-test',
      userMessageId: msg.id,
      messageIdUpperBound: msg.id,
      contextSnapshot: [],
    })
    const reasoning = {
      tokens: 0,
      items: [{ type: 'reasoning', id: 'rs1', encrypted_content: 'opaque', summary: [] }],
    }
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'thinking',
      content: '',
      payload: { kind: 'response_reasoning', reasoning },
    })
    const persisted = listSteps(store, run.id)
    expect(stepsToWireMessages(persisted)[0]?.responseReasoning).toEqual(reasoning)
    expect(stepsToWireMessages([{ ...persisted[0]!, status: 'failure' }])).toEqual([])
    const messages = stepsToWireMessages([...persisted, step({ runId: run.id, seq: 2 })])
    expect(messages[0]?.responseReasoning).toEqual(reasoning)
    expect(messages[0]?.reasoningContent).toBeUndefined()
    assertPairs(messages)
  } finally {
    store.close()
  }
})

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
 * provider 侧的配对规则，以断言表示。
 *
 * Anthropic 与多数兼容端点都要求：每条 assistant 的 tool_call 必须紧跟配对的
 * tool 结果，缺少或多出一条都返回 400。将其实现为校验器而不是假定不会出错，
 * 是因为顺序或配对出错时子串断言无法发现：请求体中确实包含该段文字。
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
  // 反向同样成立：不存在孤儿 tool 消息。
  const declared = new Set(messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []))
  for (const m of messages) {
    if (m.role === 'tool') expect(declared.has(m.toolCallId ?? '')).toBe(true)
  }
}

/**
 * 单元戳。
 *
 * 压缩按戳划分边界，因此此处锁定两项约束：一个执行波次的全部消息共用一个戳
 * （共用一个戳即一同保留或一同压缩，tool_call 与 tool_result 不会被分开），
 * 戳取单元中最后一个 step 的 seq（实时 transcript 一侧标记的是波次执行完毕时的
 * 高水位，两处必须是同一个数）。
 */
describe('可折叠单元的戳', () => {
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

  test('不同波次各有一个戳，且按 seq 递增', () => {
    const units = stepsToUnits([
      step({ seq: 1, providerBatchId: 'b1', toolCallId: 'A' }),
      step({ seq: 2, providerBatchId: 'b2', toolCallId: 'B' }),
    ])
    expect(units.map((u) => u.stamp)).toEqual([stepStamp('rn', 1), stepStamp('rn', 2)])
    expect(units[0]!.stamp < units[1]!.stamp).toBe(true)
  })

  test('尾部的纯文本单独构成一个单元，戳取其自身的 seq', () => {
    const units = stepsToUnits([
      step({ seq: 1, toolCallId: 'A', callIndex: 0 }),
      step({ seq: 2, kind: 'text', content: '说完了。', toolName: null, toolCallId: null }),
    ])
    expect(units).toHaveLength(2)
    expect(units[1]!.stamp).toBe(stepStamp('rn', 2))
  })

  test('归属消息 id 与戳一同标记，跨 run 投影回历史后定位不变', () => {
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
  test('纯文本思考只对明确要求完整回放的模型进入历史', () => {
    const steps = [
      step({ seq: 1, kind: 'thinking', content: '先分析', toolName: null, toolCallId: null }),
      step({ seq: 2, kind: 'text', content: '结论', toolName: null, toolCallId: null }),
    ]

    expect(stepsToWireMessages(steps)[0]?.reasoningContent).toBeUndefined()
    expect(
      stepsToWireMessages(steps, { preserveAssistantReasoning: true })[0]?.reasoningContent,
    ).toBe('先分析')
  })

  test('完整回放模式不丢弃只有思考、没有正文的终止轮', () => {
    const out = stepsToWireMessages(
      [
        step({
          seq: 1,
          kind: 'thinking',
          content: '达到输出上限',
          toolName: null,
          toolCallId: null,
        }),
      ],
      { preserveAssistantReasoning: true },
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.content).toBe('')
    expect(out[0]?.reasoningContent).toBe('达到输出上限')
  })

  test('结构与精确条数：user 之后是 assistant(toolCalls) + 每个调用一条 tool', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, kind: 'text', content: '我先读两个文件。', toolName: null, toolCallId: null }),
      step({ seq: 2, toolCallId: 'A', callIndex: 0, content: '思考正文' }),
      step({ seq: 3, toolCallId: 'B', callIndex: 1 }),
    ])

    // 精确条数是检出重复注入的唯一手段：多折叠一次同样能通过子串断言。
    expect(out).toHaveLength(3)
    expect(out[0]!.role).toBe('assistant')
    expect(out[0]!.toolCalls?.map((c) => c.id)).toEqual(['A', 'B'])
    expect(out[0]!.content).toBe('我先读两个文件。')
    expect(out[1]!.role).toBe('tool')
    expect(out[2]!.role).toBe('tool')
    assertPairs(out)
  })

  /**
   * DeepSeek 等兼容端点要求带 tool_calls 的 assistant 消息原样回传
   * `reasoning_content`，否则后续轮次返回 400（`ai/types.ts` 与
   * `openai-compat.ts` 均记录了该要求）。
   */
  test('思考正文从独立 step 读取，附加在 assistant 消息上', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, kind: 'thinking', content: '让我先看看这个文件。' }),
      step({ seq: 2, toolCallId: 'A', callIndex: 0 }),
      step({ seq: 3, toolCallId: 'B', callIndex: 1 }),
    ])
    expect(out[0]!.reasoningContent).toBe('让我先看看这个文件。')
  })

  test('callIndex 决定顺序，而不是写入顺序', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, toolCallId: 'B', callIndex: 1 }),
      step({ seq: 2, toolCallId: 'A', callIndex: 0 }),
    ])
    expect(out[0]!.toolCalls?.map((c) => c.id)).toEqual(['A', 'B'])
    assertPairs(out)
  })

  test('不同 batch 不合并为一个 assistant 轮', () => {
    const out = stepsToWireMessages([
      step({ seq: 1, providerBatchId: 'b1', toolCallId: 'A' }),
      step({ seq: 2, providerBatchId: 'b2', toolCallId: 'B' }),
    ])
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(2)
    assertPairs(out)
  })

  /**
   * 归属未记录的旧文本不能视为另一次生成。将其拆分等于凭空构造一条
   * 没有工具调用的 assistant 消息，而该段正文在实时 transcript 中与其后的这批调用属于同一条消息。
   */
  test('文本归属为 null 时不与其后的工具调用分开', () => {
    const out = stepsToWireMessages([
      step({
        seq: 1,
        kind: 'text',
        content: '先读一个文件。',
        toolName: null,
        toolCallId: null,
        providerBatchId: null,
      }),
      step({ seq: 2, providerBatchId: 'bt_migrated', toolCallId: 'A' }),
    ])
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(out[0]!.content).toBe('先读一个文件。')
    expect(out[0]!.toolCalls?.map((c) => c.id)).toEqual(['A'])
    assertPairs(out)
  })

  test('相邻两段文本归属不同时各成一条 assistant 消息', () => {
    const out = stepsToWireMessages([
      step({
        seq: 1,
        kind: 'text',
        content: '上半句',
        toolName: null,
        toolCallId: null,
        providerBatchId: 'pr_1',
      }),
      step({
        seq: 2,
        kind: 'text',
        content: '下半句',
        toolName: null,
        toolCallId: null,
        providerBatchId: 'pr_2',
      }),
    ])
    expect(out.map((m) => m.content)).toEqual(['上半句', '下半句'])
  })

  /** 恢复路径整体替换 payload，`args` 被清除：投影不得因此崩溃，也不得编造参数。 */
  test('孤儿 payload（args 已清除）投影为空参数与 failure，不编造参数', () => {
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
    const run = (userMessageId: MessageId, contextSnapshot: RunContextSegment[] = []) =>
      createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: `c${Math.random()}`,
        userMessageId,
        messageIdUpperBound: userMessageId,
        contextSnapshot,
      })
    return { store, conv, ws, ask, run }
  }

  /**
   * 原始失败形状的直接复现。
   *
   * 第一轮执行完毕之后，第二轮装配的历史中必须有 assistant 内容。
   * 实测库中 messages 表只有 user 行，该断言在修复前必然失败。
   */
  test('第二轮的历史中包含第一轮的 assistant 与工具结果', async () => {
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
    // 两条 user、一条 assistant（text 与 toolCalls 合并）、一条 tool。
    expect(history.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(history).toHaveLength(4)
  })

  /** 媒体去留由装配按字节预算决定（`agent` 的 `evictedMedia`），历史轮次的附件与当前轮同样转换。 */
  test('历史与当前用户消息的附件经过同一转换', async () => {
    const { store, conv } = fixture()
    appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: '第一轮',
      attachments: [
        { type: 'image', name: 'old.png', mime: 'image/png', size: 1, path: 'old.png' },
      ],
    })
    const current = appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: '第二轮',
      attachments: [
        { type: 'video', name: 'now.mp4', mime: 'video/mp4', size: 1, path: 'now.mp4' },
      ],
    }).id
    const passed: string[][] = []
    await buildHistory(store, conv.id, current, async (content, files) => {
      passed.push((files as { name: string }[]).map((f) => f.name))
      return content
    })

    expect(passed).toEqual([['old.png'], ['now.mp4']])
  })

  test('run 的上下文只出现在所属真实用户消息之前，与上一轮相同的段不再回放，重复重建不漂移', async () => {
    const { store, conv, ask, run } = fixture()
    const m1 = ask('第一轮')
    run(m1, [
      { content: '工作区：C:/ws', group: 'workspaceState' },
      { content: '## 记忆索引\n- no-repeat', group: 'memory' },
    ])
    const m2 = ask('第二轮')
    run(m2, [
      { content: '工作区：C:/ws', group: 'workspaceState' },
      { content: '## 记忆索引\n- no-repeat', group: 'memory' },
    ])
    const m3 = ask('第三轮')
    run(m3, [
      { content: '工作区：C:/ws', group: 'workspaceState' },
      { content: '## 记忆索引\n- no-repeat\n- second', group: 'memory' },
    ])

    const first = await buildHistory(store, conv.id, m3, noAttachments)
    const second = await buildHistory(store, conv.id, m3, noAttachments)
    expect(second).toEqual(first)
    expect(first.map((message) => message.role)).toEqual([
      'context',
      'context',
      'user',
      'user',
      'context',
      'user',
    ])
    expect(first[2]!.content).toBe('第一轮')
    expect(first[3]!.content).toBe('第二轮')
    expect(first[4]!.content).toBe('## 记忆索引\n- no-repeat\n- second')
    expect(first[5]!.content).toBe('第三轮')
    store.close()
  })

  test('同一条用户消息多次 run 时按最后一次快照与上一轮比较', async () => {
    const { store, conv, ask, run } = fixture()
    const m1 = ask('第一轮')
    run(m1, [{ content: '工作区：C:/ws', group: 'workspaceState' }])
    const m2 = ask('第二轮')
    run(m2, [{ content: '工作区：C:/other', group: 'workspaceState' }])
    run(m2, [{ content: '工作区：C:/ws', group: 'workspaceState' }])

    const out = await buildHistory(store, conv.id, m2, noAttachments)
    expect(out.map((message) => message.role)).toEqual(['context', 'user', 'user'])
    store.close()
  })

  test('刷新恢复后，失败工具的原始正文和未执行标记仍进入模型历史', async () => {
    const { store, conv, ask, run } = fixture()
    const m1 = ask('下载依赖')
    const r1 = run(m1)
    const tool = appendStep(store, {
      runId: r1.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      toolCallId: 'A',
      providerBatchId: 'b1',
      callIndex: 0,
      status: 'running',
      payload: { kind: 'tool_call', args: { command: 'curl example', probe_url: 'null' } },
    })
    settleToolStep(store, tool.id, 'failure', {
      kind: 'tool_result',
      args: { command: 'curl example', probe_url: 'null' },
      outcome: {
        status: 'failure',
        executed: false,
        message: 'probe_url 不是合法 URL：null',
        errorKind: 'bad_request',
      },
    })
    finishRun(store, r1.id, { status: 'failed', stopReason: 'no_progress' })

    const m2 = ask('继续')
    const history = await buildHistory(store, conv.id, m2, noAttachments)
    const result = history.find((m) => m.role === 'tool')
    expect(result).toBeDefined()
    expect(JSON.parse(String(result!.content))).toMatchObject({
      tool: 'run_command',
      status: 'failure',
      executed: false,
      summary: 'probe_url 不是合法 URL：null',
    })
    assertPairs(history)
  })

  /**
   * 中断残留：波次 1 已成功，波次 2 被中止并留下 running 行。
   *
   * 整批跳过是针对崩溃窗口的窄守卫，但一个 batchId 覆盖整个模型回合：
   * 若 `settleRunningSteps` 失效，跳过会一并丢弃波次 1 已写入磁盘的结果，
   * 即「工具重复执行、文件重读」这一问题在中断场景下复现。
   */
  test('中断后：孤儿 step 写为终态、配对完整、已成功的结果保留', async () => {
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
    // 波次 2：进入执行器后即被中止。
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
    // 已写入磁盘的结果不得丢失。
    expect(JSON.stringify(history)).toContain('写入 a.ts')
    // 被中止的调用如实标为「可能已执行、结果未知」，不标为「未执行」。
    const unknown = history.find((m) => m.role === 'tool' && m.toolCallId === 'B')
    expect(JSON.parse(String(unknown?.content)).executed).toBe(true)
  })

  /** 未进入执行器即被中断的调用如实标为「未执行」，不得与「结果未知」合并为同一种。 */
  test('未进入执行器的中断标为 executed=false', async () => {
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
   * 复现原始失败形状：迁移 26 之前思考附带在批次首条工具行的 `content` 中，
   * 因此纯文本轮的思考没有存放位置，被直接丢弃。
   *
   * 模型侧与界面侧的口径有意不同，此处锁定的是模型侧：
   * 纯文本轮不带 `reasoningContent`：实时 transcript 只在有工具调用时附加该字段
   * （`agent/loop/turn-end.ts`），投影多带一份即与实时 transcript 结构不同，缓存前缀从该处失效。
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
   * 轮内自动重发留下的失败思考不进入模型视图。
   *
   * 复现原始失败形状：断流后重发不更换 run，失败请求与重发请求的思考写入
   * 同一个 run 的 step 表且相邻。不排除时两段无关的生成会被拼接为一条
   * `reasoningContent` 回传，与实时 transcript 结构不同。
   */
  test('失败的思考 step 不进入 reasoningContent', () => {
    const out = stepsToWireMessages([
      step({
        id: 'st1' as never,
        seq: 1,
        kind: 'thinking',
        content: '失败那段',
        status: 'failure',
      }),
      step({ id: 'st2' as never, seq: 2, kind: 'thinking', content: '重发那段', status: 'done' }),
      step({ id: 'st3' as never, seq: 3 }),
    ])
    expect(out[0]?.reasoningContent).toBe('重发那段')
  })

  test('工具行正文不作为思考的第二来源', () => {
    const out = stepsToWireMessages([step({ id: 'st1' as never, seq: 1, content: '错误旧形状' })])
    expect(out[0]?.reasoningContent).toBeUndefined()
  })
})
