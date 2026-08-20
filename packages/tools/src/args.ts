/**
 * 模型给的工具参数取值。
 *
 * schema 声明了类型，但**只有开了 strict 的端点会执行它**（见 `ai` 包的 `strictify`）：
 * MCP 工具、不认 strict 的自建端点、以及 schema 形状不合格时静默降级的端点，
 * 都还会把字符串当整数传进来。所以取值这一步必须能说「读不出来」。
 */

/**
 * 取一个整数参数。缺省（`undefined` / `null`）用 `fallback`；
 * 给了但读不出整数返回 `null`，**调用方必须当失败处理，不许接着往下算**。
 *
 * `Number('5')` 是 5，所以字符串形式的整数照收——真正要挡的是
 * `Number('1,4000')` 这种读不出数的值：它会变成 `NaN`，而 `NaN` 参与的比较全为假、
 * `slice(NaN, NaN)` 是空数组，一路走下去就是「成功读取 0 行」。
 */
export function intArg(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null
  if (typeof raw !== 'string' || !raw.trim()) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

/** 读不出整数时给模型的那句话。带上原值——不说收到了什么，模型只能靠猜去改。 */
export function badIntMessage(name: string, raw: unknown): string {
  return `${name} 必须是整数，收到 ${JSON.stringify(raw)}`
}
