/**
 * 覆盖 `WindowControls.tsx`：窗口操作失败时写入通知。
 *
 * 桌面外壳以注入的 `__TAURI_INTERNALS__` 模拟，只在渲染与点击期间存在：store 的模块在导入时按是否为桌面端
 * 执行初始化，先注入再导入会使同一进程中的其他测试文件沿用桌面端的初始化结果。
 * 测试 DOM 在本文件内注册，结束后注销，理由同 `settings/LoadState.test.tsx`。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** 原始失败形状：外壳命令返回错误时按钮点击后没有任何变化，用户无法区分失败与未点中。 */
test('窗口操作失败时写入通知', async () => {
  const store = await import('../lib/store/index.ts')
  const { render } = await import('solid-js/web')
  const { WindowControls } = await import('./WindowControls.tsx')
  const g = globalThis as Record<string, unknown>
  g.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (cmd: string) => {
      if (cmd === 'window_is_maximized') return false
      if (cmd === 'window_minimize') throw '窗口最小化失败'
      return null
    },
  }
  store.setState('notice', null)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <WindowControls />, host)
  try {
    host.querySelector<HTMLButtonElement>('button[aria-label="最小化"]')!.click()
    for (let i = 0; i < 100 && !store.state.notice; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(store.state.notice?.message).toBe('窗口操作失败：窗口最小化失败')
  } finally {
    dispose()
    host.remove()
    delete g.__TAURI_INTERNALS__
    store.setState('notice', null)
  }
})
