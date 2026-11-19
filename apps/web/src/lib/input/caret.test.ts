/**
 * 覆盖范围：`caret.ts` 的接管判定、`custom-caret` 类的增减，以及光标位置何时重新测量。
 * 本文件的 DOM 环境没有排版：测量元素中的横向位置按字符数模拟，只验证位置随文字更新，不验证排版结果。
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

let caret: typeof import('./caret.ts')
let uninstall: () => void = () => {}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  caret = await import('./caret.ts')
})

afterEach(() => {
  uninstall()
  uninstall = () => {}
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function field(html: string): HTMLInputElement | HTMLTextAreaElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement
}

test('接管判定：文本类输入框与多行文本框接管；无法读取选区的类型、只读、禁用与终端中的文本框不接管', () => {
  expect(caret.tracksCaret(field('<input>'))).toBe(true)
  expect(caret.tracksCaret(field('<input type="password">'))).toBe(true)
  expect(caret.tracksCaret(field('<textarea></textarea>'))).toBe(true)
  expect(caret.tracksCaret(field('<input type="email">'))).toBe(false)
  expect(caret.tracksCaret(field('<input type="number">'))).toBe(false)
  expect(caret.tracksCaret(field('<input type="checkbox">'))).toBe(false)
  expect(caret.tracksCaret(field('<input readonly>'))).toBe(false)
  expect(caret.tracksCaret(field('<textarea disabled></textarea>'))).toBe(false)
  expect(caret.tracksCaret(field('<div class="xterm"><textarea></textarea></div>'))).toBe(false)
  expect(caret.tracksCaret(null)).toBe(false)
})

test('获得焦点时隐藏浏览器的光标，选中一段文字或失去焦点时恢复；不接管的输入框不受影响；卸载后移除光标元素', () => {
  uninstall = caret.installCaret()
  expect(document.querySelectorAll('.text-caret')).toHaveLength(1)

  const text = field('<input value="abc">') as HTMLInputElement
  text.focus()
  text.setSelectionRange(1, 1)
  document.dispatchEvent(new Event('selectionchange'))
  expect(text.classList.contains('custom-caret')).toBe(true)

  text.setSelectionRange(0, 3)
  document.dispatchEvent(new Event('selectionchange'))
  expect(text.classList.contains('custom-caret')).toBe(false)

  text.setSelectionRange(3, 3)
  document.dispatchEvent(new Event('selectionchange'))
  expect(text.classList.contains('custom-caret')).toBe(true)

  const email = field('<input type="email">')
  email.focus()
  document.dispatchEvent(new Event('selectionchange'))
  expect(text.classList.contains('custom-caret')).toBe(false)
  expect(email.classList.contains('custom-caret')).toBe(false)

  const area = field('<textarea>x</textarea>')
  area.focus()
  document.dispatchEvent(new Event('selectionchange'))
  expect(area.classList.contains('custom-caret')).toBe(true)

  uninstall()
  uninstall = () => {}
  expect(area.classList.contains('custom-caret')).toBe(false)
  expect(document.querySelector('.text-caret')).toBeNull()
})

/** 测量元素中每个字符的模拟宽度，像素。 */
const CHAR_WIDTH = 8

/**
 * 原始失败形状：会话输入框发送后文字已清空、选区已在开头，光标仍绘制在原文字的末尾。
 * 发送时由脚本给 `value` 赋空串，Chromium 对此不触发 input 与 selectionchange。
 */
test('脚本清空输入框后，光标在下一帧回到开头', async () => {
  const offsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')
  if (!offsetLeft) throw new Error('HTMLElement.prototype 没有 offsetLeft')
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      // 测量元素中标记之前的文字是光标之前的文字。
      if (!this.parentElement?.classList.contains('text-caret-mirror')) return 0
      return CHAR_WIDTH * (this.previousSibling?.textContent?.length ?? 0)
    },
  })
  const nextFrame = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  const caretX = () => {
    const transform = document.querySelector<HTMLElement>('.text-caret')?.style.transform ?? ''
    return Number(/translate\((-?\d+)px/.exec(transform)?.[1])
  }
  try {
    uninstall = caret.installCaret()
    const area = field('<textarea></textarea>') as HTMLTextAreaElement
    area.getBoundingClientRect = () => new DOMRect(0, 0, 400, 60)
    area.focus()
    document.dispatchEvent(new Event('selectionchange'))
    await nextFrame()
    const start = caretX()
    expect(Number.isFinite(start)).toBe(true)

    area.value = 'hello'
    area.dispatchEvent(new Event('input', { bubbles: true }))
    await nextFrame()
    expect(caretX()).toBe(start + 5 * CHAR_WIDTH)

    area.value = ''
    await nextFrame()
    expect(area.selectionStart).toBe(0)
    expect(caretX()).toBe(start)
  } finally {
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', offsetLeft)
  }
})
