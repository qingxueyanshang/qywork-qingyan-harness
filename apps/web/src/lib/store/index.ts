/**
 * 前端状态的对外接口。
 *
 * 状态按位置分为类型、store、连接、会话投影、用户动作与设置请求几个模块，
 * 划分依据是位置而非职责：对外只有这一个入口，组件不直接 import 子模块。
 */

export * from './actions.ts'
export * from './browser.ts'
// 画布：使用具名导出，理由同下方 shell 与 theme 的导出。
export {
  CANVAS_SUFFIX,
  type CanvasEdit,
  type CanvasQuote,
  cancelCard,
  canvasAvailable,
  canvasTitle,
  captureFrame,
  createCanvas,
  editCanvas,
  exportAbort,
  exportFinish,
  exportStart,
  exportWrite,
  importToCanvas,
  quoteCard,
  readCanvas,
  restoreCanvas,
  retrieveCard,
  runCard,
  uploadToCanvas,
  WORKSPACE_PATH_TYPE,
} from './canvas.ts'
export * from './connection.ts'
export * from './settings.ts'
// 使用具名导出，不沿用上方的 `export *`：B6 的判据是「该模块对外承诺了什么」，
// 而 shell 与 theme 只对外承诺列出的符号。
export {
  type DropSink,
  isDesktopShell,
  registerDropSink,
  tauriInvoke,
  tauriListen,
} from './shell.ts'
export * from './state.ts'
export { initTheme, setTheme, type ThemePref, theme } from './theme.ts'
export * from './ui.ts'
