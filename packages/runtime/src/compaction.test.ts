/**
 * 覆盖范围：`compaction.ts`（选界 / 收纳 / 摘要接入 / 三区投影 / 落库守卫）。
 * 压缩算法本身由 `agent/compaction.test.ts` 覆盖，与主循环的接入由
 * `agent/src/loop/compact.test.ts` 覆盖。
 */

import { describe, expect, test } from 'bun:test'
import type { CompactionRunInput, Summarizer } from '@qywork/agent'
import { softLimit } from '@qywork/agent'
import type { WireMessage } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateMessages } from '@qywork/ai'
import type { MessageId } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  getConversation,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { RuntimeCompaction } from './compaction.ts'
import { buildHistory } from './transcript.ts'

/** 加长助手回复，使单元之间存在体积差异，选界不会把全部单元划到同一侧。 */
const PAD = 'x'.repeat(1000)

/**
 * 按真实形状落库一轮对话：用户消息写入 `messages`，助手回复是该消息所属 run 中的 text step。
 * 返回用户消息 id。
 */
function turn(
  store: Store,
  workspaceId: string,
  conversationId: string,
  user: string,
  reply: string | null,
): MessageId {
  const message = appendMessage(store, {
    conversationId: conversationId as never,
    role: 'user',
    content: user,
  })
  if (reply !== null) {
    const run = createRun(store, {
      conversationId: conversationId as never,
      workspaceId: workspaceId as never,
      model: 'm',
      clientRequestId: `reply-${message.id}`,
      userMessageId: message.id,
      messageIdUpperBound: message.id,
      contextSnapshot: [],
    })
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'text',
      content: reply,
      providerBatchId: `bt_reply_${message.id}`,
    })
  }
  return message.id
}

/** `messageCount` 条对话：偶数位是用户消息，奇数位是上一条消息的助手回复。`ids` 只含用户消息。 */
function fresh(messageCount = 8) {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    title: 't',
  })
  const ids: MessageId[] = []
  for (let i = 0; i < messageCount; i += 2) {
    ids.push(
      turn(
        store,
        ws.id,
        conv.id,
        i === 0 ? '重构认证模块，不要动 legacy/' : `第 ${i} 条消息`,
        i + 1 < messageCount ? `第 ${i + 1} 条 ${PAD}` : null,
      ),
    )
  }
  return { store, ws, conv, ids }
}

const summary: Summarizer = async () => '模型写的摘要'

function port(store: Store, conversationId: string, summarize: Summarizer = summary) {
  return new RuntimeCompaction({
    store,
    conversationId: conversationId as never,
    messageIdUpperBound: null,
    summarize,
  })
}

/**
 * 构造刚越过阈值的占用：占用取会话装配后的真实估算，窗口取同一数值。
 *
 * 因此软阈值（窗口的 80%）必定低于占用，保留预算（窗口的 1/4）保留尾部：
 * 无需推测某个模型的具体数值，估算系数微调时也不会导致大量用例失败。
 */
async function pressure(store: Store, conversationId: string): Promise<CompactionRunInput> {
  const history = await buildHistory(store, conversationId as never, null, async (c) => c)
  const total = estimateMessages(history, DEFAULT_DENSITY)
  return {
    trigger: 'automatic',
    model: 'm',
    latestUnitSeen: false,
    occupancy: total,
    estimatedOccupancy: total,
    contextWindow: total,
    density: DEFAULT_DENSITY,
  }
}

async function history(store: Store, conversationId: string): Promise<WireMessage[]> {
  return buildHistory(store, conversationId as never, null, async (c) => c)
}

/** 为一条 run 添加 n 个工具批次，每个批次一条调用，结果正文按 payloadChars 填充。 */
function addToolWaves(
  store: Store,
  runId: string,
  waves: number,
  payloadChars: number,
  startSeq = 1,
): void {
  for (let w = 0; w < waves; w++) {
    const step = appendStep(store, {
      runId: runId as never,
      seq: startSeq + w,
      kind: 'tool_action',
      toolName: 'run_command',
      toolCallId: `call_${w}`,
      providerBatchId: `bt_${w}`,
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args: {},
      outcome: {
        status: 'success',
        executed: true,
        message: `第 ${w} 波跑完`,
        data: { stdout: 'y'.repeat(payloadChars) },
        resources: [
          {
            resourceId: `rs_${w}` as never,
            status: 'partial',
            contentHash: null,
            sizeBytes: payloadChars,
            mimeType: 'text/plain',
            coverage: { deliveredBytes: 100, totalBytes: payloadChars, truncated: true },
          },
        ],
      },
      action: { kind: 'run', objectLabel: '命令', target: `npm test --scope=pkg${w}` },
    })
  }
}

