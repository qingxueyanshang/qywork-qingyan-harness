/**
 * 物理键表与一次输入的规模上限。
 *
 * 覆盖范围：`keys.ts` 全部（按下集合推出的事件字段、字符到物理键、修饰位、
 * 按键阶段与拖动路径的合法性、键码取值说明）。
 */

import { expect, test } from 'bun:test'
import {
  charKeys,
  checkDuration,
  checkHeldKeys,
  checkKeyPhases,
  checkPath,
  INPUT_LIMITS,
  KEY_HINT,
  keyEvent,
  modifierBits,
} from './keys.ts'

test('键码按物理键取虚拟键码，不按字符码点', () => {
  expect(keyEvent('Semicolon', [])).toEqual({
    key: ';',
    code: 'Semicolon',
    keyCode: 186,
    text: ';',
    modifiers: 0,
  })
  // 分号与冒号是同一个物理键。按字符码点计算会得到 59 与 58，两者都不是可用的虚拟键码。
  expect(keyEvent('Semicolon', ['ShiftLeft', 'Semicolon'])).toMatchObject({
    key: ':',
    keyCode: 186,
    text: ':',
    modifiers: 8,
  })
  expect(keyEvent('Space', [])).toMatchObject({ key: ' ', text: ' ' })
  expect(keyEvent('Enter', [])).toMatchObject({ key: 'Enter', text: '\r' })
  expect(keyEvent('Tab', [])?.text).toBeUndefined()
  expect(keyEvent('Hyper', [])).toBeNull()
})

test('字符由按下集合推出：按住 Shift 时取上排字符，按住 Ctrl / Alt / Meta 时不带文本', () => {
  expect(keyEvent('KeyW', ['KeyW'])).toMatchObject({ key: 'w', text: 'w', modifiers: 0 })
  expect(keyEvent('KeyW', ['ShiftLeft', 'KeyW'])).toMatchObject({ key: 'W', text: 'W' })
  // Ctrl+A 是 Ctrl 与 A 键的组合：页面收到的 key 是 a，且不产生字符。
  const ctrlA = keyEvent('KeyA', ['ControlLeft', 'KeyA'])
  expect(ctrlA).toMatchObject({ key: 'a', modifiers: 2 })
  expect(ctrlA?.text).toBeUndefined()
  // 修饰键自身按下时集合含自身、抬起时不含自身，修饰位由调用方提供的集合决定。
  expect(keyEvent('ControlLeft', ['ControlLeft'])?.modifiers).toBe(2)
  expect(keyEvent('ControlLeft', [])?.modifiers).toBe(0)
})

test('布局表中的字符拆分为物理键，Shift 在前；表外字符返回 null', () => {
  expect(charKeys('a')).toEqual(['KeyA'])
  expect(charKeys('A')).toEqual(['ShiftLeft', 'KeyA'])
  expect(charKeys('+')).toEqual(['ShiftLeft', 'Equal'])
  expect(charKeys(' ')).toEqual(['Space'])
  expect(charKeys('中')).toBeNull()
})

test('修饰位按位或叠加，非修饰键不计', () => {
  expect(modifierBits([])).toBe(0)
  expect(modifierBits(['ControlLeft'])).toBe(2)
  expect(modifierBits(['ControlLeft', 'ShiftLeft', 'KeyA'])).toBe(10)
  expect(modifierBits(['AltLeft', 'MetaLeft'])).toBe(5)
})

test('按键阶段：键码、重复、空集合、时长与合计上限各有对应的错误说明', () => {
  expect(
    checkKeyPhases([
      { keys: ['KeyW'], durationMs: 1200 },
      { keys: ['KeyW', 'Space'] },
      { keys: ['KeyW'], durationMs: 300 },
    ]),
  ).toBeNull()
  expect(checkKeyPhases([])).toContain('至少需要一个阶段')
  expect(checkKeyPhases([{ keys: ['W'] }])).toContain('不是可用的键码')
  expect(checkKeyPhases([{ keys: ['KeyW', 'KeyW'] }])).toContain('重复')
  expect(checkKeyPhases([{ keys: [] }])).toContain('空集合')
  expect(checkKeyPhases([{ keys: [], durationMs: 100 }])).toBeNull()
  expect(checkKeyPhases([{ keys: ['KeyW'], durationMs: -1 }])).toContain('durationMs')
  expect(checkKeyPhases([{ keys: ['KeyW'], durationMs: 1.5 }])).toContain('durationMs')
  expect(checkKeyPhases([{ keys: ['KeyW'], durationMs: INPUT_LIMITS.phaseMs + 1 }])).toContain(
    'durationMs',
  )
  const long = Array.from({ length: 3 }, () => ({
    keys: ['KeyW'],
    durationMs: INPUT_LIMITS.phaseMs,
  }))
  expect(checkKeyPhases(long)).toContain('合计')
  const many = Array.from({ length: INPUT_LIMITS.phases + 1 }, () => ({ keys: ['KeyW'] }))
  expect(checkKeyPhases(many)).toContain(`最多 ${INPUT_LIMITS.phases} 个阶段`)
  const wide = ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI']
  expect(checkHeldKeys(wide, 'keys')).toContain(`最多同时按 ${INPUT_LIMITS.keys} 个键`)
})

test('拖动路径与单个时长：段数、时长与合计使用同一张上限表', () => {
  expect(checkPath([{ durationMs: 400 }, {}])).toBeNull()
  expect(checkPath([])).toContain('至少需要一段')
  expect(checkPath(Array.from({ length: INPUT_LIMITS.pathSegments + 1 }, () => ({})))).toContain(
    `最多 ${INPUT_LIMITS.pathSegments} 段`,
  )
  expect(checkPath([{ durationMs: 6000 }])).toContain('path[0].durationMs')
  expect(checkDuration(0, 'holdMs')).toBeNull()
  expect(checkDuration(Number.NaN, 'holdMs')).toContain('holdMs')
})

test('取值说明列出全部功能键与修饰键，两处拒绝共用该说明', () => {
  for (const code of ['Enter', 'Space', 'ArrowUp', 'PageDown', 'ShiftLeft', 'ControlLeft']) {
    expect(KEY_HINT).toContain(code)
  }
})
