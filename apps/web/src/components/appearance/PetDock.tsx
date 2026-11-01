/**
 * 窗口内的宠物：位于侧栏底部「系统设置」上方。
 *
 * 当前会话是否在运行，会话区与侧栏行上已经显示，因此这里只用动作表现状态；
 * 气泡只在某条会话完成或出错、且用户未在查看它时出现（见 `pet.ts` 的 `settle`）。
 * 单击展开列表：运行中、出错、完成的会话，点击即跳转，运行中的可停止。
 */

import type { PetPack } from '@qywork/core'
import { createSignal, For, onCleanup, Show } from 'solid-js'
import {
  isDesktopShell,
  openPetEntry,
  petBadge,
  petBubble,
  petEntries,
  petMood,
  setPetPrefs,
  stopPetEntry,
} from '../../lib/store/index.ts'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import { IconCheck, IconSpinner, IconStop, IconX } from '../Icons.tsx'
import { PetSprite } from './PetSprite.tsx'

export function PetDock(props: { pack: PetPack; frameUrl: (name: string) => string }) {
  const [open, setOpen] = createSignal(false)
  let wrap: HTMLDivElement | undefined
  let button!: HTMLButtonElement

  // 点击宠物与列表之外、按 Esc、滚动或改变窗口尺寸时收起，理由同 `ProjectRow` 的菜单。
  const close = () => setOpen(false)
  const onDocDown = (e: MouseEvent) => {
    const t = e.target as Node | null
    if (!t || !wrap?.contains(t)) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', close)
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', close)
  })

  const go = (id: string) => {
    close()
    void openPetEntry(id)
  }

  return (
    <div class="pet-dock" ref={wrap}>
      <Show when={petBubble()}>
        {(b) => (
          <button class="pet-bubble" type="button" onClick={() => go(b().conversationId)}>
            <span class="pet-bubble-title truncate">{b().title}</span>
            <span class="pet-bubble-state" classList={{ failed: b().outcome === 'failed' }}>
              {b().outcome === 'done' ? '已完成' : '出错'}
            </span>
          </button>
        )}
      </Show>
      <button
        ref={button}
        class="pet-button"
        type="button"
        aria-label="宠物"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <PetSprite pack={props.pack} state={petMood()} frameUrl={props.frameUrl} />
        <Show when={petBadge()}>{(t) => <span class="pet-badge">{t()}</span>}</Show>
      </button>
      <Show when={open()}>
        <AnchoredMenu class="pet-menu" anchor={button} placement="above-start">
          <div class="pet-list">
            <For each={petEntries()}>
              {(e) => (
                <div class="pet-row">
                  <button class="pet-row-main" type="button" onClick={() => go(e.conversationId)}>
                    <span class={`pet-row-icon ${e.status}`}>
                      <Show
                        when={e.status === 'running'}
                        fallback={
                          e.status === 'done' ? <IconCheck size={13} /> : <IconX size={13} />
                        }
                      >
                        <IconSpinner size={13} />
                      </Show>
                    </span>
                    <span class="truncate">{e.title}</span>
                  </button>
                  <Show when={e.status === 'running'}>
                    <button
                      class="icon-btn pet-row-stop"
                      type="button"
                      aria-label="停止"
                      data-tip="停止"
                      onClick={() => stopPetEntry(e.conversationId)}
                    >
                      <IconStop size={12} />
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <div class="pet-menu-split" />
          <Show when={isDesktopShell()}>
            <button
              class="menu-item"
              type="button"
              onClick={() => {
                close()
                setPetPrefs({ place: 'desktop' })
              }}
            >
              放到桌面
            </button>
          </Show>
          <button
            class="menu-item"
            type="button"
            onClick={() => {
              close()
              setPetPrefs({ place: 'hidden' })
            }}
          >
            隐藏宠物
          </button>
        </AnchoredMenu>
      </Show>
    </div>
  )
}
