/**
 * 文本光标：输入框与多行文本框获得焦点时隐藏浏览器的光标，在同一位置绘制一个 2px 宽的强调色光标
 * （样式见 `base.css` 的 `.text-caret`）。浏览器的光标只能设置颜色，不能设置宽度与高度。
 *
 * 约束：
 * - 只接管能读取选区的输入框类型（`TRACKED_TYPES`）与 textarea。其余类型（email、number 等）的
 *   `selectionStart` 为 null，保留浏览器的光标，颜色由 `base.css` 的 `caret-color` 设为强调色。
 * - 终端（`.xterm`）自行绘制光标，其中的辅助 textarea 不接管。
 * - 触屏设备不接管：系统在光标处显示拖动手柄，位置由浏览器的光标决定。
 * - 接管期间元素带 `custom-caret` 类，该类隐藏浏览器的光标。选中一段文字或失去焦点时移除该类，
 *   不要在别处给输入框写 `caret-color: transparent`。
 */

const TRACKED_TYPES = new Set(['text', 'search', 'password', 'tel', 'url'])

/** 光标高度与字号的比值。 */
const HEIGHT_RATIO = 1.3

/** 光标停止移动后开始闪烁之前的等待，毫秒；移动与输入期间光标常亮。 */
const BLINK_DELAY_MS = 500

/** 决定文字排版的样式，逐项复制到测量元素。 */
const MIRROR_PROPS = [
  'direction',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontFamily',
  'fontKerning',
  'fontFeatureSettings',
  'lineHeight',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
] as const

type Field = HTMLInputElement | HTMLTextAreaElement

/** 光标相对于元素边框盒左上角的位置与高度，已减去元素内部的滚动。 */
interface Offset {
  x: number
  y: number
  height: number
}

/** 该元素的光标是否由本模块绘制。 */
export function tracksCaret(el: Element | null): el is Field {
  if (!el || el.closest('.xterm')) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  return (
    el instanceof HTMLInputElement && TRACKED_TYPES.has(el.type) && !el.readOnly && !el.disabled
  )
}

/**
 * 光标在元素中的位置：把光标之前的文字放入与元素排版相同的不可见元素，取其后一个标记的位置。
 * 多行文本框的换行位置取决于内容宽度，测量元素的宽度取元素去掉滚动条之后的宽度。
 * 单行输入框的文字在内容盒中垂直居中，测量元素不居中，纵向位置按内容盒计算。
 */
function measure(el: Field, mirror: HTMLDivElement): Offset {
  const cs = getComputedStyle(el)
  const px = (v: string) => Number.parseFloat(v) || 0
  const multiline = el instanceof HTMLTextAreaElement
  const s = mirror.style
  for (const prop of MIRROR_PROPS) s[prop] = cs[prop]
  s.setProperty('-webkit-text-security', cs.getPropertyValue('-webkit-text-security'))
  s.boxSizing = 'border-box'
  s.border = '0'
  s.width = `${el.clientWidth}px`
  s.whiteSpace = multiline ? 'pre-wrap' : 'pre'
  s.overflowWrap = multiline ? 'break-word' : 'normal'

  const at = el.selectionStart ?? 0
  const marker = document.createElement('span')
  // 标记须有内容才有行盒；内容取光标之后的文字，使光标所在的词按元素中的方式换行。
  marker.textContent = el.value.slice(at) || '.'
  mirror.replaceChildren(document.createTextNode(el.value.slice(0, at)), marker)

  const height = px(cs.fontSize) * HEIGHT_RATIO
  const x = px(cs.borderLeftWidth) + marker.offsetLeft - el.scrollLeft
  if (multiline) {
    const line = px(cs.lineHeight) || marker.offsetHeight || height
    const y = px(cs.borderTopWidth) + marker.offsetTop - el.scrollTop + (line - height) / 2
    return { x, y, height }
  }
  const content = el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)
  const y = px(cs.borderTopWidth) + px(cs.paddingTop) + (content - height) / 2
  return { x, y, height }
}

