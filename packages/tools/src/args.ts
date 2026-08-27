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
 * `slice(NaN, NaN)` 是空数组，继续往下走就是「成功读取 0 行」。
 */
export function intArg(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null
  if (typeof raw !== 'string' || !raw.trim()) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

/**
 * 取一个可选的标识符参数（模型名、角色 id、会话 id 这类），空值一律归成 `''`。
 *
 * 模型表达「不填这个可选参数」有三种写法：省略键、JSON `null`、以及**字符串
 * `"null"` / `"undefined"`**。前两种 `typeof` 就挡住了，第三种挡不住，会被当成
 * 一个真实取值往下传——实测子 agent 因此收到模型名 `null`，派活当场失败。
 *
 * **不要用在自由文本参数上**（task、goal、content）：那里的 `null` 是合法内容。
 */
export function idArg(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const s = raw.trim()
  return s === 'null' || s === 'undefined' ? '' : s
}

/** 读不出整数时给模型的那句话。带上原值——不说收到了什么，模型只能靠猜去改。 */
export function badIntMessage(name: string, raw: unknown): string {
  return `${name} 必须是整数，收到 ${JSON.stringify(raw)}`
}
