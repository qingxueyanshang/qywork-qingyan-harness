/**
 * 物理键表、按键事件字段与一次输入的规模上限。
 *
 * 纯数据加纯函数，不依赖连接——放在 agent 层是因为预检（tools）与发送（server 的
 * 输入执行器）都要按同一份表裁决。**一份表，两处取**：分成两份的代价是两边各自漂移，
 * 未知键码在预检放行、到端口才被拒。
 *
 * 键一律按物理键码（`KeyboardEvent.code`）指名。字符由按下集合推出：同一个 `KeyA`
 * 按住 `ShiftLeft` 时产生 `A`，按住 `ControlLeft` 时不产生字符。布局固定为 US，
 * 不按系统当前布局推断。
 */

export interface KeySpec {
  key: string
  code: string
  keyCode: number
  /** 这个键产生的字符。没有字符的功能键缺席，缺席即发 `rawKeyDown`。 */
  text?: string
}

/** 功能键，按 `code` 索引。 */
const FUNCTION_KEYS: KeySpec[] = [
  { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  { key: 'Tab', code: 'Tab', keyCode: 9 },
  { key: 'Escape', code: 'Escape', keyCode: 27 },
  { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  { key: 'Delete', code: 'Delete', keyCode: 46 },
  { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  { key: 'Home', code: 'Home', keyCode: 36 },
  { key: 'End', code: 'End', keyCode: 35 },
  { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
]

/** 修饰键与它在 `Input.dispatchKeyEvent` 的 `modifiers` 里的位。 */
const MODIFIERS: { spec: KeySpec; bit: number }[] = [
  { spec: { key: 'Alt', code: 'AltLeft', keyCode: 18 }, bit: 1 },
  { spec: { key: 'Control', code: 'ControlLeft', keyCode: 17 }, bit: 2 },
  { spec: { key: 'Meta', code: 'MetaLeft', keyCode: 91 }, bit: 4 },
  { spec: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }, bit: 8 },
]

/**
 * US 布局的可打印键：物理 `code`、Windows 虚拟键码、无 Shift 字符、按住 Shift 的字符。
 *
 * **不要改成按字符码点算键码。** 虚拟键码是物理键的编号，与字符不是一一对应：`;` 与 `:`
 * 同一个键（186），而按码点算会得到 59 与 58 两个不存在的键；字母 `a` 与 `A` 同为 65。
 */
const PRINTABLE_KEYS: [code: string, keyCode: number, plain: string, shifted: string][] = [
  ['Backquote', 192, '`', '~'],
  ['Digit1', 49, '1', '!'],
  ['Digit2', 50, '2', '@'],
  ['Digit3', 51, '3', '#'],
  ['Digit4', 52, '4', '$'],
  ['Digit5', 53, '5', '%'],
  ['Digit6', 54, '6', '^'],
  ['Digit7', 55, '7', '&'],
  ['Digit8', 56, '8', '*'],
  ['Digit9', 57, '9', '('],
  ['Digit0', 48, '0', ')'],
  ['Minus', 189, '-', '_'],
  ['Equal', 187, '=', '+'],
  ['BracketLeft', 219, '[', '{'],
  ['BracketRight', 221, ']', '}'],
  ['Backslash', 220, '\\', '|'],
  ['Semicolon', 186, ';', ':'],
  ['Quote', 222, "'", '"'],
  ['Comma', 188, ',', '<'],
  ['Period', 190, '.', '>'],
  ['Slash', 191, '/', '?'],
]

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i)
  PRINTABLE_KEYS.push([`Key${lower.toUpperCase()}`, 65 + i, lower, lower.toUpperCase()])
}

/** 物理键 → 不按 Shift 的规格，以及按住 Shift 时的字符。 */
const BY_CODE = new Map<string, { spec: KeySpec; shifted?: string; bit?: number }>()
for (const spec of FUNCTION_KEYS) BY_CODE.set(spec.code, { spec })
for (const { spec, bit } of MODIFIERS) BY_CODE.set(spec.code, { spec, bit })
for (const [code, keyCode, plain, shifted] of PRINTABLE_KEYS) {
  BY_CODE.set(code, { spec: { key: plain, code, keyCode, text: plain }, shifted })
}

/** 字符 → 产生它要按下的物理键，Shift 在前。`type` 按它把布局表里的字符拆成按键。 */
const CHAR_KEYS = new Map<string, string[]>()
for (const [code, , plain, shifted] of PRINTABLE_KEYS) {
  CHAR_KEYS.set(plain, [code])
  CHAR_KEYS.set(shifted, ['ShiftLeft', code])
}
CHAR_KEYS.set(' ', ['Space'])

const SHIFT = 'ShiftLeft'
/** 按住时主键不产生字符的修饰位：Alt、Ctrl、Meta。按住它们时页面收到的是快捷键。 */
const SHORTCUT_BITS = 1 | 2 | 4

/**
 * 一次调用的输入规模上限。预检与端口共用，只约束单次调用，不约束任务轮数。
 *
 * `phaseMs` 同样约束指针动作的按住时长与每段拖动时长，`totalMs` 是一次调用里全部显式
 * 时长之和。两者都要小于动作的绝对期限（30 秒），给定位、复核与收尾留出余量。
 */
export const INPUT_LIMITS = {
  phases: 32,
  keys: 8,
  pathSegments: 32,
  phaseMs: 5_000,
  totalMs: 10_000,
} as const

/**
 * 键码取值说明。预检与端口两处拒绝同一个写法，用同一句话说明。
 *
 * 两处各写一句的代价是同一个拒绝给出两种说法，调用方据此改一次仍被另一处拒。
 */
export const KEY_HINT =
  `物理键码：${FUNCTION_KEYS.map((s) => s.code).join('、')}、` +
  'KeyA–KeyZ、Digit0–Digit9、Minus、Equal、BracketLeft、BracketRight、Backslash、' +
  'Semicolon、Quote、Comma、Period、Slash、Backquote，修饰键 ShiftLeft、ControlLeft、AltLeft、MetaLeft'

export function isKeyCode(code: string): boolean {
  return BY_CODE.has(code)
}

/** 一组按下的键的 `Input.dispatchKeyEvent` 修饰位。非修饰键不计。 */
export function modifierBits(held: readonly string[]): number {
  let bits = 0
  for (const code of held) bits |= BY_CODE.get(code)?.bit ?? 0
  return bits
}

/** 一条按键事件里描述这个键的字段，加上发出那一刻的修饰位。 */
export interface KeyEventFields extends KeySpec {
  modifiers: number
}

/**
 * 按下集合为 `held` 时这个键的事件字段。
 *
 * `held` 是发出这一条事件那一刻的集合：修饰键自己的按下含自身，抬起不含自身。
 * 按住 Shift 时可打印键取上排字符；按住 Alt / Ctrl / Meta 时主键不附 `text`——那时页面
 * 收到的是快捷键，附上文本会让输入框同时插进一个字符。认不出的键码返回 `null`。
 */
export function keyEvent(code: string, held: readonly string[]): KeyEventFields | null {
  const entry = BY_CODE.get(code)
  if (!entry) return null
  const modifiers = modifierBits(held)
  const shifted = entry.shifted !== undefined && held.includes(SHIFT)
  const key = shifted ? (entry.shifted as string) : entry.spec.key
  const text = (modifiers & SHORTCUT_BITS) !== 0 ? undefined : shifted ? key : entry.spec.text
  return {
    key,
    code,
    keyCode: entry.spec.keyCode,
    ...(text === undefined ? {} : { text }),
    modifiers,
  }
}

/** 产生这个字符要按下的物理键，Shift 在前。布局表里没有的字符返回 `null`。 */
export function charKeys(ch: string): string[] | null {
  return CHAR_KEYS.get(ch) ?? null
}

/**
 * 一段按键计划的合法性。返回第一处问题的说明，合法时返回 `null`。
 *
 * 每个阶段的 `keys` 是这段时间里按着的完整集合；空集合表示全部松开并等待，所以必须带
 * 正时长。时长缺省为 0，即这个集合按下之后立刻进入下一阶段。
 */
export function checkKeyPhases(
  phases: readonly { keys: readonly string[]; durationMs?: number }[],
): string | null {
  if (phases.length === 0) return 'phases 至少要有一个阶段'
  if (phases.length > INPUT_LIMITS.phases) {
    return `phases 最多 ${INPUT_LIMITS.phases} 个阶段，收到 ${phases.length} 个`
  }
  for (const [i, phase] of phases.entries()) {
    const where = `phases[${i}]`
    const problem =
      checkHeldKeys(phase.keys, `${where}.keys`) ??
      checkDuration(phase.durationMs ?? 0, `${where}.durationMs`)
    if (problem) return problem
    if (phase.keys.length === 0 && (phase.durationMs ?? 0) === 0) {
      return `${where} 是空集合，必须给正的 durationMs`
    }
  }
  return checkTotal(phases, 'phases')
}

/** `drag` 路径的段数与各段时长。 */
export function checkPath(path: readonly { durationMs?: number }[]): string | null {
  if (path.length === 0) return 'path 至少要有一段'
  if (path.length > INPUT_LIMITS.pathSegments) {
    return `path 最多 ${INPUT_LIMITS.pathSegments} 段，收到 ${path.length} 段`
  }
  for (const [i, step] of path.entries()) {
    const problem = checkDuration(step.durationMs ?? 0, `path[${i}].durationMs`)
    if (problem) return problem
  }
  return checkTotal(path, 'path')
}

/** 一个时长：0 到 `phaseMs` 的整数毫秒。 */
export function checkDuration(ms: number, field: string): string | null {
  if (Number.isInteger(ms) && ms >= 0 && ms <= INPUT_LIMITS.phaseMs) return null
  return `${field} 必须是 0 到 ${INPUT_LIMITS.phaseMs} 的整数`
}

function checkTotal(items: readonly { durationMs?: number }[], field: string): string | null {
  const total = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  if (total <= INPUT_LIMITS.totalMs) return null
  return `${field} 的 durationMs 合计最多 ${INPUT_LIMITS.totalMs}，收到 ${total}`
}

/** 一组同时按着的键：键码都认得、不重复、不超过上限。 */
export function checkHeldKeys(keys: readonly string[], field: string): string | null {
  if (keys.length > INPUT_LIMITS.keys) {
    return `${field} 最多同时按 ${INPUT_LIMITS.keys} 个键，收到 ${keys.length} 个`
  }
  for (const code of keys) {
    if (!isKeyCode(code))
      return `${field} 里的 ${JSON.stringify(code)} 不是可用的键码（${KEY_HINT}）`
  }
  if (new Set(keys).size !== keys.length) return `${field} 里有重复的键`
  return null
}
