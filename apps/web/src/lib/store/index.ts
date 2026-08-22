/**
 * 前端状态的对外面。
 *
 * 拆开之前这是一个 947 行的文件，同时装着类型、那一份 store、连接、
 * 会话投影、用户动作和五个设置面板的请求。**拆的是位置不是职责**——
 * 对外仍然是这一个入口，17 个组件的 import 一行没改。
 */

export * from './actions.ts'
export * from './connection.ts'
export * from './settings.ts'
// 具名，不跟上面几行的 `export *`——B6 的判据是「这个模块对外承诺了什么」，
// 而 theme 只承诺三个符号。上面几行是拆分前就有的形状，不在这次改动范围内。
export { isDesktopShell, tauriInvoke, tauriListen } from './shell.ts'
export * from './state.ts'
export { initTheme, setTheme, type ThemePref, theme } from './theme.ts'
export * from './ui.ts'
