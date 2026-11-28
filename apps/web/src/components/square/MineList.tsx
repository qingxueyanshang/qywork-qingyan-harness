import {
  SQUARE_KIND_LABEL,
  type SquareKind,
  type SquareMineItem,
  type SquareStatus,
} from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded, suspendUntil } from '../../lib/resource.ts'
import { explainApiError } from '../../lib/store/index.ts'
import { mySquareItems, removeSquareItem } from '../../lib/store/square.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { LoadState } from '../settings/LoadState.tsx'
import { EmptyBox, EntryCard } from '../settings/Page.tsx'

const STATUS: Record<SquareStatus, string> = {
  pending: '待审核',
  approved: '已上架',
  rejected: '已驳回',
}

/**
 * 本人发布的条目：最新版本的审核状态与驳回原因；可发布新版本或下架。`revision` 变化时重新读取，读取期间保留上一份列表。
 * 列表经 `loaded` 读取，不要改为 `items()`：读取中的 resource 会使外层的 Suspense 挂起，整个弹窗被移出文档再重新挂载。
 */
export function MineList(props: {
  revision: number
  onRevise: (id: string, kind: SquareKind) => void
}) {
  const [items, { refetch }] = createResource(
    () => props.revision,
    () => mySquareItems(),
  )
  suspendUntil(() => !items.loading)
  const [removing, setRemoving] = createSignal<SquareMineItem | null>(null)
  const [error, setError] = createSignal('')

  return (
    <>
      <Show when={error()}>{(m) => <p class="square-error">{m()}</p>}</Show>
      <Show
        when={loaded(items)}
        fallback={<LoadState error={items.error} onRetry={() => void refetch()} />}
      >
        {(list) => (
          <Show when={list().length > 0} fallback={<EmptyBox label="暂无发布记录" />}>
            <div class="entry-list">
              <For each={list()}>
                {(item) => (
                  <EntryCard
                    name={item.title}
                    badge={
                      <span
                        class="entry-tag"
                        classList={{ 'square-rejected': item.status === 'rejected' }}
                      >
                        {STATUS[item.status]}
                      </span>
                    }
                    desc={`${SQUARE_KIND_LABEL[item.kind]} · 版本 ${item.version}${
                      item.listed && item.status !== 'approved' ? ' · 已有上架的版本' : ''
                    }`}
                    actions={
                      <>
                        <Show when={item.status !== 'pending' && item.source === 'upload'}>
                          <button
                            type="button"
                            class="btn-ghost sm"
                            onClick={() => props.onRevise(item.id, item.kind)}
                          >
                            发布新版本
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="btn-ghost sm"
                          onClick={() => setRemoving(item)}
                        >
                          下架
                        </button>
                      </>
                    }
                  >
                    <Show when={item.note}>
                      {(note) => <div class="entry-extra bad">{note()}</div>}
                    </Show>
                  </EntryCard>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
      <ConfirmDialog
        open={removing() !== null}
        title={`下架「${removing()?.title ?? ''}」？`}
        confirmLabel="下架"
        danger
        onConfirm={() => {
          const item = removing()
          setRemoving(null)
          if (!item) return
          setError('')
          void removeSquareItem(item.id)
            .then(() => refetch())
            .catch((e: unknown) => setError(explainApiError(e, '下架失败')))
        }}
        onCancel={() => setRemoving(null)}
      />
    </>
  )
}
