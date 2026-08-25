/**
 * 前端状态的对外面。
 *
 * 状态按位置分成类型、store、连接、会话投影、用户动作与设置请求几块，
 * **分的是位置不是职责**：对外只有这一个入口，组件不直接 import 子模块。
 */

export * from './actions.ts'
export * from './connection.ts'
export * from './settings.ts'
// 具名，不跟上面几行的 `export *`——B6 的判据是「这个模块对外承诺了什么」，
// 而 theme 只承诺三个符号。
export { isDesktopShell, tauriInvoke, tauriListen } from './shell.ts'
export * from './state.ts'
export { initTheme, setTheme, type ThemePref, theme } from './theme.ts'
export * from './ui.ts'
