/** 电脑控制工具的参数解析：判定参数是否提供，以及字符串、枚举与数值参数的读取。 */

/**
 * 调用端口之前判定出的参数错误与前置条件不满足。
 *
 * 携带 `errorKind` 是为了与端口的执行前拒绝经由同一出口：两者都是判定而不是故障，
 * 结果中的 `executed` 必须为 `false`。
 */
export class ArgError extends Error {
  readonly errorKind: string
  constructor(message: string, errorKind = 'invalid_argument') {
    super(message)
    this.name = 'ArgError'
    this.errorKind = errorKind
  }
}

/**
 * 判断该可选参数是否已提供。`null`、空串与字符串 `"null"` 视为未提供，与浏览器工具使用同一判据。
 *
 * 该判据同样用于「不属于本动作的参数」检查，不要在那里改为 `!== undefined`。
 * strict 工具 schema 把每个可选参数都列入 `required` 并在类型中加入 `null`
 * （`packages/ai` 的 `strictify`），模型据此为无关参数逐个填写空值：约束解码的端点填写
 * `null` 与空串，DeepSeek 无论 schema 是否 strict 都会填写字符串 `"null"`。按 `!== undefined`
 * 判断会把一次 `set_value` 附带的约二十个空值全部报告为多余参数，动作始终无法派发。
 *
 * 空串与 `"null"` 在该检查中不构成例外：`value`、`text` 的原文由动作自身的参数表读取，
 * 不经过该判据，输入字面量 null 不受影响。
 */
export function given(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  const text = String(raw).trim()
  return text !== '' && text.toLowerCase() !== 'null'
}

/** 不属于本动作的参数取 0 与 false 时同样视为空值：它们不表达任何意图。 */
export function blank(raw: unknown): boolean {
  return raw === false || String(raw).trim() === '0'
}

export function str(raw: unknown, field: string): string {
  const value = String(raw ?? '').trim()
  if (!value) throw new ArgError(`缺少 ${field}`)
  return value
}

export function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  const value = String(raw ?? '')
  if (!allowed.includes(value as T)) {
    throw new ArgError(`${field} 只能是 ${allowed.join(' / ')}，收到 ${JSON.stringify(raw)}`)
  }
  return value as T
}

/** 先判断有限性再截断：`NaN` 与 `Infinity` 若透传给端口，端口计算出的上限将没有边界。 */
export function bounded(raw: unknown, field: string, low: number, high: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new ArgError(`${field} 必须是数字，收到 ${JSON.stringify(raw)}`)
  }
  return Math.min(high, Math.max(low, Math.floor(value)))
}
