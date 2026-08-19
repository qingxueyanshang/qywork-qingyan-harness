/**
 * 投递预算。
 *
 * 覆盖范围：`registry.ts` 的 `READ_DELIVERY_CAP` / `RESULT_BUDGET_RATIO` /
 * `BATCH_TO_CALL_RATIO` / `deliveryBudget` / `resetBatchBudget` / `chargeBatchBudget`。
 *
 * 这一组锁的是两件用户看得见的事：**一次工具调用不许吃掉大半个窗口**，
 * 以及**一波并行读取加起来也有上界**——后者同时是压缩的保留预算，
 * 「刚进来的那一波必然完整保留」靠它成立。
 */

import { describe, expect, test } from 'bun:test'
import {
  chargeBatchBudget,
  deliveryBudget,
  READ_DELIVERY_CAP,
  resetBatchBudget,
} from './registry.ts'

const ctx = (contextWindow: number) => ({ state: new Map<string, unknown>(), contextWindow })

describe('投递预算', () => {
  /**
   * 上限不是拍的：`read_file` 默认读 2000 行，约 20~25k token。
   * 预算必须容得下这个默认读法，否则工具描述里写的默认值就是假的。
   */
  test('200k 档的单次预算恰好容得下默认 2000 行', () => {
    const c = ctx(200_000)
    expect(deliveryBudget(200_000).perCall).toBe(25_000)
    expect(chargeBatchBudget(c, 24_000).ok).toBe(true)
  })

  /**
   * **大窗口不再按比例放大。** 承诺随产品定，跟着窗口走的话 1M 档单次就是 125K
   * ——一次读取吃掉八分之一个上下文。
   */
  test('1M 档收在承诺上限，不随窗口线性放大', () => {
    expect(deliveryBudget(1_000_000).perCall).toBe(READ_DELIVERY_CAP)
    expect(chargeBatchBudget(ctx(1_000_000), 100_000).ok).toBe(false)
  })

  /** 小窗口下窗口份额才是那个更小的界：32K 档单次只有 4000。 */
  test('小窗口下按窗口份额收紧', () => {
    expect(deliveryBudget(32_000).perCall).toBe(4000)
    expect(chargeBatchBudget(ctx(32_000), 5000).ok).toBe(false)
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
   * **限单次没有上界。** 一波五个 read_file 各自都在单次预算以内，
   * 加起来就是五份——批级预算就是为这个存在的。
   */
  test('批级累计有上界：一波连读会在超出两倍单次预算时被拦下', () => {
    const c = ctx(200_000)
    expect(deliveryBudget(200_000).batchCap).toBe(50_000)
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
