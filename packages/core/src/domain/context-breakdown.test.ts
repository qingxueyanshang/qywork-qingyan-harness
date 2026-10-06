/**
 * 分组占用的对账。覆盖 `domain/model.ts` 中的 `reconcileBreakdown` 与 `emptyBreakdown`。
 *
 * 该函数唯一的约定是**各分组之和恒等于总数**：面板上各行之和与
 * 标题中的总数不一致时，用户无法判断差额的去向。
 */

import { describe, expect, test } from 'bun:test'
import {
  CONTEXT_GROUPS,
  type ContextBreakdown,
  emptyBreakdown,
  reconcileBreakdown,
} from './model.ts'

function sum(b: ContextBreakdown): number {
  return Object.values(b).reduce((n, v) => n + v, 0)
}

function make(parts: Partial<ContextBreakdown>): ContextBreakdown {
  return { ...emptyBreakdown(), ...parts }
}

/** 固定类目 8.8k、可变类目 361k，取自实测会话 cv_0mt2wpe4o0000pfxnb6。 */
const REAL = make({
  systemPrompt: 1_400,
  systemTools: 7_100,
  workspaceState: 345,
  historyMessages: 301,
  executionRecords: 230_900,
  intermediateContent: 168_882,
})

describe('分组对账', () => {
  test('真值高于估算：差额计入可变桶，固定类目保持不变', () => {
    const out = reconcileBreakdown(REAL, 680_145)

    expect(sum(out)).toBe(680_145)
    expect(out.systemPrompt).toBe(REAL.systemPrompt)
    expect(out.systemTools).toBe(REAL.systemTools)
    expect(out.workspaceState).toBe(REAL.workspaceState)
    expect(out.executionRecords).toBeGreaterThan(REAL.executionRecords)
    expect(out.intermediateContent).toBeGreaterThan(REAL.intermediateContent)
  })

  test('真值低于估算：可变桶缩减，固定类目仍保持不变', () => {
    const out = reconcileBreakdown(REAL, 300_000)

    expect(sum(out)).toBe(300_000)
    expect(out.systemTools).toBe(REAL.systemTools)
    expect(out.executionRecords).toBeLessThan(REAL.executionRecords)
  })

  /**
   * 回归测试：**可变桶无法吸收的负差额不得被截断丢弃**。
   *
   * 复现形状：会话刚开始运行，固定类目（主要是工具 schema）的估算高于 provider 真值。
   * 对每个桶套用 `Math.max(0, …)` 时，三个可变桶清零之后剩余的负差额会丢失：
   * 真值 50、各行合计 89，而本函数的作用正是使这两个数相等。
   */
  test('真值不足以容纳固定类目时，缩减固定类目而不丢弃差额', () => {
    const tiny = make({
      systemPrompt: 1,
      systemTools: 88,
      executionRecords: 23,
      intermediateContent: 18,
    })
    const out = reconcileBreakdown(tiny, 50)

    expect(sum(out)).toBe(50)
    // 先缩减可变桶。
    expect(out.executionRecords).toBe(0)
    expect(out.intermediateContent).toBe(0)
    // 固定类目按占比缩减，而不是清零。
    expect(out.systemTools).toBeGreaterThan(0)
  })

  test('总数为零时全部归零，不留余值', () => {
    expect(sum(reconcileBreakdown(REAL, 0))).toBe(0)
  })

  test('尚未执行过工具的新会话：可变桶全为零，其余全部归入历史消息', () => {
    const fresh = make({ systemPrompt: 1_400, systemTools: 7_100 })
    const out = reconcileBreakdown(fresh, 20_000)

    expect(sum(out)).toBe(20_000)
    expect(out.historyMessages).toBe(20_000 - 8_500)
    expect(out.systemTools).toBe(7_100)
  })

  test('已经相等时原样返回', () => {
    expect(reconcileBreakdown(REAL, sum(REAL))).toEqual(REAL)
  })

  /** 桶集必须与协议完全一致：多出或缺少一个都说明出现了第二套定义。 */
  test('无论如何分摊，键集不变', () => {
    for (const total of [0, 1, 50, 8_000, 300_000, 680_145, 1_000_000]) {
      const out = reconcileBreakdown(REAL, total)
      expect(Object.keys(out).sort()).toEqual([...CONTEXT_GROUPS].sort())
      expect(sum(out)).toBe(total)
      expect(Object.values(out).every((v) => v >= 0)).toBe(true)
    }
  })
})
