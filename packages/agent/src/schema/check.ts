/**
 * 按工具定义（JSON Schema）核对一次调用的参数。
 *
 * 只覆盖本仓库工具定义使用的关键字：type（单个或数组）、properties、required、additionalProperties、enum、items、minItems。
 * 其余关键字不据此判定，由工具自身的参数检查负责。用于按需工具：它们在工具表中只有桩定义，模型服务不按完整定义约束参数，
 * 执行前在本地按完整定义核对（`ToolRegistry.execute`）。
 */

const TYPE_NAMES: Record<string, string> = {
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔值',
  array: '数组',
  object: '对象',
  null: '空值（null）',
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 不是合法 JSON 时返回 undefined。 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 按定义规范化一次按需工具调用的参数，返回规范化后的参数；不修改传入的对象。
 *
 * 按需工具的桩定义不经 strict 约束，模型按文本形式的完整定义传参时有两种写法与常驻工具不同，在核对之前按完整定义还原：
 * - 可选参数写为 null：模型在 strict 形状下以 null 表示不提供（适配器对 strict 工具按同一规则还原），视为未提供。
 *   类型声明含 null 的参数保留 null。
 * - 字符串参数收到对象或数组：定义为 JSON 文本的参数（如 `params_json`、`json`）在 strict 下必为字符串，
 *   以文本阅读定义时模型常直接传入对象，取其 JSON 文本。
 * - 数组或对象参数收到 JSON 文本：桩定义不声明参数类型，经 Anthropic 协议调用时数组参数可能以其 JSON 文本到达
 *   （`"[\"a.png\"]"`），模型按报错重新调用得到的仍是同一形式。解析结果是定义的类型时取解析结果。
 * 不要扩大为按参数名或取值的其他转换：其余不符合之处由 `schemaProblems` 报告，模型按报错中的定义改正。
 */
export function normalizeArgs(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema)) return value
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const structured = types.includes('object') || types.includes('array')
  if (types.includes('string') && !structured) {
    if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value)
  }
  if (typeof value === 'string' && structured && !types.includes('string')) {
    const parsed = parseJson(value)
    if (
      (Array.isArray(parsed) && types.includes('array')) ||
      (isRecord(parsed) && types.includes('object'))
    ) {
      return normalizeArgs(schema, parsed)
    }
  }
  if (Array.isArray(value)) return value.map((item) => normalizeArgs(schema.items, item))
  if (!isRecord(value)) return value
  const props = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const child = props[key]
    if (item === null && !required.has(key) && isRecord(child)) {
      const childTypes = Array.isArray(child.type) ? child.type : [child.type]
      if (!childTypes.includes('null')) continue
    }
    out[key] = key in props ? normalizeArgs(child, item) : item
  }
  return out
}

/** 不符合之处，每条一句；符合时为空数组。`path` 是报告中该值的位置。 */
export function schemaProblems(schema: unknown, value: unknown, path = '参数'): string[] {
  if (!isRecord(schema)) return []
  const problems: string[] = []
  const types = Array.isArray(schema.type)
    ? schema.type.filter((t): t is string => typeof t === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : []
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    const want = types.map((t) => TYPE_NAMES[t] ?? t).join(' 或 ')
    return [`${path} 应为${want}，收到${TYPE_NAMES[typeOf(value)] ?? typeOf(value)}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => Object.is(e, value))) {
    problems.push(`${path} 须为下列之一：${schema.enum.map((e) => JSON.stringify(e)).join('、')}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      problems.push(`${path} 至少 ${schema.minItems} 项`)
    }
    value.forEach((item, i) => {
      problems.push(...schemaProblems(schema.items, item, `${path}[${i}]`))
    })
  }
  if (isRecord(value)) {
    const props = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (typeof key === 'string' && value[key] === undefined) {
        problems.push(`${path} 缺少必填项 ${key}`)
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in props) problems.push(...schemaProblems(props[key], item, `${path}.${key}`))
      else if (schema.additionalProperties === false) problems.push(`${path} 不接受 ${key}`)
    }
  }
  return problems
}
