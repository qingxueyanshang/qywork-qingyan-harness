/**
 * 覆盖范围：`compaction.ts`（选界 / 收纳 / 摘要接线 / 三区投影 / 落库守卫）。
 * 压缩算法本身在 `agent/compaction.test.ts`，与主循环的接线在
 * `agent/compaction-loop.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import type { CompactionRunInput, Summarizer } from '@qywork/agent'
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

/** 助手消息垫长一点，单元之间才有体积差，选界不至于一刀切到底。 */
const PAD = 'x'.repeat(1000)

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
  for (let i = 0; i < messageCount; i++) {
    ids.push(
      appendMessage(store, {
        conversationId: conv.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content:
          i === 0
            ? '重构认证模块，不要动 legacy/'
            : i % 2 === 0
              ? `第 ${i} 条消息`
              : `第 ${i} 条 ${PAD}`,
      }).id,
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
 * 造出「刚刚越线」的压力：占用取会话装配后的真实估算，窗口取同一个数。
 *
 * 因此软阈值（窗口的 80%）必定低于占用，保留预算（窗口的 1/4）留住尾巴——
 * 不用去猜某个模型档的具体数字，也不会因为估算系数微调就整片红。
 */
async function pressure(store: Store, conversationId: string): Promise<CompactionRunInput> {
  const history = await buildHistory(store, conversationId as never, null, async (c) => c)
  const total = estimateMessages(history, DEFAULT_DENSITY)
  return { occupancy: total, contextWindow: total, density: DEFAULT_DENSITY }
}

async function history(store: Store, conversationId: string): Promise<WireMessage[]> {
  return buildHistory(store, conversationId as never, null, async (c) => c)
}

/** 给一条 run 挂 n 个工具波次，每个波次一条调用，结果正文按 payloadChars 撑大。 */
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
  test('压缩后原始消息一条不少', async () => {
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

  test('manifest 落在 conversations 上，可跨进程恢复', async () => {
    const { store, conv } = fresh()
    await port(store, conv.id).run(await pressure(store, conv.id))

    const reloaded = getConversation(store, conv.id)!.compactionManifest
    expect(reloaded).not.toBeNull()
    expect(reloaded!.revision).toBe(1)
    expect(reloaded!.condensedThrough).toBeDefined()
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

  test('摘要线以内换成摘要 + 事实清单两条，尾部原样', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    await p.run(await pressure(store, conv.id))

    const h = await history(store, conv.id)
    const projected = p.project(h)
    expect(projected.length).toBeLessThan(h.length)
    expect(projected[0]!.content).toContain('被压缩的早期对话摘要')
    expect(projected[1]!.content).toContain('事实清单')
    // 最后一条永远保留：压掉它模型就忘了自己刚被问了什么。
    expect(projected[projected.length - 1]!.content).toBe(h[h.length - 1]!.content as string)
    store.close()
  })

  test('没有 _messageId 的消息（尾区注记）一律保留', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    await p.run(await pressure(store, conv.id))

    const h = [
      ...(await history(store, conv.id)),
      { role: 'system' as const, content: '尾区注记：当前分支 main' },
    ]
    expect(p.project(h).some((m) => String(m.content).includes('尾区注记'))).toBe(true)
    store.close()
  })

  test('manifest 与当前历史对不上时不平白多两条', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    await p.run(await pressure(store, conv.id))

    const alien = [{ role: 'user' as const, content: 'x', _messageId: 'ms_zzzzzzzz' }]
    expect(p.project(alien)).toHaveLength(1)
    store.close()
  })

  /**
   * **带图的工具结果必须收得掉。**
   *
   * 这条盯的是一个完全静默的形状：收纳对非字符串 content 一旦原样放行
   * （`agent/compaction.ts` 的 `condenseToolResult`），因此一张几 MB 的截图
   * 在此后每一轮满额重放，直到撞上窗口上限——而压缩机制对它不做任何处理。
   *
   * 两半都要断言：图**丢掉**，信封**留下**。只丢不留的话模型连「那一轮读过一张图」
   * 都不知道，重新取都无从取起。
   */
  test('收纳区带图的工具结果丢掉图、留下信封', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
    })
    // 每一波带一张「图」：内容不重要，体积重要——要撑得起选界。
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

    // 收纳段里的图没了，保留区那几张还在。
    expect(imagesIn(projected)).toBeGreaterThan(0)
    expect(imagesIn(projected)).toBeLessThan(12)

    // 被收掉的那些：信封完整，模型仍然知道那一轮读过哪个文件、成没成功。
    const condensed = projected.filter((m) => m.role === 'tool' && typeof m.content === 'string')
    expect(condensed.length).toBeGreaterThan(0)
    const env = JSON.parse(condensed[0]!.content as string) as Record<string, unknown>
    expect(env.tool).toBe('read_file')
    expect(env.status).toBe('success')
    expect(String(env.summary)).toContain('.png')
    // 字节一个都不许留在信封里。
    expect(condensed.every((m) => !(m.content as string).includes('AAAA'))).toBe(true)
    store.close()
  })

  test('收纳区的工具结果只剩信封与定位符，正文不再上线', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
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
    // 定位符必须活下来，否则 sink 里那份正文再也调不起来。
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
 * 账本里那条会话是 2 条 user 消息 + 287 条工具 step：按「user 消息条数」判门槛
 * 时它恒回 `too_few_messages`，一次也压不动，而真正占掉 66 万字符的正是那些
 * 工具结果。压缩单元改成「执行波次」之后，它有几十个可折单元。
 */
describe('长 run 少消息的会话必须压得动', () => {
  test('2 条用户消息 + 大量工具波次：折得动，不再回跳过', async () => {
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
    })
    addToolWaves(store, run.id, 60, 2000)
    appendMessage(store, { conversationId: conv.id, role: 'user', content: '继续' })

    const r = await port(store, conv.id).run(await pressure(store, conv.id))
    expect(r.status).toBe('compacted')
    store.close()
  })
})

