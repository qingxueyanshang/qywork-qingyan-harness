import {
  SQUARE_KIND_LABEL,
  type SquareKind,
  type SquareMineItem,
  type SquareStatus,
} from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { explainApiError } from '../../lib/store/index.ts'
import { mySquareItems, removeSquareItem } from '../../lib/store/square.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'

const STATUS: Record<SquareStatus, string> = {
  pending: '待审核',
  approved: '已上架',
  rejected: '已驳回',
}

/** 本人发布的条目：最新版本的审核状态与驳回原因；可发布新版本或下架。 */
export function MineList(props: { onRevise: (id: string, kind: SquareKind) => void }) {
  const [items, { refetch }] = createResource(mySquareItems)
  const [removing, setRemoving] = createSignal<SquareMineItem | null>(null)
  const [error, setError] = createSignal('')

  return (
    <>
      <Show when={items.error || error()}>
        <p class="square-error">{error() || explainApiError(items.error, '读取失败')}</p>
      </Show>
      <ul class="square-mine">
        <For each={items() ?? []}>
          {(item) => (
            <li>
              <div class="square-mine-main">
                <span class="square-card-title">{item.title}</span>
                <span class="square-item-sub">
                  {SQUARE_KIND_LABEL[item.kind]} · 版本 {item.version} · {STATUS[item.status]}
                  {item.listed && item.status !== 'approved' ? ' · 已有上架的版本' : ''}
                </span>
                <Show when={item.note}>{(note) => <span class="square-error">{note()}</span>}</Show>
              </div>
              <Show when={item.status !== 'pending'}>
                <button
                  type="button"
                  class="btn-ghost sm"
                  onClick={() => props.onRevise(item.id, item.kind)}
                >
                  发布新版本
                </button>
              </Show>
              <button type="button" class="btn-ghost sm" onClick={() => setRemoving(item)}>
                下架
              </button>
            </li>
          )}
        </For>
      </ul>
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
