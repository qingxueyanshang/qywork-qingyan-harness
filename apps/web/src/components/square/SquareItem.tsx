import { createResource, Show } from 'solid-js'
import { loaded, suspendUntil } from '../../lib/resource.ts'
import { squareDetail } from '../../lib/store/square.ts'
import { LoadState } from '../settings/LoadState.tsx'
import { ACTIONS, createActionRunner } from './actions.ts'
import { PREVIEWS } from './previews.tsx'

/**
 * 条目详情：标题、发布者、版本、该类型的操作、简介与内容预览。返回入口在弹窗的标题行。
 * 详情经 `loaded` 读取，不要改为 `detail()`：读取中的 resource 会使外层的 Suspense 挂起，整个弹窗被移出文档再重新挂载。
 */
export function SquareItem(props: { id: string }) {
  const [detail, { refetch }] = createResource(() => squareDetail(props.id))
  suspendUntil(() => !detail.loading)
  const runner = createActionRunner()

  return (
    <Show
      when={loaded(detail)}
      fallback={<LoadState error={detail.error} onRetry={() => void refetch()} />}
    >
      {(d) => {
        const action = ACTIONS[d().kind]
        return (
          <div class="square-detail">
            <div class="square-detail-head">
              <div class="square-detail-id">
                <h3 class="square-detail-title">{d().title}</h3>
                <span class="square-desc">
                  {d().author} · 版本 {d().version}
                  {d().license ? ` · ${d().license}` : ''}
                </span>
              </div>
              <Show when={!action.when || action.when(d())}>
                <button
                  type="button"
                  class="btn-primary"
                  disabled={runner.busy()}
                  onClick={() => void runner.run(action, d().id, () => Promise.resolve(d()))}
                >
                  {action.label}
                </button>
              </Show>
            </div>
            <Show when={runner.result()}>
              {(r) => <p class={r().ok ? 'square-result' : 'square-error'}>{r().text}</p>}
            </Show>
            <Show when={d().summary}>
              <p class="square-summary">{d().summary}</p>
            </Show>
            {PREVIEWS[d().kind](d())}
          </div>
        )
      }}
    </Show>
  )
}
