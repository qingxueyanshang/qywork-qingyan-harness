/** 积分数值：不足 0.01 时四位小数，不足 0.0001 时写「<0.0001」，不显示为 0；其余两位小数。 */
export function formatCredits(n: number): string {
  if (n > 0 && n < 0.0001) return '<0.0001'
  const digits = n > 0 && n < 0.01 ? 4 : 2
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/**
 * 单价（积分）：按实际值显示，至多 6 位小数，不补零，如 0.0175、0.4375、0；与管理后台的价格写法相同。
 * 不要改用 `formatCredits`：它按金额保留两位小数，0.0175 显示为 0.02。
 */
export const formatUnitPrice = (n: number) =>
  n.toLocaleString('zh-CN', { maximumFractionDigits: 6 })

/** 售价倍率，如「0.5×」。 */
export const formatRatio = (ratio: number) =>
  `${ratio.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}×`

/**
 * 生成型号的时长范围，如「4–15秒」，取自参数表中的时长参数（接口字段 `duration` 或 `seconds`）：
 * 整数参数取上下限，枚举取最小与最大值。没有时长参数或取值不受限时为空串。
 */
export function durationRange(
  params: readonly {
    name: string
    type: string
    min?: number
    max?: number
    values?: readonly unknown[]
  }[],
): string {
  const p = params.find((x) => x.name === 'duration' || x.name === 'seconds')
  if (!p) return ''
  const nums =
    p.type === 'enum'
      ? (p.values ?? []).map(Number).filter(Number.isFinite)
      : p.min !== undefined && p.max !== undefined
        ? [p.min, p.max]
        : []
  if (!nums.length) return ''
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  return lo === hi ? `${lo}秒` : `${lo}–${hi}秒`
}
