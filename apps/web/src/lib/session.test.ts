/**
 * 覆盖 `lib/session.ts`：记录的读取、写入缓冲与 `pagehide` 时的一次写入。
 *
 * sessionStorage 由带计数的 Map 模拟：写入次数是本模块的性能约束，拖动画布与输入文字期间不得写入。
 * 模块实例与其他测试文件共用，每条用例先执行一次 `flushSession` 清空待写表。
 */

import { beforeEach, describe, expect, test } from 'bun:test'

const stored = new Map<string, string>()
let writes = 0
;(globalThis as Record<string, unknown>).sessionStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => {
    writes += 1
    stored.set(k, v)
  },
  removeItem: (k: string) => {
    writes += 1
    stored.delete(k)
  },
}

const { flushSession, readSession, SET_CODEC, sessionSignal, writeSession } = await import(
  './session.ts'
)

beforeEach(() => {
  flushSession()
  stored.clear()
  writes = 0
})

describe('页面状态的刷新恢复', () => {
  test('没有记录时使用初值；有记录时以记录为初值', () => {
    expect(sessionSignal('t.a', 1)[0]()).toBe(1)
    stored.set('t.a', '7')
    expect(sessionSignal('t.a', 1)[0]()).toBe(7)
  })

  test('设值在 pagehide 之前不写入 sessionStorage，之后的同键信号读到最近的值', () => {
    const [get, set] = sessionSignal('t.b', 0)
    set(3)
    set((v) => v + 1)
    expect(get()).toBe(4)
    expect(writes).toBe(0)
    expect(sessionSignal('t.b', 0)[0]()).toBe(4)
    flushSession()
    expect(stored.get('t.b')).toBe('4')
  })

  test('Set 经转换往返', () => {
    const [, set] = sessionSignal<ReadonlySet<string>>('t.c', new Set(), SET_CODEC)
    set(new Set(['x', 'y']))
    flushSession()
    const [get] = sessionSignal<ReadonlySet<string>>('t.c', new Set(), SET_CODEC)
    expect([...get()]).toEqual(['x', 'y'])
  })

  test('记录 undefined 即删除', () => {
    stored.set('t.d', '1')
    writeSession('t.d', undefined)
    expect(readSession('t.d')).toBeUndefined()
    flushSession()
    expect(stored.has('t.d')).toBe(false)
  })

  test('记录无法解析时使用初值', () => {
    stored.set('t.e', '{')
    expect(sessionSignal('t.e', 'init')[0]()).toBe('init')
  })

  /**
   * 性能约束：拖动画布每帧修改三个视口值，输入框每次按键修改草稿。
   * 期间写入次数为 0，`pagehide` 时每个修改过的键只写入一次。
   */
  test('600 帧平移与 500 次按键期间不写入，pagehide 时每个键写入一次', () => {
    const [, setZ] = sessionSignal('t.z', 1)
    const [, setX] = sessionSignal('t.x', 0)
    const [, setY] = sessionSignal('t.y', 0)
    const [, setText] = sessionSignal('t.text', '')
    for (let i = 0; i < 600; i++) {
      setZ(1 + i / 1000)
      setX(i)
      setY(-i)
    }
    for (let i = 0; i < 500; i++) setText((t) => `${t}字`)
    expect(writes).toBe(0)
    flushSession()
    expect(writes).toBe(4)
    expect(JSON.parse(stored.get('t.text')!)).toHaveLength(500)
  })
})
