/**
 * 自动压缩的触发比例：按模型窗口分三档，每档一个整数百分比，缺省为 `COMPACT_PERCENT_DEFAULT`。
 *
 * 设置页的滑块范围、配置校验与运行侧的解析都取自本文件。不要在别处另写范围：两处分别定义时，
 * 设置页可以保存一个运行侧拒绝的值。
 */

/** 配置中的三档取值，键为档名。缺少的档取 `COMPACT_PERCENT_DEFAULT`。 */
export interface CompactPercentSetting {
  large?: number
  medium?: number
  small?: number
}

export type CompactTierKey = keyof CompactPercentSetting

export interface CompactTier {
  key: CompactTierKey
  /** 设置页的行名，与模型库中窗口的写法相同。 */
  label: string
  /** 本档窗口的下限（含）。 */
  minWindow: number
  /** 可选的最小百分比。 */
  min: number
  /** 可选的最大百分比。 */
  max: number
}

/** 缺省比例，也是各档的上限。比例为该值时触发线为窗口的 80%，尾部保留量为窗口的 1/4。 */
export const COMPACT_PERCENT_DEFAULT = 80

/** 可选比例的步长。 */
export const COMPACT_PERCENT_STEP = 5

/**
 * 最低触发线（token）。
 *
 * 触发线 L、信封（系统提示词与工具定义）5.5 万、尾部保留量 T = L × 5/16，保留的尾部在 T 至 2T 之间：
 * L = 15 万时 L − 信封 − 2T 为 1250，是最差情形下摘要与事实清单仍有空间的边界值。信封 5.5 万是账本中
 * 系统提示词与工具定义合计的最大值。调整该值时，各档的下限同步取不使主流窗口低于它的最小 5 的倍数。
 */
export const COMPACT_TRIGGER_FLOOR = 150_000

/**
 * 三档按窗口下限降序排列。范围按主流窗口确定：1M 档 100 万、500K 档 50 万、256K 档 25.6 万与 26.2 万，
 * 各档下限是这些窗口不低于最低触发线的最小 5 的倍数。其他窗口按所在档取值，同样受最低触发线约束。
 */
export const COMPACT_TIERS: readonly CompactTier[] = [
  { key: 'large', label: '1M', minWindow: 800_000, min: 30, max: COMPACT_PERCENT_DEFAULT },
  { key: 'medium', label: '500K', minWindow: 300_000, min: 30, max: COMPACT_PERCENT_DEFAULT },
  { key: 'small', label: '256K', minWindow: 0, min: 60, max: COMPACT_PERCENT_DEFAULT },
]

/** 窗口所在的档。最后一档的下限为 0，任何窗口都有所属的档。 */
export function compactTierOf(contextWindow: number): CompactTier {
  return COMPACT_TIERS.find((tier) => contextWindow >= tier.minWindow) ?? COMPACT_TIERS.at(-1)!
}

/**
 * 窗口所在档的设置值。不判定合法性：调用方先以 `compactPercentProblems` 判定整份设置，
 * 不合法时报错，不要改用缺省值。
 */
export function compactPercentOf(
  contextWindow: number,
  setting: CompactPercentSetting | undefined,
): number {
  return setting?.[compactTierOf(contextWindow).key] ?? COMPACT_PERCENT_DEFAULT
}

/** 某一档的取值是否可选：整数、步长的倍数、在该档范围内。 */
export function isCompactPercent(tier: CompactTier, value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value % COMPACT_PERCENT_STEP === 0 &&
    value >= tier.min &&
    value <= tier.max
  )
}

/** 配置值 `compactPercent` 的问题清单。空数组表示合法；缺省（undefined）合法。 */
export function compactPercentProblems(setting: unknown): string[] {
  if (setting === undefined) return []
  const keys = COMPACT_TIERS.map((tier) => tier.key).join('、')
  if (setting === null || typeof setting !== 'object' || Array.isArray(setting)) {
    return [`compactPercent 必须是对象，键为 ${keys}`]
  }
  const problems: string[] = []
  for (const [key, value] of Object.entries(setting)) {
    const tier = COMPACT_TIERS.find((t) => t.key === key)
    if (!tier) {
      problems.push(`compactPercent.${key} 不是有效的档，可选：${keys}`)
    } else if (!isCompactPercent(tier, value)) {
      problems.push(
        `compactPercent.${key} 必须是 ${tier.min} 至 ${tier.max} 之间 ${COMPACT_PERCENT_STEP} 的倍数的整数，当前为 ${JSON.stringify(value)}`,
      )
    }
  }
  return problems
}
