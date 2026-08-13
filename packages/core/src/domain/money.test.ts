/**
 * 金额显示。覆盖 `domain/model.ts` 里的 `formatMoney` / `formatCosts` / `CURRENCY_SYMBOL`。
 *
 * 这两个函数是**命令行和界面共用的那一份**。放在 core 而不是各写各的，
 * 就是为了避免「`qy usage` 说 $0.0001、面板说 $0.00」这种没人会报的 bug。
 * 所以这里锁的既是数字口径，也是「不跨币种相加」这条硬规矩。
 */

import { describe, expect, test } from 'bun:test'
import { CURRENCY_SYMBOL, formatCosts, formatMoney } from './model.ts'

describe('单币种', () => {
  test('币种决定符号', () => {
    expect(formatMoney(1.5, 'USD')).toBe('$1.50')
    expect(formatMoney(1.5, 'CNY')).toBe('¥1.50')
    expect(CURRENCY_SYMBOL.CNY).toBe('¥')
  })

  test('不传币种按美元', () => {
    expect(formatMoney(1.5)).toBe('$1.50')
  })

  /**
   * 小额必须看得见。真花了钱却显示 `$0.0000`，读起来就是「免费」——
   * 而「小到显示不出来」和「没有」是两回事。
   */
  test('小额不塌成 0', () => {
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(0.00001)).toBe('<$0.0001')
    expect(formatMoney(0.00001, 'CNY')).toBe('<¥0.0001')
    expect(formatMoney(0.0023)).toBe('$0.0023')
  })
})

describe('多币种', () => {
  /**
   * **这条是这个文件里最要紧的一条。**
   *
   * 把 ¥100 和 $20 加起来得到的 120 不是任何东西的金额，但它看起来是。
   * 合并需要汇率，而汇率天天变——落盘或显示的那一刻它就开始说谎。
   */
  test('两种币种分开列，不相加', () => {
    const s = formatCosts({ USD: 20, CNY: 100 })
    expect(s).toContain('$20.00')
    expect(s).toContain('¥100.00')
    expect(s).not.toBe('$120.00')
  })

  test('只有一种时就是那一种', () => {
    expect(formatCosts({ CNY: 3 })).toBe('¥3.00')
  })

  /** 空对象 = 这段区间确实没花钱，不是「不知道」，所以显示零而不是空白。 */
  test('空对象显示成零', () => {
    expect(formatCosts({})).toBe('$0.00')
  })

  /** 金额为 0 的币种不占位置——它只会让人以为那边也用过。 */
  test('零金额的币种不列出来', () => {
    expect(formatCosts({ USD: 1, CNY: 0 })).toBe('$1.00')
  })

  /** 顺序稳定：同一份数据每次刷新排列不同，读起来像是变了。 */
  test('顺序按币种码稳定', () => {
    expect(formatCosts({ USD: 1, CNY: 2 })).toBe(formatCosts({ CNY: 2, USD: 1 }))
  })
})
