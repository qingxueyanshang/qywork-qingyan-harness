/**
 * 覆盖 `LoadState.tsx`。
 *
 * DOM 在本文件中注册，用后注销，不放入预载：happy-dom 的全局对象带有自己的 `fetch`，而服务端各包
 * 的测试需要 Bun 原生的 `fetch`；注册为全局时，服务端的大量测试会失败。
 *
 * 使用动态 import 的原因：`LoadState.tsx` 逐层 import 到 `lib/store`，该模块顶层的
 * `new QyClient(...)` 会读取 `location` / `sessionStorage`。静态 import 在 `beforeAll` 之前就已求值，
 * 无法读取。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mount(props: { error: unknown }) {
  const { render } = await import('solid-js/web')
  const { LoadState } = await import('./LoadState.tsx')
  const host = document.createElement('div')
  const dispose = render(
    () => <LoadState error={props.error} onRetry={() => {}} />,
    host as unknown as HTMLElement,
  )
  return { host, dispose }
}

describe('「读取中」不先于数据显示', () => {
  test('数据在阈值内返回时，「读取中」不渲染', async () => {
    const { host, dispose } = await mount({ error: undefined })
    expect(host.textContent).toBe('')
    // 本机取数实测在一帧（约 30ms）内返回。此处等待时间远超一帧，但仍在阈值内。
    await Bun.sleep(80)
    expect(host.textContent).toBe('')
    dispose()
  })

  test('超过阈值仍未返回时才显示', async () => {
    const { host, dispose } = await mount({ error: undefined })
    await Bun.sleep(260)
    expect(host.textContent).toContain('读取中')
    dispose()
  })

  test('失败不受阈值限制，立即显示并提供重试按钮', async () => {
    const { host, dispose } = await mount({ error: new Error('boom') })
    expect(host.textContent).toContain('重试')
    expect(host.textContent).not.toContain('读取中')
    dispose()
  })
})
