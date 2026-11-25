/**
 * 窄屏上返回手势与浏览器后退关闭最上层的浮层（全屏面板、抽屉、设置、账号与确认弹窗），全部关闭之后才离开页面。
 *
 * - 浮层打开时压入一条浏览记录（地址不变），后退时关闭最上层的浮层。
 * - 浮层以其他方式关闭（关闭按钮、遮罩、Esc）时撤回它的记录：不撤回时，下一次后退只消耗这条记录，看起来没有反应。
 *   撤回经 `history.back()` 完成，随之到达的 `popstate` 不再关闭浮层（`skip`）。
 * - 只在窄屏启用：宽屏的面板与侧栏并排显示，不是浮层，鼠标侧键后退不应收起它们。打开时判定一次。
 * - 页面嵌在云端网页的 iframe 中时，iframe 内压入的记录同样位于浏览器的会话历史中，后退先回退 iframe 内的记录。
 */

import { createEffect, onCleanup } from 'solid-js'
import { narrowScreen } from './store/ui.ts'

interface Layer {
  close: () => void
}

const stack: Layer[] = []
/** 待忽略的 `popstate` 次数：撤回记录时由本模块发起的后退。 */
let skip = 0

globalThis.addEventListener?.('popstate', () => {
  if (skip > 0) {
    skip -= 1
    return
  }
  stack.pop()?.close()
})

/** 压入一层，返回撤回函数；该层已由后退关闭时撤回不做任何事。 */
function push(close: () => void): () => void {
  const layer: Layer = { close }
  stack.push(layer)
  history.pushState(history.state, '')
  return () => {
    const i = stack.indexOf(layer)
    if (i < 0) return
    stack.splice(i, 1)
    skip += 1
    history.back()
  }
}

/**
 * 在当前组件中登记一个浮层：`open()` 变为真时压入，变为假或组件卸载时撤回。后退时调用 `close`，
 * 由它使 `open()` 变为假。
 */
export function closeOnBack(open: () => boolean, close: () => void): void {
  let release: (() => void) | null = null
  const settle = () => {
    release?.()
    release = null
  }
  createEffect(() => {
    if (open()) {
      if (!release && narrowScreen()) release = push(close)
    } else settle()
  })
  onCleanup(settle)
}