describe('压缩是投影，不销毁数据', () => {
  test('压缩后原始消息完整保留', async () => {
    const { store, conv } = fresh()
    const before = store.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
      )
      .get(conv.id)!.n

    const r = await port(store, conv.id).run(await pressure(store, conv.id))
    expect(r.status).toBe('compacted')

    const after = store.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
      )
      .get(conv.id)!.n
    expect(after).toBe(before)
    store.close()
  })

  test('manifest 保存在 conversations 上，可跨进程恢复', async () => {
    const { store, conv } = fresh()
    await port(store, conv.id).run(await pressure(store, conv.id))

    const reloaded = getConversation(store, conv.id)!.compactionManifest
    expect(reloaded).not.toBeNull()
    expect(reloaded!.revision).toBe(1)
    expect(reloaded!.condensedThrough).toBeDefined()
    expect(reloaded!.contextAfter?.model).toBe('m')
    expect(reloaded!.contextAfter?.measured).toBeLessThan(
      (await pressure(store, conv.id)).estimatedOccupancy,
    )
    store.close()
  })
})

describe('投影三区', () => {
  test('未压缩时原样返回', async () => {
    const { store, conv } = fresh()
    const h = await history(store, conv.id)
    expect(port(store, conv.id).project(h)).toHaveLength(h.length)
    store.close()
  })

  test('摘要线以内替换为摘要与事实清单两条消息，尾部保持原样', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    await p.run(await pressure(store, conv.id))

    const h = await history(store, conv.id)
    const projected = p.project(h)
    expect(projected.length).toBeLessThan(h.length)
    expect(projected[0]!.content).toContain('被压缩的早期对话摘要')
    expect(projected[1]!.content).toContain('事实清单')
    // 最后一条始终保留：压缩该条会使模型丢失当前的提问。
    expect(projected[projected.length - 1]!.content).toBe(h[h.length - 1]!.content as string)
    store.close()
  })

  test('最新运行上下文跨过摘要线时只保留一份，并紧邻摘要用户消息', async () => {
    const { store, ws, conv, ids } = fresh(8)
    createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'context-pin',
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [
        { content: '工作区：C:/ws', group: 'workspaceState' },
        { content: '## 记忆索引\n- no-repeat', group: 'memory' },
      ],
    })
    const p = port(store, conv.id)
    expect((await p.run(await pressure(store, conv.id))).status).toBe('compacted')

    const projected = p.project(await history(store, conv.id))
    expect(projected.slice(0, 3).map((message) => message.role)).toEqual([
      'context',
      'context',
      'user',
    ])
    expect(projected.filter((message) => message.role === 'context')).toHaveLength(2)
    expect(projected[0]!.content).toBe('工作区：C:/ws')
    expect(projected[2]!.content).toContain('被压缩的早期对话摘要')
    store.close()
  })

  test('与上一轮相同的段只回放一次；被摘要线折叠后从最新快照补回，段既不丢失也不重复', async () => {
    const { store, ws, conv, ids } = fresh(8)
    const segments = [
      { content: '工作区：C:/ws', group: 'workspaceState' as const },
      { content: '## 记忆索引\n- no-repeat', group: 'memory' as const },
    ]
    for (const [i, userMessageId] of [ids[0]!, ids[1]!, ids[2]!].entries()) {
      createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: `dedupe-${i}`,
        userMessageId,
        messageIdUpperBound: userMessageId,
        contextSnapshot: segments,
      })
    }
    const raw = await history(store, conv.id)
    expect(raw.filter((message) => message.role === 'context').map((m) => m.content)).toEqual([
      '工作区：C:/ws',
      '## 记忆索引\n- no-repeat',
    ])

    const p = port(store, conv.id)
    expect((await p.run(await pressure(store, conv.id))).status).toBe('compacted')
    const projected = p.project(await history(store, conv.id))
    expect(projected.filter((message) => message.role === 'context').map((m) => m.content)).toEqual(
      ['工作区：C:/ws', '## 记忆索引\n- no-repeat'],
    )
    expect(projected.slice(0, 3).map((message) => message.role)).toEqual([
      'context',
      'context',
      'user',
    ])
    store.close()
  })

  test('最后一次成功 write_todos 跨摘要与收纳仍保留完整调用和结果', async () => {
    const { store, ws, conv, ids } = fresh(2)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'todo-pin',
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    const todo = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_todos',
      toolCallId: 'todo_1',
      providerBatchId: 'todo_batch',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, todo.id, 'success', {
      kind: 'tool_result',
      args: {
        todos: [
          { content: '检查缓存', status: 'completed' },
          { content: '验证重启', status: 'in_progress' },
        ],
      },
      outcome: { status: 'success', executed: true, message: '待办已更新' },
    })
    addToolWaves(store, run.id, 24, 3000, 2)
    const p = port(store, conv.id)
    expect((await p.run(await pressure(store, conv.id))).status).toBe('compacted')

    const projected = p.project(await history(store, conv.id))
    const assistant = projected.find((message) =>
      message.toolCalls?.some((call) => call.name === 'write_todos'),
    )
    expect(assistant).toBeDefined()
    const call = assistant!.toolCalls!.find((item) => item.name === 'write_todos')!
    expect(call.arguments).toEqual({
      todos: [
        { content: '检查缓存', status: 'completed' },
        { content: '验证重启', status: 'in_progress' },
      ],
    })
    const result = projected.find(
      (message) => message.role === 'tool' && message.toolCallId === call.id,
    )
    expect(JSON.parse(String(result?.content)).status).toBe('success')
    expect(projected.filter((message) => message.toolCallId === call.id)).toHaveLength(1)
    store.close()
  })

  test('整表之后的待验收子任务回执跨摘要仍保留，但大输出照常收纳', async () => {
    const { store, ws, conv, ids } = fresh(2)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'todo-subagent-pin',
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    const todo = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_todos',
      toolCallId: 'todo_parent',
      providerBatchId: 'todo_batch',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, todo.id, 'success', {
      kind: 'tool_result',
      args: {
        todos: [
          { content: '子任务审计', status: 'in_progress' },
          { content: '主会话收尾', status: 'pending' },
        ],
      },
      outcome: { status: 'success', executed: true, message: '第 1/2 步' },
    })
    const child = appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'subagent',
      toolCallId: 'child_1',
      providerBatchId: 'child_batch',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, child.id, 'success', {
      kind: 'tool_result',
      args: { task: '完成独立审计', parentTodo: '子任务审计' },
      outcome: {
        status: 'success',
        executed: true,
        message: '临时子 agent 已返回；父待办仍待验收：子任务审计',
        data: { output: 'z'.repeat(12_000), conversationId: 'cv_child' },
      },
    })
    addToolWaves(store, run.id, 24, 3000, 3)
    const p = port(store, conv.id)
    expect((await p.run(await pressure(store, conv.id))).status).toBe('compacted')

    const projected = p.project(await history(store, conv.id))
    const assistant = projected.find((message) =>
      message.toolCalls?.some((call) => call.id === 'child_1'),
    )
    const call = assistant?.toolCalls?.find((item) => item.id === 'child_1')
    expect(call?.arguments.parentTodo).toBe('子任务审计')
    const result = projected.find(
      (message) => message.role === 'tool' && message.toolCallId === 'child_1',
    )
    const envelope = JSON.parse(String(result?.content)) as {
      status: string
      summary: string
      result_omitted?: boolean
    }
    expect(envelope.status).toBe('success')
    expect(envelope.summary).toContain('父待办仍待验收：子任务审计')
    expect(envelope.result_omitted).toBe(true)
    expect(String(result?.content)).not.toContain('z'.repeat(100))
    store.close()
  })

  /**
   * 待办表与大回执位于同一执行批次时的保留粒度。
   *
   * 保留粒度取单元时，同批的子 agent 回执随之固定在窗口中：收纳线前移，
   * 投影却没有减少任何 token，此后每轮都判定 `nothing_to_fold`，直到触及上下文窗口上限。
   */
  test('待办表与大回执同批时只保留整表对应的调用与结果', async () => {
    const { store, ws, conv, ids } = fresh(2)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'todo-same-batch',
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    const todo = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_todos',
      toolCallId: 'todo_same_batch',
      providerBatchId: 'mixed_batch',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, todo.id, 'success', {
      kind: 'tool_result',
      args: {
        todos: [
          { content: '派外部 CLI 审查 game.js', status: 'in_progress' },
          { content: '汇总审查结论', status: 'pending' },
        ],
      },
      outcome: { status: 'success', executed: true, message: '第 1/2 步' },
    })
    // 同一个 providerBatchId：`stepsToUnits` 把两条调用合并到同一个可折单元。
    const receipt = appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'subagent',
      toolCallId: 'cli_same_batch',
      providerBatchId: 'mixed_batch',
      callIndex: 1,
      status: 'running',
    })
    settleToolStep(store, receipt.id, 'success', {
      kind: 'tool_result',
      args: { task: '审查 game.js', kind: 'cli' },
      outcome: {
        status: 'success',
        executed: true,
        message: '外部 CLI claude 已返回',
        data: { output: 'z'.repeat(300_000), conversationId: 'cv_cli' },
      },
    })
    // 尾部必须累积足够的保留预算，否则该大单元本身位于收纳线之后，无法测试粒度。
    addToolWaves(store, run.id, 24, 12_000, 3)

    const p = port(store, conv.id)
    const before = await history(store, conv.id)
    const outcome = await p.run(await pressure(store, conv.id))
    expect(outcome.status).toBe('compacted')

    const projected = p.project(before)
    const assistant = projected.find((message) =>
      message.toolCalls?.some((call) => call.id === 'todo_same_batch'),
    )
    expect(assistant).toBeDefined()
    // 整表逐字保留：调用参数不做任何修改。
    expect(assistant!.toolCalls!.find((call) => call.id === 'todo_same_batch')!.arguments).toEqual({
      todos: [
        { content: '派外部 CLI 审查 game.js', status: 'in_progress' },
        { content: '汇总审查结论', status: 'pending' },
      ],
    })
    const table = projected.find(
      (message) => message.role === 'tool' && message.toolCallId === 'todo_same_batch',
    )
    expect(JSON.parse(String(table?.content)).status).toBe('success')

    // 同批的大回执替换为信封：正文不再发送。
    const envelope = JSON.parse(
      String(
        projected.find(
          (message) => message.role === 'tool' && message.toolCallId === 'cli_same_batch',
        )?.content,
      ),
    ) as { status: string; summary: string; result_omitted?: boolean }
    expect(envelope.status).toBe('success')
    expect(envelope.summary).toBe('外部 CLI claude 已返回')
    expect(envelope.result_omitted).toBe(true)
    expect(projected.every((message) => !String(message.content).includes('z'.repeat(100)))).toBe(
      true,
    )

    // 收纳确实回收了体积，不只是前移收纳线。
    expect(estimateMessages(projected, DEFAULT_DENSITY)).toBeLessThan(
      estimateMessages(before, DEFAULT_DENSITY) / 2,
    )
    store.close()
  })

  /**
   * 落库的读数与投影必须基于同一份内容计量。
   *
   * `contextAfter.measured` 由 `estimateProjection` 计算，模型看到的内容由 `project` 组装；
   * 两处对逐字保留条目的判定不一致时，面板报告的回收量无法达到，且两处都不报错。
   */
  test('落库读数与投影口径一致', async () => {
    const { store, ws, conv, ids } = fresh(2)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'todo-estimate',
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    const todo = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_todos',
      toolCallId: 'todo_estimate',
      providerBatchId: 'mixed_batch',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, todo.id, 'success', {
      kind: 'tool_result',
      args: { todos: [{ content: '派外部 CLI 审查', status: 'in_progress' }] },
      outcome: { status: 'success', executed: true, message: '第 1/1 步' },
    })
    const receipt = appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'subagent',
      toolCallId: 'cli_estimate',
      providerBatchId: 'mixed_batch',
      callIndex: 1,
      status: 'running',
    })
    settleToolStep(store, receipt.id, 'success', {
      kind: 'tool_result',
      args: { task: '审查 game.js', kind: 'cli' },
      outcome: {
        status: 'success',
        executed: true,
        message: '外部 CLI claude 已返回',
        data: { output: 'z'.repeat(300_000) },
      },
    })
    addToolWaves(store, run.id, 24, 12_000, 3)

    const p = port(store, conv.id)
    const before = await history(store, conv.id)
    const outcome = await p.run(await pressure(store, conv.id))
    expect(outcome.status).toBe('compacted')

    const measured = getConversation(store, conv.id)!.compactionManifest!.contextAfter!.measured
    expect(measured).toBe(estimateMessages(p.project(before), DEFAULT_DENSITY))
    store.close()
  })

  test('没有 _messageId 的投影消息一律保留', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    await p.run(await pressure(store, conv.id))

    const h = [
      ...(await history(store, conv.id)),
      { role: 'assistant' as const, content: '投影摘要' },
    ]
    expect(p.project(h).some((m) => String(m.content).includes('投影摘要'))).toBe(true)
    store.close()
  })

  test('manifest 与当前历史不一致时不额外插入两条消息', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    await p.run(await pressure(store, conv.id))

    const alien = [{ role: 'user' as const, content: 'x', _messageId: 'ms_zzzzzzzz' }]
    expect(p.project(alien)).toHaveLength(1)
    store.close()
  })

  /**
   * 带图的工具结果必须能被收纳。
   *
   * 本用例针对一种完全静默的失败形状：收纳一旦原样放行非字符串 content
   * （`agent/compaction.ts` 的 `condenseToolResult`），一张数 MB 的截图
   * 会在此后每一轮完整重放，直到触及窗口上限，而压缩机制对其不做任何处理。
   *
   * 两部分都必须断言：图片被丢弃，信封被保留。只丢弃不保留时，模型无从得知
   * 该轮读取过一张图片，也无法重新取得。
   */
  test('收纳区带图的工具结果丢弃图片、保留信封', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    // 每一批带一张图片：内容无关紧要，体积必须足以影响选界。
    for (let w = 0; w < 12; w++) {
      const step = appendStep(store, {
        runId: run.id,
        seq: 1 + w,
        kind: 'tool_action',
        toolName: 'read_file',
        toolCallId: `call_${w}`,
        providerBatchId: `bt_${w}`,
        callIndex: 0,
        status: 'running',
      })
      settleToolStep(store, step.id, 'success', {
        kind: 'tool_result',
        args: { path: `shot_${w}.png` },
        outcome: {
          status: 'success',
          executed: true,
          message: `读取 shot_${w}.png（图片）`,
          data: { images: [{ data: 'A'.repeat(4000), mime: 'image/png' }] },
        },
      } as never)
    }

    const p = port(store, conv.id)
    const before = await history(store, conv.id)
    const imagesIn = (msgs: WireMessage[]) =>
      msgs
        .filter((m) => typeof m.content !== 'string')
        .flatMap((m) => (m.content as { type: string }[]).filter((b) => b.type === 'image')).length

    expect(imagesIn(before)).toBe(12)
    await p.run(await pressure(store, conv.id))
    const projected = p.project(before)

    // 收纳段中的图片已移除，保留区的图片仍在。
    expect(imagesIn(projected)).toBeGreaterThan(0)
    expect(imagesIn(projected)).toBeLessThan(12)

    // 被收纳的条目：信封完整，模型仍可知道该轮读取了哪个文件以及是否成功。
    const condensed = projected.filter((m) => m.role === 'tool' && typeof m.content === 'string')
    expect(condensed.length).toBeGreaterThan(0)
    const env = JSON.parse(condensed[0]!.content as string) as Record<string, unknown>
    expect(env.tool).toBe('read_file')
    expect(env.status).toBe('success')
    expect(String(env.summary)).toContain('.png')
    // 信封中不得保留任何图片字节。
    expect(condensed.every((m) => !(m.content as string).includes('AAAA'))).toBe(true)
    store.close()
  })

  test('收纳区的工具结果只保留信封与定位符，正文不再发送', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    addToolWaves(store, run.id, 12, 4000)

    const p = port(store, conv.id)
    const before = await history(store, conv.id)
    await p.run(await pressure(store, conv.id))
    const projected = p.project(before)

    const tools = projected.filter((m) => m.role === 'tool')
    expect(tools.length).toBeGreaterThan(0)
    const condensed = tools.filter((m) => (m.content as string).includes('result_omitted'))
    expect(condensed.length).toBeGreaterThan(0)
    // 定位符必须保留，否则 sink 中的正文将无法再取回。
    expect(condensed.some((m) => (m.content as string).includes('rs_'))).toBe(true)
    expect(estimateMessages(projected, DEFAULT_DENSITY)).toBeLessThan(
      estimateMessages(before, DEFAULT_DENSITY) / 2,
    )
    store.close()
  })
})

