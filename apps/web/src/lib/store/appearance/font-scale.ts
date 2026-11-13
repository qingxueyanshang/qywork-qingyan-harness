/**
 * 字体大小：界面文字相对默认字号的比例，写入根元素的 `--font-scale`，`tokens.css` 的 `--fs-*` 按它计算。
 *
 * 只改变文字，不改变控件、间距与窗口布局。不要改为缩放整个 WebView：窗口最小尺寸、弹窗尺寸与
 * 原生子视图的摆放都按 100% 的布局推导。
 * 只保存在本机，不写入服务端配置：它是当前屏幕的偏好，理由与主题相同（`../theme.ts`）。
 * 终端使用固定字号，不随之变化：其列数由字符宽度推导。
 */

import { createSignal } from 'solid-js'

/** 比例的取值范围。上限受固定高度的控件限制：行内按钮与分段控件的高度不随文字变化。 */
export const FONT_SCALE_RANGE = [0.9, 1.3] as const

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

/** 将已保存的比例写入 DOM。由入口在 `render()` 之前同步调用一次，理由同 `initTheme`。 */
export function initFontScale(): void {
  apply(fontScale())
}

export function setFontScale(scale: number): void {
  apply(scale)
  setFontScaleSignal(scale)
  try {
    localStorage.setItem(FONT_SCALE_KEY, String(scale))
  } catch {
    // 保存失败只影响下次启动时恢复，本次修改已生效。
  }
}
