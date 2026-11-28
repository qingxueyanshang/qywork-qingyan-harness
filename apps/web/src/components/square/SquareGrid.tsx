import { SQUARE_KIND_LABEL, type SquareCard, type SquareKind } from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded, suspendUntil } from '../../lib/resource.ts'
import { explainApiError } from '../../lib/store/index.ts'
import { listSquare, type SquarePage, squareDetail, squareFileUrl } from '../../lib/store/square.ts'
import { LoadState } from '../settings/LoadState.tsx'
import { EmptyBox } from '../settings/Page.tsx'
import { ACTIONS, createActionRunner } from './actions.ts'
import { KIND_VIEW } from './kinds.tsx'

/**
 * 一种类型的条目，按通过审核的时间倒序，版式取 `KIND_VIEW`；有更多条目时末尾显示「加载更多」。
 * 类型与搜索词在一个实例中不变：切换时 `HoldSwitch` 换为新实例，新一页读取完成前保留上一页。
 * 首页经 `loaded` 读取，不要改为 `first()`：读取中的 resource 会使外层的 Suspense 挂起，整个弹窗被移出文档再重新挂载。
 */
export function SquareGrid(props: {
  kind: SquareKind
  query: string
  onOpen: (id: string) => void
}) {
  const [first, { refetch }] = createResource(() => listSquare(props.kind, props.query, null))
  suspendUntil(() => !first.loading)
  const [more, setMore] = createSignal<SquarePage[]>([])
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [moreError, setMoreError] = createSignal('')

  const items = () => [...(loaded(first)?.items ?? []), ...more().flatMap((p) => p.items)]
  const next = () => {
    const last = more().at(-1)
    return last ? last.next : (loaded(first)?.next ?? null)
  }
  const loadMore = async (before: string) => {
    setLoadingMore(true)
    setMoreError('')
    try {
      const page = await listSquare(props.kind, props.query, before)
      setMore((pages) => [...pages, page])
    } catch (e) {
      setMoreError(explainApiError(e, '读取失败'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Show
      when={loaded(first)}
      fallback={<LoadState error={first.error} onRetry={() => void refetch()} />}
    >
      <Show
        when={items().length > 0}
        fallback={
          <EmptyBox label={props.query ? '无匹配的条目' : `暂无${SQUARE_KIND_LABEL[props.kind]}`} />
        }
      >
        <Show
          when={KIND_VIEW[props.kind].layout === 'gallery'}
          fallback={
            <div class="square-list">
              <For each={items()}>{(card) => <SquareRow card={card} onOpen={props.onOpen} />}</For>
            </div>
          }
        >
          <div class="square-gallery">
            <For each={items()}>{(card) => <SquareTile card={card} onOpen={props.onOpen} />}</For>
          </div>
        </Show>
        <Show when={moreError()}>{(m) => <p class="square-error">{m()}</p>}</Show>
        <Show when={next()}>
          {(before) => (
            <button
              type="button"
              class="btn-ghost square-more"
              disabled={loadingMore()}
              onClick={() => void loadMore(before())}
            >
              加载更多
            </button>
          )}
        </Show>
      </Show>
    </Show>
  )
}

/** 封面网格中的一项：封面、标题与发布者。没有封面时显示类型图标。 */
function SquareTile(props: { card: SquareCard; onOpen: (id: string) => void }) {
  const view = KIND_VIEW[props.card.kind]
  return (
    <button type="button" class="square-tile" onClick={() => props.onOpen(props.card.id)}>
      <div class="square-cover" classList={{ contain: view.contain === true }}>
        <Show when={props.card.cover} fallback={<view.icon size={22} />}>
          {(hash) => <img src={squareFileUrl(hash())} alt="" loading="lazy" />}
        </Show>
      </div>
      <div class="square-tile-text">
        <span class="square-name">{props.card.title}</span>
        <span class="square-desc">{props.card.author}</span>
      </div>
    </button>
  )
}

/**
 * 双列行中的一项：类型图标、标题与简介（没有简介时为发布者），右侧为该类型的操作。
 * 操作的结果显示在本行，替换简介。需要详情才能判定的操作（`when`）只在详情页显示。
 */
function SquareRow(props: { card: SquareCard; onOpen: (id: string) => void }) {
  const view = KIND_VIEW[props.card.kind]
  const action = ACTIONS[props.card.kind]
  const runner = createActionRunner()
  return (
    <div class="square-row">
      <button type="button" class="square-row-main" onClick={() => props.onOpen(props.card.id)}>
        <span class="square-icon">
          <view.icon size={18} {...(view.iconClass ? { class: view.iconClass } : {})} />
        </span>
        <span class="square-row-text">
          <span class="square-name">{props.card.title}</span>
          <Show
            when={runner.result()}
            fallback={<span class="square-desc">{props.card.summary || props.card.author}</span>}
          >
            {(r) => (
              <span class="square-desc" classList={{ bad: !r().ok }}>
                {r().text}
              </span>
            )}
          </Show>
        </span>
      </button>
      <Show when={!action.when}>
        <button
          type="button"
          class="btn-ghost sm"
          disabled={runner.busy()}
          onClick={() => void runner.run(action, props.card.id, () => squareDetail(props.card.id))}
        >
          {action.label}
        </button>
      </Show>
    </div>
  )
}
