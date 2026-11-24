/**
 * 覆盖 `HoldSwitch.tsx` 与 `lib/resource.ts` 的 `suspendUntil`。
 *
 * 锁定的原始失败形状：设置切换类目、侧面板切换页签、文件页切换文件时，新内容挂载后才开始首次读取，
 * 界面先渲染「已切换、无内容」的状态一至三帧，再显示新内容（逐帧实测内容区元素数降为 0）。
 * 断言以 MutationObserver 记录每次微任务检查点上的文字：中间状态跨过检查点时会被记录。
 *
 * DOM 在本文件中注册、用后注销，使用动态 import 的原因同 `settings/LoadState.test.tsx`。
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Accessor, JSX } from 'solid-js'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
// 保留时限由假计时器推进：断言只取决于推进的时长，与机器负载无关。
beforeEach(() => {
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
})

/** 推进微任务：resource 解除挂起、Suspense 恢复与提升各经过若干个 Promise 回调。 */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function setup() {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { HoldSwitch } = await import('./HoldSwitch.tsx')
  const { suspendUntil } = await import('../lib/resource.ts')
  /** 首次读取在 `ready()` 为真时完成的页面。 */
  function Page(props: { name: string; ready: Accessor<boolean> }): JSX.Element {
    suspendUntil(props.ready)
    return <p>{props.name}</p>
  }
  const host = document.createElement('div')
  const texts: string[] = []
  const observer = new MutationObserver(() => texts.push(host.textContent ?? ''))
  observer.observe(host, { childList: true, subtree: true, characterData: true })
  return { createSignal, render, HoldSwitch, Page, suspendUntil, host, texts, observer }
}

test('切换时保留上一项，新一项首次读取完成后在同一次更新中替换，任何时刻都不为空', async () => {
  const { createSignal, render, HoldSwitch, Page, host, texts, observer } = await setup()
  const [key, setKey] = createSignal('a')
  const [readyB, setReadyB] = createSignal(false)
  const dispose = render(
    () => (
      <HoldSwitch key={key()}>
        {(k) => <Page name={k} ready={k === 'b' ? readyB : () => true} />}
      </HoldSwitch>
    ),
    host,
  )
  try {
    await flush()
    expect(host.textContent).toBe('a')
    setKey('b')
    await flush()
    expect(host.textContent).toBe('a')
    jest.advanceTimersByTime(100)
    await flush()
    expect(host.textContent).toBe('a')
    setReadyB(true)
    await flush()
    expect(host.textContent).toBe('b')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((t) => t === 'a' || t === 'b')).toBe(true)
  } finally {
    observer.disconnect()
    dispose()
  }
})

test('首次读取超过保留时限时显示新一项自身的内容，不停留在上一项', async () => {
  const { createSignal, render, HoldSwitch, Page, host, observer } = await setup()
  const [key, setKey] = createSignal('a')
  const dispose = render(
    () => <HoldSwitch key={key()}>{(k) => <Page name={k} ready={() => k === 'a'} />}</HoldSwitch>,
    host,
  )
  try {
    await flush()
    setKey('c')
    jest.advanceTimersByTime(199)
    await flush()
    expect(host.textContent).toBe('a')
    jest.advanceTimersByTime(1)
    await flush()
    expect(host.textContent).toBe('c')
  } finally {
    observer.disconnect()
    dispose()
  }
})

test('等待期间切回当前项时撤销等待中的一项，之后它完成读取也不显示', async () => {
  const { createSignal, render, HoldSwitch, Page, host, observer } = await setup()
  const [key, setKey] = createSignal('a')
  const [readyB, setReadyB] = createSignal(false)
  const dispose = render(
    () => (
      <HoldSwitch key={key()}>
        {(k) => <Page name={k} ready={k === 'b' ? readyB : () => true} />}
      </HoldSwitch>
    ),
    host,
  )
  try {
    await flush()
    setKey('b')
    await flush()
    setKey('a')
    await flush()
    setReadyB(true)
    jest.advanceTimersByTime(300)
    await flush()
    expect(host.textContent).toBe('a')
  } finally {
    observer.disconnect()
    dispose()
  }
})

