/**
 * 金额显示。覆盖 `domain/model.ts` 中的 `formatMoney` / `formatCosts` / `CURRENCY_SYMBOL`。
 *
 * 这两个函数由命令行与界面共用。放在 core 而不是各自实现，
 * 是为了避免「`qy usage` 显示 $0.0001、面板显示 $0.00」这类难以被报告的缺陷。
 * 因此本文件锁定的既是数字格式，也是「不跨币种相加」这条规则。
 */

import { describe, expect, test } from 'bun:test'
import { CURRENCY_SYMBOL, formatCosts, formatMoney } from './model.ts'

describe('单币种', () => {
  test('币种决定符号', () => {
    expect(formatMoney(1.5, 'USD')).toBe('$1.50')
    expect(formatMoney(1.5, 'CNY')).toBe('¥1.50')
    expect(CURRENCY_SYMBOL.CNY).toBe('¥')
  })

  test('未传入币种时按美元', () => {
    expect(formatMoney(1.5)).toBe('$1.50')
  })

  /**
   * 小额必须可见。实际产生费用却显示 `$0.0000`，会被理解为免费；
   * 「金额过小无法显示」与「没有费用」是不同的情况。
   */
  test('小额不显示为 0', () => {
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(0.00001)).toBe('<$0.0001')
    expect(formatMoney(0.00001, 'CNY')).toBe('<¥0.0001')
    expect(formatMoney(0.0023)).toBe('$0.0023')
  })
})

describe('多币种', () => {
  test('集梦影币独立展示，不混入人民币或美元', () => {
    expect(formatMoney(440, 'BINGUO_CREDIT')).toBe('440 影币')
    expect(formatCosts({ BINGUO_CREDIT: 440, CNY: 2, USD: 3 })).toBe('440 影币 + ¥2.00 + $3.00')
  })
  /**
   * 本文件中最重要的一条测试。
   *
   * ¥100 与 $20 相加得到的 120 不是任何币种的金额，但形式上像是金额。
   * 合并需要汇率，而汇率每天变化，落盘或显示时该数值即不再成立。
   */
  test('两种币种分开列出，不相加', () => {
    const s = formatCosts({ USD: 20, CNY: 100 })
    expect(s).toContain('$20.00')
    expect(s).toContain('¥100.00')
    expect(s).not.toBe('$120.00')
  })

  test('只有一种币种时只显示该币种', () => {
    expect(formatCosts({ CNY: 3 })).toBe('¥3.00')
  })

  /** 空对象表示该区间确实没有费用，而不是金额未知，因此显示零而不是空白。 */
  test('空对象显示为零', () => {
    expect(formatCosts({})).toBe('$0.00')
  })

  /** 金额为 0 的币种不列出：列出时会被理解为该币种也产生过费用。 */
  test('零金额的币种不列出', () => {
    expect(formatCosts({ USD: 1, CNY: 0 })).toBe('$1.00')
  })

  /** 顺序稳定：同一份数据每次刷新排列不同时，会被误认为数据发生了变化。 */
  test('顺序按币种码稳定', () => {
    expect(formatCosts({ USD: 1, CNY: 2 })).toBe(formatCosts({ CNY: 2, USD: 1 }))
  })
})
