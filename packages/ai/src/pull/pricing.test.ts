/**
 * 覆盖 `expression.ts`（计费公式求值）与 `pricing.ts`（New API 价格折算）。
 * 站点与计费条目为合成数据：充值价 7.3（人民币计价），系数取能整除的值，期望值按折算规则逐项写出。
 */

import { describe, expect, test } from 'bun:test'
import { compileBilling, UnsupportedBilling } from './expression.ts'
import {
  chatPriceOf,
  imagePriceOf,
  type NewApiPricingEntry,
  priceBasis,
  quotaAmount,
  videoPriceOf,
} from './pricing.ts'

/** 三个分组：`default` 原价，`video` 2.5 倍，`chat` 1.3 倍。 */
const basis = priceBasis({ group_ratio: { default: 1, video: 2.5, chat: 1.3 } }, { price: 7.3 })

const entry = (fields: Omit<NewApiPricingEntry, 'model_name'>): NewApiPricingEntry => ({
  model_name: 'model-a',
  enable_groups: ['default'],
  ...fields,
})

/** 按北京时间计价的对话公式：周末全天与工作日 0:00–9:00、12:00–14:00、18:00–24:00 五折。 */
const OFF_PEAK =
  '(tier("peak", p * 0.1 + c * 0.4 + cr * 0.002)) * (weekday("Asia/Shanghai") >= 6 || weekday("Asia/Shanghai") < 1 ? 0.5 : 1) * (weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") < 6 && (hour("Asia/Shanghai") >= 18 || hour("Asia/Shanghai") < 9) ? 0.5 : 1) * (weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") < 6 && hour("Asia/Shanghai") >= 12 && hour("Asia/Shanghai") < 14 ? 0.5 : 1)'

describe('计费公式', () => {
  test('三元只对选中的分支求值', () => {
    const run = compileBilling('len < 10 ? tier("a", p * 2) : sqrt(p)')
    expect(run({ p: 3, len: 0 })).toBe(6)
    expect(() => run({ p: 3, len: 20 })).toThrow(UnsupportedBilling)
  })

  test('u() 取计量，字符串比较', () => {
    const run = compileBilling(
      'u("size") == "854x480" ? tier("480P", u("seconds") * 2) : tier("720P", u("seconds") * 3)',
    )
    expect(run({}, { size: '854x480', seconds: 5 })).toBe(10)
    expect(run({}, { size: '1280x720', seconds: 5 })).toBe(15)
  })

  test('weekday 与 hour 按给定时刻在该时区取值', () => {
    const run = compileBilling('weekday("Asia/Shanghai") * 100 + hour("Asia/Shanghai")')
    // 2026-01-04 20:00 UTC 是北京时间周一 04:00。
    expect(run({}, {}, Date.UTC(2026, 0, 4, 20))).toBe(104)
    expect(() => run({})).toThrow(UnsupportedBilling)
    expect(() => compileBilling('hour("Mars/Base")')({}, {}, 0)).toThrow(UnsupportedBilling)
  })

  test('未给出的变量与函数不支持', () => {
    expect(() => compileBilling('q * 2')({})).toThrow(UnsupportedBilling)
    expect(() => compileBilling('minute("Asia/Shanghai")')({}, {}, 0)).toThrow(UnsupportedBilling)
    expect(() => compileBilling('1 +')).toThrow(UnsupportedBilling)
  })
})

