/**
 * 覆盖范围：`history.ts` 的 `read_history`。
 *
 * 本工具与压缩配合：被折叠的原文始终保存在账本中，本工具负责把它交还给模型。
 * 因此本文件锁定三项行为：取回的是逐字原文；端口未接入时如实报告，而不是报告未找到；
 * 读取量受本次决策的投递额度约束，超出额度的部分存入正文库，由 `read_resource` 续读。
 */

import { describe, expect, test } from 'bun:test'
import {
  batchRemaining,
  type HistoryPort,
  type HistoryStep,
  openBatchBudget,
  type SinkPort,
  type ToolContext,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { readHistoryTool } from './history.ts'
import { MIN_DELIVERY_BYTES } from './sink.ts'

const LONG = '甲'.repeat(60_000)

function memHistory(): HistoryPort {
  const messages: Record<string, { role: 'user' | 'assistant'; content: string }> = {
    ms_1: { role: 'user', content: '把签名算法定为 RS256，不要用 HS256' },
    ms_big: { role: 'assistant', content: LONG },
  }
  const steps: Record<string, HistoryStep> = {
    'rn_1:7': {
      tool: 'read_file',
      status: 'success',
      args: '{"path":"a.ts"}',
      outcome: '{"ok":1}',
    },
    'rn_1:9': {
      tool: 'read_file',
      status: 'success',
      args: '{"path":"shot.png"}',
      outcome: '{"status":"success","message":"读取 shot.png（图片）"}',
      images: [{ data: 'QUJD', mime: 'image/png' }],
    },
  }
  // 已收纳的工具结果只剩信封，信封中的 call_id 是它唯一的定位标识。
  const byCall: Record<string, string> = { call_9: 'rn_1:7' }
  const child: HistoryPort = {
    message: (id) => (id === 'ms_c' ? { role: 'assistant', content: '子 agent 的产出' } : null),
    step: () => null,
    byCallId: () => null,
    search: (query) =>
      '子 agent 的产出'.includes(query)
        ? [{ id: 'ms_c', kind: 'message' as const, line: '子 agent 的产出' }]
        : [],
    forSubagent: () => null,
  }
  return {
    forSubagent: (id) => (id === 'cv_child' ? child : null),
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
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink: null,
    ...(history ? { history } : {}),
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

const run = (args: Record<string, unknown>) => readHistoryTool.fn(args, ctx(memHistory()))

describe('读取子 agent 的历史', () => {
  test('提供 subagent 时读取该子 agent 的会话', async () => {
    const r = await run({ subagent: 'cv_child', message_id: 'ms_c' })
    expect(r.status).toBe('success')
    expect((r.data as { content: string }).content).toBe('子 agent 的产出')
    const hits = await run({ subagent: 'cv_child', query: '产出' })
    expect((hits.data as { hits: string[] }).hits[0]).toContain('ms_c')
  })

  test('不属于本会话的子 agent id 被拒绝', async () => {
    const r = await run({ subagent: 'cv_other', message_id: 'ms_c' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('没有子 agent cv_other')
  })
})

describe('前置校验', () => {
  test('端口未接入时如实报告，不误报为未找到', async () => {
    // 显式构造未接入端口的 ctx：默认参数遇到 undefined 时会取默认值，无法覆盖该路径。
    const r = await readHistoryTool.fn({ message_id: 'ms_1' }, ctx(undefined))
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('history_unavailable')
  })

  test('未提供任何检索参数时报错', async () => {
    const r = await run({})
    expect(r.status).toBe('failure')
  })

  test('未知 id 报 not_found', async () => {
    expect((await run({ message_id: 'ms_nope' })).errorKind).toBe('not_found')
    expect((await run({ step_id: 'rn_1:999' })).errorKind).toBe('not_found')
  })

  test('step id 不是复合形式时不做推测', async () => {
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

  /** 被 `images_omitted` 信封替换的图片，按记录 id 取回的是读取时保存的同一份字节。 */
  test('带图片的执行记录把图片作为图像块返回，outcome 文本中不含字节', async () => {
    const r = await run({ step_id: 'rn_1:9' })
    expect(r.status).toBe('success')
    const d = r.data as { outcome: string; images: { data: string; mime: string }[] }
    expect(d.images).toEqual([{ data: 'QUJD', mime: 'image/png' }])
    expect(d.outcome).not.toContain('QUJD')
    expect(r.message).toContain('含图片')
  })

  test('执行记录返回参数与结果', async () => {
    const r = await run({ step_id: 'rn_1:7' })
    expect(r.status).toBe('success')
    const d = r.data as { tool: string; args: string; outcome: string }
    expect(d.tool).toBe('read_file')
    expect(d.args).toBe('{"path":"a.ts"}')
    expect(d.outcome).toBe('{"ok":1}')
  })
})

describe('搜索', () => {
  test('命中行带有定位符，模型据此取回全文', async () => {
    const r = await run({ query: 'RS256' })
    expect(r.status).toBe('success')
    const hits = (r.data as { hits: string[] }).hits
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('[message:ms_1]')
  })

  test('未命中不视为失败', async () => {
    const r = await run({ query: '这段话不存在' })
    expect(r.status).toBe('success')
    expect((r.data as { hits: string[] }).hits).toHaveLength(0)
  })
})

describe('投递额度', () => {
  function fakeSink(): SinkPort & { landed: Uint8Array[] } {
    const landed: Uint8Array[] = []
    return {
      landed,
      land(input) {
        landed.push(input.body)
        return { resourceId: `rs_${landed.length}`, contentHash: 'sha:x' }
      },
      read: () => null,
      stat: () => null,
    }
  }
  const budgeted = (room: number) => {
    const sink = fakeSink()
    const c = { ...ctx(memHistory()), sink }
    openBatchBudget(c.state, room)
    return { c, sink }
  }
  const contentOf = (r: { data?: Record<string, unknown> }) =>
    (r.data as { content: string }).content

  /**
   * 历史条目没有范围参数：超出额度时只返回提示，原文将无法完整读取。
   * 因此投递头部，完整原文保存一次，说明中给出 `read_resource` 的续读位置。
   */
  test('无法容纳时投递头部，完整原文存入正文库，给出续读位置', async () => {
    const { c, sink } = budgeted(5000)
    const r = await readHistoryTool.fn({ message_id: 'ms_big' }, c)
    expect(r.status).toBe('success')
    const head = contentOf(r)
    expect(LONG.startsWith(head)).toBe(true)
    expect(head.length).toBeLessThan(LONG.length)
    expect(new TextDecoder().decode(sink.landed[0]!)).toBe(LONG)
    expect(r.message).toContain('read_resource')
    expect(r.message).toContain(`offset=${new TextEncoder().encode(head).byteLength}`)
    expect(batchRemaining(c)).toBeLessThan(500)
  })

  test('额度按决策累计：同一决策中已读取的量从余额中扣除', async () => {
    const fresh = budgeted(5000)
    const alone = contentOf(await readHistoryTool.fn({ message_id: 'ms_big' }, fresh.c))

    const { c } = budgeted(5000)
    expect((await readHistoryTool.fn({ message_id: 'ms_1' }, c)).status).toBe('success')
    const after = contentOf(await readHistoryTool.fn({ message_id: 'ms_big' }, c))
    expect(after.length).toBeLessThan(alone.length)
  })

  /** 报告失败的回合不产出正文，模型会原样重试；余量为 0 时仍投递最小的一份，完整原文同样可续读。 */
  test('余额为 0 时仍投递最小的一份头部，完整原文存入正文库', async () => {
    const { c, sink } = budgeted(0)
    const r = await readHistoryTool.fn({ message_id: 'ms_big' }, c)
    expect(r.status).toBe('success')
    const head = contentOf(r)
    expect(head.length).toBeGreaterThan(0)
    expect(new TextEncoder().encode(head).byteLength).toBeLessThanOrEqual(MIN_DELIVERY_BYTES)
    expect(LONG.startsWith(head)).toBe(true)
    expect(new TextDecoder().decode(sink.landed[0]!)).toBe(LONG)
  })
})
