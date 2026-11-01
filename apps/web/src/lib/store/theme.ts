/**
 * 外观：主题（跟随系统 / 浅色 / 深色）与当前屏幕选用的皮肤。两者只由本文件记录与应用。
 *
 * 外观不写入服务端配置。服务端配置决定本机 agent 如何运行，外观决定当前屏幕如何显示。
 * 桌面端与手机端连接同一个 `qy serve`：写入服务端时，手机上切换为深色会使桌面端随之切换。
 * 此外首屏即需要外观：经由服务端时，第一帧只能按推测的外观渲染，HTTP 返回后再切换，产生明显的闪白。
 * 皮肤的定义存放在服务端的皮肤库中，本文件只记录选用了哪一套。
 *
 * 代价是更换设备后需要重新设置。该代价可以接受：外观不是配置，而是当前屏幕的偏好。
 *
 * 主题是三态而不是布尔值。`system` 必须是独立的一态，不能用「深色开关 = 关」代替：否则系统切换为深色时
 * 应用不随之切换，且「亮色」与「跟随」两档在界面上无法区分。
 *
 * 对应的 CSS：`system` 时不写 `data-theme`，交给 `tokens.css` 中的
 * `@media (prefers-color-scheme: dark)` 分支；另外两态写入固定属性，优先于媒体查询。
 * 选用皮肤时 `data-theme` 取皮肤的 `base`。`data-theme` 与骨架变量只由本文件设置，
 * 修改此处前先确认 `tokens.css` 的判据仍与之一致。
 */

import type { Skin, SkinBase } from '@qywork/core'
import { createSignal } from 'solid-js'
import { luminance, mix, parseColor, toCss, withAlpha } from '../color.ts'

export type ThemePref = 'system' | 'light' | 'dark'

/**
 * 当前屏幕选用的皮肤。
 *
 * `base` 是首帧依据：皮肤定义要等连接建立后才能读取，首帧按记录的 `base` 设置明暗，
 * 读取到定义后由 `paintSkin` 校正。不记录时，主题为浅色而皮肤为深色的屏幕每次启动都先闪白。
 */
export interface SkinChoice {
  id: string
  base: SkinBase
}

/** 已读取到定义、正在显示的皮肤。`imageUrl` 是图片背景的直链，其他背景为 null。 */
export interface PaintedSkin {
  id: string
  skin: Skin
  imageUrl: string | null
}

const THEME_KEY = 'qywork.theme'
const SKIN_KEY = 'qywork.skin'

/** 皮肤写入 `document.documentElement` 行内样式的变量。清除皮肤时逐一移除，恢复 `tokens.css` 的值。 */
const SKIN_VARIABLES = ['--frame-bg', '--content-bg', '--accent', '--accent-hover', '--accent-soft']

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // 隐私模式下 localStorage 会直接抛错。外观无法读取时不应导致应用无法启动。
    return null
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 保存失败只影响下次启动时恢复外观，本次切换已生效，无需提示用户。
  }
}

function readTheme(): ThemePref {
  const v = load(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function readSkinChoice(): SkinChoice | null {
  try {
    const v = JSON.parse(load(SKIN_KEY) ?? 'null') as Partial<SkinChoice> | null
    if (typeof v?.id === 'string' && (v.base === 'light' || v.base === 'dark')) {
      return { id: v.id, base: v.base }
    }
  } catch {
    // 记录损坏时按未选用皮肤处理。
  }
  return null
}

const [theme, setThemeSignal] = createSignal<ThemePref>(readTheme())
const [skinChoice, setSkinChoiceSignal] = createSignal<SkinChoice | null>(readSkinChoice())
const [paintedSkin, setPaintedSkin] = createSignal<PaintedSkin | null>(null)

export { paintedSkin, skinChoice, theme }

/**
 * 实际生效的明暗：选用皮肤时取皮肤的 `base`，否则取主题偏好。
 *
 * 按 `data-theme` 取色的组件（终端）监听它而不是 `theme()`：切换皮肤不改变主题偏好，
 * 只监听 `theme()` 时皮肤的明暗变化不会触发重新取色。
 */
export function effectiveTheme(): ThemePref {
  return skinChoice()?.base ?? theme()
}

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
 * 把皮肤写入骨架变量。
 *
 * 半透明底色由当前明暗的令牌值计算，因此必须在 `data-theme` 已设置之后调用：
 * 先计算再切换明暗时，深色皮肤会取到浅色令牌。
 */
function writeVariables(skin: Skin | null): void {
  const style = document.documentElement.style
  for (const name of SKIN_VARIABLES) style.removeProperty(name)
  if (!skin) return
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => parseColor(css.getPropertyValue(name))
  const opacity = skin.surface.opacity
  const frame = token('--bg-sunken')
  const content = token('--bg-app')
  if (opacity < 1 && frame && content) {
    style.setProperty('--frame-bg', toCss(withAlpha(frame, opacity)))
    style.setProperty('--content-bg', toCss(withAlpha(content, opacity)))
  }
  const accent = skin.accent ? parseColor(skin.accent) : null
  if (accent && content) {
    // 悬停色向底色方向偏移，与默认令牌的关系一致：深色底上变暗、浅色底上变亮。
    const toward =
      luminance(content) < 0.5 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
    style.setProperty('--accent', toCss(accent))
    style.setProperty('--accent-hover', toCss(mix(accent, toward, 0.15)))
    style.setProperty('--accent-soft', toCss(withAlpha(accent, 0.14)))
  }
}

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
  applyDataTheme(effectiveTheme())
}

export function setTheme(pref: ThemePref): void {
  if (!skinChoice()) applyDataTheme(pref)
  setThemeSignal(pref)
  save(THEME_KEY, pref)
}

/**
 * 选用或取消皮肤。只记录选择并设置明暗；定义由皮肤库读取后经 `paintSkin` 应用。
 *
 * 选用的皮肤变化时立即清除正在显示的背景与骨架变量。不要保留到新定义到达：
 * 期间 `data-theme` 已是新皮肤的明暗，而骨架变量仍按旧皮肤与旧明暗的令牌计算。
 */
export function chooseSkin(choice: SkinChoice | null): void {
  const changed = paintedSkin()?.id !== choice?.id
  applyDataTheme(choice?.base ?? theme())
  if (changed) writeVariables(null)
  setSkinChoiceSignal(choice)
  save(SKIN_KEY, choice ? JSON.stringify(choice) : null)
  if (changed) setPaintedSkin(null)
}

/**
 * 应用已读取的皮肤定义。
 *
 * 定义不属于当前选用的皮肤时忽略：读取期间用户已改选另一套，较慢返回的旧请求不得覆盖新选择。
 * 定义的 `base` 与记录不一致时（皮肤在别处被修改）同步更新记录。
 */
export function paintSkin(painted: PaintedSkin): void {
  const choice = skinChoice()
  if (choice?.id !== painted.id) return
  if (choice.base !== painted.skin.base) {
    const next = { id: painted.id, base: painted.skin.base }
    applyDataTheme(next.base)
    setSkinChoiceSignal(next)
    save(SKIN_KEY, JSON.stringify(next))
  }
  writeVariables(painted.skin)
  setPaintedSkin(painted)
}
