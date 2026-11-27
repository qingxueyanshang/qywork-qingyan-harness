import { SQUARE_KIND_LABEL, SQUARE_KINDS, type SquareKind } from '@qywork/core'
import { createEffect, createSignal, For, Match, onCleanup, Switch } from 'solid-js'
import { holdOverlay } from '../../lib/store/index.ts'
import { setSquareOpen } from '../../lib/store/square.ts'
import { IconX } from '../Icons.tsx'
import { MineList } from './MineList.tsx'
import { PublishForm } from './PublishForm.tsx'
import { SquareGrid } from './SquareGrid.tsx'
import { SquareItem } from './SquareItem.tsx'

const close = () => setSquareOpen(false)

/** 弹窗正文显示的内容：某一类型的列表、条目详情、发布记录，或发布表单（`itemId` 给出时发布该条目的新版本）。 */
type View =
  | { type: 'list' }
  | { type: 'item'; id: string }
  | { type: 'mine' }
  | { type: 'publish'; itemId?: string; kind?: SquareKind }

/**
 * 创作广场弹窗：按类型分页的条目列表、条目详情、发布记录与发布表单。尺寸固定（B9），正文在弹窗内滚动。
 * 打开详情时详情替换列表；返回列表时类型与搜索词不变。
 */
export default function SquareDialog() {
  holdOverlay(() => true)
  const [kind, setKind] = createSignal<SquareKind>('work')
  const [query, setQuery] = createSignal('')
  const [view, setView] = createSignal<View>({ type: 'list' })
  const [notice, setNotice] = createSignal('')

  const itemView = () => {
    const v = view()
    return v.type === 'item' ? v : null
  }
  const publishView = () => {
    const v = view()
    return v.type === 'publish' ? v : null
  }
  const show = (next: View) => {
    setNotice('')
    setView(next)
  }

  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        e.preventDefault()
        if (view().type !== 'list') show({ type: 'list' })
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
                    classList={{ active: view().type === 'list' && kind() === k }}
                    onClick={() => {
                      setKind(k)
                      show({ type: 'list' })
                    }}
                  >
                    {SQUARE_KIND_LABEL[k]}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="square-tab"
                classList={{ active: view().type === 'mine' }}
                onClick={() => show({ type: 'mine' })}
              >
                发布记录
              </button>
            </nav>
            <input
              class="square-search"
              type="search"
              aria-label="搜索"
              placeholder="搜索"
              value={query()}
              onChange={(e) => {
                setQuery(e.currentTarget.value.trim())
                show({ type: 'list' })
              }}
            />
            <button type="button" class="btn-primary sm" onClick={() => show({ type: 'publish' })}>
              发布
            </button>
          </header>
          <div class="square-body">
            {notice() ? <p class="square-result">{notice()}</p> : null}
            <Switch>
              <Match when={view().type === 'list'}>
                <SquareGrid
                  kind={kind()}
                  query={query()}
                  onOpen={(id) => show({ type: 'item', id })}
                />
              </Match>
              <Match when={itemView()} keyed>
                {(v) => <SquareItem id={v.id} onBack={() => show({ type: 'list' })} />}
              </Match>
              <Match when={view().type === 'mine'}>
                <MineList onRevise={(itemId, k) => show({ type: 'publish', itemId, kind: k })} />
              </Match>
              <Match when={publishView()} keyed>
                {(v) => (
                  <PublishForm
                    {...(v.itemId ? { itemId: v.itemId } : {})}
                    {...(v.kind ? { kind: v.kind } : {})}
                    onDone={(message) => {
                      setView({ type: 'mine' })
                      setNotice(message)
                    }}
                  />
                )}
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </>
  )
}