/**
 * 复现原始失败形状。
 *
 * 账本中的会话是 2 条 user 消息与 287 条工具 step：按 user 消息条数判定门槛
 * 时恒返回 `too_few_messages`，无法压缩，而实际占用 66 万字符的正是这些
 * 工具结果。压缩单元为执行批次时，该会话有数十个可折单元。
 */
describe('长 run 少消息的会话必须可以压缩', () => {
  test('2 条用户消息 + 大量工具批次：可以折叠，不返回跳过', async () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
    const conv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: 't',
    })
    const m1 = appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: '把这个仓库过一遍',
    }).id
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: m1,
      messageIdUpperBound: m1,
      contextSnapshot: [],
    })
    addToolWaves(store, run.id, 60, 2000)
    appendMessage(store, { conversationId: conv.id, role: 'user', content: '继续' })

    const r = await port(store, conv.id).run(await pressure(store, conv.id))
    expect(r.status).toBe('compacted')
    store.close()
  })
})

describe('切分边界不会分开 tool_call 与 tool_result', () => {
  test('任意保留预算下投影中都没有孤立的工具消息', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    addToolWaves(store, run.id, 20, 800)

    const before = await history(store, conv.id)
    const total = estimateMessages(before, DEFAULT_DENSITY)
    // 从几乎全部折叠到几乎全部保留遍历窗口，每一档都要求配对完整。
    for (let window = 400; window <= total * 2; window += Math.max(1, Math.floor(total / 8))) {
      const p = port(store, conv.id)
      await p.run({
        trigger: 'automatic',
        model: 'm',
        latestUnitSeen: false,
        occupancy: total,
        estimatedOccupancy: total,
        contextWindow: window,
        density: DEFAULT_DENSITY,
      })
      const projected = p.project(before)

      const declared = new Set<string>()
      for (const m of projected) for (const c of m.toolCalls ?? []) declared.add(c.id)
      const answered = new Set<string>()
      for (const m of projected) {
        if (m.role !== 'tool') continue
        expect(declared.has(m.toolCallId ?? '')).toBe(true)
        answered.add(m.toolCallId ?? '')
      }
      expect(answered.size).toBe(declared.size)
    }
    store.close()
  })
})

