/**
 * 桌面宠物的任务框窗口（`pet.html#box`）：气泡与列表。外壳以透明、无边框、置顶的窗口加载它，
 * 位置由外壳按宠物窗口计算（`pet.rs` 的 `box_origin`），宠物移动时随之移动。
 *
 * 不变量：
 * - 窗口始终处于显示状态，没有内容时由外壳缩为 1 × 1。不要改为隐藏后再 `show()`：
 *   外壳只在第一次显示时不激活窗口，之后每次 `show()` 都会把它激活为前台窗口。
 * - 改变尺寸前先清空内容并缩小，等待空白画面显示后再展开：展开的那一帧 WebView 仍显示上一帧画面，
 *   上一帧为空白时这一帧不可见；直接从气泡改为列表时，这一帧显示的是错位的气泡。
 * - 列表的高度随条目数变化（打开期间新增或减少条目同样调整），最多 `MENU_MAX_ROWS` 行，更多的行在框内滚动。
 *   用户要求不出现滚动条，因此不按 B9 固定高度。
 * - 行按位置复用（`Index`），不要改回 `For`：主窗口每次推送的都是新对象，`For` 会重建全部行，
 *   按下与抬起落在新旧两个节点上时不产生 click，运行中推送频繁，点击随之丢失。
 */

import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  Match,
  onMount,
  Show,
  Switch,
} from 'solid-js'
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

/** 唤起主窗口；给出会话时主窗口随后打开它。 */
function openMain(id?: string): void {
  void tauriInvoke('pet_open_main', id ? { conversationId: id } : {}).catch(() => undefined)
}

export function PetBox() {
  const view = petView()
  const [menuOpen, setMenuOpen] = createSignal(false)
  const entryCount = () => view()?.entries.length ?? 0

  // 列表只列出运行中的会话与未查看的结果，没有条目时不显示空框，单击宠物改为唤起主窗口：
  // 主窗口隐藏到托盘后，这是从宠物回到客户端的唯一路径。
  createEffect(() => {
    if (entryCount() === 0) setMenuOpen(false)
  })
  onMount(() => {
    void tauriListen(PET_BOX_TOGGLE_EVENT, () => {
      if (!menuOpen() && entryCount() === 0) return openMain()
      setMenuOpen(!menuOpen())
    }).catch(() => undefined)
  })

  /** 应当显示的内容与高度。只在种类或高度变化时改变，内容变化在原尺寸内更新。 */
  const wanted = createMemo<Box | null>(
    () => {
      const rows = menuOpen() ? Math.min(entryCount(), MENU_MAX_ROWS) : 0
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
                <Index each={v().entries}>
                  {(e) => (
                    <div class="petw-row">
                      <button
                        class="petw-row-main"
                        type="button"
                        onClick={() => {
                          setMenuOpen(false)
                          openMain(e().conversationId)
                        }}
                      >
                        <span class={`petw-row-icon ${e().status}`}>
                          <Switch fallback={<IconX size={13} />}>
                            <Match when={e().status === 'running'}>
                              <IconSpinner size={13} />
                            </Match>
                            <Match when={e().status === 'done'}>
                              <IconCheck size={13} />
                            </Match>
                          </Switch>
                        </span>
                        <span class="petw-title">{e().title}</span>
                      </button>
                      <Show when={e().status === 'running'}>
                        <button
                          class="petw-stop"
                          type="button"
                          aria-label="停止"
                          onClick={() => act({ type: 'stop', id: e().conversationId })}
                        >
                          <IconStop size={12} />
                        </button>
                      </Show>
                    </div>
                  )}
                </Index>
              </div>
            </div>
          </Match>
          <Match when={shown()?.kind === 'bubble' && v().bubble}>
            {(b) => (
              <button
                class="petw-bubble"
                type="button"
                onClick={() => openMain(b().conversationId)}
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
