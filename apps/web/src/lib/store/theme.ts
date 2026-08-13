/**
 * 外观：跟随系统 / 浅色 / 深色。
 *
 * ## 为什么不进服务端配置
 *
 * 服务端配置回答「这台机器上 agent 怎么跑」；主题回答「这块屏幕怎么画」。
 * 桌面端和手机端连的是**同一个** `qy serve`——主题写进服务端，手机上调成深色
 * 桌面跟着变。而且首屏就要用它：走服务端意味着第一帧只能先画一个猜的主题，
 * 等 HTTP 回来再翻，那是肉眼可见的闪白。
 *
 * 代价是换台机器要重设一次。接受——它不是配置，是这块屏幕的偏好。
 *
 * ## 三态，不是布尔
 *
 * `system` 必须是独立的一态，不能用「深色开关 = 关」代替：那样系统切到深色时
 * 应用不会跟，而用户以为自己选的是「亮色」还是「跟随」，界面上分不出来。
 *
 * 对应到 CSS：`system` 时**不写** `data-theme`，交给 `tokens.css` 里的
 * `@media (prefers-color-scheme: dark)` 分支；另外两态写死属性，压过媒体查询。
 * 那两块 CSS 从写下来那天就在，只是全仓没有一行代码设置过这个属性——
 * 在这个文件出现之前它们是死的。
 */

import { createSignal } from 'solid-js'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'qywork.theme'

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    // 隐私模式下 localStorage 会直接抛。主题读不出来不该让应用起不来。
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
 * 把存下来的偏好写到 DOM 上。**由入口在 `render()` 之前同步调一次。**
 *
 * 不在模块顶层直接跑：`import` 的副作用会跟着 `store/index.ts` 传染到每一个
 * 引用 store 的模块，包括跑在没有 DOM 的环境里的单测——那边一 import 就
 * `document is not defined`，而报错点在一个和主题毫无关系的测试文件里。
 *
 * 也不放 `onMount`：那时第一帧已经画完了，系统是亮色而用户选了深色时会先闪一下白。
 * 入口里 render 之前调，两个问题都没有。
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
    // 存不下只影响下次启动记不住，这一次的切换已经生效了，不用打扰用户。
  }
}
