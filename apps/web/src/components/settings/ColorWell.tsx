import { createSignal, For, onCleanup, Show } from 'solid-js'

/**
 * 颜色选择：色块按钮，单击弹出颜色面板。面板含可选的空值一项、常用色网格与「其他颜色」（系统取色器）。
 *
 * 空值即「不设置」：传入 `emptyLabel` 时可选，色块显示斜线。不另设「启用 / 关闭」开关：
 * 开关与颜色是同一件事的两个控件，关闭后颜色控件仍可见但无效。
 *
 * 面板以 `position: fixed` 渲染在组件内，按色块按钮的位置计算坐标。不改用 `popover`：
 * 桌面端最低支持的 WebView2 110 没有该接口。面板位于模态窗口的子树中，因此显示在模态窗口之上。
 */

/** 常用色：第一行为灰阶，其后三行为十种色相的浅、中、深三档。 */
const PALETTE = [
  [
    '#ffffff',
    '#f2f2f2',
    '#d9d9d9',
    '#bfbfbf',
    '#a6a6a6',
    '#808080',
    '#595959',
    '#404040',
    '#262626',
    '#000000',
  ],
  [
    '#fecaca',
    '#fed7aa',
    '#fde68a',
    '#fef08a',
    '#bbf7d0',
    '#99f6e4',
    '#a5f3fc',
    '#bfdbfe',
    '#c7d2fe',
    '#e9d5ff',
  ],
  [
    '#ef4444',
    '#f97316',
    '#f59e0b',
    '#eab308',
    '#22c55e',
    '#14b8a6',
    '#06b6d4',
    '#3b82f6',
    '#6366f1',
    '#a855f7',
  ],
  [
    '#991b1b',
    '#9a3412',
    '#92400e',
    '#854d0e',
    '#166534',
    '#115e59',
    '#155e75',
    '#1e40af',
    '#3730a3',
    '#6b21a8',
  ],
].flat()

/** 面板与色块按钮之间的间距，以及面板距窗口边缘的最小距离。 */
const GAP = 4

/** 系统取色器只接受 `#rrggbb`：三位写法展开，带透明度的去掉透明度。 */
function sixDigit(v: string): string {
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`
  return v.slice(0, 7).toLowerCase()
}

export function ColorWell(props: {
  label: string
  value: string | null
  /** 空值一项的名称（如「无」「默认」）。不传时不能选空值。 */
  emptyLabel?: string
  onPick: (value: string | null) => void
}) {
  let button!: HTMLButtonElement
  let panel: HTMLDivElement | undefined
  let native: HTMLInputElement | undefined
  const [at, setAt] = createSignal<{ left: number; top: number } | null>(null)

  /**
   * 面板打开期间拦截所在模态窗口的关闭请求，Escape 只关闭面板。
   *
   * 模态窗口的 Escape 由浏览器作为关闭请求处理（`cancel` 事件），在面板的 keydown 中阻止默认行为无法拦截它
   * （WebView2 156 实测：面板与个性化弹窗一起关闭）。监听在关闭面板后的下一个任务才移除：
   * 同一次 Escape 先触发 keydown 关闭面板，随后才派发 `cancel`。
   */
  let detach: (() => void) | null = null

  const close = () => {
    setAt(null)
    detach?.()
    detach = null
  }

  /** 面板右缘与色块按钮右缘对齐，默认在按钮下方；下方空间不足时放在上方。 */
  const open = () => {
    const r = button.getBoundingClientRect()
    const width = 232
    const height = props.emptyLabel ? 170 : 136
    const left = Math.max(GAP, Math.min(r.right - width, window.innerWidth - width - GAP))
    const below = r.bottom + GAP
    const top =
      below + height <= window.innerHeight - GAP ? below : Math.max(GAP, r.top - GAP - height)
    setAt({ left, top })
    const dialog = button.closest('dialog')
    if (dialog && !detach) {
      const onCancel = (e: Event) => {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      }
      dialog.addEventListener('cancel', onCancel, true)
      detach = () => setTimeout(() => dialog.removeEventListener('cancel', onCancel, true), 0)
    }
  }
  onCleanup(() => detach?.())

  const pick = (value: string | null) => {
    props.onPick(value)
    close()
  }

  const onDocDown = (e: PointerEvent) => {
    const target = e.target as Node
    if (!panel?.contains(target) && !button.contains(target)) close()
  }
  document.addEventListener('pointerdown', onDocDown, true)
  onCleanup(() => document.removeEventListener('pointerdown', onDocDown, true))

  const current = () => (props.value ? sixDigit(props.value) : null)

  return (
    <>
      <button
        ref={button}
        class="color-well"
        type="button"
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={at() !== null}
        data-tip={props.value ?? props.emptyLabel ?? ''}
        onClick={() => (at() ? close() : open())}
      >
        <span
          class="color-swatch"
          classList={{ empty: props.value === null }}
          style={props.value ? { background: props.value } : {}}
        />
      </button>
      <Show when={at()}>
        {(pos) => (
          <div
            ref={panel}
            class="color-panel"
            role="dialog"
            aria-label={props.label}
            style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
            onKeyDown={(e) => {
              // Escape 只关闭面板，不关闭外层的模态窗口。
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
                button.focus()
              }
            }}
          >
            <Show when={props.emptyLabel}>
              {(label) => (
                <button
                  class="color-panel-row"
                  type="button"
                  aria-pressed={props.value === null}
                  onClick={() => pick(null)}
                >
                  <span class="color-swatch empty" />
                  {label()}
                </button>
              )}
            </Show>
            <div class="color-panel-grid">
              <For each={PALETTE}>
                {(c) => (
                  <button
                    class="color-panel-cell"
                    type="button"
                    aria-label={c}
                    aria-pressed={current() === c}
                    style={{ background: c }}
                    onClick={() => pick(c)}
                  />
                )}
              </For>
            </div>
            <button class="color-panel-row" type="button" onClick={() => native?.click()}>
              <span
                class="color-swatch"
                style={props.value ? { background: props.value } : {}}
                classList={{ empty: props.value === null }}
              />
              其他颜色…
            </button>
            <input
              ref={native}
              class="color-panel-native"
              type="color"
              tabIndex={-1}
              aria-hidden="true"
              value={current() ?? '#808080'}
              onInput={(e) => props.onPick(e.currentTarget.value)}
            />
          </div>
        )}
      </Show>
    </>
  )
}