describe('仅收纳段即足够时不调用模型', () => {
  test('工具正文占多数：不调用摘要器，占用同样下降', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    addToolWaves(store, run.id, 30, 6000)

    let calls = 0
    const p = port(store, conv.id, async () => {
      calls++
      return '不该被调用'
    })
    const before = await history(store, conv.id)
    const r = await p.run(await pressure(store, conv.id))

    expect(r.status).toBe('compacted')
    expect(r.status === 'compacted' && r.summarized).toBe(false)
    // 没有失败码表示未执行摘要段，而不是摘要段失败后的回退处理。
    expect(r.status === 'compacted' && r.reasonCode).toBeUndefined()
    expect(calls).toBe(0)
    // 折叠区的工具正文全部替换为信封；其余是保留预算内的尾部。
    expect(estimateMessages(p.project(before), DEFAULT_DENSITY)).toBeLessThan(
      estimateMessages(before, DEFAULT_DENSITY) * 0.4,
    )
    store.close()
  })

  test('手动触发在低占用时仍选出旧段并尝试摘要', async () => {
    const { store, conv } = fresh()
    let calls = 0
    const p = port(store, conv.id, async () => {
      calls++
      return '用户手动触发的摘要'
    })
    const input = await pressure(store, conv.id)
    const r = await p.run({
      ...input,
      trigger: 'manual',
      // 占用仅为模型窗口的 10%：若按窗口的 1/4 保留尾部，整段历史均无可折叠的内容。
      contextWindow: input.contextWindow * 10,
    })

    expect(r.status).toBe('compacted')
    expect(r.status === 'compacted' && r.summarized).toBe(true)
    expect(calls).toBe(1)
    expect(r.status === 'compacted' && r.manifest.summary).toBe('用户手动触发的摘要')
    store.close()
  })
})

