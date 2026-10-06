/**
 * 外观：跟随系统 / 浅色 / 深色。
 *
 * 主题不写入服务端配置。服务端配置决定本机 agent 如何运行，主题决定当前屏幕如何显示。
 * 桌面端与手机端连接同一个 `qy serve`：主题写入服务端时，手机上切换为深色会使桌面端随之切换。
 * 此外首屏即需要主题：经由服务端时，第一帧只能按推测的主题渲染，HTTP 返回后再切换，产生明显的闪白。
 *
 * 代价是更换设备后需要重新设置。该代价可以接受：主题不是配置，而是当前屏幕的偏好。
 *
 * 主题是三态而不是布尔值。`system` 必须是独立的一态，不能用「深色开关 = 关」代替：否则系统切换为深色时
 * 应用不随之切换，且「亮色」与「跟随」两档在界面上无法区分。
 *
 * 对应的 CSS：`system` 时不写 `data-theme`，交给 `tokens.css` 中的
 * `@media (prefers-color-scheme: dark)` 分支；另外两态写入固定属性，优先于媒体查询。
 * `data-theme` 只由本文件设置，修改此处前先确认两处 CSS 的判据仍与之一致。
 */

import { createSignal } from 'solid-js'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'qywork.theme'

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    // 隐私模式下 localStorage 会直接抛错。主题无法读取时不应导致应用无法启动。
    return 'system'
  }
}

function apply(pref: ThemePref): void {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
}

const [theme, setThemeSignal] = createSignal<ThemePref>(read())

export { theme }

/**
 * 将已保存的偏好写入 DOM。由入口在 `render()` 之前同步调用一次。
 *
 * 不在模块顶层直接执行：`import` 的副作用会经由 `store/index.ts` 传递到每一个
 * 引用 store 的模块，包括在没有 DOM 的环境中运行的单测，这些单测在 import 时即报
 * `document is not defined`，且报错位于与主题无关的测试文件中。
 *
 * 也不放在 `onMount` 中：此时第一帧已渲染完成，系统为亮色而用户选择深色时会先出现闪白。
 * 在入口的 render 之前调用可同时避免这两个问题。
 */
export function initTheme(): void {
  apply(theme())
}

export function setTheme(pref: ThemePref): void {
  setThemeSignal(pref)
  apply(pref)
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    // 保存失败只影响下次启动时恢复主题，本次切换已生效，无需提示用户。
  }
}
