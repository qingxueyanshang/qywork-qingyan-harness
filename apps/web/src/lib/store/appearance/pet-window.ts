/**
 * 桌面宠物窗口的主窗口一侧：按偏好显示或关闭外壳的宠物窗口，把派生状态推送给它，处理它回传的操作。
 *
 * 宠物窗口不连接服务、不推导状态，只显示这里推送的内容（理由见 `pet.ts` 文件头）。
 * 主窗口关闭时隐藏到托盘而不销毁，推导持续进行。
 */

import type { PetPack } from '@qywork/core'
import { createEffect, createRoot, on } from 'solid-js'
import {
  PET_ACTION_EVENT,
  PET_MOVED_EVENT,
  PET_OPEN_EVENT,
  PET_READY_EVENT,
  PET_STATE_EVENT,
  PET_WINDOW_LABEL,
  type PetAnchor,
  type PetWindowAction,
  type PetWindowState,
} from '../../pet-protocol.ts'
import { isDesktopShell, tauriEmitTo, tauriInvoke, tauriListen } from '../shell.ts'
import { paintedPersonalization, personalAccent, theme } from '../theme.ts'
import {
  openPetEntry,
  petBadge,
  petBubble,
  petEntries,
  petMood,
  petPrefs,
  stopPetEntry,
} from './pet.ts'

const POSITION_KEY = 'qywork.pet.position'

function savedPosition(): PetAnchor | null {
  try {
    const v = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') as {
      left?: unknown
      bottom?: unknown
    } | null
    return typeof v?.left === 'number' && typeof v.bottom === 'number'
      ? { left: v.left, bottom: v.bottom }
      : null
  } catch {
    return null
  }
}

/**
 * 开始同步。由入口在挂载后调用；不在桌面外壳中时不做任何事。
 * `active` 给出当前显示的宠物包与取图方式（`components/appearance/active-pet.ts`）。
 */
export function observePetWindow(
  active: () => { pack: PetPack; frameUrl: (name: string) => string },
): () => void {
  if (!isDesktopShell()) return () => {}
  return createRoot((dispose) => {
    const snapshot = (): PetWindowState => {
      const { pack, frameUrl } = active()
      const frames: Record<string, string> = {}
      for (const a of Object.values(pack.states)) for (const f of a.frames) frames[f] = frameUrl(f)
      const b = petBubble()
      const pref = theme()
      return {
        mood: petMood(),
        badge: petBadge(),
        bubble: b ? { conversationId: b.conversationId, title: b.title, outcome: b.outcome } : null,
        entries: petEntries(),
        pack,
        frames,
        dark:
          pref === 'system'
            ? window.matchMedia('(prefers-color-scheme: dark)').matches
            : pref === 'dark',
        accent: personalAccent(paintedPersonalization()?.personalization ?? null),
      }
    }
    const shown = () => petPrefs().place === 'desktop'
    const push = () => {
      if (shown())
        void tauriEmitTo(PET_WINDOW_LABEL, PET_STATE_EVENT, snapshot()).catch(() => undefined)
    }

    createEffect(
      on(shown, (on) => {
        if (on) {
          const at = savedPosition()
          void tauriInvoke('pet_window_show', at ? { left: at.left, bottom: at.bottom } : {}).catch(
            () => undefined,
          )
        } else {
          void tauriInvoke('pet_window_hide').catch(() => undefined)
        }
      }),
    )
    createEffect(() => {
      snapshot()
      push()
    })

    // 宠物窗口加载完成时请求一次完整状态：它在主窗口首次推送之后才创建。
    void tauriListen(PET_READY_EVENT, push).catch(() => undefined)
    void tauriListen<string>(PET_OPEN_EVENT, (id) => void openPetEntry(id)).catch(() => undefined)
    void tauriListen<PetWindowAction>(PET_ACTION_EVENT, (a) => stopPetEntry(a.id)).catch(
      () => undefined,
    )
    void tauriListen<PetAnchor>(PET_MOVED_EVENT, (at) => {
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(at))
      } catch {
        // 保存失败只影响下次显示的位置。
      }
    }).catch(() => undefined)
    return dispose
  })
}
