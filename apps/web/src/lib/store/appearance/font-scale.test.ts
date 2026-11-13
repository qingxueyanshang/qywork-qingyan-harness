/**
 * 覆盖 `appearance/font-scale.ts`：启动时把已保存的比例写入根元素的 `--font-scale`；
 * 修改后更新根元素、当前比例与保存值；回到 100% 时移除该变量。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'

const saved = new Map<string, string>()
const style = new Map<string, string>()
const previous = {
  storage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
}
let store: typeof import('./font-scale.ts')

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => void style.set(name, value),
          removeProperty: (name: string) => void style.delete(name),
        },
      },
    },
  })
  // 模块在加载时读取已保存的比例，因此先写入再加载。
  saved.set('qywork.fontScale', '1.15')
  store = await import('./font-scale.ts')
})

afterAll(() => {
  for (const [name, descriptor] of [
    ['localStorage', previous.storage],
    ['document', previous.document],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

test('启动时把已保存的比例写入根元素', () => {
  expect(store.fontScale()).toBe(1.15)
  store.initFontScale()
  expect(style.get('--font-scale')).toBe('1.15')
})

test('修改后更新根元素、当前比例与保存值', () => {
  store.setFontScale(1.3)
  expect(style.get('--font-scale')).toBe('1.3')
  expect(store.fontScale()).toBe(1.3)
  expect(saved.get('qywork.fontScale')).toBe('1.3')
})

test('回到 100% 时移除根元素上的变量', () => {
  store.setFontScale(1)
  expect(style.has('--font-scale')).toBe(false)
  expect(saved.get('qywork.fontScale')).toBe('1')
})
