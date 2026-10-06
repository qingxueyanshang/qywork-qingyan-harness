/**
 * 投递额度与续读落盘。
 *
 * 覆盖范围：`delivery.ts` 的 `openBatchBudget` / `chargeBatchBudget` / `recordBatchSpent` /
 * `batchRemaining` / `outcomeTokens` / `tokensToBytes` / `landHead` / `continuationNote` /
 * `boundExecutedOutcome`。
 *
 * 本组测试锁定三项行为：一次决策只有一份额度，读取与已执行的结果从同一份额度中扣除；
 * 超出额度时正文不丢失，投递头部、完整内容可续读；已执行的结果不改报失败，
 * 超额的结构化数据整份存入正文库，而不是按字符串截断。
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_DENSITY, MEDIA_TOKENS } from '@qywork/ai'
import {
  batchRemaining,
  boundExecutedOutcome,
  chargeBatchBudget,
  continuationNote,
  deliveredTokens,
  deliveryCap,
  landHead,
  openBatchBudget,
  outcomeTokens,
  recordBatchSpent,
  tailRetain,
  tokensToBytes,
} from './delivery.ts'
import type { SinkPort } from './registry.ts'

/** 窗口取 0：尾部保留量为 0，单次上限等于余额，便于逐项核对账目。上限本身另有用例。 */
const ctx = (room: number) => ({
  state: openBatchBudget(new Map<string, unknown>(), room),
  contextWindow: 0,
})

function fakeSink(): SinkPort & { landed: Uint8Array[] } {
  const landed: Uint8Array[] = []
  return {
    landed,
    land(input) {
      landed.push(input.body)
      return { resourceId: `rs_${landed.length}`, contentHash: `sha:${landed.length}` }
    },
    read: () => null,
    stat: () => null,
  }
}

describe('一次决策一份额度', () => {
  test('未开账就调用属于装配错误，不提供默认额度', () => {
    expect(() => chargeBatchBudget({ state: new Map(), contextWindow: 0 }, 1)).toThrow(
      '投递额度未开账',
    )
  })

  /** 额度是请求余量，不是常数：1M 窗口下 31K 的读取在余量内即放行。 */
  test('额度内的读取放行并记账，额度外的拒绝且不记账', () => {
    const c = ctx(800_000)
    expect(chargeBatchBudget(c, 31_000)).toEqual({ ok: true, cap: 769_000 })
    expect(chargeBatchBudget(c, 800_000).ok).toBe(false)
    expect(batchRemaining(c)).toBe(769_000)
  })

  test('读取与已执行的用量从同一份额度中扣除', () => {
    const c = ctx(40_000)
    chargeBatchBudget(c, 10_000)
    recordBatchSpent(c, 10_000)
    expect(batchRemaining(c)).toBe(20_000)
  })

  test('已执行的用量如实累加，超过额度后余额报 0，随后的读取准入不使用虚假余额', () => {
    const c = ctx(6000)
    chargeBatchBudget(c, 4000)
    expect(recordBatchSpent(c, 4000).remaining).toBe(0)
    expect(chargeBatchBudget(c, 1).ok).toBe(false)
    openBatchBudget(c.state, 6000)
    expect(chargeBatchBudget(c, 100).ok).toBe(true)
  })

  test('负的余量按 0 开账', () => {
    expect(batchRemaining(ctx(-500))).toBe(0)
  })

  /**
   * 填满余额的结果在下一次压缩中是跨越保留量边界的单元，会被保留，
   * 下一次决策的额度为 0、续读无法推进。单次上限因此为下一次决策留出半份尾部保留量。
   */
  test('单次上限给下一次决策留出半份尾部保留量', () => {
    const c = { state: openBatchBudget(new Map<string, unknown>(), 25_000), contextWindow: 32_000 }
    expect(tailRetain(32_000)).toBe(8_000)
    expect(deliveryCap(c)).toBe(21_000)
    expect(chargeBatchBudget(c, 22_000).ok).toBe(false)
    expect(chargeBatchBudget(c, 21_000).ok).toBe(true)
  })

  test('余额不足一份保留量时，单次不超过半份保留量', () => {
    const c = { state: openBatchBudget(new Map<string, unknown>(), 6_000), contextWindow: 32_000 }
    expect(deliveryCap(c)).toBe(4_000)
    expect(deliveryCap({ ...c, state: openBatchBudget(new Map(), 3_000) })).toBe(3_000)
  })

  test('保留量按窗口比例计算，不设固定上限', () => {
    expect(tailRetain(1_000_000)).toBe(250_000)
    expect(tailRetain(200_000)).toBe(50_000)
  })
})

