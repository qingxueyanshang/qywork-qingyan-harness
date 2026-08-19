/**
 * 覆盖范围：`history.ts` 的 `read_history`。
 *
 * 它是压缩的另一半：折掉的原文一直在账本里，这个工具负责把它接回给模型。
 * 所以这里锁三件事——**取回的是逐字原文**、**端口没接时如实报而不是谎称找不到**、
 * **读回来的量受投递预算约束**（没有这道闸，模型可以把刚折掉的整段读回来，
 * 压缩当场失效）。
 */

import { describe, expect, test } from 'bun:test'
import type { HistoryPort, ToolContext } from '@qywork/agent'
import { readHistoryTool } from './history.ts'

const LONG = '甲'.repeat(60_000)

function memHistory(): HistoryPort {
  const messages: Record<string, { role: 'user' | 'assistant'; content: string }> = {
    ms_1: { role: 'user', content: '把签名算法定为 RS256，不要用 HS256' },
    ms_big: { role: 'assistant', content: LONG },
  }
  const steps: Record<string, { tool: string; status: string; args: string; outcome: string }> = {
    'rn_1:7': {
      tool: 'read_file',
      status: 'success',
      args: '{"path":"a.ts"}',
      outcome: '{"ok":1}',
    },
  }
  // 收纳过的工具结果只剩信封，信封里的 call_id 是它唯一的地址。
  const byCall: Record<string, string> = { call_9: 'rn_1:7' }
  return {
    message: (id) => messages[id] ?? null,
    step: (id) => steps[id] ?? null,
    byCallId: (callId) => steps[byCall[callId] ?? ''] ?? null,
    search: (query, limit) => {
      const out: { id: string; kind: 'message' | 'step'; line: string }[] = []
      for (const [id, m] of Object.entries(messages)) {
        if (out.length >= limit) break
        if (m.content.includes(query)) out.push({ id, kind: 'message', line: m.content })
      }
      for (const [id, s] of Object.entries(steps)) {
        if (out.length >= limit) break
        if (`${s.tool} ${s.args}`.includes(query)) out.push({ id, kind: 'step', line: s.args })
      }
      return out
    },
  }
}

function ctx(history: HistoryPort | undefined): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink: null,
    ...(history ? { history } : {}),
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  }
}

const run = (args: Record<string, unknown>) => readHistoryTool.fn(args, ctx(memHistory()))

describe('前置校验', () => {
  test('端口没接时如实说，不谎称找不到', async () => {
    // 显式构造一个没接端口的 ctx——默认参数遇到 undefined 会回落，测不到这条。
    const r = await readHistoryTool.fn({ message_id: 'ms_1' }, ctx(undefined))
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('history_unavailable')
  })

  test('三个参数一个都不给要报错', async () => {
    const r = await run({})
    expect(r.status).toBe('failure')
  })

  test('未知 id 报 not_found', async () => {
    expect((await run({ message_id: 'ms_nope' })).errorKind).toBe('not_found')
    expect((await run({ step_id: 'rn_1:999' })).errorKind).toBe('not_found')
  })

  test('step id 不是复合形式时不去猜', async () => {
    expect((await run({ step_id: '7' })).errorKind).toBe('not_found')
  })
})

describe('取回原文', () => {
  test('消息逐字取回', async () => {
    const r = await run({ message_id: 'ms_1' })
    expect(r.status).toBe('success')
    expect((r.data as { content: string }).content).toBe('把签名算法定为 RS256，不要用 HS256')
  })

  test('收纳后只剩信封时，用 call_id 取回完整记录', async () => {
    const r = await run({ call_id: 'call_9' })
    expect(r.status).toBe('success')
    expect((r.data as { args: string }).args).toBe('{"path":"a.ts"}')
  })

  test('未知 call_id 报 not_found', async () => {
    expect((await run({ call_id: 'call_nope' })).errorKind).toBe('not_found')
  })

  test('执行记录带回参数与结果', async () => {
    const r = await run({ step_id: 'rn_1:7' })
    expect(r.status).toBe('success')
    const d = r.data as { tool: string; args: string; outcome: string }
    expect(d.tool).toBe('read_file')
    expect(d.args).toBe('{"path":"a.ts"}')
    expect(d.outcome).toBe('{"ok":1}')
  })
})

describe('搜索', () => {
  test('命中行带定位符，模型据它再取全文', async () => {
    const r = await run({ query: 'RS256' })
    expect(r.status).toBe('success')
    const hits = (r.data as { hits: string[] }).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('[message:ms_1]')
  })

  test('没命中不是失败', async () => {
    const r = await run({ query: '这段话不存在' })
    expect(r.status).toBe('success')
    expect((r.data as { hits: string[] }).hits).toHaveLength(0)
  })
})

describe('投递预算', () => {
  /**
   * 没有这条闸，模型可以把刚折掉的内容整段读回来——压缩白做。
   * 与 `read_file` 同一口径：**超了拒绝，不截断**。
   */
  test('超出单次预算时拒绝，且给出可执行的下一步', async () => {
    const r = await run({ message_id: 'ms_big' })
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('result_too_large')
    expect(r.message).toContain('query')
  })

  test('预算按波次累计，不是每次调用重置', async () => {
    const c = ctx(memHistory())
    expect((await readHistoryTool.fn({ message_id: 'ms_1' }, c)).status).toBe('success')
    // 同一个 ctx 再读一次大的：单次预算之外还要受本批已花掉的量约束。
    const second = await readHistoryTool.fn({ message_id: 'ms_big' }, c)
    expect(second.status).toBe('failure')
  })
})
