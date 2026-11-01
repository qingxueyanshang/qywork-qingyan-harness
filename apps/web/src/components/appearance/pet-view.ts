/**
 * 宠物窗口与任务框窗口共用：接收主窗口推送的状态，并按状态设置明暗与个性化强调色。
 * 不 import store，理由同 `PetWindow.tsx`。
 */

import { type Accessor, createEffect, createSignal, onMount } from 'solid-js'
import { PET_READY_EVENT, PET_STATE_EVENT, type PetWindowState } from '../../lib/pet-protocol.ts'
import { tauriEmitTo, tauriListen } from '../../lib/store/shell.ts'

export const MAIN_WINDOW = 'main'

/** 在组件中调用。窗口加载完成后向主窗口请求一次完整状态：两个窗口都在主窗口首次推送之后才创建。 */
export function petView(): Accessor<PetWindowState | null> {
  const [view, setView] = createSignal<PetWindowState | null>(null)
  onMount(() => {
    void tauriListen<PetWindowState>(PET_STATE_EVENT, setView).then(() =>
      tauriEmitTo(MAIN_WINDOW, PET_READY_EVENT, null),
    )
  })

  createEffect(() => {
    const dark = view()?.dark
    if (dark !== undefined)
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  })

  // 个性化的强调色写在根元素上，覆盖 `tokens.css` 的值；为 null 时移除，恢复主题的强调色。
  createEffect(() => {
    const accent = view()?.accent ?? null
    const style = document.documentElement.style
    if (accent) {
      style.setProperty('--accent', accent.color)
      style.setProperty('--accent-fg', accent.fg)
    } else {
      style.removeProperty('--accent')
      style.removeProperty('--accent-fg')
    }
  })

  return view
}
