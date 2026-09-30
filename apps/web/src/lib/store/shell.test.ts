/**
 * 覆盖 `store/shell.ts` 的外壳拖放分发：按落点交给命中的那一个接收方，悬停状态广播给全部接收方，注销后不再收。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

/** 外壳事件桥的桩：记下每个事件的回调，由测试手动触发。 */
const handlers = new Map<string, (raw: unknown) => void>()

beforeAll(() => {
  let next = 0
  const callbacks = new Map<number, (raw: unknown) => void>()
  ;(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: (fn: (raw: unknown) => void) => {
      next += 1
      callbacks.set(next, fn)
      return next
    },
    invoke: async (cmd: string, args: { event: string; handler: number }) => {
      if (cmd === 'plugin:event|listen') handlers.set(args.event, callbacks.get(args.handler)!)
    },
  }
})

afterAll(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
})

const fire = (event: string, payload: unknown) => handlers.get(event)!({ payload })

describe('外壳拖放分发', () => {
  test('落点在哪个接收方的区域里就交给哪个；悬停广播给全部；注销后不再收', async () => {
    const { registerDropSink } = await import('./shell.ts')
    const got: string[] = []
    const over: string[] = []
    const left = registerDropSink({
      hit: (p) => p.x < 100,
      over: (on) => over.push(`left:${on}`),
      paths: (paths) => got.push(`left:${paths.join(',')}`),
    })
    const right = registerDropSink({
      hit: (p) => p.x >= 100,
      over: (on) => over.push(`right:${on}`),
      paths: (paths, pos) => got.push(`right:${paths.join(',')}@${pos.x}`),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    fire('tauri://drag-over', { position: { x: 150, y: 10 } })
    expect(over).toEqual(['left:false', 'right:true'])
    fire('tauri://drag-drop', { paths: ['C:/a.png'], position: { x: 150, y: 10 } })
    expect(got).toEqual(['right:C:/a.png@150'])

    right()
    fire('tauri://drag-drop', { paths: ['C:/b.png'], position: { x: 150, y: 10 } })
    expect(got).toEqual(['right:C:/a.png@150'])
    fire('tauri://drag-drop', { paths: ['C:/c.png'], position: { x: 10, y: 10 } })
    expect(got).toEqual(['right:C:/a.png@150', 'left:C:/c.png'])
    left()
  })
})
