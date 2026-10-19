/**
 * 模型所传工具参数的取值。
 *
 * schema 声明了类型，但**只有开启 strict 的端点会校验类型**（见 `ai` 包的 `strictify`）：
 * MCP 工具、不支持 strict 的自建端点，以及 schema 结构不合格时不报错直接降级的端点，
 * 仍会将字符串作为整数传入。因此取值时必须能够报告无法解析。
 */

/**
 * 取一个整数参数。缺省（`undefined` / `null`）时使用 `fallback`；
 * 已提供但无法解析为整数时返回 `null`，**调用方必须按失败处理，不得继续计算**。
 *
 * `Number('5')` 为 5，因此字符串形式的整数照常接受；需要拒绝的是
 * `Number('1,4000')` 这类无法解析为数字的值：它会变为 `NaN`，而 `NaN` 参与的比较全为假、
 * `slice(NaN, NaN)` 为空数组，继续执行会得到「成功读取 0 行」。
 */
export function intArg(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null
  if (typeof raw !== 'string' || !raw.trim()) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

/**
 * 取一个可选的标识符参数（模型名、角色 id、会话 id 等），空值一律归为 `''`。
 *
 * 模型表示不填写可选参数有三种写法：省略键、JSON `null`，以及**字符串
 * `"null"` / `"undefined"`**。前两种由 `typeof` 判断即可排除，第三种无法排除，会被当作
 * 真实取值向下传递：实测子 agent 因此收到模型名 `null`，派发任务立即失败。
 *
 * **不要用于自由文本参数**（task、goal、content）：这些参数中的 `null` 是合法内容。
 */
export function idArg(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const s = raw.trim()
  return s === 'null' || s === 'undefined' ? '' : s
}

const KIND_NAMES: Record<string, string> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔值',
  object: '对象',
}

/** 值的类型名称，用于报错中说明实际收到的是什么。 */
function kindOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  return KIND_NAMES[typeof v] ?? typeof v
}

/**
 * 取一个以 JSON 文本声明的参数（`params_json`、`ops_json`、`config_json`）。
 *
 * 这类参数声明为字符串：严格模式的工具格式（`openai_strict`）无法描述任意字段的对象。模型仍可能直接传入
 * 对象或数组，其含义与对应的 JSON 文本相同，按目标形状照常接受。文本无法解析或形状不符时返回说明，
 * 说明中写明实际收到的类型：只写「必须是 JSON 对象」时，传入对象的模型无从判断错在哪里。
 * 缺省（`undefined`、`null`、空白字符串）时 `value` 为 `undefined`，是否必填由调用方判断。
 */
export function jsonArg(
  raw: unknown,
  shape: 'object' | 'array',
  name: string,
):
  | { ok: true; value: Record<string, unknown> | unknown[] | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return { ok: true, value: undefined }
  }
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch (err) {
      return { ok: false, error: `${name} 的 JSON 文本无法解析：${(err as Error).message}` }
    }
  }
  const fits = shape === 'array' ? Array.isArray(value) : kindOf(value) === '对象'
  if (!fits) {
    const want = shape === 'array' ? '数组' : '对象'
    return { ok: false, error: `${name} 须为 JSON ${want}，收到的是${kindOf(value)}` }
  }
  return { ok: true, value: value as Record<string, unknown> | unknown[] }
}

/** 无法解析为整数时给模型的提示。附带原值：不说明收到的值时，模型只能推测如何修改。 */
export function badIntMessage(name: string, raw: unknown): string {
  return `${name} 必须是整数，收到 ${JSON.stringify(raw)}`
}
