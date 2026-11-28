import { SQUARE_KIND_LABEL, SQUARE_KINDS, type SquareKind } from '@qywork/core'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { holdOverlay } from '../../lib/store/index.ts'
import { setSquareOpen } from '../../lib/store/square.ts'
import { HoldSwitch } from '../HoldSwitch.tsx'
import { IconChevron, IconSearch, IconUpload, IconX } from '../Icons.tsx'
import { KIND_VIEW } from './kinds.tsx'
import { MineList } from './MineList.tsx'
import { PublishDialog } from './PublishDialog.tsx'
import { SquareGrid } from './SquareGrid.tsx'
import { SquareItem } from './SquareItem.tsx'

const close = () => setSquareOpen(false)

/** 右栏显示的内容：当前类型的列表、条目详情或发布记录。 */
type View = { type: 'list' } | { type: 'item'; id: string } | { type: 'mine' }

/** 正文的一项。`HoldSwitch` 的键须为字符串（按 `Object.is` 比较），因此以 JSON 编码，渲染时解码。 */
type Body =
  | { type: 'list'; kind: SquareKind; query: string }
  | { type: 'item'; id: string }
  | { type: 'mine' }

/** 发布窗口的对象：新条目的类型，或本人已有条目的新版本。 */
interface Publishing {
  kind: SquareKind
  itemId?: string
}

/** 搜索框停止输入超过此时长后才读取：每次读取都经云端。 */
const SEARCH_DELAY_MS = 250

/**
 * 创作广场弹窗：左栏为类型与发布记录，右栏为标题行与内容，版面与设置弹窗相同。尺寸固定（B9），内容在右栏内滚动。
 * 「发布」发布当前类型，在另一个窗口中进行（`PublishDialog`），打开在本弹窗之上。
 *
 * 切换类型、搜索、打开详情时，新内容读取完成前保留上一项（`HoldSwitch`）。各项的读取不得使外层的 Suspense 挂起：
 * 外层是 `App.tsx` 中包裹本弹窗的边界，挂起时整个弹窗被移出文档再重新挂载。
 */
export default function SquareDialog() {
  holdOverlay(() => true)
  const [kind, setKind] = createSignal<SquareKind>('work')
  const [query, setQuery] = createSignal('')
  const [view, setView] = createSignal<View>({ type: 'list' })
  const [publishing, setPublishing] = createSignal<Publishing | null>(null)
  const [published, setPublished] = createSignal(0)

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(searchTimer))

  const body = (): string => {
    const v = view()
    const b: Body = v.type === 'list' ? { type: 'list', kind: kind(), query: query().trim() } : v
    return JSON.stringify(b)
  }

  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 发布窗口与确认框打开时由它们处理 Escape。
      if (e.key !== 'Escape' || document.querySelector('dialog[open], [role="alertdialog"]')) return
      e.preventDefault()
      if (view().type === 'item') setView({ type: 'list' })
      else close()
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      <button class="backdrop-close" type="button" aria-label="关闭创作广场" onClick={close} />
      <div class="sheet-backdrop pass-through">
        <div class="square-dialog" role="dialog" aria-modal="true" aria-label="创作广场">
          <nav class="square-nav" aria-label="类型">
            <ul class="nav-list">
              <For each={SQUARE_KINDS}>
                {(k) => {
                  const kv = KIND_VIEW[k]
                  return (
                    <li>
                      <button
                        class="nav-item"
                        classList={{ active: view().type !== 'mine' && kind() === k }}
                        type="button"
                        onClick={() => {
                          setKind(k)
                          setView({ type: 'list' })
                        }}
                      >
                        <kv.icon size={15} {...(kv.iconClass ? { class: kv.iconClass } : {})} />
                        {SQUARE_KIND_LABEL[k]}
                      </button>
                    </li>
                  )
                }}
              </For>
            </ul>
            <ul class="nav-list nav-group-split">
              <li>
                <button
                  class="nav-item"
                  classList={{ active: view().type === 'mine' }}
                  type="button"
                  onClick={() => setView({ type: 'mine' })}
                >
                  <IconUpload size={15} />
                  发布记录
                </button>
              </li>
            </ul>
          </nav>

          <div class="square-pane">
            <button class="icon-btn square-close" type="button" aria-label="关闭" onClick={close}>
              <IconX size={15} />
            </button>
            <header class="square-head">
              <Show when={view().type === 'item'}>
                <button
                  class="icon-btn square-back"
                  type="button"
                  aria-label="返回"
                  onClick={() => setView({ type: 'list' })}
                >
                  <IconChevron dir="left" size={16} />
                </button>
              </Show>
              <h2 class="page-title">
                {view().type === 'mine' ? '发布记录' : SQUARE_KIND_LABEL[kind()]}
              </h2>
              <div class="square-head-actions">
                <Show when={view().type === 'list'}>
                  <label class="square-search">
                    <IconSearch size={14} />
                    <input
                      type="search"
                      aria-label="搜索"
                      placeholder="搜索"
                      spellcheck={false}
                      value={query()}
                      onInput={(e) => {
                        const text = e.currentTarget.value
                        clearTimeout(searchTimer)
                        searchTimer = setTimeout(() => setQuery(text), SEARCH_DELAY_MS)
                      }}
                    />
                  </label>
                </Show>
                {/* 发布当前类型；发布记录页没有当前类型，各条记录另有「发布新版本」。 */}
                <Show when={view().type !== 'mine'}>
                  <button
                    class="btn-primary square-publish-button"
                    type="button"
                    onClick={() => setPublishing({ kind: kind() })}
                  >
                    发布
                  </button>
                </Show>
              </div>
            </header>
            <div class="square-scroll">
              <div class="square-inner">
                <HoldSwitch key={body()}>
                  {(key) => {
                    const b = JSON.parse(key) as Body
                    if (b.type === 'list')
                      return (
                        <SquareGrid
                          kind={b.kind}
                          query={b.query}
                          onOpen={(id) => setView({ type: 'item', id })}
                        />
                      )
                    if (b.type === 'item') return <SquareItem id={b.id} />
                    return (
                      <MineList
                        revision={published()}
                        onRevise={(itemId, k) => setPublishing({ kind: k, itemId })}
                      />
                    )
                  }}
                </HoldSwitch>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Show when={publishing()} keyed>
        {(p) => (
          <PublishDialog
            kind={p.kind}
            {...(p.itemId ? { itemId: p.itemId } : {})}
            onClose={() => setPublishing(null)}
            onDone={() => {
              setPublishing(null)
              setPublished((n) => n + 1)
              setView({ type: 'mine' })
            }}
          />
        )}
      </Show>
    </>
  )
}
