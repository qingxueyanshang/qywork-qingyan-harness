import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { batch, createRoot, createSignal } from 'solid-js'
import { createHeld, createRefreshKey, SLOW_MS } from './resource.ts'

// 刷新间隔由假计时器推进：断言只取决于经过的间隔数，与机器负载无关。
beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

test('连续失效合并为最新修订，切换对象不等待且撤销旧对象的延迟刷新', () => {
  const root = createRoot((dispose) => {
    const [scope, setScope] = createSignal('a')
    const [revision, setRevision] = createSignal(0)
    return { dispose, setScope, setRevision, key: createRefreshKey(scope, revision, 30) }
  })
  try {
    for (let i = 1; i <= 10; i++) root.setRevision(i)
    expect(root.key()).toEqual({ scope: 'a', revision: 0 })
    jest.advanceTimersByTime(50)
    expect(root.key()).toEqual({ scope: 'a', revision: 10 })
    root.setRevision(11)
    root.setScope('b')
    expect(root.key()).toEqual({ scope: 'b', revision: 11 })
    jest.advanceTimersByTime(50)
    expect(root.key()).toEqual({ scope: 'b', revision: 11 })
  } finally {
    root.dispose()
  }
})

test('持续失效不会无限推迟刷新，卸载后不发布待执行的修订', () => {
  const root = createRoot((dispose) => {
    const [revision, setRevision] = createSignal(0)
    return { dispose, setRevision, key: createRefreshKey(() => 'a', revision, 25) }
  })
  try {
    for (let i = 1; i <= 6; i++) {
      root.setRevision(i)
      jest.advanceTimersByTime(10)
    }
    expect(root.key().revision).toBeGreaterThan(0)
    jest.advanceTimersByTime(40)
    expect(root.key().revision).toBe(6)
    root.setRevision(7)
    root.dispose()
    jest.advanceTimersByTime(40)
    expect(root.key().revision).toBe(6)
  } finally {
    root.dispose()
  }
})

test('切换后保留上一个值直到就绪；超时后跟随当前值，直到下一次就绪', () => {
  const root = createRoot((dispose) => {
    const [value, setValue] = createSignal('a')
    const [ready, setReady] = createSignal(true)
    return { dispose, setValue, setReady, shown: createHeld(value, ready) }
  })
  const change = (value: string, ready: boolean) =>
    batch(() => {
      root.setValue(value)
      root.setReady(ready)
    })
  try {
    expect(root.shown()).toBe('a')
    change('b', false)
    expect(root.shown()).toBe('a')
    root.setReady(true)
    expect(root.shown()).toBe('b')

    change('c', false)
    jest.advanceTimersByTime(SLOW_MS - 1)
    expect(root.shown()).toBe('b')
    jest.advanceTimersByTime(1)
    expect(root.shown()).toBe('c')
    root.setValue('d')
    expect(root.shown()).toBe('d')
    root.setReady(true)
    expect(root.shown()).toBe('d')

    change('e', false)
    expect(root.shown()).toBe('d')
  } finally {
    root.dispose()
  }
})

test('卸载后不再按时限换值', () => {
  const root = createRoot((dispose) => {
    const [value, setValue] = createSignal('a')
    const [ready, setReady] = createSignal(true)
    return { dispose, setValue, setReady, shown: createHeld(value, ready) }
  })
  batch(() => {
    root.setValue('b')
    root.setReady(false)
  })
  root.dispose()
  jest.advanceTimersByTime(SLOW_MS * 2)
  expect(root.shown()).toBe('a')
})
