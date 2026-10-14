/** 覆盖接口标签的宽度折叠、当前项保留、列表更新及菜单键盘操作。 */
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

async function fixture(
  check: (f: {
    root: HTMLElement
    resize: (width: number) => void
    names: (names: string[]) => void
    current: () => string
    settle: () => Promise<void>
  }) => Promise<void>,
) {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { ProviderTabs } = await import('./ProviderTabs.tsx')
  const [names, setNames] = createSignal(['first', 'second', 'third', 'fourth'])
  const [current, setCurrent] = createSignal('first')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(
    () => (
      <ProviderTabs
        names={names()}
        current={current()}
        live="second"
        library={false}
        onPick={setCurrent}
      />
    ),
    host,
  )
  const root = host.querySelector<HTMLElement>('.tab-strip')!
  let width = 210
  Object.defineProperty(root.querySelector('.provider-tabs')!, 'clientWidth', { get: () => width })
  root.style.columnGap = '16px'
  root.querySelector<HTMLElement>('.provider-tabs')!.style.columnGap = '16px'
  root.querySelector<HTMLElement>('.provider-tab-list')!.style.columnGap = '16px'
  root.querySelector<HTMLElement>('.provider-tab-actions')!.getBoundingClientRect = () =>
    ({ width: 100 }) as DOMRect
  const measure = () => {
    for (const item of root.querySelectorAll<HTMLElement>('.provider-tabs-measure > span')) {
      item.getBoundingClientRect = () => ({ width: 60 }) as DOMRect
    }
    root.querySelector<HTMLElement>('.provider-more-measure')!.getBoundingClientRect = () =>
      ({ width: 40 }) as DOMRect
  }
  measure()
  const settle = async () => {
    await Promise.resolve()
  }
  try {
    await settle()
    await check({
      root,
      current,
      settle,
      resize: (next) => {
        width = next
        // happy-dom 不执行布局；更新属性触发同一测量入口。
        setNames([...names()])
      },
      names: (next) => {
        setNames(next)
        measure()
      },
    })
  } finally {
    dispose()
    host.remove()
  }
}

const visibleNames = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLButtonElement>('button.provider-tab')].map(
    (item) => item.textContent,
  )

test('超宽接口收进菜单，选择隐藏接口后主栏始终显示当前项', async () => {
  await fixture(async ({ root, current, settle, resize }) => {
    expect(visibleNames(root)).toEqual(['first', 'second'])
    root.querySelector<HTMLButtonElement>('.provider-more')!.click()
    const items = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['third', 'fourth'])
    items[1]!.click()
    await settle()
    expect(current()).toBe('fourth')
    expect(visibleNames(root)).toEqual(['first', 'fourth'])
    expect(root.querySelector('.provider-tabs-menu')).toBeNull()
    expect(document.activeElement?.textContent).toBe('fourth')
    resize(100)
    await settle()
    expect(visibleNames(root)).toEqual(['fourth'])
    root.querySelector<HTMLButtonElement>('.provider-more')!.click()
    expect(root.querySelector('.provider-menu-item.live')?.textContent).toBe('second')
    resize(500)
    await settle()
    expect(visibleNames(root)).toEqual(['first', 'second', 'third', 'fourth'])
    expect(root.querySelector('.provider-more')).toBeNull()
    expect(root.querySelector('.provider-tabs-menu')).toBeNull()
  })
})

test('接口增加和移除后重新折叠，空列表仍可正常显示', async () => {
  await fixture(async ({ root, names, settle }) => {
    names(['first'])
    await settle()
    expect(visibleNames(root)).toEqual(['first'])
    expect(root.querySelector('.provider-more')).toBeNull()
    names(['first', 'another', 'third', 'fourth'])
    await settle()
    expect(visibleNames(root)).toEqual(['first', 'another'])
    names([])
    await settle()
    expect(visibleNames(root)).toEqual([])
    expect(root.querySelector('.provider-more')).toBeNull()
  })
})

test('菜单支持方向键、Escape 和外部点击，Escape 不传递给设置弹窗', async () => {
  await fixture(async ({ root }) => {
    const more = root.querySelector<HTMLButtonElement>('.provider-more')!
    const key = (value: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
      )
    more.focus()
    key('ArrowDown')
    expect(document.activeElement?.textContent).toBe('third')
    key('ArrowDown')
    expect(document.activeElement?.textContent).toBe('fourth')
    key('Home')
    expect(document.activeElement?.textContent).toBe('third')
    let escaped = false
    const onEscape = () => {
      escaped = true
    }
    window.addEventListener('keydown', onEscape)
    try {
      key('Escape')
      expect(escaped).toBe(false)
      expect(root.querySelector('.provider-tabs-menu')).toBeNull()
      expect(document.activeElement).toBe(more)
    } finally {
      window.removeEventListener('keydown', onEscape)
    }
    more.click()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(root.querySelector('.provider-tabs-menu')).toBeNull()
  })
})
