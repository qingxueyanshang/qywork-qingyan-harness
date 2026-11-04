/** 积分数值：不足 0.01 时四位小数，不足 0.0001 时写「<0.0001」，不显示为 0；其余两位小数。 */
export function formatCredits(n: number): string {
  if (n > 0 && n < 0.0001) return '<0.0001'
  const digits = n > 0 && n < 0.01 ? 4 : 2
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** 售价倍率，如「0.5×」。 */
export const formatRatio = (ratio: number) =>
  `${ratio.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}×`
