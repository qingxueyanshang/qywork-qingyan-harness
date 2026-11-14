/**
 * 覆盖范围：`caret.ts` 的接管判定与 `custom-caret` 类的增减。
 * 光标的像素位置依赖浏览器排版，本文件的 DOM 环境没有排版，不在此处验证。
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
