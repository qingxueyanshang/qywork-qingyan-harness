/**
 * 桌面宠物的任务框窗口（`pet.html#box`）：气泡与列表。外壳以透明、无边框、置顶的窗口加载它，
 * 位置由外壳按宠物窗口计算（`pet.rs` 的 `box_origin`），宠物移动时随之移动。
 *
 * 不变量：
 * - 窗口始终处于显示状态，没有内容时由外壳缩为 1 × 1。不要改为隐藏后再 `show()`：
 *   外壳只在第一次显示时不激活窗口，之后每次 `show()` 都会把它激活为前台窗口。
 * - 改变尺寸前先清空内容并缩小，等待空白画面显示后再展开：展开的那一帧 WebView 仍显示上一帧画面，
 *   上一帧为空白时这一帧不可见；直接从气泡改为列表时，这一帧显示的是错位的气泡。
 * - 列表的高度在打开时按行数确定，打开期间不随内容变化（B9），多出的行在框内滚动。
 */

import { createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch } from 'solid-js'
import {
  PET_ACTION_EVENT,
  PET_BOX_TOGGLE_EVENT,
  type PetWindowAction,
} from '../../lib/pet-protocol.ts'
import { tauriEmitTo, tauriInvoke, tauriListen } from '../../lib/store/shell.ts'
import { IconCheck, IconSpinner, IconStop, IconX } from '../Icons.tsx'
import { MAIN_WINDOW, petView } from './pet-view.ts'

/** 任务框的宽度与气泡的高度。 */
const BOX_W = 244
const BUBBLE_H = 34
/** 列表一行的高度（与 `.petw-row-main` 一致）、最多显示的行数、内边距与边框之和。 */
const ROW_H = 30
const MENU_MAX_ROWS = 6
const MENU_CHROME = 10

type Box = { kind: 'menu' | 'bubble'; height: number }

/**
 * 等待缩小后的空白画面显示出来。合成与上屏落后动画帧一到两帧（60 Hz 下约 33 毫秒），
 * 两次动画帧之后再留 50 毫秒。
 */
const blankFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))),
  )

function act(a: PetWindowAction): void {
  void tauriEmitTo(MAIN_WINDOW, PET_ACTION_EVENT, a).catch(() => undefined)
}

function openConversation(id: string): void {
  void tauriInvoke('pet_open_main', { conversationId: id }).catch(() => undefined)
}

export function PetBox() {
  const view = petView()
  /** 列表打开时的行数，0 表示关闭。 */
  const [menuRows, setMenuRows] = createSignal(0)

  // 列表只列出运行中的会话与未查看的结果，没有条目时不显示空框。
  createEffect(() => {
    if (view()?.entries.length === 0) setMenuRows(0)
  })
  onMount(() => {
    void tauriListen(PET_BOX_TOGGLE_EVENT, () => {
      const count = view()?.entries.length ?? 0
      setMenuRows(menuRows() ? 0 : Math.min(count, MENU_MAX_ROWS))
    }).catch(() => undefined)
  })

  /** 应当显示的内容与高度。只在种类或高度变化时改变，内容变化在原尺寸内更新。 */
  const wanted = createMemo<Box | null>(
    () => {
      const rows = menuRows()
      if (rows) return { kind: 'menu', height: rows * ROW_H + MENU_CHROME }
      return view()?.bubble ? { kind: 'bubble', height: BUBBLE_H } : null
    },
    null,
    { equals: (a, b) => a?.kind === b?.kind && a?.height === b?.height },
  )

  /** 正在显示的内容；`placed` 是外壳当前设置的尺寸。两者只由 `place` 按顺序修改。 */
  const [shown, setShown] = createSignal<Box | null>(null)
  let placed: Box | null = null
  const place = async (next: Box | null) => {
    if (placed) {
      setShown(null)
      await tauriInvoke('pet_box_place', { width: 0, height: 0 }).catch(() => undefined)
      placed = null
      if (!next) return
      await blankFrame()
    }
    if (!next) return
    await tauriInvoke('pet_box_place', { width: BOX_W, height: next.height }).catch(() => undefined)
    placed = next
    setShown(next)
  }
  let queue = Promise.resolve()
  createEffect(() => {
    const next = wanted()
    queue = queue.then(() => place(next))
  })

  return (
    <Show when={view()}>
      {(v) => (
        <Switch>
          <Match when={shown()?.kind === 'menu'}>
            <div class="petw-menu">
              <div class="petw-list">
                <For each={v().entries}>
                  {(e) => (
                    <div class="petw-row">
                      <button
                        class="petw-row-main"
                        type="button"
                        onClick={() => {
                          setMenuRows(0)
                          openConversation(e.conversationId)
                        }}
                      >
                        <span class={`petw-row-icon ${e.status}`}>
                          <Show
                            when={e.status === 'running'}
                            fallback={
                              e.status === 'done' ? <IconCheck size={13} /> : <IconX size={13} />
                            }
                          >
                            <IconSpinner size={13} />
                          </Show>
                        </span>
                        <span class="petw-title">{e.title}</span>
                      </button>
                      <Show when={e.status === 'running'}>
                        <button
                          class="petw-stop"
                          type="button"
                          aria-label="停止"
                          onClick={() => act({ type: 'stop', id: e.conversationId })}
                        >
                          <IconStop size={12} />
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Match>
          <Match when={shown()?.kind === 'bubble' && v().bubble}>
            {(b) => (
              <button
                class="petw-bubble"
                type="button"
                onClick={() => openConversation(b().conversationId)}
              >
                <span class="petw-title">{b().title}</span>
                <span class="petw-bubble-state" classList={{ failed: b().outcome === 'failed' }}>
                  {b().outcome === 'done' ? '已完成' : '出错'}
                </span>
              </button>
            )}
          </Match>
        </Switch>
      )}
    </Show>
  )
}