describe('价格折算', () => {
  test('站点按充值价折算为人民币', () => {
    expect(basis).toMatchObject({ rate: 7.3, currency: 'CNY' })
    expect(priceBasis({}, undefined)).toMatchObject({ rate: 1, currency: 'USD' })
  })

  test('视频：按秒与按次的固定价格', () => {
    const tiers = { '720p': {} }
    expect(
      videoPriceOf(
        entry({ quota_type: 2, model_price: 0.1, billing_mode: 'per_second' }),
        basis,
        [5, 30],
        tiers,
      ),
    ).toEqual({ per: 'second', amount: 0.73, currency: 'CNY' })
    expect(videoPriceOf(entry({ quota_type: 1, model_price: 1 }), basis, [4, 30], tiers)).toEqual({
      per: 'request',
      amount: 7.3,
      currency: 'CNY',
    })
  })

  test('视频公式计费：按次、按秒、按分辨率分档', () => {
    const formula = (billing_expr: string) =>
      entry({ quota_type: 1, enable_groups: ['video'], billing_mode: 'tiered_expr', billing_expr })
    const sizes = { '720p': { size: ['1280x720', '720x1280'] } }
    expect(videoPriceOf(formula('tier("per-request", 2 / 7.3)'), basis, [30], sizes)).toEqual({
      per: 'request',
      amount: 5,
      currency: 'CNY',
    })
    expect(videoPriceOf(formula('u("seconds") * 0.2 / 7.3'), basis, [5, 6, 30], sizes)).toEqual({
      per: 'second',
      amount: 0.5,
      currency: 'CNY',
    })
    // 480P 与 720P 每秒单价不同，按档位分别保存。
    const tiered = formula(
      'u("size") == "854x480" ? tier("480P", u("seconds") * 0.02) : u("size") == "480x854" ? tier("480P", u("seconds") * 0.02) : tier("720P", u("seconds") * 0.04)',
    )
    const both = {
      '480p': { size: ['854x480', '480x854'] },
      '720p': { size: ['1280x720', '720x1280'] },
    }
    expect(videoPriceOf(tiered, basis, [4, 30], both)).toEqual({
      per: 'second',
      amount: { '480p': 0.365, '720p': 0.73 },
      currency: 'CNY',
    })
    // 同一档位内单价不一致时价格不明。
    expect(
      videoPriceOf(tiered, basis, [4, 30], { '720p': { size: ['854x480', '1280x720'] } }),
    ).toBeUndefined()
  })

  test('对话：公式与倍率两种计费', () => {
    expect(
      chatPriceOf(
        entry({
          quota_type: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * 0.2 + c * 1 + cr * 0.02 + cc * 0.25)',
        }),
        basis,
      ),
    ).toEqual({ input: 1.46, output: 7.3, cacheRead: 0.146, cacheWrite: 1.825, currency: 'CNY' })
    expect(
      chatPriceOf(
        entry({
          quota_type: 0,
          model_ratio: 0.05,
          completion_ratio: 5,
          cache_ratio: 0.1,
          enable_groups: ['chat'],
        }),
        basis,
      ),
    ).toMatchObject({ input: 0.949, output: 4.745, cacheRead: 0.0949 })
    // 长上下文档只取基础档。
    expect(
      chatPriceOf(
        entry({
          quota_type: 0,
          billing_mode: 'tiered_expr',
          billing_expr:
            'len < 272000 ? tier("base", p * 0.2 + c * 1.2) : tier("long_context", p * 0.4 + c * 2.4)',
        }),
        basis,
      )?.input,
    ).toBe(1.46)
  })

  test('对话：按时段打折的公式折算为高峰价与 UTC 高峰时段', () => {
    // 高峰为北京时间周一至周五 9:00–12:00、14:00–18:00，即 UTC 1:00–4:00、6:00–10:00。
    expect(
      chatPriceOf(
        entry({ quota_type: 0, billing_mode: 'tiered_expr', billing_expr: OFF_PEAK }),
        basis,
      ),
    ).toEqual({
      input: 0.73,
      output: 2.92,
      cacheRead: 0.0146,
      cacheWrite: 0,
      currency: 'CNY',
      offPeak: {
        rate: 0.5,
        peakWindowsUtc: [
          [1, 4],
          [6, 10],
        ],
        peakWeekdaysUtc: [1, 2, 3, 4, 5],
      },
    })
  })

  test('对话：无法用一组折扣表示的时段计价，价格不明', () => {
    const priced = (billing_expr: string) =>
      chatPriceOf(entry({ quota_type: 0, billing_mode: 'tiered_expr', billing_expr }), basis)
    // 两档折扣。
    expect(priced('p * (hour("UTC") < 8 ? 0.5 : hour("UTC") < 16 ? 0.8 : 1)')).toBeUndefined()
    // 只有周一有高峰时可以表示；周一与周二的高峰时段不同时无法表示。
    expect(priced('p * (weekday("UTC") == 1 && hour("UTC") < 8 ? 1 : 0.5)')?.offPeak).toEqual({
      rate: 0.5,
      peakWindowsUtc: [[0, 8]],
      peakWeekdaysUtc: [1],
    })
    expect(
      priced(
        'p * ((weekday("UTC") == 1 && hour("UTC") < 8) || (weekday("UTC") == 2 && hour("UTC") >= 8) ? 1 : 0.5)',
      ),
    ).toBeUndefined()
    // 夏令时使一月与七月的 UTC 时段不同。
    expect(priced('p * (hour("America/New_York") < 9 ? 0.5 : 1)')).toBeUndefined()
    // 半小时偏移的时区按 15 分钟采样，换档时刻落在 UTC 半点。
    expect(
      priced('p * (hour("Asia/Kolkata") >= 9 && hour("Asia/Kolkata") < 18 ? 1 : 0.5)')?.offPeak,
    ).toEqual({
      rate: 0.5,
      peakWindowsUtc: [[3.5, 12.5]],
      peakWeekdaysUtc: [0, 1, 2, 3, 4, 5, 6],
    })
  })

  test('图像：按次与按分辨率分档的每张价格', () => {
    expect(
      imagePriceOf(entry({ quota_type: 1, model_price: 0.01 }), basis, ['1K', '2K', '4K']),
    ).toEqual({ per: 'request', amount: 0.073, currency: 'CNY' })
    const tiered = entry({
      quota_type: 1,
      billing_mode: 'tiered_expr',
      billing_expr:
        'u("resolution") == "1K" ? tier("1K", u("n") * 0.02) : u("resolution") == "2K" ? tier("2K", u("n") * 0.03) : tier("4K", u("n") * 0.03)',
    })
    expect(imagePriceOf(tiered, basis, ['1K', '2K', '4K'])).toEqual({
      per: 'request',
      amount: { '1K': 0.146, '2K': 0.219, '4K': 0.219 },
      currency: 'CNY',
    })
  })

  test('任务记录中的扣费额度按站点状态折算', () => {
    const status = { price: 7.3, quota_per_unit: 500000 }
    expect(quotaAmount(256849, status)).toEqual({ amount: 3.75, currency: 'CNY' })
    expect(quotaAmount(513699, status)).toEqual({ amount: 7.5, currency: 'CNY' })
    expect(quotaAmount(547945, status)).toEqual({ amount: 8, currency: 'CNY' })
    expect(quotaAmount(500000, { quota_per_unit: 500000 })).toEqual({ amount: 1, currency: 'USD' })
    expect(quotaAmount(256849, { price: 7.3 })).toBeUndefined()
  })

  test('可见分组倍率不一致时价格不明', () => {
    const groups = { ...basis, groupRatio: { a: 1, b: 2 } }
    const ratio = (enable_groups: string[]) =>
      chatPriceOf(entry({ quota_type: 0, model_ratio: 0.3, enable_groups }), groups)
    expect(ratio(['a', 'b'])).toBeUndefined()
    expect(ratio(['a', 'c'])?.input).toBeGreaterThan(0)
  })
})