describe('结果的占用', () => {
  test('按写入 JSON 后的形式估算，每张图像按固定值计', () => {
    const image = { data: 'x'.repeat(100_000), mime: 'image/png' }
    const withImage = outcomeTokens(
      { message: '读取', data: { images: [image], note: 'a' } },
      DEFAULT_DENSITY,
    )
    const without = outcomeTokens({ message: '读取', data: { note: 'a' } }, DEFAULT_DENSITY)
    expect(withImage - without).toBe(MEDIA_TOKENS)
  })

  test('换行按转义后的形式计入', () => {
    const lines = 'a\n'.repeat(1000)
    expect(outcomeTokens({ message: lines }, DEFAULT_DENSITY)).toBeGreaterThan(
      deliveredTokens(lines, DEFAULT_DENSITY),
    )
  })

  test('额度换算出的字节数对中文与 ASCII 均不超出额度', () => {
    const bytes = tokensToBytes(1000, DEFAULT_DENSITY)
    const ascii = 'a'.repeat(bytes)
    const cjk = '中'.repeat(Math.floor(bytes / 3))
    expect(deliveredTokens(ascii, DEFAULT_DENSITY)).toBeLessThanOrEqual(1000)
    expect(deliveredTokens(cjk, DEFAULT_DENSITY)).toBeLessThanOrEqual(1000)
  })
})

describe('续读落盘', () => {
  const enc = new TextEncoder()
  const input = (body: string, budgetBytes: number) => ({
    toolName: 'read_history',
    sourceType: 'history:message',
    body: enc.encode(body),
    mimeType: 'text/plain',
    budgetBytes,
  })

  test('可整份容纳：不落盘，没有续读说明', () => {
    const sink = fakeSink()
    const head = landHead(sink, input('短正文', 1000))
    expect(head.text).toBe('短正文')
    expect(head.resource).toBeNull()
    expect(sink.landed).toHaveLength(0)
    expect(continuationNote(head)).toBe('')
  })

  test('无法容纳：头部在码点边界上结束，完整正文存一次，续读位置接在头部之后', () => {
    const sink = fakeSink()
    const body = '中文正文🙂'.repeat(100)
    const head = landHead(sink, input(body, 101))
    expect(body.startsWith(head.text)).toBe(true)
    expect(head.nextOffset).toBe(enc.encode(head.text).byteLength)
    expect(head.nextOffset).toBeLessThanOrEqual(101)
    expect(sink.landed).toHaveLength(1)
    expect(new TextDecoder().decode(sink.landed[0])).toBe(body)
    expect(head.resource?.coverage).toMatchObject({
      deliveredBytes: head.nextOffset,
      truncated: true,
    })
    expect(continuationNote(head)).toContain(`offset=${head.nextOffset}`)
  })

  test('没有 sink：照常投递头部，说明中写明其余部分不可续读', () => {
    const head = landHead(null, input('x'.repeat(500), 100))
    expect(head.text).toHaveLength(100)
    expect(head.resource).toBeNull()
    expect(continuationNote(head)).toContain('无法保存')
  })
})

describe('已执行结果按余额定稿', () => {
  const source = { toolName: 'mcp__srv__tool', sourceType: 'mcp' }

  test('可容纳：原样返回，按实际用量记账', () => {
    const c = { ...ctx(10_000), sink: fakeSink(), density: DEFAULT_DENSITY }
    const outcome = { status: 'success' as const, executed: true, message: '完成', data: { n: 1 } }
    expect(boundExecutedOutcome(c, outcome, source)).toBe(outcome)
    expect(batchRemaining(c)).toBe(10_000 - outcomeTokens(outcome, DEFAULT_DENSITY))
  })

  /** 结构化数据按字符串截断会得到非法 JSON：整份存入正文库，返回结果中保留地址。 */
  test('超额的结构化数据整份存入正文库，返回结果保持合法且大小有界', () => {
    const sink = fakeSink()
    const c = { ...ctx(2000), sink, density: DEFAULT_DENSITY }
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `行${i}` }))
    const r = boundExecutedOutcome(
      c,
      { status: 'success', executed: true, message: '查询完成', data: { rows } },
      source,
    )
    expect(r.status).toBe('success')
    expect(r.executed).toBe(true)
    expect(r.data).toBeUndefined()
    expect(JSON.parse(new TextDecoder().decode(sink.landed[0]!))).toEqual({ rows })
    expect(String(r.resources?.[0]?.resourceId)).toBe('rs_1')
    expect(r.message).toContain('rs_1')
    expect(outcomeTokens(r, DEFAULT_DENSITY)).toBeLessThanOrEqual(2000)
  })

  test('超额的正文投递头部，完整正文可续读，失败状态如实保留', () => {
    const sink = fakeSink()
    const c = { ...ctx(500), sink, density: DEFAULT_DENSITY }
    const text = `${'输出。'.repeat(5000)}尾部标记`
    const r = boundExecutedOutcome(
      c,
      { status: 'failure', executed: true, message: text, errorKind: 'mcp_tool_error' },
      source,
    )
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('mcp_tool_error')
    expect(new TextDecoder().decode(sink.landed[0])).toBe(text)
    expect(r.message).toContain('read_resource')
    expect(r.message.length).toBeLessThan(text.length)
  })
})
