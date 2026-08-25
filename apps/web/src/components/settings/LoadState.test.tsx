/**
 * 覆盖 `LoadState.tsx`。
 *
 * ## DOM 在这里装，用完卸掉
 *
 * 不放进预载：happy-dom 的全局里带着它自己那份 `fetch`，而服务端那些包的测试要的是
 * Bun 原生的——装成全局，一百多个测试当场变红。
 *
 * ## 为什么要动态 import
 *
 * `LoadState.tsx` 一路 import 到 `lib/store`，那里顶层 `new QyClient(...)` 会读
 * `location` / `sessionStorage`。静态 import 在 `beforeAll` 之前就求值了，读不到。
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

describe('读取中不抢在数据前面出场', () => {
  test('门槛内数据就到了，那行字从来没画过', async () => {
    const { host, dispose } = await mount({ error: undefined })
    expect(host.textContent).toBe('')
    // 本机取数实测一帧（约 30ms）就回。这里等到远超一帧、仍在门槛内。
    await Bun.sleep(80)
    expect(host.textContent).toBe('')
    dispose()
  })

  test('真的慢了才出场', async () => {
    const { host, dispose } = await mount({ error: undefined })
    await Bun.sleep(260)
    expect(host.textContent).toContain('读取中')
    dispose()
  })

  test('失败不受门槛管，来了就画，且带一条重试的路', async () => {
    const { host, dispose } = await mount({ error: new Error('boom') })
    expect(host.textContent).toContain('重试')
    expect(host.textContent).not.toContain('读取中')
    dispose()
  })
})
