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
import { contrast, mix, overlayFor, parseColor, type Rgba, toCss, withAlpha } from '../color.ts'

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
  '--app-bg',
  '--frame-bg',
  '--content-bg',
  '--content-inset',
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

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

/**
 * 白色系的界限：强调色与白色的对比度低于此值时，白色的文字与圆钮在强调色上无法区分
 * （相对亮度 0.825，灰阶 `#ebebeb` 及更浅）。`#f2f2f2` 为 1.12；`#d9d9d9` 为 1.42、`#bfbfbf` 为 1.84，
 * 属于灰色而不是白色系。
 */
const WHITE_SERIES_CONTRAST = 1.2

/**
 * 强调色填充上的文字、图标与实心图形（主按钮文字、开关圆点、复选框勾号）共用一条规则：
 * 白色，只有强调色属于白色系时取 `#16161a`。浅灰、`#bfbfbf`、浅蓝等一律为白色。
 * 不要改为按亮度或对比度在黑白之间择优：中等亮度的彩色强调色上会出现黑字。
 */
function onAccent(accent: Rgba): string {
  return contrast(accent, WHITE) < WHITE_SERIES_CONTRAST ? '#16161a' : '#ffffff'
}

/**
 * 由强调色推导的全部颜色，每种用途一条规则。样式只引用这些变量，不在组件中另作判定，也不使用
 * `accent-color`：浏览器按自己的阈值推导勾号与滑块轨道的颜色。
 *
 * - `--accent`：填充（主按钮、开关轨道、滑块）与页面上以强调色绘制的线条、标记与文字，原样使用。
 * - `--accent-hover`：填充的悬停色，向 `page` 混合 15%，与默认令牌的关系一致。
 * - `--accent-fg`：填充上的文字、图标与实心图形，见 `onAccent`。
 * - `--accent-soft`：浅底（文字选中、框选），取强调色的 14%。
 *
 * `page` 是当前主题的内容底色。
 */
export function accentPalette(accent: Rgba, page: Rgba): Record<string, string> {
  return {
    '--accent': toCss(accent),
    '--accent-hover': toCss(mix(accent, page, 0.15)),
    '--accent-soft': toCss(withAlpha(accent, 0.14)),
    '--accent-fg': onAccent(accent),
  }
}

/**
 * 个性化的强调色与其上的文字色。null 表示使用主题的强调色。供桌面宠物窗口的角标使用：
 * 宠物窗口不读取个性化，由主窗口随状态推送（`appearance/pet-window.ts`）。
 */
export function personalAccent(p: Personalization | null): { color: string; fg: string } | null {
  const accent = p?.accent ? parseColor(p.accent) : null
  if (!accent) return null
  return { color: toCss(accent), fg: onAccent(accent) }
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
    // 外框比内容低一层：不透明度取界面不透明度的平方，透出的背景多于内容区（85% 时为 28% 对 15%），
    // 任何背景下两层都有可辨认的差别。两者取同一不透明度时，强烈的背景压过两层底色本身的差别，
    // 会话栏、会话区与面板显示为同一种颜色。卡片、输入框与浮层不透明，位于内容之上。
    style.setProperty('--frame-bg', toCss(withAlpha(frame, p.opacity * p.opacity)))
    style.setProperty('--content-bg', toCss(withAlpha(content, p.opacity)))
    style.setProperty('--app-bg', 'transparent')
    // 内容区中凹下的底色改为叠加色，随内容区透出背景（见 `tokens.css` 的 `--content-inset`）。
    const inset = token('--bg-inset')
    if (inset) style.setProperty('--content-inset', toCss(overlayFor(content, inset)))
  }
  const accent = p.accent ? parseColor(p.accent) : null
  if (accent && content) {
    for (const [name, value] of Object.entries(accentPalette(accent, content))) {
      style.setProperty(name, value)
    }
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