describe('事实提取', () => {
  test('文件类动作的 target 列入清单，命令字符串不列入', async () => {
    const { store, ws, conv, ids } = fresh()
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    const edit = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'edit_file',
      toolCallId: 'c_edit',
      providerBatchId: 'bt_edit',
      callIndex: 0,
      status: 'running',
    })
    settleToolStep(store, edit.id, 'success', {
      kind: 'tool_result',
      args: {},
      outcome: { status: 'success', executed: true, message: '改了 3 处' },
      action: { kind: 'edit', objectLabel: '文件', target: 'src/auth/token.ts' },
    })
    // 正文较小，仅靠收纳段不够，摘要段必定执行，事实包因此有产出。
    addToolWaves(store, run.id, 4, 100, 2)

    const r = await port(store, conv.id).run(await pressure(store, conv.id))
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).toContain('src/auth/token.ts')
    expect(r.manifest.facts.filesTouched.join('')).not.toContain('npm test')
    store.close()
  })

  test('仍在 running 的批次不列入事实包：结果未知，不能视为已完成', async () => {
    const { store, ws, conv, ids } = fresh()
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: 'c_run',
      providerBatchId: 'bt_run',
      callIndex: 0,
      status: 'running',
      payload: {
        kind: 'tool_call',
        args: {},
        action: { kind: 'read', objectLabel: '文件', target: '还没读完.ts' },
      },
    })

    const r = await port(store, conv.id).run(await pressure(store, conv.id))
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).not.toContain('还没读完.ts')
    store.close()
  })
})

