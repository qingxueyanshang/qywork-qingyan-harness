/**
 * 覆盖 `store/actions.ts` 的 `activeModel`：会话没有记录模型时取配置的默认「接口 × 模型」，与服务端发送时的优先顺序相同。
 *
 * 原始失败形状：登录云端账号之前新建的会话没有模型，登录后选择器一直显示「选择模型」，而发送实际使用默认模型。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Conversation } from '@qywork/core'

let store: typeof import('../store/index.ts')
let state: typeof import('./state.ts')
let originalApi: typeof store.client.api

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  store = await import('../store/index.ts')
  state = await import('./state.ts')
  originalApi = store.client.api
  store.client.api = async <T>(path: string): Promise<T> => {
    if (path === '/api/models') {
      return {
        providers: [],
        active: { provider: 'qywork', model: 'claude-sonnet-5-5' },
        library: [],
        media: [],
        mediaLibrary: [],
      } as T
    }
    throw new Error(`未替换的接口：${path}`)
  }
  await store.reloadModelCatalog()
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

const conversation = (id: string, provider: string, model: string) =>
  ({ id, provider, model, title: '', mode: 'auto' }) as unknown as Conversation

test('会话没有记录模型时取配置的默认模型；记录了模型时以会话为准', () => {
  state.setState('conversations', [
    conversation('cv_empty', '', ''),
    conversation('cv_own', 'own', 'gpt-5'),
  ])
  state.setState('activeConversation', 'cv_empty' as never)
  expect(store.activeModel()).toEqual({ provider: 'qywork', model: 'claude-sonnet-5-5' })
  state.setState('activeConversation', 'cv_own' as never)
  expect(store.activeModel()).toEqual({ provider: 'own', model: 'gpt-5' })
})
