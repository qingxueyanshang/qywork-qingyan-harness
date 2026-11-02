/** 积分数值，两位小数；大于 0 而不足 0.01 时写「<0.01」，不显示为 0。 */
export function formatCredits(n: number): string {
  if (n > 0 && n < 0.01) return '<0.01'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
