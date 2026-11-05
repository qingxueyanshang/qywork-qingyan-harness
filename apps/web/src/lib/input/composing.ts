/**
 * 输入法组合中的按键：组合期间的回车用于选词，不能作为提交或发送。
 *
 * 不要只判断 `isComposing`：macOS 的 WebKit（Tauri 在 macOS 上的 WKWebView 与 Safari）先触发 `compositionend`，
 * 再触发确认选词的那次 `keydown`，此时 `isComposing` 已为 false，`keyCode` 为 229。
 */
export function composing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229
}
