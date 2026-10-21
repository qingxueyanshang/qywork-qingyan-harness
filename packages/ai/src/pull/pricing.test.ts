/**
 * 覆盖 `expression.ts`（计费公式求值）与 `pricing.ts`（New API 价格折算）。
 * 数据是 2026-10-21 从 hongcheng 与木木公开接口取得的响应片段（`../fixtures/newapi-*.json`），
 * 期望值与渠道说明中写明的价格逐项一致。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateBilling, UnsupportedBilling } from './expression.ts'
import { chatPriceOf, type NewApiPricingEntry, priceBasis, videoPriceOf } from './pricing.ts'

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
    expect(evaluateBilling('len < 10 ? tier("a", p * 2) : weekday("x")', { p: 3, len: 0 })).toBe(6)
    expect(() => evaluateBilling('len < 10 ? 1 : weekday("x")', { len: 20 })).toThrow(
      UnsupportedBilling,
    )
  })

  test('u() 取计量，字符串比较', () => {
    const expr =
      'u("size") == "854x480" ? tier("480P", u("seconds") * 2) : tier("720P", u("seconds") * 3)'
    expect(evaluateBilling(expr, {}, { size: '854x480', seconds: 5 })).toBe(10)
    expect(evaluateBilling(expr, {}, { size: '1280x720', seconds: 5 })).toBe(15)
  })

  test('未给出的变量与函数不支持', () => {
    expect(() => evaluateBilling('q * 2', {})).toThrow(UnsupportedBilling)
    expect(() => evaluateBilling('hour("Asia/Shanghai")', {})).toThrow(UnsupportedBilling)
    expect(() => evaluateBilling('1 +', {})).toThrow(UnsupportedBilling)
  })
})

describe('价格折算', () => {
  test('站点按充值价折算为人民币', () => {
    expect(hc).toMatchObject({ rate: 7.3, currency: 'CNY' })
    expect(priceBasis({}, undefined)).toMatchObject({ rate: 1, currency: 'USD' })
  })

  test('hongcheng 按秒与按次', () => {
    expect(videoPriceOf(entry(hongcheng, 'TTseadanco2.5-720'), hc, [5, 30])).toEqual({
      per: 'second',
      amount: 0.42,
      currency: 'CNY',
    })
    expect(videoPriceOf(entry(hongcheng, 'GGseadanco2.5/720'), hc, [5])?.amount).toBe(0.54)
    expect(videoPriceOf(entry(hongcheng, 'seedance-2.5-yy-720p'), hc, [4, 30])).toEqual({
      per: 'request',
      amount: 7.3,
      currency: 'CNY',
    })
  })

  test('木木公式计费：按次、按秒、按尺寸分档', () => {
    const sizes = { size: ['1280x720', '720x1280'] }
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
    // 480P 与 720P 每秒单价不同，按次、按秒都无法表示。
    expect(
      videoPriceOf(entry(mumugofe, '007系列/sd2.5(30图10音/480P/720P)'), mm, [4, 30], {
        size: ['854x480', '1280x720'],
      }),
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
    // 按时段打折的公式价格不明。
    expect(chatPriceOf(entry(mumugofe, 'deepseek-v4.1-flash'), mm)).toBeUndefined()
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
