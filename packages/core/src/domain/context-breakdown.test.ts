/**
 * 分组占用的对账。覆盖 `domain/model.ts` 里的 `reconcileBreakdown` 与 `emptyBreakdown`。
 *
 * 这个函数唯一的承诺是**各分组之和恒等于总数**——面板上「各行加起来」与
 * 「标题上那个数」对不上时，用户没有任何办法判断差额去了哪儿。
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
  test('真值高于估算：差额进可变桶，固定类目一个字不动', () => {
    const out = reconcileBreakdown(REAL, 680_145)

    expect(sum(out)).toBe(680_145)
    expect(out.systemPrompt).toBe(REAL.systemPrompt)
    expect(out.systemTools).toBe(REAL.systemTools)
    expect(out.workspaceState).toBe(REAL.workspaceState)
    expect(out.executionRecords).toBeGreaterThan(REAL.executionRecords)
    expect(out.intermediateContent).toBeGreaterThan(REAL.intermediateContent)
  })

  test('真值低于估算：可变桶缩，固定类目仍不动', () => {
    const out = reconcileBreakdown(REAL, 300_000)

    expect(sum(out)).toBe(300_000)
    expect(out.systemTools).toBe(REAL.systemTools)
    expect(out.executionRecords).toBeLessThan(REAL.executionRecords)
  })

  /**
   * 回归测试：**可变桶吸不下的负差额不许被钳掉**。
   *
   * 复现形状：会话刚开跑，固定类目（主要是工具 schema）的估算比 provider 真值还高。
   * 早先的写法给每个桶套 `Math.max(0, …)`，三个可变桶清零之后剩下的负差额就凭空
   * 消失了——真值 50、各行加起来 89，而这个函数的全部意义就是让这两个数相等。
   */
  test('真值连固定类目都装不下时，缩固定类目而不是把差额丢掉', () => {
    const tiny = make({
      systemPrompt: 1,
      systemTools: 88,
      executionRecords: 23,
      intermediateContent: 18,
    })
    const out = reconcileBreakdown(tiny, 50)

    expect(sum(out)).toBe(50)
    // 可变桶让位在先。
    expect(out.executionRecords).toBe(0)
    expect(out.intermediateContent).toBe(0)
    // 固定类目按占比缩，不是清零。
    expect(out.systemTools).toBeGreaterThan(0)
  })

  test('总数为零时全归零，不留残值', () => {
    expect(sum(reconcileBreakdown(REAL, 0))).toBe(0)
  })

  test('还没跑过工具的新会话：可变桶全零，整块给历史消息', () => {
    const fresh = make({ systemPrompt: 1_400, systemTools: 7_100 })
    const out = reconcileBreakdown(fresh, 20_000)

    expect(sum(out)).toBe(20_000)
    expect(out.historyMessages).toBe(20_000 - 8_500)
    expect(out.systemTools).toBe(7_100)
  })

  test('已经相等时原样返回', () => {
    expect(reconcileBreakdown(REAL, sum(REAL))).toEqual(REAL)
  })

  /** 桶集必须与协议恒等：多一个少一个都说明有人又另立了一套。 */
  test('无论怎么摊，键集不变', () => {
    for (const total of [0, 1, 50, 8_000, 300_000, 680_145, 1_000_000]) {
      const out = reconcileBreakdown(REAL, total)
      expect(Object.keys(out).sort()).toEqual([...CONTEXT_GROUPS].sort())
      expect(sum(out)).toBe(total)
      expect(Object.values(out).every((v) => v >= 0)).toBe(true)
    }
  })
})
