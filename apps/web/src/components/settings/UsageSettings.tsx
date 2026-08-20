import { formatCosts } from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { compact } from '../../lib/step-view.ts'
import { client } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { PageHead } from './Page.tsx'

/**
 * 用量账本。这台机器最近这些天的全部模型花费。
 *
 * ## 为什么在设置里，不在会话的运行页
 *
 * 它的尺度是**机器**与**天**，而运行页的尺度是这一条会话。两者并排放在同一页时，
 * 两套筛选钮会先于任何数字占掉两行，两组合计还会互相冒充。运行页底部留一行
 * 30 天合计当入口，明细在这里。
 *
 * ## 不做「本工作区」单独一格
 *
 * 「按工作区」这个分组本来就把它列出来了，再单给一格就是同一个数两处显示。
 */

interface Totals {
  entries: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number | null
  reasoningTokens: number
  cost: Record<string, number>
}
interface Bucket extends Totals {
  key: string
}
interface UsageResponse {
  days: number
  by: string
  totals: Totals
  rows: Bucket[]
}

const RANGES = [7, 30, 90] as const
const GROUPS = [
  { by: 'model', label: '按模型' },
  { by: 'day', label: '按天' },
  { by: 'kind', label: '按类型' },
  { by: 'workspace', label: '按工作区' },
] as const

/** 金额。一笔计价都没有时给「—」——写成 $0.00 是把「不知道」说成「免费」。 */
function money(cost: Record<string, number>): string {
  return Object.values(cost).some((v) => v > 0) ? formatCosts(cost) : '—'
}

/** 「输入」给含缓存命中的口径：中转站后台账单就是这个数，两边同口径才能对账。 */
function input(t: Totals): number {
  return t.inputTokens + (t.cachedTokens ?? 0)
}

export default function UsageSettings() {
  const [days, setDays] = createSignal<number>(30)
  const [by, setBy] = createSignal<string>('model')
  const [data, { refetch }] = createResource(
    () => ({ days: days(), by: by() }),
    (q) => client.api<UsageResponse>(`/api/usage?days=${q.days}&by=${q.by}`),
  )

  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。 */}
      <PageHead title="用量" desc="含压缩摘要、权限分类器与 team 的花费，会话删除后账仍在。" />

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

            {/* 一笔都没有时整张表不画：一排只有表头的空列读起来像加载没完成。 */}
            <Show when={u().rows.length > 0}>
              {/* 窄窗口下表格自己横向滚，不把整页撑宽。 */}
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
                          {/* 汇总量到亿位，逐位对账在运行页的逐请求表，这里收成 K/M。 */}
                          <td class="num">{compact(input(r))}</td>
                          <td class="num">{compact(r.outputTokens)}</td>
                          {/* null 是「没回报」，写成 0 会让「缓存没生效」看起来像「生效了但没命中」。 */}
                          <td class="num">
                            {r.cachedTokens === null ? '未回报' : compact(r.cachedTokens)}
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
