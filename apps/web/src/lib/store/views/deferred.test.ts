/**
 * 覆盖 `store/views/deferred.ts`：历史页中标记 `deferred` 的工具结果按 step 读取完整结果并替换会话流中的条目；
 * 读取失败时记录原因、条目不变，再次读取成功后原因清除。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

let store: typeof import('../index.ts')
let deferred: typeof import('./deferred.ts')
let originalApi: typeof store.client.api
let failing = false
const calls: string[] = []

const FULL = {
  status: 'success',
  executed: true,
  message: '读取 a.ts',
  data: { content: '完整正文', startLine: 1, endLine: 2, totalLines: 9 },
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  store = await import('../index.ts')
  deferred = await import('./deferred.ts')
  originalApi = store.client.api
  store.client.api = async <T>(path: string): Promise<T> => {
    calls.push(path)
    if (failing) throw new Error('未收到服务响应')
    if (path === '/api/conversations/cv_d/steps/st_1') {
      return { step: { id: 'st_1', payload: { kind: 'tool_result', outcome: FULL } } } as T
    }
    throw new Error(`未替换的接口：${path}`)
  }
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

test('读取失败时记录原因且条目不变；再次读取后替换为完整结果并清除原因', async () => {
  // 视图表只保留当前会话与右侧打开的子会话页（`syncViews`），因此先把该会话设为当前会话。
  store.setState({ activeConversation: 'cv_d' })
  store.openView('cv_d')
  store.setState('views', 'cv_d', 'transcript', [
    {
      id: 'st_1',
      kind: 'tool',
      text: '',
      toolName: 'read_file',
      status: 'success',
      outcome: {
        status: 'success',
        executed: true,
        message: '读取 a.ts',
        data: { startLine: 1, endLine: 2, totalLines: 9 },
        deferred: true,
      },
    },
  ])
  const item = () => store.state.views.cv_d!.transcript[0]!

  failing = true
  await deferred.loadDeferredOutcome('st_1')
  expect(deferred.deferredError('st_1')).toBe('未收到服务响应')
  expect(item().outcome?.deferred).toBe(true)

  failing = false
  await deferred.loadDeferredOutcome('st_1')
  expect(deferred.deferredError('st_1')).toBeUndefined()
  expect(item().outcome).toEqual(FULL as never)
  expect(calls.filter((p) => p.includes('/steps/'))).toHaveLength(2)
  store.setState({ activeConversation: null })
  store.dropView('cv_d')
})
