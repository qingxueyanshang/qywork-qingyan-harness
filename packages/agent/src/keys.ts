/**
 * 按键词表与组合键解析。
 *
 * 纯数据加纯函数，不依赖连接，也不产生任何协议参数——放在 agent 层是因为
 * 预检（tools）与发送（server 的 CDP 客户端）都要按同一份表裁决。**一份表，两处取**：
 * 分成两份的代价是两边各自漂移，未知主键名在预检放行、到端口才被拒。
 *
 * 表不接受调用方给的任意字符串：`key` / `code` / `windowsVirtualKeyCode` 三项必须自洽，
 * 缺一项网页收到的是认不出的按键而不报错。布局固定为 US，不按系统当前布局推断。
 */

/** 功能键。 */
const FUNCTION_KEYS: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

/**
 * US 布局的可打印键：物理 `code`、Windows 虚拟键码、无 Shift 字符、按住 Shift 的字符。
 *
 * **不要改成按字符码点算键码。** 虚拟键码是物理键的编号，与字符不是一一对应：`;` 与 `:`
 * 同一个键（186），而按码点算会得到 59 与 58 两个不存在的键；字母 `a` 与 `A` 同为 65。
 * 平台布局固定为 US，不按系统当前布局推断。
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

/** 字符 → 按键规格。大写字母与上排符号带 `shift`，调用方据此补按 Shift。 */
const CHAR_KEYS = new Map<string, KeySpec>()
/** 物理键 → 不按 Shift 时的规格。快捷键里的字母按物理键算，用它当主键。 */
const PLAIN_BY_CODE = new Map<string, KeySpec>()
for (const [code, keyCode, plain, shifted] of PRINTABLE_KEYS) {
  const spec: KeySpec = { key: plain, code, keyCode, text: plain }
  CHAR_KEYS.set(plain, spec)
  PLAIN_BY_CODE.set(code, spec)
  CHAR_KEYS.set(shifted, { key: shifted, code, keyCode, text: shifted, shift: true })
}
CHAR_KEYS.set(' ', { key: ' ', code: 'Space', keyCode: 32, text: ' ' })

export interface KeySpec {
  key: string
  code: string
  keyCode: number
  /** 这个键产生的字符。没有字符的功能键缺席，缺席即发 `rawKeyDown`。 */
  text?: string
  /** 产生这个字符要按住 Shift。 */
  shift?: boolean
}

/** `Input.dispatchKeyEvent` 的 `modifiers` 位。 */
const MODIFIER_BITS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const

export type ModifierName = keyof typeof MODIFIER_BITS

/** 修饰键自身的规格。发送方按 `KeyStroke.modifiers` 的顺序按下、逆序抬起。 */
export const MODIFIER_KEYS: Record<ModifierName, KeySpec> = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
}

/** 一次按键：先按下的修饰键，再主键。 */
export interface KeyStroke {
  modifiers: ModifierName[]
  key: KeySpec
}

export const PRESS_KEYS = Object.keys(FUNCTION_KEYS)

/**
 * 按键取值说明。预检与端口两处拒绝同一个写法，用同一句话说明。
 *
 * 两处各写一句的代价是同一个拒绝给出两种说法，调用方据此改一次仍被另一处拒。
 */
export const KEY_HINT =
  `功能键 ${PRESS_KEYS.join('、')}，或字母数字标点；` +
  '可加 Ctrl / Shift / Alt / Meta 修饰键，加号写成 Plus'

/** 一个主键名对应的规格。`Plus` 表示加号本身——`+` 是组合键的分隔符。 */
export function keySpec(name: string): KeySpec | null {
  if (name === 'Plus') return CHAR_KEYS.get('+') ?? null
  return FUNCTION_KEYS[name] ?? CHAR_KEYS.get(name) ?? null
}

/**
 * 解析一次按键：`Ctrl+Shift+Enter` 这样的写法，末段是主键，之前各段是修饰键。
 *
 * 空段、重复修饰键、认不出的修饰键或主键一律返回 `null`，由调用方拒绝整次动作。
 */
export function keyStroke(input: string): KeyStroke | null {
  const parts = input.split('+')
  if (parts.some((part) => part === '')) return null
  const main = parts.pop()
  if (main === undefined) return null
  const key = keySpec(main)
  if (!key) return null
  const modifiers: ModifierName[] = []
  for (const part of parts) {
    if (!(part in MODIFIER_BITS)) return null
    const name = part as ModifierName
    if (modifiers.includes(name)) return null
    modifiers.push(name)
  }
  if (key.shift !== true || modifiers.includes('Shift')) return { modifiers, key }
  // 大写字母与上排符号要按住 Shift 才产生，补上它，否则页面收到的是另一个字符。
  // 快捷键里的字母是例外：`Ctrl+A` 说的是 Ctrl 加 A 键，补 Shift 会变成另一个快捷键，
  // 而页面在真实的 Ctrl+A 上看到的 `key` 本来就是 `a`。
  if (key.code.startsWith('Key') && modifiers.some((name) => name !== 'Shift')) {
    return { modifiers, key: PLAIN_BY_CODE.get(key.code) ?? key }
  }
  modifiers.push('Shift')
  return { modifiers, key }
}

/** 一组修饰键的 `Input.dispatchKeyEvent` 修饰位。 */
export function modifierBits(names: readonly ModifierName[]): number {
  let bits = 0
  for (const name of names) bits |= MODIFIER_BITS[name]
  return bits
}
