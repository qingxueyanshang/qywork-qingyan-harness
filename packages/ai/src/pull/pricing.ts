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
import type { OffPeakDiscount } from '../catalog.ts'
import { type Billing, compileBilling, UnsupportedBilling } from './expression.ts'

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
  /** 计费读取的请求字段，键为字段名。 */
  billing_usage_schema?: Record<string, unknown>
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
  /** 分时段折扣。此时四项单价是高峰价。 */
  offPeak?: OffPeakDiscount
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

/**
 * 任务记录中的扣费额度（New API 任务的 `quota`，已含分组倍率）折算为金额：
 * 额度 ÷ 站点状态的 `quota_per_unit`（每额度美元的额度数）× 充值价。站点状态缺少换算单位时返回 undefined。
 * 金额取到 0.0001：额度由金额取整得到，按 1e-6 保留会显示 3.749998 这类取整误差。
 */
export function quotaAmount(
  quota: number,
  status: { price?: unknown; quota_per_unit?: unknown },
): { amount: number; currency: Currency } | undefined {
  const unit = status.quota_per_unit
  if (!(typeof unit === 'number' && unit > 0)) return undefined
  const { rate, currency } = priceBasis({}, status)
  return { amount: Math.round((quota / unit) * rate * 1e4) / 1e4, currency }
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

type Rates = [number, number, number, number]

/** 时刻 `at` 的输入、输出、缓存命中、缓存写入单价；公式不是四项计量的线性组合时返回 undefined。 */
function ratesAt(run: Billing, at: number): Rates | undefined {
  // 长上下文档不折算，只取 `len = 0` 时的基础档。
  const v = (vars: Partial<Record<'p' | 'c' | 'cr' | 'cc', number>>) =>
    run({ p: 0, c: 0, cr: 0, cc: 0, len: 0, ...vars }, {}, at)
  if (!same(v({}), 0)) return undefined
  const rates: Rates = [v({ p: 1 }), v({ c: 1 }), v({ cr: 1 }), v({ cc: 1 })]
  return same(v({ p: 2, c: 2 }), 2 * (rates[0] + rates[1])) ? rates : undefined
}

const HOUR = 3_600_000
/** 采样间隔为 15 分钟：时区偏移可为半小时或 45 分钟，整点采样会漏掉这些时区的换档时刻。 */
const SLOTS_PER_HOUR = 4
const SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR
/**
 * 两个参考周的起点，均为周日 00:00 UTC，分别位于一月与七月。两周的结果不一致说明公式的时区有夏令时，
 * 一组 UTC 时段无法表示全年，价格不明。
 */
const REFERENCE_WEEKS = [Date.UTC(2026, 0, 4), Date.UTC(2026, 6, 5)]

/**
 * 公式计费的单价与分时段折扣。在两个参考周内逐个时刻求单价：最高的一组为高峰价，其余时刻须为高峰价乘以同一折扣系数，
 * 高峰时刻在每个出现高峰的星期须为同一组 UTC 时段。不满足时（多档折扣、各天高峰时段不同）返回 undefined。
 */
function tieredRates(expr: string): { rates: Rates; offPeak?: OffPeakDiscount } | undefined {
  const run = compileBilling(expr)
  const samples: Rates[] = []
  for (const week of REFERENCE_WEEKS)
    for (let i = 0; i < 7 * SLOTS_PER_DAY; i++) {
      const rates = ratesAt(run, week + (i * HOUR) / SLOTS_PER_HOUR)
      if (!rates) return undefined
      samples.push(rates)
    }
  const peak = samples.reduce((a, b) => (b[0] > a[0] ? b : a))
  if (!(peak[0] > 0)) return undefined
  const factors: number[] = []
  for (const rates of samples) {
    const k = rates[0] / peak[0]
    if (!rates.every((r, j) => same(r, k * peak[j]!))) return undefined
    factors.push(k)
  }
  const week = factors.length / REFERENCE_WEEKS.length
  if (factors.some((k, i) => i >= week && !same(k, factors[i - week]!))) return undefined
  const discounts = factors.filter((k) => !same(k, 1))
  if (!discounts.length) return { rates: peak }
  const rate = discounts[0]!
  if (!discounts.every((k) => same(k, rate))) return undefined

  const days = new Map<number, string>()
  for (let i = 0; i < week; i++)
    if (same(factors[i]!, 1)) {
      const day = Math.floor(i / SLOTS_PER_DAY)
      days.set(day, `${days.get(day) ?? ''},${i % SLOTS_PER_DAY}`)
    }
  if (new Set(days.values()).size !== 1) return undefined
  const slots = [...days.values()][0]!.split(',').slice(1).map(Number)
  const peakWindowsUtc: [number, number][] = []
  for (const s of slots) {
    const last = peakWindowsUtc[peakWindowsUtc.length - 1]
    if (last && last[1] === s / SLOTS_PER_HOUR) last[1] = (s + 1) / SLOTS_PER_HOUR
    else peakWindowsUtc.push([s / SLOTS_PER_HOUR, (s + 1) / SLOTS_PER_HOUR])
  }
  return {
    rates: peak,
    offPeak: { rate: round(rate), peakWindowsUtc, peakWeekdaysUtc: [...days.keys()] },
  }
}

/** 对话型号每百万 Token 的价格；按次计费的对话型号不在此列。 */
export function chatPriceOf(entry: NewApiPricingEntry, basis: PriceBasis): ChatPrice | undefined {
  const factor = groupFactor(entry, basis)
  if (factor === null) return undefined
  let rates: Rates
  let offPeak: OffPeakDiscount | undefined
  if (entry.billing_mode === 'tiered_expr') {
    if (!entry.billing_expr) return undefined
    try {
      const tiered = tieredRates(entry.billing_expr)
      if (!tiered) return undefined
      rates = tiered.rates
      offPeak = tiered.offPeak
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
    ...(offPeak ? { offPeak } : {}),
  }
}

type TierPrice = { per: ChannelPrice['per']; amount: number }

/**
 * 一个分辨率档位的价格（额度美元）。按型号可选的时长与 `choices` 中的其余计量逐一求值：
 * 结果全部相同为按次，与时长成正比为按秒，其余价格不明。
 */
function tierPrice(
  run: Billing,
  seconds: readonly number[],
  choices: Readonly<Record<string, readonly string[]>>,
): TierPrice | undefined {
  let combos: Record<string, string>[] = [{}]
  for (const [key, values] of Object.entries(choices))
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })))
  const results: { s: number; v: number }[] = []
  for (const s of seconds)
    for (const c of combos) results.push({ s, v: run({}, { ...c, seconds: s }) })
  const first = results[0]!
  if (results.every((r) => same(r.v, first.v))) return { per: 'request', amount: first.v }
  const k = first.v / first.s
  if (results.every((r) => same(r.v, k * r.s))) return { per: 'second', amount: k }
  return undefined
}