/**
 * 一段数十万 token 的续读投递本身即超过保留量。模型已查看后若整段留在保留尾部，
 * 压缩后占用仍接近软阈值，下一段只剩一份保留量的空间；模型未查看时必须整段保留。
 */
describe('模型已查看的超大单元在压缩时一并收纳', () => {
  async function withHugeLastUnit() {
    const { store, ws, conv, ids } = fresh(2)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'huge-read',
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    addToolWaves(store, run.id, 1, 40_000)
    return { store, conv }
  }
  const lastTool = (messages: WireMessage[]) =>
    String([...messages].reverse().find((m) => m.role === 'tool')?.content ?? '')

  test('已查看：收纳该单元，只收纳不摘要', async () => {
    const { store, conv } = await withHugeLastUnit()
    const p = port(store, conv.id)
    const outcome = await p.run({ ...(await pressure(store, conv.id)), latestUnitSeen: true })
    expect(outcome.status === 'compacted' && outcome.summarized).toBe(false)
    const tool = lastTool(p.project(await history(store, conv.id)))
    expect(tool).toContain('result_omitted')
    expect(tool).not.toContain('y'.repeat(1000))
    store.close()
  })

  test('未查看：整段保留', async () => {
    const { store, conv } = await withHugeLastUnit()
    const p = port(store, conv.id)
    await p.run({ ...(await pressure(store, conv.id)), latestUnitSeen: false })
    expect(lastTool(p.project(await history(store, conv.id)))).toContain('y'.repeat(1000))
    store.close()
  })
})

