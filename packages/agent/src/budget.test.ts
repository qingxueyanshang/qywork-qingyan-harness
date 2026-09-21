/**
 * 投递预算。
 *
 * 覆盖范围：`registry.ts` 的 `READ_DELIVERY_CAP` / `RESULT_BUDGET_RATIO` /
 * `BATCH_TO_CALL_RATIO` / `deliveryBudget` / `resetBatchBudget` / `chargeBatchBudget` /
 * `recordBatchSpent`。
 *
 * 这一组锁的是两件用户看得见的事：**一次工具调用不许占掉大半个窗口**，
 * 以及**一波并行读取加起来也有上界**——后者同时是压缩的保留预算，
 * 「刚进来的那一波必然完整保留」靠它成立。
 */

import { describe, expect, test } from 'bun:test'
import {
  chargeBatchBudget,
  deliveryBudget,
  READ_DELIVERY_CAP,
  recordBatchSpent,
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
   * ——一次读取占掉八分之一个上下文。
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
    // 拒掉的那次不记账——否则一次失败会消耗本批额度。
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

/**
 * 已经投出去的量走这一条：副作用发生过的工具没有「不投」这个选项，
 * 唯一正确的做法是把真实用量记进同一份计数。
 */
describe('已投递用量', () => {
  /** 32K 档单次 4000、整波 8000。先用掉 6000，余额 2000。 */
  const spent6000 = () => {
    const c = ctx(32_000)
    chargeBatchBudget(c, 4000)
    chargeBatchBudget(c, 2000)
    expect(chargeBatchBudget(c, 0).batchRemaining).toBe(2000)
    return c
  }

  test('余额 2000 时投 4000：照实累加，余额报 0', () => {
    const c = spent6000()
    expect(recordBatchSpent(c, 4000).batchRemaining).toBe(0)
    expect(chargeBatchBudget(c, 0).batchRemaining).toBe(0)
  })

  test('累计值不截回上限，随后的读取准入不使用假余额', () => {
    const c = spent6000()
    recordBatchSpent(c, 4000)
    // 截回上限的话这一笔会被放行：8000 - 8000 + 100 仍在界内。
    expect(chargeBatchBudget(c, 100).ok).toBe(false)
    resetBatchBudget(c.state)
    expect(chargeBatchBudget(c, 100).ok).toBe(true)
  })

  test('准入通过的那一笔与已投递走同一份计数', () => {
    const c = ctx(200_000)
    chargeBatchBudget(c, 10_000)
    recordBatchSpent(c, 10_000)
    expect(chargeBatchBudget(c, 0).batchRemaining).toBe(30_000)
  })
})
