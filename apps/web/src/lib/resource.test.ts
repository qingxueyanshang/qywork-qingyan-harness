import { expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'
import { createRefreshKey } from './resource.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('连续失效合并为最新修订，切换对象不等待且撤销旧对象的延迟刷新', async () => {
  const root = createRoot((dispose) => {
    const [scope, setScope] = createSignal('a')
    const [revision, setRevision] = createSignal(0)
    return { dispose, setScope, setRevision, key: createRefreshKey(scope, revision, 30) }
  })
  try {
    for (let i = 1; i <= 10; i++) root.setRevision(i)
    expect(root.key()).toEqual({ scope: 'a', revision: 0 })
    await wait(50)
    expect(root.key()).toEqual({ scope: 'a', revision: 10 })
    root.setRevision(11)
    root.setScope('b')
    expect(root.key()).toEqual({ scope: 'b', revision: 11 })
    await wait(50)
    expect(root.key()).toEqual({ scope: 'b', revision: 11 })
  } finally {
    root.dispose()
  }
})

test('持续失效不会无限推迟刷新，卸载后不发布待执行的修订', async () => {
  const root = createRoot((dispose) => {
    const [revision, setRevision] = createSignal(0)
    return { dispose, setRevision, key: createRefreshKey(() => 'a', revision, 25) }
  })
  try {
    for (let i = 1; i <= 6; i++) {
      root.setRevision(i)
      await wait(10)
    }
    expect(root.key().revision).toBeGreaterThan(0)
    await wait(40)
    expect(root.key().revision).toBe(6)
    root.setRevision(7)
    root.dispose()
    await wait(40)
    expect(root.key().revision).toBe(6)
  } finally {
    root.dispose()
  }
})