describe('软阈值以下只执行回收量足够大的收纳', () => {
  /** 占用低于软阈值：窗口取占用的 1.3 倍，软阈值 = 1.04 × 占用。 */
  async function belowLine(store: Store, conversationId: string): Promise<CompactionRunInput> {
    const load = await pressure(store, conversationId)
    return { ...load, contextWindow: Math.round(load.occupancy * 1.3) }
  }

  test('回收量不足半份保留量：跳过，不调用摘要器，manifest 不变', async () => {
    const { store, conv } = fresh(8)
    let calls = 0
    const p = port(store, conv.id, async () => {
      calls++
      return '摘要'
    })
    const outcome = await p.run(await belowLine(store, conv.id))
    expect(outcome).toEqual({ status: 'skipped', reasonCode: 'nothing_to_fold' })
    expect(calls).toBe(0)
    expect(getConversation(store, conv.id)?.compactionManifest ?? null).toBeNull()
    store.close()
  })

  test('回收量足够：只收纳，不调用摘要器', async () => {
    const { store, ws, conv, ids } = fresh(8)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'bulky-tools',
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
      contextSnapshot: [],
    })
    addToolWaves(store, run.id, 3, 20_000)
    let calls = 0
    const p = port(store, conv.id, async () => {
      calls++
      return '摘要'
    })
    const outcome = await p.run(await belowLine(store, conv.id))
    expect(outcome.status === 'compacted' && outcome.summarized).toBe(false)
    expect(calls).toBe(0)
    store.close()
  })
})

describe('增量压缩', () => {
  test('第二次只处理新增部分，revision 递增', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    const first = await p.run(await pressure(store, conv.id))
    expect(first.status === 'compacted' && first.manifest.revision).toBe(1)

    for (let i = 0; i < 2; i++) {
      turn(store, conv.workspaceId, conv.id, `新消息 ${i}`, `新回复 ${i} ${PAD}`)
    }

    const second = await p.run(await pressure(store, conv.id))
    expect(second.status === 'compacted' && second.manifest.revision).toBe(2)
    store.close()
  })

  test('没有新单元时跳过，不产生无效的摘要调用', async () => {
    const { store, conv } = fresh()
    let calls = 0
    const p = port(store, conv.id, async () => {
      calls++
      return '摘要'
    })
    const load = await pressure(store, conv.id)
    await p.run(load)
    expect(calls).toBe(1)

    const again = await p.run(load)
    expect(again.status).toBe('skipped')
    expect(again.status === 'skipped' && again.reasonCode).toBe('nothing_to_fold')
    expect(calls).toBe(1)
    store.close()
  })
})

describe('摘要段失败不回退收纳段', () => {
  test('摘要器抛错：收纳正常落库，结果对用户可见', async () => {
    const { store, conv } = fresh()
    const r = await port(store, conv.id, async () => {
      throw new Error('上下文超限')
    }).run(await pressure(store, conv.id))

    expect(r.status).toBe('compacted')
    expect(r.status === 'compacted' && r.summarized).toBe(false)
    expect(r.status === 'compacted' && r.reasonCode).toBe('summary_error')
    const landed = getConversation(store, conv.id)!.compactionManifest
    expect(landed).not.toBeNull()
    // 摘要线不动，收纳线前移。
    expect(landed!.compactedThroughMessageId).toBeNull()
    expect(landed!.condensedThrough).toBeDefined()
    store.close()
  })
})

/**
 * 中断安全。
 *
 * 复现的原始失败形状：用户点击停止 8 毫秒后，一份机械截取的 manifest 被写入数据库，
 * 32 万 token 的上下文在下一轮变为 4.5 万；该变化不可逆，界面上也没有任何提示。
 */
describe('中断即丢弃', () => {
  test('摘要已生成但中断信号已触发：manifest 未变更', async () => {
    const { store, conv } = fresh()
    const ac = new AbortController()
    const before = getConversation(store, conv.id)!.compactionManifest
    const r = await port(store, conv.id, async () => {
      ac.abort()
      return '一份没人等到的摘要'
    }).run({ ...(await pressure(store, conv.id)), signal: ac.signal })

    expect(r.status).toBe('aborted')
    expect(getConversation(store, conv.id)!.compactionManifest).toEqual(before)
    store.close()
  })

  test('摘要调用被中断时不写入任何行', async () => {
    const { store, conv } = fresh()
    const ac = new AbortController()
    const r = await port(store, conv.id, async () => {
      throw new DOMException('已中断', 'AbortError')
    }).run({ ...(await pressure(store, conv.id)), signal: ac.signal })

    expect(r.status).toBe('aborted')
    expect(getConversation(store, conv.id)!.compactionManifest).toBeNull()
    store.close()
  })

  /** 中断之后投影必须与中断前逐条相等：占用骤降正是在此处发生。 */
  test('中断之后投影不变，历史完整保留', async () => {
    const { store, conv } = fresh()
    const ac = new AbortController()
    const p = port(store, conv.id, async () => {
      ac.abort()
      return '摘要'
    })
    const h = await history(store, conv.id)

    await p.run({ ...(await pressure(store, conv.id)), signal: ac.signal })
    expect(p.project(h)).toHaveLength(h.length)
    store.close()
  })
})

/**
 * run 内注入的用户消息折叠进摘要线之后，必须得到保留并可取回。
 *
 * 折叠区组装摘要段时只收录 `row` 与 assistant 正文，不包含 user 角色的单元消息，
 * 而注入单元的 `actions` 为空：不为其设置 `row` 时，用户调整方向的消息
 * 在一次压缩后完全丢失，模型继续按调整之前的判断执行，界面上没有任何提示。
 */