/**
 * 安装文本光标，返回卸载函数。整个文档共用一个光标元素与一个测量元素；
 * 光标元素放在顶层（popover），模态对话框中的输入框同样可见。
 */
export function installCaret(): () => void {
  if (matchMedia('(pointer: coarse)').matches) return () => {}

  const caret = document.createElement('div')
  caret.className = 'text-caret'
  caret.setAttribute('aria-hidden', 'true')
  const topLayer = typeof caret.showPopover === 'function'
  if (topLayer) caret.popover = 'manual'
  else caret.hidden = true
  const mirror = document.createElement('div')
  mirror.className = 'text-caret-mirror'
  mirror.setAttribute('aria-hidden', 'true')
  document.body.append(mirror, caret)

  let field: Field | null = null
  let offset: Offset | null = null
  let dirty = false
  let frame = 0
  let blinkTimer: ReturnType<typeof setTimeout> | undefined
  let last = ''
  const resize = new ResizeObserver(() => {
    dirty = true
  })

  const show = (on: boolean) => {
    if (!topLayer) caret.hidden = !on
    else if (on && !caret.matches(':popover-open')) caret.showPopover()
    else if (!on && caret.matches(':popover-open')) caret.hidePopover()
  }

  const release = () => {
    if (!field) return
    field.classList.remove('custom-caret')
    resize.disconnect()
    cancelAnimationFrame(frame)
    clearTimeout(blinkTimer)
    field = null
    offset = null
    last = ''
    show(false)
  }

  /** 每帧按元素当前的位置放置光标：元素随滚动、动画与布局变化移动时没有事件可以监听。 */
  const paint = () => {
    const el = field
    if (!el) return
    frame = requestAnimationFrame(paint)
    if (dirty || !offset) {
      offset = measure(el, mirror)
      dirty = false
    }
    const box = el.getBoundingClientRect()
    // 光标所在的行滚动到元素可见范围之外时不绘制。
    const visible =
      offset.x >= 0 &&
      offset.x <= box.width &&
      offset.y + offset.height > 0 &&
      offset.y < box.height
    show(visible)
    if (!visible) return
    // 横向以光标位置为中线（光标宽 2px），不压住其后的第一个字。
    const next = `translate(${Math.round(box.left + offset.x) - 1}px, ${Math.round(box.top + offset.y)}px)`
    if (next === last) return
    last = next
    caret.style.transform = next
    caret.style.height = `${offset.height}px`
    caret.classList.remove('blink')
    clearTimeout(blinkTimer)
    blinkTimer = setTimeout(() => caret.classList.add('blink'), BLINK_DELAY_MS)
  }

  /** 按当前焦点与选区决定是否接管：焦点在可接管的元素上且没有选中文字时接管。 */
  const sync = () => {
    const el = document.activeElement
    if (!tracksCaret(el) || el.selectionStart !== el.selectionEnd) {
      release()
      return
    }
    dirty = true
    if (field === el) return
    release()
    field = el
    el.classList.add('custom-caret')
    resize.observe(el)
    // 重新放入顶层：其后打开的模态对话框在顶层中位于光标之上。
    show(false)
    frame = requestAnimationFrame(paint)
  }

  const markDirty = () => {
    dirty = true
  }
  document.addEventListener('selectionchange', sync)
  document.addEventListener('focusin', sync)
  document.addEventListener('focusout', sync)
  document.addEventListener('input', sync, true)
  document.addEventListener('scroll', markDirty, true)
  window.addEventListener('blur', release)
  window.addEventListener('focus', sync)
  sync()

  return () => {
    release()
    document.removeEventListener('selectionchange', sync)
    document.removeEventListener('focusin', sync)
    document.removeEventListener('focusout', sync)
    document.removeEventListener('input', sync, true)
    document.removeEventListener('scroll', markDirty, true)
    window.removeEventListener('blur', release)
    window.removeEventListener('focus', sync)
    caret.remove()
    mirror.remove()
  }
}