describe('切界永不切开 tool_call 与 tool_result', () => {
  test('任意保留预算下投影里都没有孤儿工具消息', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
    })
    addToolWaves(store, run.id, 20, 800)

    const before = await history(store, conv.id)
    const total = estimateMessages(before, DEFAULT_DENSITY)
    // 从「几乎全折」到「几乎全留」扫一遍窗口，每一档都要求配对完整。
    for (let window = 400; window <= total * 2; window += Math.max(1, Math.floor(total / 8))) {
      const p = port(store, conv.id)
      await p.run({ occupancy: total, contextWindow: window, density: DEFAULT_DENSITY })
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

describe('收纳段单独够用时零模型调用', () => {
  test('工具正文占大头：不调摘要器，占用照样降下来', async () => {
    const { store, ws, conv, ids } = fresh(4)
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
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
    // 没有失败码 = 没走摘要段，不是摘要段失败后的兜底。
    expect(r.status === 'compacted' && r.reasonCode).toBeUndefined()
    expect(calls).toBe(0)
    // 被折区的工具正文全换成信封；余下的是保留预算里那一段尾巴。
    expect(estimateMessages(p.project(before), DEFAULT_DENSITY)).toBeLessThan(
      estimateMessages(before, DEFAULT_DENSITY) * 0.4,
    )
    store.close()
  })
})

describe('事实提取', () => {
  test('文件类动作的 target 进清单，命令串不进', async () => {
    const { store, ws, conv, ids } = fresh()
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
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
    // 正文压得小，收纳段单独不够，摘要段必定跑起来——事实包才有产出。
    addToolWaves(store, run.id, 4, 100, 2)

    const r = await port(store, conv.id).run(await pressure(store, conv.id))
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).toContain('src/auth/token.ts')
    expect(r.manifest.facts.filesTouched.join('')).not.toContain('npm test')
    store.close()
  })

  test('还在 running 的波次不进事实包 —— 结果未知不能当已完成', async () => {
    const { store, ws, conv, ids } = fresh()
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
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

describe('增量压缩', () => {
  test('第二次只处理新增部分，revision 递增', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    const first = await p.run(await pressure(store, conv.id))
    expect(first.status === 'compacted' && first.manifest.revision).toBe(1)

    for (let i = 0; i < 4; i++) {
      appendMessage(store, {
        conversationId: conv.id,
        role: 'assistant',
        content: `新消息 ${i} ${PAD}`,
      })
    }

    const second = await p.run(await pressure(store, conv.id))
    expect(second.status === 'compacted' && second.manifest.revision).toBe(2)
    store.close()
  })

  test('没有新单元时跳过，不白花一次摘要调用', async () => {
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
  test('摘要器抛错：收纳照常落库，结果对用户可见', async () => {
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
 * 复现的原始失败形状：用户按停止之后 8 毫秒，一份机械截取的 manifest 落了库，
 * 32 万 token 的上下文在下一轮变成 4.5 万——不可逆，用户也看不出发生过什么。
 */
describe('中断即丢弃', () => {
  test('摘要已经写完但信号被拉起：manifest 未变更', async () => {
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

  test('摘要调用被中断时不落任何行', async () => {
    const { store, conv } = fresh()
    const ac = new AbortController()
    const r = await port(store, conv.id, async () => {
      throw new DOMException('已中断', 'AbortError')
    }).run({ ...(await pressure(store, conv.id)), signal: ac.signal })

    expect(r.status).toBe('aborted')
    expect(getConversation(store, conv.id)!.compactionManifest).toBeNull()
    store.close()
  })

  /** 中断之后投影必须与中断前逐条相等——占用跳水就是从这里发生的。 */
  test('中断之后投影不变，历史一条不少', async () => {
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
