/**
 * 覆盖 `expression.ts`（计费公式求值）与 `pricing.ts`（New API 价格折算）。
 * 数据是 2026-10-21 从 hongcheng 与木木公开接口取得的响应片段（`../fixtures/newapi-*.json`），
 * 期望值与渠道说明中写明的价格逐项一致。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileBilling, UnsupportedBilling } from './expression.ts'
import {
  chatPriceOf,
  imagePriceOf,
  type NewApiPricingEntry,
  priceBasis,
  quotaAmount,
  videoPriceOf,
} from './pricing.ts'

interface Site {
  pricing: { group_ratio: Record<string, number>; data: NewApiPricingEntry[] }
  status: { data: { price: number } }
}
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '../fixtures', name), 'utf8')) as Site
const hongcheng = fixture('newapi-hongcheng.json')
const mumugofe = fixture('newapi-mumugofe.json')

const entry = (site: Site, id: string) =>
  site.pricing.data.find((e) => e.model_name === id) as NewApiPricingEntry
const hc = priceBasis(hongcheng.pricing, hongcheng.status.data)
const mm = priceBasis(mumugofe.pricing, mumugofe.status.data)

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
    expect(hc).toMatchObject({ rate: 7.3, currency: 'CNY' })
    expect(priceBasis({}, undefined)).toMatchObject({ rate: 1, currency: 'USD' })
  })

  test('hongcheng 按秒与按次', () => {
    const tiers = { '720p': {} }
    expect(videoPriceOf(entry(hongcheng, 'TTseadanco2.5-720'), hc, [5, 30], tiers)).toEqual({
      per: 'second',
      amount: 0.42,
      currency: 'CNY',
    })
    expect(videoPriceOf(entry(hongcheng, 'GGseadanco2.5/720'), hc, [5], tiers)?.amount).toBe(0.54)
    expect(videoPriceOf(entry(hongcheng, 'seedance-2.5-yy-720p'), hc, [4, 30], tiers)).toEqual({
      per: 'request',
      amount: 7.3,
      currency: 'CNY',
    })
  })

  test('木木公式计费：按次、按秒、按分辨率分档', () => {
    const sizes = { '720p': { size: ['1280x720', '720x1280'] } }
    expect(videoPriceOf(entry(mumugofe, 'X-SD25-301010'), mm, [30], sizes)).toEqual({
      per: 'request',
      amount: 7,
      currency: 'CNY',
    })
    expect(
      videoPriceOf(entry(mumugofe, '007系列/sd2.5(30图10音/4-30秒/720P)'), mm, [4, 5, 30], sizes)
        ?.amount,
    ).toBe(6)
    expect(videoPriceOf(entry(mumugofe, 'seedance-2.5-deal'), mm, [5, 6, 30], sizes)).toEqual({
      per: 'second',
      amount: 0.7,
      currency: 'CNY',
    })
    // 480P 与 720P 每秒单价不同，按档位分别保存。
    const tiered = entry(mumugofe, '007系列/sd2.5(30图10音/480P/720P)')
    const both = {
      '480p': { size: ['854x480', '480x854'] },
      '720p': { size: ['1280x720', '720x1280'] },
    }
    expect(videoPriceOf(tiered, mm, [4, 30], both)).toEqual({
      per: 'second',
      amount: { '480p': 0.4, '720p': 0.6 },
      currency: 'CNY',
    })
    // 同一档位内单价不一致时价格不明。
    expect(
      videoPriceOf(tiered, mm, [4, 30], { '720p': { size: ['854x480', '1280x720'] } }),
    ).toBeUndefined()
  })

  test('对话：公式与倍率两种计费', () => {
    expect(chatPriceOf(entry(mumugofe, 'claude-sonnet-5-5'), mm)).toEqual({
      input: 1.8,
      output: 9,
      cacheRead: 0.18,
      cacheWrite: 2.25,
      currency: 'CNY',
    })
    expect(chatPriceOf(entry(mumugofe, 'gemini-3.8-flash'), mm)).toMatchObject({
      input: 0.34125,
      output: 1.70625,
    })
    // 长上下文档只取基础档。
    expect(chatPriceOf(entry(mumugofe, 'gpt-5.6-sol'), mm)?.input).toBe(2.08)
  })

  test('对话：按时段打折的公式折算为高峰价与 UTC 高峰时段', () => {
    // 渠道说明：常规时段输入 1.04 元、输出 4.16 元、缓存读取 0.0208 元，优惠时段五折；
    // 高峰为北京时间周一至周五 9:00–12:00、14:00–18:00，即 UTC 1:00–4:00、6:00–10:00。
    expect(chatPriceOf(entry(mumugofe, 'deepseek-v4.1-flash'), mm)).toEqual({
      input: 1.04,
      output: 4.16,
      cacheRead: 0.0208,
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
    const flash = entry(mumugofe, 'deepseek-v4.1-flash')
    const priced = (billing_expr: string) => chatPriceOf({ ...flash, billing_expr }, mm)
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
    // 渠道说明：gpt-image-2 每次生成 1 张，0.052 元。
    expect(imagePriceOf(entry(mumugofe, 'gpt-image-2'), mm, ['1K', '2K', '4K'])).toEqual({
      per: 'request',
      amount: 0.052,
      currency: 'CNY',
    })
    // 2026-10-21 木木 nano_banana_pro 的公式：1K 与 2K、4K 分两档。
    const tiered = {
      ...entry(mumugofe, 'gpt-image-2'),
      billing_mode: 'tiered_expr',
      billing_expr:
        'u("resolution") == "1K" ? tier("1K", u("n") * 0.02465753424657534) : u("resolution") == "2K" ? tier("2K", u("n") * 0.03561643835616438) : tier("4K", u("n") * 0.03561643835616438)',
    }
    expect(imagePriceOf(tiered, mm, ['1K', '2K', '4K'])).toEqual({
      per: 'request',
      amount: { '1K': 0.234, '2K': 0.338, '4K': 0.338 },
      currency: 'CNY',
    })
  })

  test('任务记录中的扣费额度按站点状态折算', () => {
    // 2026-10-21 实测三个任务：额度分别对应 ¥3.75、¥7.50、¥8.00。
    const status = { price: 7.3, quota_per_unit: 500000 }
    expect(quotaAmount(256849, status)).toEqual({ amount: 3.75, currency: 'CNY' })
    expect(quotaAmount(513699, status)).toEqual({ amount: 7.5, currency: 'CNY' })
    expect(quotaAmount(547945, status)).toEqual({ amount: 8, currency: 'CNY' })
    expect(quotaAmount(500000, { quota_per_unit: 500000 })).toEqual({ amount: 1, currency: 'USD' })
    expect(quotaAmount(256849, { price: 7.3 })).toBeUndefined()
  })

  test('可见分组倍率不一致时价格不明', () => {
    const basis = { ...mm, groupRatio: { a: 1, b: 2 } }
    expect(
      chatPriceOf({ ...entry(mumugofe, 'glm-5.2'), enable_groups: ['a', 'b'] }, basis),
    ).toBeUndefined()
    expect(
      chatPriceOf({ ...entry(mumugofe, 'glm-5.2'), enable_groups: ['a', 'c'] }, basis)?.input,
    ).toBeGreaterThan(0)
  })
})
