/**
 * 覆盖 `commands.ts`：斜杠命令执行失败时在界面上显示原因。
 *
 * 测试 DOM 在本文件内注册，结束后注销，理由同 `components/settings/LoadState.test.tsx`。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** 原始失败形状：「/new」请求失败时没有任何提示，用户无法判断命令是否执行。 */
test('新对话命令失败时写入通知', async () => {
  const store = await import('./store/index.ts')
  const { buildCommands } = await import('./commands.ts')
  const original = store.client.api
  ;(store.client as unknown as { api: () => Promise<unknown> }).api = async () => {
    throw new Error('503 /api/conversations: 服务暂不可用')
  }
  try {
    store.setState('notice', null)
    buildCommands()
      .find((c) => c.id === 'new')!
      .run()
    for (let i = 0; i < 100 && !store.state.notice; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(store.state.notice?.message).toBe('无法新建会话：503 /api/conversations: 服务暂不可用')
  } finally {
    ;(store.client as unknown as { api: typeof original }).api = original
    store.setState('notice', null)
  }
})
