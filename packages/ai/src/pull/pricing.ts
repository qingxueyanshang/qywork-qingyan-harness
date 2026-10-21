/**
 * New API 公开价格（`/api/pricing`、`/api/status`）的折算。
 *
 * 计费量的单位是渠道的「额度美元」：对话按倍率计费时每百万 Token 为 `model_ratio × 2`，按次与按秒为 `model_price`，
 * 公式计费（`tiered_expr`）为公式结果，其中对话变量 `p c cr cc` 的系数即每百万 Token 的单价。
 * 乘以 `/api/status` 的充值价 `price`（每额度美元对应的人民币）与分组倍率，得到用户实际支付的价格。
 *
 * 任何一项无法确定时价格不明（返回 undefined），不按部分结果折算：账本中虚构的金额与真实金额无法区分。
 */

import type { ChannelPrice, Currency } from '@qywork/core'
import { evaluateBilling, UnsupportedBilling } from './expression.ts'

/** `/api/pricing` 的 `data[]` 中与价格有关的字段。 */
export interface NewApiPricingEntry {
  model_name: string
  quota_type?: number
  model_ratio?: number
  model_price?: number
  completion_ratio?: number
  cache_ratio?: number
  create_cache_ratio?: number
  enable_groups?: string[]
  supported_endpoint_types?: string[]
  billing_mode?: string
  billing_expr?: string
}

/** 价格折算所需的站点级数据。 */
export interface PriceBasis {
  /** 每额度美元对应的金额。 */
  rate: number
  currency: Currency
  groupRatio: Readonly<Record<string, number>>
}

/** 每百万 Token 的对话价格，字段与模型库覆盖的价格字段相同。 */
export interface ChatPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  currency: Currency
}

/**
 * 站点的计价币种与充值价。`/api/status` 给出正数的 `price` 时按人民币计价；没有时按额度美元原值计价。
 */
export function priceBasis(
  pricing: { group_ratio?: unknown },
  status: { price?: unknown } | undefined,
): PriceBasis {
  const groupRatio: Record<string, number> = {}
  if (pricing.group_ratio && typeof pricing.group_ratio === 'object') {
    for (const [g, r] of Object.entries(pricing.group_ratio))
      if (typeof r === 'number' && r > 0) groupRatio[g] = r
  }
  const price = status?.price
  return typeof price === 'number' && price > 0
    ? { rate: price, currency: 'CNY', groupRatio }
    : { rate: 1, currency: 'USD', groupRatio }
}

/** 型号可用分组的倍率。可见分组的倍率不一致时无法确定用户所在分组，返回 null。 */
function groupFactor(entry: NewApiPricingEntry, basis: PriceBasis): number | null {
  const ratios = (entry.enable_groups ?? []).flatMap((g) =>
    basis.groupRatio[g] === undefined ? [] : [basis.groupRatio[g]],
  )
  if (!ratios.length) return null
  return ratios.every((r) => r === ratios[0]) ? ratios[0]! : null
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
const same = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

/** 对话型号每百万 Token 的价格；按次计费的对话型号不在此列。 */
export function chatPriceOf(entry: NewApiPricingEntry, basis: PriceBasis): ChatPrice | undefined {
  const factor = groupFactor(entry, basis)
  if (factor === null) return undefined
  let rates: [number, number, number, number]
  if (entry.billing_mode === 'tiered_expr') {
    if (!entry.billing_expr) return undefined
    const expr = entry.billing_expr
    // 长上下文档与时段折扣不折算，只取 `len = 0` 时的基础档。
    const at = (vars: Partial<Record<'p' | 'c' | 'cr' | 'cc', number>>) =>
      evaluateBilling(expr, { p: 0, c: 0, cr: 0, cc: 0, len: 0, ...vars })
    try {
      if (!same(at({}), 0)) return undefined
      rates = [at({ p: 1 }), at({ c: 1 }), at({ cr: 1 }), at({ cc: 1 })]
      if (!same(at({ p: 2, c: 2 }), 2 * (rates[0] + rates[1]))) return undefined
    } catch (err) {
      if (err instanceof UnsupportedBilling) return undefined
      throw err
    }
  } else {
    if (entry.quota_type !== 0 || !(entry.model_ratio && entry.model_ratio > 0)) return undefined
    const input = entry.model_ratio * 2
    rates = [
      input,
      input * (entry.completion_ratio ?? 1),
      input * (entry.cache_ratio ?? 1),
      input * (entry.create_cache_ratio ?? 1),
    ]
  }
  if (!(rates[0] > 0) || rates.some((r) => r < 0)) return undefined
  const [input, output, cacheRead, cacheWrite] = rates.map((r) => round(r * basis.rate * factor))
  return {
    input: input!,
    output: output!,
    cacheRead: cacheRead!,
    cacheWrite: cacheWrite!,
    currency: basis.currency,
  }
}

/**
 * 视频型号的价格。公式计费时按型号可选的时长与 `choices` 中的其余计量逐一求值：
 * 结果全部相同为按次，与时长成正比为按秒，其余（如按尺寸分档）价格不明。
 */
export function videoPriceOf(
  entry: NewApiPricingEntry,
  basis: PriceBasis,
  seconds: readonly number[],
  choices: Readonly<Record<string, readonly string[]>> = {},
): ChannelPrice | undefined {
  const factor = groupFactor(entry, basis)
  if (factor === null) return undefined
  const priced = (per: ChannelPrice['per'], amount: number): ChannelPrice | undefined =>
    amount > 0
      ? { per, amount: round(amount * basis.rate * factor), currency: basis.currency }
      : undefined
  if (entry.billing_mode !== 'tiered_expr') {
    const amount = entry.model_price ?? 0
    if (entry.billing_mode === 'per_second') return priced('second', amount)
    return entry.quota_type === 1 ? priced('request', amount) : undefined
  }
  if (!entry.billing_expr || !seconds.length) return undefined
  let combos: Record<string, string>[] = [{}]
  for (const [key, values] of Object.entries(choices))
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })))
  const results: { s: number; v: number }[] = []
  try {
    for (const s of seconds)
      for (const c of combos)
        results.push({ s, v: evaluateBilling(entry.billing_expr, {}, { ...c, seconds: s }) })
  } catch (err) {
    if (err instanceof UnsupportedBilling) return undefined
    throw err
  }
  const first = results[0]!
  if (results.every((r) => same(r.v, first.v))) return priced('request', first.v)
  const k = first.v / first.s
  if (results.every((r) => same(r.v, k * r.s))) return priced('second', k)
  return undefined
}
