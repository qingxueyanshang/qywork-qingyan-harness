import { onCleanup, onMount } from 'solid-js'

/** 提示与触发元素之间的间距。 */
const GAP = 6
/**
 * 从悬停到显示提示的延迟。原生 `title` 约为 1s，延迟过长时看起来像没有提示；
 * 短于 200ms 时，鼠标划过工具栏会使提示连续闪烁。
 */
const DELAY = 350

/**
 * 悬停提示。整个应用只有一个实例，读取触发元素上的 `data-tip`。
 *
 * **不使用原生 title。** `title` 的气泡由系统绘制，CSS 无法控制：字体、圆角、配色与延迟都不可调整，
 * 暗色主题下仍显示为系统亮色的白底细边框。要与界面使用同一套令牌，只能自行绘制。
 * 因此 `title` 在本应用中只保留无障碍用途（`iframe` 的名称），
 * 悬停文案一律使用 `data-tip`。
 *
 * **单实例 + fixed 定位。** 触发元素大多位于 `overflow: hidden` 的容器中（输入区工具栏、侧栏列表、
 * 文件树），用 `::after` 附加在触发元素上会被祖先元素裁切。fixed 定位脱离所有滚动容器，并能在
 * 靠近视口下边缘时改为显示在上方。
 *
 * **边界**：
 * - 禁用的表单控件不派发指针事件，设在其上的 `data-tip` 不会显示。
 *   需要在禁用状态说明原因时，把提示设在外层容器上。
 * - 触摸设备不显示提示：触摸设备没有悬停状态，显示的提示会遮挡手指下方的内容。
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
    // 先测量再定位：offsetWidth 不受 transform 影响，读取的是排版后的实际尺寸。
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
    // 只响应键盘产生的焦点：鼠标点击按钮同样会触发 focus，此时提示多余，
    // 且鼠标移开后仍会显示，直到焦点转移才消失。
    if (!t?.dataset.tip || !t.matches(':focus-visible')) return
    target = t
    show(t)
  }

  onMount(() => {
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerdown', hide)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', hide)
    // 在捕获阶段监听：scroll 不冒泡，容器内的滚动只能在捕获阶段接收。
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

  // aria-hidden：无障碍名称由触发元素自身的 aria-label 或正文提供，
  // 此处再次朗读会重复。
  return <div class="tooltip" ref={el} aria-hidden="true" />
}
