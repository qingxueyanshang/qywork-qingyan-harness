/**
 * 字体大小：界面文字相对默认字号的比例，写入根元素的 `--font-scale`，`tokens.css` 的 `--fs-*` 按它计算。
 *
 * 只改变文字，不改变控件、间距与窗口布局。不要改为缩放整个 WebView：窗口最小尺寸、弹窗尺寸与
 * 原生子视图的摆放都按 100% 的布局推导。
 * 权威是电脑上的界面偏好，读取、推送与修改都经 `preferences.ts`；本机记录只用于连接之前的首次渲染，
 * 理由同主题（`../theme.ts`）。
 * 终端使用固定字号，不随之变化：其列数由字符宽度推导。
 */

import { FONT_SCALE_RANGE } from '@qywork/core'
import { createSignal } from 'solid-js'

const FONT_SCALE_KEY = 'qywork.fontScale'

function readFontScale(): number {
  try {
    const saved = Number(localStorage.getItem(FONT_SCALE_KEY))
    return saved >= FONT_SCALE_RANGE[0] && saved <= FONT_SCALE_RANGE[1] ? saved : 1
  } catch {
    return 1
  }
}

const [fontScale, setFontScaleSignal] = createSignal(readFontScale())

export { fontScale }

function apply(scale: number): void {
  const style = document.documentElement.style
  if (scale === 1) style.removeProperty('--font-scale')
  else style.setProperty('--font-scale', String(scale))
}

/** 将本机记录的比例写入 DOM。由入口在 `render()` 之前同步调用一次，理由同 `initTheme`。 */
export function initFontScale(): void {
  apply(fontScale())
}

/** 应用一个比例并写入本机记录。只由 `preferences.ts` 调用。 */
export function applyFontScale(scale: number): void {
  apply(scale)
  setFontScaleSignal(scale)
  try {
    localStorage.setItem(FONT_SCALE_KEY, String(scale))
  } catch {
    // 写入失败只影响下次启动时的首次渲染，本次修改已生效。
  }
}
