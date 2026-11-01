/**
 * 覆盖 `store/connection.ts` 的 `onConnectionState`：本页嵌在 console 的 iframe 中且握手被拒时通知 console；
 * 未嵌入或其他连接状态时不发送。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

let connection: typeof import('./connection.ts')
let store: typeof import('./state.ts')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  connection = await import('./connection.ts')
  store = await import('./state.ts')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function withParent(parent: unknown, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'parent')
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  try {
    run()
  } finally {
    if (descriptor) Object.defineProperty(window, 'parent', descriptor)
  }
}

test('嵌在 iframe 中且握手被拒时通知上层页面，消息不含令牌', () => {
  const sent: unknown[] = []
  withParent({ postMessage: (message: unknown) => sent.push(message) }, () => {
    connection.onConnectionState('ready')
    connection.onConnectionState('unauthorized', '令牌无效')
  })
  expect(sent).toEqual([{ type: 'qywork.unauthorized' }])
})

test('未嵌入时握手被拒只更新连接状态', () => {
  const { state } = store
  connection.onConnectionState('unauthorized', '令牌无效')
  expect(window.parent).toBe(window)
  expect(state.connection).toBe('unauthorized')
  expect(state.connectionDetail).toBe('令牌无效')
})
