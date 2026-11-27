import { SQUARE_KIND_LABEL, SQUARE_KINDS, type SquareKind } from '@qywork/core'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { holdOverlay } from '../../lib/store/index.ts'
import { setSquareOpen } from '../../lib/store/square.ts'
import { IconX } from '../Icons.tsx'
import { SquareGrid } from './SquareGrid.tsx'
import { SquareItem } from './SquareItem.tsx'

const close = () => setSquareOpen(false)

/**
 * 创作广场弹窗：按类型分页的条目列表与条目详情。尺寸固定（B9），列表与详情在弹窗内滚动。
 * 选中条目时详情替换列表；返回列表时类型与搜索词不变。
 */
export default function SquareDialog() {
  holdOverlay(() => true)
  const [kind, setKind] = createSignal<SquareKind>('work')
  const [query, setQuery] = createSignal('')
  const [selected, setSelected] = createSignal<string | null>(null)

  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        e.preventDefault()
        if (selected()) setSelected(null)
        else close()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      <button class="backdrop-close" type="button" aria-label="关闭创作广场" onClick={close} />
      <div class="sheet-backdrop pass-through">
        <div class="square-dialog" role="dialog" aria-modal="true" aria-label="创作广场">
          <button class="icon-btn square-close" type="button" aria-label="关闭" onClick={close}>
            <IconX size={15} />
          </button>
          <header class="square-head">
            <nav class="square-tabs" aria-label="类型">
              <For each={SQUARE_KINDS}>
                {(k) => (
                  <button
                    type="button"
                    class="square-tab"
                    classList={{ active: kind() === k }}
                    onClick={() => {
                      setKind(k)
                      setSelected(null)
                    }}
                  >
                    {SQUARE_KIND_LABEL[k]}
                  </button>
                )}
              </For>
            </nav>
            <input
              class="square-search"
              type="search"
              aria-label="搜索"
              placeholder="搜索"
              value={query()}
              onChange={(e) => {
                setQuery(e.currentTarget.value.trim())
                setSelected(null)
              }}
            />
          </header>
          <div class="square-body">
            <Show
              when={selected()}
              keyed
              fallback={<SquareGrid kind={kind()} query={query()} onOpen={setSelected} />}
            >
              {(id) => <SquareItem id={id} onBack={() => setSelected(null)} />}
            </Show>
          </div>
        </div>
      </div>
    </>
  )
}
