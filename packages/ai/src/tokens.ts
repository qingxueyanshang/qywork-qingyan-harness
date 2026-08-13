/**
 * Token 粗估。
 *
 * **只用于面板的即时反馈**，精确值走 `adapter.measure()` 或 provider 回报的 usage。
 * 按字符数除以 3.5——中英文混排下这个系数比 4 更接近实测，而且它的用途是
 * 「这一轮大概占了多少」，不是计费。
 *
 * 独立成文件是因为它原本在三个 provider 里各抄了一遍
 * （`anthropic.ts` / `openai-compat.ts` / `openai-responses.ts`）。三份同样的常数
 * 迟早会漂成三个值，而那时候「面板显示的和实际发的对不上」这种问题
 * 谁也查不到这里来。
 */
export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil((text?.length ?? 0) / 3.5)
}
