/**
 * 外观：主题（跟随系统 / 浅色 / 深色）与正在显示的个性化。两者只由本文件写入 DOM。
 *
 * 主题不写入服务端配置。服务端配置决定本机 agent 如何运行，主题决定当前屏幕如何显示。
 * 桌面端与手机端连接同一个 `qy serve`：写入服务端时，手机上切换为深色会使桌面端随之切换。
 * 此外首屏即需要主题：经由服务端时，第一帧只能按推测的主题渲染，HTTP 返回后再切换，产生明显的闪白。
 * 代价是更换设备后需要重新设置主题，可以接受：主题不是配置，而是当前屏幕的偏好。
 *
 * 个性化只有一套，存放在服务端（所有屏幕相同）；读取与保存见 `appearance/personalization.ts`，
 * 本文件只负责把读取到的内容写入骨架变量。
 *
 * 主题是三态而不是布尔值。`system` 必须是独立的一态，不能用「深色开关 = 关」代替：否则系统切换为深色时
 * 应用不随之切换，且「亮色」与「跟随」两档在界面上无法区分。
 *
 * 对应的 CSS：`system` 时不写 `data-theme`，交给 `tokens.css` 中的
 * `@media (prefers-color-scheme: dark)` 分支；另外两态写入固定属性，优先于媒体查询。
 * `data-theme` 与个性化变量只由本文件设置，修改此处前先确认 `tokens.css` 的判据仍与之一致。
 */

import type { Personalization } from '@qywork/core'
import { createSignal } from 'solid-js'
import { luminance, mix, parseColor, toCss, withAlpha } from '../color.ts'

export type ThemePref = 'system' | 'light' | 'dark'

/** 正在显示的个性化。`imageUrl` 是图片背景的直链，其他背景为 null。 */
export interface PaintedPersonalization {
  personalization: Personalization
  imageUrl: string | null
}

const THEME_KEY = 'qywork.theme'

/**
 * 个性化写入 `document.documentElement` 行内样式的变量。清除时逐一移除，恢复 `tokens.css` 的值。
 *
 * 半透明底色与悬停色由当前明暗的令牌值计算，切换主题或系统明暗后须重新计算（`repaint`）。
 * 不改用 CSS 的 `color-mix()`，理由见 `../color.ts`。
 */
const PERSONAL_VARIABLES = [
  '--frame-bg',
  '--content-bg',
  '--accent',
  '--accent-hover',
  '--accent-soft',
  '--accent-fg',
]

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // 隐私模式下 localStorage 会直接抛错。外观无法读取时不应导致应用无法启动。
    return null
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 保存失败只影响下次启动时恢复外观，本次切换已生效，无需提示用户。
  }
}

function readTheme(): ThemePref {
  const v = load(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

const [theme, setThemeSignal] = createSignal<ThemePref>(readTheme())
const [painted, setPainted] = createSignal<PaintedPersonalization | null>(null)

export { painted as paintedPersonalization, theme }

/**
 * 写入 `data-theme`。必须在修改对应信号**之前**调用：信号写入后监听者（终端）同步重新取色，
 * 此时属性仍为旧值，取到的是上一套明暗的令牌。
 */
function applyDataTheme(pref: ThemePref): void {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', pref)
}

/**
 * 个性化的强调色与其上的文字色。null 表示使用主题的强调色。主窗口与桌面宠物窗口共用：
 * 宠物窗口不读取个性化，由主窗口随状态推送（`appearance/pet-window.ts`）。
 *
 * 文字色按强调色自身的明暗取黑或白：浅色强调色上的白字无法辨认。
 */
export function personalAccent(p: Personalization | null): { color: string; fg: string } | null {
  const accent = p?.accent ? parseColor(p.accent) : null
  if (!accent) return null
  return { color: toCss(accent), fg: luminance(accent) > 0.6 ? '#16161a' : '#ffffff' }
}

/** 必须在 `data-theme` 已设置之后调用：先计算再切换明暗时，深色下会取到浅色令牌。 */
function writeVariables(p: Personalization | null): void {
  const style = document.documentElement.style
  for (const name of PERSONAL_VARIABLES) style.removeProperty(name)
  if (!p) return
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => parseColor(css.getPropertyValue(name))
  const frame = token('--bg-sunken')
  const content = token('--bg-app')
  if (p.opacity < 1 && frame && content) {
    style.setProperty('--frame-bg', toCss(withAlpha(frame, p.opacity)))
    style.setProperty('--content-bg', toCss(withAlpha(content, p.opacity)))
  }
  const accent = p.accent ? parseColor(p.accent) : null
  const pair = personalAccent(p)
  if (accent && pair && content) {
    // 悬停色向底色方向偏移 15%，与默认令牌的关系一致：深色底上变暗、浅色底上变亮。
    style.setProperty('--accent', pair.color)
    style.setProperty('--accent-hover', toCss(mix(accent, content, 0.15)))
    style.setProperty('--accent-soft', toCss(withAlpha(accent, 0.14)))
    style.setProperty('--accent-fg', pair.fg)
  }
}

function repaint(): void {
  writeVariables(painted()?.personalization ?? null)
}

/**
 * 将已保存的主题写入 DOM。由入口在 `render()` 之前同步调用一次。
 *
 * 不在模块顶层直接执行：`import` 的副作用会经由 `store/index.ts` 传递到每一个
 * 引用 store 的模块，包括在没有 DOM 的环境中运行的单测，这些单测在 import 时即报
 * `document is not defined`，且报错位于与主题无关的测试文件中。
 *
 * 也不放在 `onMount` 中：此时第一帧已渲染完成，系统为亮色而用户选择深色时会先出现闪白。
 * 在入口的 render 之前调用可同时避免这两个问题。
 */
export function initTheme(): void {
  applyDataTheme(theme())
  // 跟随系统时，系统明暗变化即令牌变化，半透明底色与悬停色须按新令牌重新计算。
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (theme() === 'system') repaint()
  })
}

export function setTheme(pref: ThemePref): void {
  applyDataTheme(pref)
  repaint()
  setThemeSignal(pref)
  save(THEME_KEY, pref)
}

/** 应用读取到或正在编辑的个性化；传入 null 清除（连接前与恢复默认之后由调用方传入默认值）。 */
export function paintPersonalization(p: PaintedPersonalization | null): void {
  writeVariables(p?.personalization ?? null)
  setPainted(p)
}
