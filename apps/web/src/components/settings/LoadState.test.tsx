/**
 * 覆盖 `LoadState.tsx`（`LoadState`、`Skeleton`、`PendingText`）。
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
import type { JSX } from 'solid-js'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mountWith(view: (m: typeof import('./LoadState.tsx')) => () => JSX.Element) {
  const { render } = await import('solid-js/web')
  const host = document.createElement('div')
  const dispose = render(view(await import('./LoadState.tsx')), host as unknown as HTMLElement)
  return { host, dispose }
}

const mount = (props: { error: unknown }) =>
  mountWith((m) => () => <m.LoadState error={props.error} onRetry={() => {}} lines={4} />)

describe('读取中的占位不先于数据显示', () => {
  test('数据在阈值内返回时，占位不渲染', async () => {
    const { host, dispose } = await mount({ error: undefined })
    expect(host.innerHTML).toBe('')
    // 本机取数实测在一帧（约 30ms）内返回。此处等待时间远超一帧，但仍在阈值内。
    await Bun.sleep(80)
    expect(host.innerHTML).toBe('')
    dispose()
  })

  test('超过阈值仍未返回时显示占位条，行数按 lines，不写文字', async () => {
    const { host, dispose } = await mount({ error: undefined })
    await Bun.sleep(260)
    expect(host.querySelectorAll('.skeleton-line')).toHaveLength(4)
    expect(host.textContent).toBe('')
    dispose()
  })

  test('失败不受阈值限制，立即显示原因与重试按钮，不显示占位', async () => {
    const { host, dispose } = await mount({ error: new Error('boom') })
    expect(host.textContent).toContain('重试')
    expect(host.querySelector('.skeleton')).toBeNull()
    dispose()
  })
})

describe('行内的值', () => {
  test('尚未读取到时超过阈值才显示占位条；读取到后显示值', async () => {
    const { createSignal } = await import('solid-js')
    const [value, setValue] = createSignal<string | null>(null)
    const { host, dispose } = await mountWith((m) => () => <m.PendingText value={value()} />)
    expect(host.innerHTML).toBe('')
    await Bun.sleep(260)
    expect(host.querySelector('.skeleton-inline')).not.toBeNull()
    setValue('已就绪')
    expect(host.textContent).toBe('已就绪')
    expect(host.querySelector('.skeleton-inline')).toBeNull()
    dispose()
  })
})
