import type { SquareCard, SquareKind } from '@qywork/core'
import { createEffect, createSignal, For, on, Show } from 'solid-js'
import { explainApiError } from '../../lib/store/index.ts'
import { listSquare, squareFileUrl } from '../../lib/store/square.ts'

/**
 * 一种类型的条目列表：封面、标题与发布者，按通过审核的时间倒序；有更多条目时在末尾显示「加载更多」。
 * 类型或搜索词变化时从第一页重新读取。
 */
export function SquareGrid(props: {
  kind: SquareKind
  query: string
  onOpen: (id: string) => void
}) {
  const [items, setItems] = createSignal<SquareCard[] | null>(null)
  const [next, setNext] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)

  const load = async (before: string | null) => {
    const kind = props.kind
    const query = props.query
    setLoading(true)
    setError('')
    try {
      const page = await listSquare(kind, query, before)
      if (kind !== props.kind || query !== props.query) return
      setItems((list) => (before ? [...(list ?? []), ...page.items] : page.items))
      setNext(page.next)
    } catch (e) {
      setError(explainApiError(e, '读取失败'))
    } finally {
      setLoading(false)
    }
  }

  createEffect(
    on([() => props.kind, () => props.query], () => {
      setItems(null)
      setNext(null)
      void load(null)
    }),
  )

  return (
    <>
      <Show when={error()}>{(m) => <p class="square-error">{m()}</p>}</Show>
      <div class="square-grid">
        <For each={items() ?? []}>
          {(card) => (
            <button type="button" class="square-card" onClick={() => props.onOpen(card.id)}>
              <div class="square-cover">
                <Show when={card.cover}>
                  {(hash) => <img src={squareFileUrl(hash())} alt="" loading="lazy" />}
                </Show>
              </div>
              <span class="square-card-title">{card.title}</span>
              <span class="square-card-author">{card.author}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={next()}>
        {(before) => (
          <button
            type="button"
            class="btn-ghost square-more"
            disabled={loading()}
            onClick={() => void load(before())}
          >
            加载更多
          </button>
        )}
      </Show>
    </>
  )
}
