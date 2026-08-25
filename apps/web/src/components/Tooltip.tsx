import { onCleanup, onMount } from 'solid-js'

/** 提示与触发元素之间留的空。 */
const GAP = 6
/**
 * 悬停到出现之间的等待。原生 `title` 约 1s，慢到读起来像没有提示；
 * 短于 200ms 则划过工具栏时连续闪烁。
 */
const DELAY = 350

/**
 * 悬停提示。整个应用一个实例，读触发元素上的 `data-tip`。
 *
 * **不用原生 title。** `title` 的气泡由系统绘制，CSS 够不着：字体、圆角、配色、延迟都不受控，
 * 暗色主题下它仍是系统亮色的白底细框。要它跟界面同一套令牌，只能自己画。
 * 因此 `title` 在这个应用里只保留它的无障碍用途（`iframe` 的名字），
 * 悬停文案一律走 `data-tip`。
 *
 * **单实例 + fixed 定位。** 触发点大多在 `overflow: hidden` 的容器里（输入区工具栏、侧栏列表、文件
 * 树），用 `::after` 挂在触发元素上会被祖先裁掉。fixed 脱离所有滚动容器，并能在贴近视口下沿时翻到
 * 上方。
 *
 * **边界**：
 * - 禁用的表单控件不派发指针事件，挂在它身上的 `data-tip` 不会出现。
 *   要在禁用态解释原因，把提示挂到外层容器。
 * - 触摸设备不出提示：没有「悬停」这个状态，出来就是挡住手指底下那一块。
 */
export function Tooltip() {
  let el!: HTMLDivElement
  let timer: ReturnType<typeof setTimeout> | undefined
  let target: HTMLElement | null = null

  const hide = () => {
    clearTimeout(timer)
    target = null
    el.classList.remove('show')
  }

  const show = (t: HTMLElement) => {
    const text = t.dataset.tip
    if (!text || !t.isConnected) return
    el.textContent = text
    // 先量再摆：offsetWidth 不受 transform 影响，读到的是排版后的真实尺寸。
    const r = t.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const below = r.bottom + GAP + h <= innerHeight
    const y = below ? r.bottom + GAP : r.top - GAP - h
    const x = Math.min(Math.max(GAP, r.left + r.width / 2 - w / 2), innerWidth - w - GAP)
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    el.classList.add('show')
  }

  const pick = (e: Event): HTMLElement | null =>
    (e.target as Element | null)?.closest<HTMLElement>('[data-tip]') ?? null

  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    const t = pick(e)
    if (t === target) return
    hide()
    if (!t?.dataset.tip) return
    target = t
    timer = setTimeout(() => show(t), DELAY)
  }

  const onFocus = (e: FocusEvent) => {
    hide()
    const t = pick(e)
    // 只认键盘留下的焦点：点一下按钮同样会 focus，那时提示是多余的，
    // 而且鼠标移开后它仍显示，直到焦点转移到别处才消失。
    if (!t?.dataset.tip || !t.matches(':focus-visible')) return
    target = t
    show(t)
  }

  onMount(() => {
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerdown', hide)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', hide)
    // 捕获阶段：scroll 不冒泡，容器内的滚动只能这样收到。
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
  })

  onCleanup(() => {
    clearTimeout(timer)
    document.removeEventListener('pointerover', onOver)
    document.removeEventListener('pointerdown', hide)
    document.removeEventListener('focusin', onFocus)
    document.removeEventListener('focusout', hide)
    document.removeEventListener('scroll', hide, true)
    window.removeEventListener('blur', hide)
  })

  // aria-hidden：无障碍名字由触发元素自己的 aria-label 或正文给出，
  // 这里再念一遍就是重复。
  return <div class="tooltip" ref={el} aria-hidden="true" />
}
