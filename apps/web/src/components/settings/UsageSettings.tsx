import type { UsageResponse, UsageTotals } from '@qywork/core'
import { formatCosts } from '@qywork/core'
import { createResource, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { sessionSignal } from '../../lib/session.ts'
import { compact } from '../../lib/step-view.ts'
import { client } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'

/**
 * 用量账本：本机在所选天数内的全部模型花费。
 *
 * 放在设置中而不放在会话的运行页：它的统计范围是本机与天数，而运行页的统计范围是单个会话。两
 * 者放在同一页时，两组筛选按钮会在数字之前占用两行，两组合计也容易混淆。运行页底部保留一行 30
 * 天合计作为入口，明细在此处显示。
 *
 * 不单独显示「本工作区」：「按工作区」分组已列出该数值，单独显示会使同一数值出现在两处。
 */

const RANGES = [7, 30, 90] as const
const GROUPS = [
  { by: 'model', label: '按模型' },
  { by: 'day', label: '按天' },
  { by: 'kind', label: '按类型' },
  { by: 'workspace', label: '按工作区' },
] as const

/**
 * 「此处无可用值」。与运行页使用同一术语、同一含义：该数值不存在，而不是等于 0。
 * 两处使用不同的词时，同一件事在界面上会有两种说法。
 */
const NA = 'N/A'

/** 金额。没有任何一笔计价表示该模型没有价目；显示为 $0.00 会把「未知」显示为「免费」。 */
function money(cost: Record<string, number>): string {
  return Object.values(cost).some((v) => v > 0) ? formatCosts(cost) : NA
}

/** 「输入」采用包含缓存命中的口径：与中转站后台账单的口径一致，才能对账。 */
function input(t: UsageTotals): number {
  return t.inputTokens + (t.cachedTokens ?? 0)
}

export default function UsageSettings() {
  const [days, setDays] = sessionSignal<number>('qywork.settings.usage.days', 30)
  const [by, setBy] = sessionSignal<string>('qywork.settings.usage.by', 'model')
  const [data, { refetch }] = createResource(
    () => ({ days: days(), by: by() }),
    (q) => client.api<UsageResponse>(`/api/usage?days=${q.days}&by=${q.by}`),
  )

  return (
    <>
      <div class="usage-bar">
        <div class="usage-chips">
          <For each={RANGES}>
            {(d) => (
              <button
                class="usage-chip"
                classList={{ active: days() === d }}
                type="button"
                onClick={() => setDays(d)}
              >
                {d} 天
              </button>
            )}
          </For>
        </div>
        <div class="usage-chips">
          <For each={GROUPS}>
            {(g) => (
              <button
                class="usage-chip"
                classList={{ active: by() === g.by }}
                type="button"
                onClick={() => setBy(g.by)}
              >
                {g.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(u) => (
          <>
            <div class="usage-total">
              <span class="usage-total-cost">{money(u().totals.cost)}</span>
              <span class="usage-total-meta">{u().totals.entries.toLocaleString()} 笔</span>
            </div>

            {/* 没有记录时不渲染表格：只有表头的空表会被误认为尚未加载完成。 */}
            <Show when={u().rows.length > 0}>
              {/* 窄窗口下表格在自身容器内横向滚动，不撑宽整个页面。 */}
              <div class="usage-scroll">
                <table class="usage-table">
                  <thead>
                    <tr>
                      <th>{GROUPS.find((g) => g.by === u().by)?.label ?? '分组'}</th>
                      <th class="num">笔数</th>
                      <th class="num">输入</th>
                      <th class="num">输出</th>
                      <th class="num">命中</th>
                      <th class="num">金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={u().rows}>
                      {(r) => (
                        <tr>
                          <td>{r.key}</td>
                          <td class="num">{r.entries.toLocaleString()}</td>
                          {/* 汇总值可达亿级，逐位对账使用运行页的逐请求表，此处以 K/M 缩写显示。 */}
                          <td class="num">{compact(input(r))}</td>
                          <td class="num">{compact(r.outputTokens)}</td>
                          {/* `null` 表示接口未返回该字段；显示为 0 会使「缓存未生效」
                              看起来像「缓存生效但未命中」。术语与运行页相同。 */}
                          <td class="num">
                            {r.cachedTokens === null ? NA : compact(r.cachedTokens)}
                          </td>
                          <td class="num">{money(r.cost)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          </>
        )}
      </Show>
    </>
  )
}
