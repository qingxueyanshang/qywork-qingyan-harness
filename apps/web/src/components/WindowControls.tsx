import { createSignal, onMount, Show } from 'solid-js'
import {
  isDesktopShell,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
} from '../lib/store/index.ts'
import { IconWinClose, IconWinMax, IconWinMin } from './Icons.tsx'

/**
 * 窗口按钮。
 *
 * **只在桌面端渲染。** 浏览器和手机没有窗口可最小化。按 B5：能力不存在的那一端**不显示入口**，
 * 而不是显示一个点了报错的按钮。判据用 `isDesktopShell()`——它检测的是
 * Tauri 注入的全局对象，不是猜 UA。
 *
 * **为什么按钮长得和别处不一样。** 这三个是系统控件的替身，Windows 的观感就是 1px 细线；
 * 用界面其他地方的 2.0 描边画出来会明显偏粗，像三个应用图标而不是窗口按钮。
 * 关闭按钮的 hover 是红底白字，也是照系统的既有约定——用户对这套配色的
 * 肌肉记忆比任何自创样式都强。
 */
export function WindowControls() {
  const desktop = isDesktopShell()
  const [maximized, setMaximized] = createSignal(false)

  onMount(() => {
    if (!desktop) return
    // 启动时可能已经是最大化（系统记住了上次的状态），先问一次真值。
    void windowIsMaximized()
      .then(setMaximized)
      .catch(() => {})
  })

  return (
    <Show when={desktop}>
      <div class="win-controls">
        <button
          class="win-btn"
          type="button"
          aria-label="最小化"
          onClick={() => void windowMinimize()}
        >
          <IconWinMin />
        </button>
        <button
          class="win-btn"
          type="button"
          aria-label={maximized() ? '还原' : '最大化'}
          onClick={() => void windowToggleMaximize().then(setMaximized)}
        >
          <IconWinMax restore={maximized()} />
        </button>
        <button
          class="win-btn danger"
          type="button"
          aria-label="关闭"
          onClick={() => void windowClose()}
        >
          <IconWinClose />
        </button>
      </div>
    </Show>
  )
}
