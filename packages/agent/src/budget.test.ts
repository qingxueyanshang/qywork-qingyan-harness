/**
 * 投递预算。
 *
 * 覆盖范围：`registry.ts` 的 `RESULT_BUDGET_RATIO` / `BATCH_BUDGET_RATIO` /
 * `resetBatchBudget` / `chargeBatchBudget`。
 *
 * 这一组锁的是两件用户看得见的事：**一次工具调用不许吃掉大半个窗口**，
 * 以及**一波并行读取加起来也有上界**——后者是「压缩只留发送前检查一个入口」
 * 能成立的前提，没有它两次检查之间的跳变就没有上界。
 */

import { describe, expect, test } from 'bun:test'
import {
  BATCH_BUDGET_RATIO,
  chargeBatchBudget,
  RESULT_BUDGET_RATIO,
  resetBatchBudget,
} from './registry.ts'

const ctx = (contextWindow: number) => ({ state: new Map<string, unknown>(), contextWindow })

describe('投递预算', () => {
  /**
   * 比例不是拍的：`read_file` 默认读 2000 行，约 20~25k token。
   * 预算必须容得下这个默认读法，否则工具描述里写的默认值就是假的。
   * 200k 窗口的 1/8 恰好是 25k。
   */
  test('随窗口走：200k 窗口的单次预算恰好容得下默认 2000 行', () => {
    const c = ctx(200_000)
    expect(Math.floor(200_000 * RESULT_BUDGET_RATIO)).toBe(25_000)
    expect(chargeBatchBudget(c, 24_000).ok).toBe(true)
  })

  test('大窗口给更多，不是一个固定常数', () => {
    expect(chargeBatchBudget(ctx(1_000_000), 100_000).ok).toBe(true)
    expect(chargeBatchBudget(ctx(200_000), 100_000).ok).toBe(false)
  })

  test('单次超预算直接拒，并把剩余额度报回去', () => {
    const c = ctx(200_000)
    const r = chargeBatchBudget(c, 30_000)
    expect(r.ok).toBe(false)
    expect(r.perCall).toBe(25_000)
    // 拒掉的那次不记账——否则一次失败会白白吃掉本批额度。
    expect(chargeBatchBudget(c, 1000).ok).toBe(true)
  })

  /**
   * **限单次没有上界。** 一波五个 read_file 各自都在 1/8 以内，
   * 加起来就是 5/8——批级预算就是为这个存在的。
   */
  test('批级累计有上界：一波连读会在超出 1/4 时被拦下', () => {
    const c = ctx(200_000)
    expect(Math.floor(200_000 * BATCH_BUDGET_RATIO)).toBe(50_000)
    expect(chargeBatchBudget(c, 24_000).ok).toBe(true)
    expect(chargeBatchBudget(c, 24_000).ok).toBe(true)
    // 第三个在单次预算内，但本批已经用掉 48k，只剩 2k。
    const third = chargeBatchBudget(c, 24_000)
    expect(third.ok).toBe(false)
    expect(third.batchRemaining).toBe(2000)
  })

  test('新波次清零，上一波的用量不拖累这一波', () => {
    const c = ctx(200_000)
    chargeBatchBudget(c, 24_000)
    chargeBatchBudget(c, 24_000)
    resetBatchBudget(c.state)
    expect(chargeBatchBudget(c, 24_000).ok).toBe(true)
  })
})