describe('注入的用户消息与压缩', () => {
  test('可进入摘要段，地址为 <runId>:<stepId>', async () => {
    const { store, conv, ids } = fresh(8)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: 'ws' as never,
      model: 'm',
      clientRequestId: 'c1',
      userMessageId: ids[0] ?? null,
      messageIdUpperBound: ids[0] ?? null,
      contextSnapshot: [],
    })
    addToolWaves(store, run.id, 2, 400)
    const injected = appendStep(store, {
      runId: run.id,
      seq: 9,
      kind: 'user',
      content: '所有路径都用正斜杠',
      payload: { kind: 'user' },
    })

    // 摘要器收到的提示词包含折叠区的全部段落，断言直接读取该提示词。
    let prompt = ''
    const spy: Summarizer = async (text) => {
      prompt = text
      return '模型写的摘要'
    }
    const result = await port(store, conv.id, spy).run(await pressure(store, conv.id))

    expect(result.status).toBe('compacted')
    expect(prompt).toContain('所有路径都用正斜杠')
    // 输出为 `[message:<runId>:<stepId>]`：该消息不在 messages 表中，
    // 由 `HistoryPort.message` 的复合形式解析。
    expect(prompt).toContain(`[message:${run.id}:${injected.id}] 用户：所有路径都用正斜杠`)
    store.close()
  })

  /** 助手正文的地址是其自身的 text step，不是所属用户消息的 id。 */
  test('助手正文进入摘要段时，地址为其自身的 <runId>:<stepId>', async () => {
    const { store, conv, ids } = fresh(8)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: 'ws' as never,
      model: 'm',
      clientRequestId: 'c1',
      userMessageId: ids[0] ?? null,
      messageIdUpperBound: ids[0] ?? null,
      contextSnapshot: [],
    })
    const text = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'text',
      content: '结论：签名算法定为 RS256',
      providerBatchId: 'bt_answer',
    })
    addToolWaves(store, run.id, 2, 400, 2)

    let prompt = ''
    const spy: Summarizer = async (p) => {
      prompt = p
      return '模型写的摘要'
    }
    const result = await port(store, conv.id, spy).run(await pressure(store, conv.id))

    expect(result.status).toBe('compacted')
    expect(prompt).toContain(`[message:${run.id}:${text.id}] 助手：结论：签名算法定为 RS256`)
    expect(prompt).not.toContain(`[message:${ids[0]}] 助手：结论`)
    store.close()
  })
})

/**
 * 占用取 provider 真值、回收量取本地估算时，两种口径不得直接相减。
 *
 * 复现的形状：未收录模型的估算实测偏高 1.47 倍，因此收纳回收量虚高同样的倍数，
 * `condenseOnly` 判定「仅收纳即可」而实际不足：摘要线不前移，此后每一轮都判定
 * `nothing_to_fold`，占用只增不减，直到触及上下文窗口上限。直接相减时实测压缩后真值为 2179，软阈值为 2177。
 *
 * 断言写为压缩之后真值必须低于软阈值，不断言摘要是否执行：后者是实现细节，
 * 前者是压缩这一步应交付的结果。真值按同一倍率反推：该倍率是这条会话实测得到的
 * 常数（六次请求恒为 1.470），不是假设。
 */
describe('两种计量口径不得直接相减', () => {
  test('回收量按实测比值折算后再相减，压缩后真值低于软阈值', async () => {
    const K = 1.47
    // 三档窗口都处于收纳恰好不足的区间：直接相减时三档全部越过阈值，折算后全部达标。
    for (const contextWindow of [2722, 2400, 2000]) {
      const { store, ws, conv, ids } = fresh()
      const run = createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: `req-${contextWindow}`,
        userMessageId: ids[0]!,
        messageIdUpperBound: ids[0]!,
        contextSnapshot: [],
      })
      addToolWaves(store, run.id, 20, 800)

      const before = await history(store, conv.id)
      const estimated = estimateMessages(before, DEFAULT_DENSITY)
      const occupancy = Math.round(estimated / K)
      const limit = softLimit({ contextWindow })
      // 前提：真值确实越过阈值，否则本轮不应压缩，用例即不针对该问题。
      expect(occupancy).toBeGreaterThan(limit)

      const p = port(store, conv.id)
      const outcome = await p.run({
        trigger: 'automatic',
        model: 'm',
        latestUnitSeen: false,
        occupancy,
        estimatedOccupancy: estimated,
        contextWindow,
        density: DEFAULT_DENSITY,
      })
      expect(outcome.status).toBe('compacted')

      const after = estimateMessages(p.project(before), DEFAULT_DENSITY) / K
      expect(after).toBeLessThanOrEqual(limit)
      store.close()
    }
  })
})