/**
 * 按公式逐档求价（`priceOf` 返回额度美元计的价格），合为保存的价格：各档计价方式须相同；
 * 金额相同时合为一个数，不同时按档位分别保存。任何一档价格不明时整体价格不明。
 */
function tieredPrice(
  expr: string,
  names: readonly string[],
  basis: PriceBasis,
  factor: number,
  priceOf: (run: Billing, name: string) => TierPrice | undefined,
): ChannelPrice | undefined {
  const prices: TierPrice[] = []
  try {
    const run = compileBilling(expr)
    for (const name of names) {
      const price = priceOf(run, name)
      if (!price || !(price.amount > 0)) return undefined
      prices.push(price)
    }
  } catch (err) {
    if (err instanceof UnsupportedBilling) return undefined
    throw err
  }
  const per = prices[0]!.per
  if (prices.some((p) => p.per !== per)) return undefined
  const amounts = prices.map((p) => round(p.amount * basis.rate * factor))
  return {
    per,
    amount: amounts.every((a) => same(a, amounts[0]!))
      ? amounts[0]!
      : Object.fromEntries(names.map((name, i) => [name, amounts[i]!])),
    currency: basis.currency,
  }
}

/**
 * 视频型号的价格。`tiers` 是各分辨率档位对应的其余计量可选值（键为档位），公式计费时逐档求价。
 */
export function videoPriceOf(
  entry: NewApiPricingEntry,
  basis: PriceBasis,
  seconds: readonly number[],
  tiers: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>,
): ChannelPrice | undefined {
  const factor = groupFactor(entry, basis)
  if (factor === null) return undefined
  if (entry.billing_mode !== 'tiered_expr') {
    const amount = entry.model_price ?? 0
    const per =
      entry.billing_mode === 'per_second' ? 'second' : entry.quota_type === 1 ? 'request' : null
    return per && amount > 0
      ? { per, amount: round(amount * basis.rate * factor), currency: basis.currency }
      : undefined
  }
  const names = Object.keys(tiers)
  if (!entry.billing_expr || !seconds.length || !names.length) return undefined
  return tieredPrice(entry.billing_expr, names, basis, factor, (run, name) =>
    tierPrice(run, seconds, tiers[name]!),
  )
}

/** 图像型号每张的价格。公式计费时按各分辨率档位与 `n = 1` 求值。 */
export function imagePriceOf(
  entry: NewApiPricingEntry,
  basis: PriceBasis,
  resolutions: readonly string[],
): ChannelPrice | undefined {
  const factor = groupFactor(entry, basis)
  if (factor === null) return undefined
  if (entry.billing_mode !== 'tiered_expr') {
    const amount = entry.model_price ?? 0
    return entry.quota_type === 1 && amount > 0
      ? { per: 'request', amount: round(amount * basis.rate * factor), currency: basis.currency }
      : undefined
  }
  if (!entry.billing_expr || !resolutions.length) return undefined
  return tieredPrice(entry.billing_expr, resolutions, basis, factor, (run, resolution) => ({
    per: 'request',
    amount: run({}, { n: 1, resolution }),
  }))
}
