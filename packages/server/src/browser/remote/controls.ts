/**
 * 远程查看中由客户端代为显示的网页控件：单选下拉框，日期、时间与颜色输入框。
 *
 * 这些控件的弹出层由浏览器在页面之外另行绘制，不在 screencast 画面中，远程查看时无法显示选项。按下时先查询该位置的元素：
 * 是这类控件时不把按下交给网页（弹出层不打开），由客户端显示选择，结果写入该元素并派发 `input` 与 `change`。
 *
 * - 同源 iframe 中的控件按 iframe 的位置换算后查询；跨源 iframe 中的控件照常交给网页。
 * - 元素以 CDP 的对象引用保留在 `OBJECT_GROUP` 中，直到回答或查看连接关闭。
 * - 值的写入使用原型上的 setter：React 等框架在实例上覆盖 `value`，直接赋值时框架不认为值已变化。
 */

import type { BrowserViewInputKind, BrowserViewPrompt } from '@qywork/core'
import type { CdpClient } from '../cdp.ts'

export const OBJECT_GROUP = 'qywork-view-controls'

export const INPUT_KINDS: readonly BrowserViewInputKind[] = [
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'color',
]

/** 查找该位置（页面视口的 CSS 像素）的可代选控件，返回元素本身；不是这类控件时返回 `null`。 */
const FIND = `(x, y, kinds) => {
  let el = document.elementFromPoint(x, y)
  while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
    let inner = null
    try { inner = el.contentDocument } catch {}
    if (!inner) return null
    const r = el.getBoundingClientRect()
    x -= r.left + el.clientLeft
    y -= r.top + el.clientTop
    el = inner.elementFromPoint(x, y)
  }
  if (!el) return null
  if (el.tagName === 'OPTION' || el.tagName === 'OPTGROUP') el = el.closest('select')
  if (!el || el.disabled) return null
  if (el.tagName === 'SELECT') return !el.multiple && el.size <= 1 ? el : null
  if (el.tagName === 'INPUT') return kinds.includes(el.type) && !el.readOnly ? el : null
  return null
}`

/** 在元素上执行：聚焦，返回弹出层的内容；位置换算到最外层页面的视口。 */
const DESCRIBE = `function () {
  this.focus({ preventScroll: true })
  const r = this.getBoundingClientRect()
  let x = r.left
  let y = r.top
  let w = this.ownerDocument.defaultView
  while (w.frameElement) {
    const f = w.frameElement.getBoundingClientRect()
    x += f.left + w.frameElement.clientLeft
    y += f.top + w.frameElement.clientTop
    w = w.parent
  }
  const rect = { x, y, width: r.width, height: r.height }
  if (this.tagName === 'SELECT') {
    return {
      type: 'select',
      rect,
      value: String(this.selectedIndex),
      options: Array.from(this.options, (o, i) => {
        const group = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null
        return {
          label: o.label || o.text,
          value: String(i),
          disabled: o.disabled || Boolean(group && group.disabled),
          group: group ? group.label : '',
        }
      }),
    }
  }
  return { type: 'input', rect, kind: this.type, value: this.value, min: this.min, max: this.max, step: this.step }
}`

/** 在元素上执行：写入选择的值并派发 `input` 与 `change`。 */
const APPLY = `function (value) {
  const w = this.ownerDocument.defaultView
  this.focus({ preventScroll: true })
  if (this.tagName === 'SELECT') {
    Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'selectedIndex').set.call(this, Number(value))
  } else {
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(this, value)
  }
  this.dispatchEvent(new w.Event('input', { bubbles: true }))
  this.dispatchEvent(new w.Event('change', { bubbles: true }))
}`

/** 弹出层的内容，不含编号。逐个成员去掉 `id`：对联合类型整体使用 `Omit` 只保留各成员共有的字段。 */
type Described =
  | Omit<Extract<BrowserViewPrompt, { type: 'select' }>, 'id'>
  | Omit<Extract<BrowserViewPrompt, { type: 'input' }>, 'id'>

/** 一个等待客户端选择的控件。 */
export interface PendingControl {
  id: number
  objectId: string
}

/**
 * 查询该位置的控件。是可代选控件时返回其引用与弹出层内容（不含 `id`），否则返回 `null`。
 * 查询失败（页面正在导航、会话已断开）同样返回 `null`：按下照常交给网页。
 */
export async function findControl(
  client: CdpClient,
  sessionId: string,
  x: number,
  y: number,
): Promise<{ objectId: string; prompt: Described } | null> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  try {
    const found = await client.send<{ result: { objectId?: string; subtype?: string } }>(
      'Runtime.evaluate',
      {
        expression: `(${FIND})(${x}, ${y}, ${JSON.stringify(INPUT_KINDS)})`,
        objectGroup: OBJECT_GROUP,
      },
      { sessionId },
    )
    const objectId = found.result.objectId
    if (!objectId || found.result.subtype === 'null') return null
    const described = await client.send<{ result: { value?: Described } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: DESCRIBE, returnByValue: true },
      { sessionId },
    )
    const prompt = described.result.value
    return prompt ? { objectId, prompt } : null
  } catch {
    return null
  }
}

/** 写入客户端选择的值。元素已不在页面中时由浏览器报错，调用方忽略：画面反映实际结果。 */
export async function applyControl(
  client: CdpClient,
  sessionId: string,
  objectId: string,
  value: string,
): Promise<void> {
  await client.send(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: APPLY, arguments: [{ value }], userGesture: true },
    { sessionId },
  )
}
