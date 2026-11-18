/** 覆盖图片预览的刷新位置、资源切换、加载失败恢复与缩放快捷键；实际布局由浏览器检查。 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

let dispose: (() => void) | undefined
let measure: (width: number, height: number) => void
let originalObserver: typeof ResizeObserver

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents, DelegatedEvents } = await import('solid-js/web')
  delegateEvents([...DelegatedEvents])
  originalObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      measure = (width, height) => {
        callback(
          [{ contentRect: { width, height } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver
})

afterEach(async () => {
  dispose?.()
  document.body.replaceChildren()
  // 缩放模式与阅读位置在挂载之间保留（刷新恢复），每条用例从未记录的状态开始。
  const { flushSession } = await import('../lib/session.ts')
  flushSession()
  sessionStorage.clear()
})

afterAll(async () => {
  globalThis.ResizeObserver = originalObserver
  await GlobalRegistrator.unregister()
})

async function mount() {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { default: FileImageView } = await import('./FileImageView.tsx')
  const { PreviewToolsContext } = await import('./preview/tools.ts')
  type Render = import('./preview/tools.ts').ToolsRender
  const [preview, setPreview] = createSignal({ src: '/long.png?v=1', path: 'long.png' })
  // 与文件页相同：视图提供的控件渲染在标题行中。
  const [tools, setTools] = createSignal<Render | null>(null)
  const slot = {
    show: (r: Render) => setTools(() => r),
    hide: (r: Render) => {
      if (tools() === r) setTools(null)
    },
  }
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(
    () => (
      <PreviewToolsContext.Provider value={slot}>
        <span class="preview-tools">{tools()?.()}</span>
        <FileImageView src={preview().src} path={preview().path} />
      </PreviewToolsContext.Provider>
    ),
    host,
  )
  measure(800, 600)
  const image = host.querySelector('img')!
  const load = (width: number, height: number) => {
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: width },
      naturalHeight: { configurable: true, value: height },
    })
    image.dispatchEvent(new Event('load'))
  }
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === label)!
  return { host, setPreview, image, load, button }
}

test('同一资源的预览结果刷新时保留缩放与长图阅读位置，仅在切换图片时重置', async () => {
  const { host, setPreview, image, load, button } = await mount()
  load(1000, 10000)
  button('适应宽度').click()
  const viewport = host.querySelector<HTMLElement>('.image-preview-viewport')!
  viewport.scrollTop = 3000
  const width = image.style.width
  setPreview({ src: '/long.png?v=1', path: 'long.png' })
  expect(button('适应宽度').getAttribute('aria-pressed')).toBe('true')
  expect(image.style.width).toBe(width)
  expect(viewport.scrollTop).toBe(3000)

  setPreview({ src: '/portrait.png?v=1', path: 'portrait.png' })
  expect(button('适应窗口').getAttribute('aria-pressed')).toBe('true')
  expect(viewport.scrollTop).toBe(0)
  expect(button('适应窗口').disabled).toBe(true)
  load(1080, 1920)
  expect(button('适应窗口').disabled).toBe(false)
  expect(image.style.visibility).toBe('visible')
})

/** 原始失败形状：整页刷新后图片回到「适应窗口」与顶部。刷新以 `flushSession` 后重新挂载模拟。 */
test('刷新后同一张图片恢复缩放模式与阅读位置', async () => {
  const { flushSession } = await import('../lib/session.ts')
  const first = await mount()
  first.load(1000, 10000)
  first.button('适应宽度').click()
  const before = first.host.querySelector<HTMLElement>('.image-preview-viewport')!
  before.scrollTop = 3000
  before.dispatchEvent(new Event('scroll'))
  dispose?.()
  document.body.replaceChildren()
  flushSession()

  const second = await mount()
  expect(second.button('适应宽度').getAttribute('aria-pressed')).toBe('true')
  second.load(1000, 10000)
  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(second.host.querySelector<HTMLElement>('.image-preview-viewport')!.scrollTop).toBe(3000)
})

test('加载失败时显示错误并禁用缩放，切换到有效图片后恢复', async () => {
  const { host, setPreview, image, load, button } = await mount()
  image.dispatchEvent(new Event('error'))
  expect(host.textContent).toContain('无法加载图片')
  expect(button('适应窗口').disabled).toBe(true)
  setPreview({ src: '/valid.png?v=1', path: 'valid.png' })
  load(120, 80)
  expect(host.textContent).not.toContain('无法加载图片')
  expect(button('适应窗口').disabled).toBe(false)
  expect(image.style.width).toBe('120px')
  expect(image.style.height).toBe('80px')
})

/** 原始失败形状：图片只能用按钮缩放，Ctrl+滚轮与 Ctrl+加减号没有反应。 */
test('Ctrl+滚轮缩放图片，未按 Ctrl 的滚轮不缩放', async () => {
  const { host, load } = await mount()
  load(1000, 500)
  const viewport = host.querySelector<HTMLElement>('.image-preview-viewport')!
  const ratio = () => host.querySelector('output')!.textContent
  expect(ratio()).toBe('80%')

  const plain = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
  viewport.dispatchEvent(plain)
  expect(plain.defaultPrevented).toBe(false)
  expect(ratio()).toBe('80%')

  const zoomed = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
  // 测试环境的 WheelEvent 不读取初始化参数中的 ctrlKey，在事件上直接定义。
  Object.defineProperty(zoomed, 'ctrlKey', { value: true })
  viewport.dispatchEvent(zoomed)
  expect(zoomed.defaultPrevented).toBe(true)
  // 一格约 100 像素，放大 e^0.15 倍。
  expect(ratio()).toBe('93%')
})

test('Ctrl+加减号缩放图片，Ctrl+0 回到适应窗口；焦点在输入框中或图片隐藏时不响应', async () => {
  const { host, load, button } = await mount()
  load(1000, 500)
  const viewport = host.querySelector<HTMLElement>('.image-preview-viewport')!
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 800 })
  const ratio = () => host.querySelector('output')!.textContent
  const press = (key: string, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', {
      key,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }

  expect(press('=')).toBe(true)
  expect(ratio()).toBe('100%')
  expect(press('-')).toBe(true)
  expect(ratio()).toBe('80%')
  press('+')
  expect(button('适应窗口').getAttribute('aria-pressed')).toBe('false')
  expect(press('0')).toBe(true)
  expect(button('适应窗口').getAttribute('aria-pressed')).toBe('true')

  const input = document.createElement('input')
  document.body.append(input)
  expect(press('=', input)).toBe(false)
  expect(ratio()).toBe('80%')

  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 0 })
  expect(press('=')).toBe(false)
  expect(ratio()).toBe('80%')
})

/** 原始失败形状：记录按带修改时间的地址匹配，图片被改写后缩放回到适应窗口、滚动回到顶部。 */
test('图片被改写后按路径保留缩放与阅读位置', async () => {
  const { host, setPreview, load, button } = await mount()
  load(1000, 10000)
  button('适应宽度').click()
  const viewport = host.querySelector<HTMLElement>('.image-preview-viewport')!
  viewport.scrollTop = 3000
  viewport.dispatchEvent(new Event('scroll'))

  setPreview({ src: '/long.png?v=2', path: 'long.png' })
  expect(button('适应宽度').getAttribute('aria-pressed')).toBe('true')
  load(1000, 10000)
  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(viewport.scrollTop).toBe(3000)
})
