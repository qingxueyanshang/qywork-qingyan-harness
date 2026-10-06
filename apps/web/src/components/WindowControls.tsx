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
 * 只在桌面端渲染。浏览器与手机没有可最小化的窗口；按 B5，能力不存在的一端不显示入口，
 * 而不是显示一个点击即报错的按钮。判据使用 `isDesktopShell()`：它检测
 * Tauri 注入的全局对象，不按 UA 推测。
 *
 * 按钮样式与界面其他部分不同：这三个按钮代替系统窗口控件，Windows 的窗口控件使用 1px 细线；
 * 使用界面其他部分的 2.0 描边会明显偏粗，看起来像应用图标而不是窗口按钮。
 * 关闭按钮 hover 时为红底白字，遵循系统的既有约定，用户已熟悉这套配色。
 */
export function WindowControls() {
  const desktop = isDesktopShell()
  const [maximized, setMaximized] = createSignal(false)

  onMount(() => {
    if (!desktop) return
    // 启动时窗口可能已是最大化状态（系统保留了上次的状态），先查询一次实际状态。
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