/**
 * 原始失败形状：文件页中 Markdown 切换到源码时代码视图才创建，它声明的首次读取挂起已显示的一项，
 * 整个预览换为空白的后备内容，语言包取回后再出现。
 */
test('一项显示之后创建的内容声明首次读取时不再挂起该项，已显示的内容保持', async () => {
  const { createSignal, render, HoldSwitch, Page, host, texts, observer } = await setup()
  const { Show } = await import('solid-js')
  const [late, setLate] = createSignal(false)
  const dispose = render(
    () => (
      <HoldSwitch key="a">
        {(k) => (
          <div>
            <p>{k}</p>
            <Show when={late()}>
              <Page name="迟" ready={() => false} />
            </Show>
          </div>
        )}
      </HoldSwitch>
    ),
    host,
  )
  try {
    await flush()
    expect(host.textContent).toBe('a')
    setLate(true)
    await flush()
    expect(host.textContent).toBe('a迟')
    expect(texts.every((t) => t.startsWith('a'))).toBe(true)
  } finally {
    observer.disconnect()
    dispose()
  }
})

test('HoldBoundary：所在一项尚未显示时挂起交给该项，已显示之后创建时显示自身的后备内容', async () => {
  const { createSignal, render, HoldSwitch, Page, host, observer } = await setup()
  const { Show } = await import('solid-js')
  const { HoldBoundary } = await import('./HoldSwitch.tsx')
  const [key, setKey] = createSignal('a')
  const [readyB, setReadyB] = createSignal(false)
  const [late, setLate] = createSignal(false)
  const dispose = render(
    () => (
      <HoldSwitch key={key()}>
        {(k) => (
          <div>
            <p>{k}</p>
            <Show when={k === 'b'}>
              <HoldBoundary fallback={<i>载</i>}>
                <Page name="乙" ready={readyB} />
              </HoldBoundary>
            </Show>
            <Show when={k === 'b' && late()}>
              <HoldBoundary fallback={<i>载</i>}>
                <Page name="迟" ready={() => false} />
              </HoldBoundary>
            </Show>
          </div>
        )}
      </HoldSwitch>
    ),
    host,
  )
  try {
    await flush()
    setKey('b')
    await flush()
    expect(host.textContent).toBe('a')
    setReadyB(true)
    await flush()
    expect(host.textContent).toBe('b乙')

    setLate(true)
    await flush()
    expect(host.textContent).toBe('b乙载')
    jest.advanceTimersByTime(200)
    await flush()
    expect(host.textContent).toBe('b乙迟')
  } finally {
    observer.disconnect()
    dispose()
  }
})

test('嵌套时外层切换等待内层首次显示的内容', async () => {
  const { createSignal, render, HoldSwitch, Page, host, texts, observer } = await setup()
  const [outer, setOuter] = createSignal('x')
  const [ready, setReady] = createSignal(false)
  const dispose = render(
    () => (
      <HoldSwitch key={outer()}>
        {(o) => (
          <HoldSwitch key={`${o}-inner`}>
            {(i) => <Page name={i} ready={o === 'x' ? () => true : ready} />}
          </HoldSwitch>
        )}
      </HoldSwitch>
    ),
    host,
  )
  try {
    await flush()
    expect(host.textContent).toBe('x-inner')
    setOuter('y')
    await flush()
    expect(host.textContent).toBe('x-inner')
    setReady(true)
    await flush()
    expect(host.textContent).toBe('y-inner')
    expect(texts.every((t) => t === 'x-inner' || t === 'y-inner')).toBe(true)
  } finally {
    observer.disconnect()
    dispose()
  }
})
