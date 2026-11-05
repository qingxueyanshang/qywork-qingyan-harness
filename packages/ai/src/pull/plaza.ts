/**
 * 模型广场（`/api/v1/model-plaza`）的价格折算。
 *
 * 该格式按分组给出倍率（`rate_multiplier`），型号给出每 token 的基础价与长上下文分档（`intervals`）；
 * 实扣为基础价 × 分组倍率。站点以「$」显示金额，本处按美元记账，账本与站点显示的金额相同。
 *
 * - 基础价与分档都与模型库的官方价一致时返回倍率：长上下文档由模型库按倍率计算，与站点的分档计价相同。
 * - 否则返回单价，站点的分档随单价一并返回（`longContext`）。
 * - 型号所在的各分组倍率不一致、分组开启高峰加价、计费方式不是按 token 时价格不明。
 *   任何一项无法确定时价格不明，不按部分结果折算：账本中虚构的金额与真实金额无法区分。
 */

import type { Currency, ProviderKind } from '@qywork/core'
import { lookupModel, priceAt } from '../catalog.ts'
import type { ChatPrice } from './pricing.ts'

/** 拉取得到的对话价格：四项单价，或模型库官方价的倍率。 */
export type PulledPrice = ChatPrice | { scale: number; currency: Currency }

type Json = Record<string, unknown>

const PER_MILLION = 1e6
const round = (n: number) => Math.round(n * 1e6) / 1e6
const same = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

interface Rates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 每百万 token 的四项价格。输入或输出缺失时为 null；缓存两项缺失时为 0（站点不收该项）。 */
function ratesOf(p: Json, base?: Rates): Rates | null {
  // 分档的价格可写为基础价的倍数（`*_multiplier`），没有价格也没有倍数时沿用基础价。
  const at = (key: string, fallback: number | undefined) => {
    const price = num(p[`${key}_price`])
    if (price !== null) return price * PER_MILLION
    const mult = num(p[`${key}_multiplier`])
    if (mult !== null && fallback !== undefined) return mult * fallback
    return fallback ?? null
  }
  const input = at('input', base?.input)
  const output = at('output', base?.output)
  if (input === null || output === null) return null
  return {
    input,
    output,
    cacheRead: at('cache_read', base?.cacheRead) ?? 0,
    cacheWrite: at('cache_write', base?.cacheWrite) ?? 0,
  }
}

/** 一个型号在一个分组中的价格：基础价与高于基础价的各档（第一个进入该档的提示词 token 数）。 */
interface Listing {
  rate: number
  base: Rates
  tiers: { from: number; rates: Rates }[]
}

function listingOf(group: Json, model: Json): Listing | null {
  const pricing = obj(model.pricing)
  const rate = num(group.rate_multiplier)
  if (!pricing || rate === null || rate <= 0) return null
  if (group.peak_rate_enabled === true || pricing.billing_mode !== 'token') return null
  const base = ratesOf(pricing)
  if (!base) return null
  const tiers: Listing['tiers'] = []
  if (group.long_context_pricing_enabled === true && Array.isArray(pricing.intervals)) {
    for (const raw of pricing.intervals) {
      const interval = obj(raw)
      const min = num(interval?.min_tokens)
      if (!interval || min === null || min <= 0) continue
      const rates = ratesOf(interval, base)
      if (!rates) return null
      // `min_tokens` 是上一档的上限，提示词超过它才进入本档。
      tiers.push({ from: min + 1, rates })
    }
  }
  return { rate, base, tiers }
}

const sameRates = (a: Rates, b: Rates) =>
  same(a.input, b.input) &&
  same(a.output, b.output) &&
  same(a.cacheRead, b.cacheRead) &&
  same(a.cacheWrite, b.cacheWrite)

/** 基础价与各档都与模型库的官方价一致，且模型库没有站点不执行的时段折扣。 */
function matchesCatalog(id: string, kind: ProviderKind, listing: Listing): boolean {
  const spec = lookupModel(id, kind)
  if (spec.catalogued === false || spec.offPeak || (spec.pricing.currency ?? 'USD') !== 'USD')
    return false
  const official = (promptTokens: number): Rates | null => {
    const p = priceAt(spec, { promptTokens })
    if (p.input === null || p.output === null) return null
    return {
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead ?? 0,
      cacheWrite: p.cacheWrite5m ?? 0,
    }
  }
  const base = official(0)
  if (!base || !sameRates(base, listing.base)) return false
  // 两边的分档须一一对应：站点的每一档在模型库中有相同的价格，模型库的每一档在站点中也有。
  const thresholds = new Set([
    ...listing.tiers.map((t) => t.from),
    ...(spec.longContext ?? []).map((t) => t.thresholdTokens),
  ])
  for (const from of thresholds) {
    const site = [...listing.tiers].reverse().find((t) => t.from <= from)?.rates ?? listing.base
    const mine = official(from)
    if (!mine || !sameRates(site, mine)) return false
  }
  return true
}

/** 广场中各型号的价格；广场格式无法识别时返回 null。`kind` 是接口的协议，按它查询模型库。 */
export function plazaPrices(body: unknown, kind: ProviderKind): Map<string, PulledPrice> | null {
  const groups = obj(obj(body)?.data)?.groups
  if (!Array.isArray(groups)) return null
  const listings = new Map<string, (Listing | null)[]>()
  for (const g of groups) {
    const group = obj(g)
    if (!group || !Array.isArray(group.models)) continue
    for (const m of group.models) {
      const model = obj(m)
      if (typeof model?.name !== 'string') continue
      listings.set(model.name, [...(listings.get(model.name) ?? []), listingOf(group, model)])
    }
  }
  const prices = new Map<string, PulledPrice>()
  for (const [id, all] of listings) {
    const first = all[0]
    if (!first) continue
    // 分组倍率或价格不一致时，无法确定该接口的密钥属于哪个分组。
    const consistent = all.every(
      (l) =>
        l !== null &&
        same(l.rate, first.rate) &&
        sameRates(l.base, first.base) &&
        l.tiers.length === first.tiers.length,
    )
    if (!consistent) continue
    if (matchesCatalog(id, kind, first)) {
      prices.set(id, { scale: first.rate, currency: 'USD' })
      continue
    }
    const by = (n: number) => round(n * first.rate)
    const tiers = first.tiers.filter((t) => !sameRates(t.rates, first.base))
    prices.set(id, {
      input: by(first.base.input),
      output: by(first.base.output),
      cacheRead: by(first.base.cacheRead),
      cacheWrite: by(first.base.cacheWrite),
      currency: 'USD',
      ...(tiers.length
        ? {
            longContext: tiers.map((t) => {
              const input = by(t.rates.input)
              const output = by(t.rates.output)
              const cacheRead = by(t.rates.cacheRead)
              const over = (t.from - 1).toLocaleString('en-US')
              return {
                thresholdTokens: t.from,
                input,
                output,
                cacheRead,
                cacheWrite5m: by(t.rates.cacheWrite),
                cacheWrite1h: by(t.rates.cacheWrite),
                note: `提示词超过 ${over} token 后整条请求按 $${input} / $${output}（缓存 $${cacheRead}）计价`,
              }
            }),
          }
        : {}),
    })
  }
  return prices
}
