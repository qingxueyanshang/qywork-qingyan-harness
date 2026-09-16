/**
 * 按键词表与组合键解析。
 *
 * 覆盖范围：`keys.ts` 全部（物理键的键码、功能键清单、组合键的修饰键顺序与
 * Shift 补按规则、拒绝形状、修饰位）。
 */

import { expect, test } from 'bun:test'
import { KEY_HINT, keySpec, keyStroke, modifierBits, PRESS_KEYS } from './keys.ts'

test('键盘表按物理键给键码，不按字符码点', () => {
  expect(keySpec(';')).toEqual({ key: ';', code: 'Semicolon', keyCode: 186, text: ';' })
  expect(keySpec(':')).toEqual({
    key: ':',
    code: 'Semicolon',
    keyCode: 186,
    text: ':',
    shift: true,
  })
  // 分号与冒号是同一个物理键。按字符码点算会得到 59 与 58，两个都不是可用的虚拟键码。
  expect(keySpec(';')?.keyCode).not.toBe(';'.codePointAt(0))
  expect(keySpec('a')?.keyCode).toBe(keySpec('A')?.keyCode)
  expect(PRESS_KEYS).toContain('Enter')
  expect(PRESS_KEYS).toContain('PageDown')
})

test('组合键解析：修饰键在前、主键在末，空段与重复修饰键一律拒绝', () => {
  expect(keyStroke('Ctrl+A')).toEqual({
    modifiers: ['Ctrl'],
    // Ctrl+A 是 Ctrl 加 A 键：不补 Shift，页面看到的 key 是 a。
    key: { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' },
  })
  expect(keyStroke('Ctrl+a')?.key.key).toBe('a')
  expect(keyStroke('Shift+Tab')?.modifiers).toEqual(['Shift'])
  expect(keyStroke('Ctrl+Shift+Enter')?.modifiers).toEqual(['Ctrl', 'Shift'])
  // 加号写 Plus：它是上排符号，要按住 Shift 才产生。
  expect(keyStroke('Ctrl+Plus')?.modifiers).toEqual(['Ctrl', 'Shift'])
  expect(keyStroke('Ctrl+Plus')?.key.code).toBe('Equal')
  // 不带其他修饰键的大写字母补 Shift，否则页面收到的是小写。
  expect(keyStroke('A')).toEqual({
    modifiers: ['Shift'],
    key: { key: 'A', code: 'KeyA', keyCode: 65, text: 'A', shift: true },
  })

  for (const bad of ['', 'Ctrl+', '+A', 'Ctrl++', 'Ctrl+Ctrl+A', 'Hyper+A', 'F13', 'ctrl+a']) {
    expect(keyStroke(bad)).toBeNull()
  }
})

test('修饰位按位或叠加，顺序不影响结果', () => {
  expect(modifierBits([])).toBe(0)
  expect(modifierBits(['Ctrl'])).toBe(2)
  expect(modifierBits(['Ctrl', 'Shift'])).toBe(10)
  expect(modifierBits(['Shift', 'Ctrl'])).toBe(10)
})

test('取值说明列全功能键与修饰键，两处拒绝共用它', () => {
  for (const name of PRESS_KEYS) expect(KEY_HINT).toContain(name)
  expect(KEY_HINT).toContain('Plus')
})
