import type { ProviderRequest, Run, RunUsage } from '@qywork/core'
import { formatCosts, formatMoney } from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { stopReasonLabel } from '../lib/step-view.ts'
import { client, state } from '../lib/store/index.ts'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 运行详情：这个会话到目前为止花了多少，以及每一轮各花了多少。
 *
 * ## 零后端改动
 *
 * 数据全在 `/api/conversations/:id/runs` 里——每个 `Run` 行本来就带 `usage`
 * 与 `stopReason`。上一轮排查时我判断「逐请求账本要后端先记账」，那是错的：
 * 账本一直在，只是没有人读。
 *
 * ## 为什么值得单独一个面板
 *
 * 会话流末尾的读数条只说**这一轮**。而「我这个会话已经烧了多少」要把每一轮
 * 加起来才知道，那不该让用户自己拿计算器。重试尤其明显：一次失败重试三遍，
 * 四笔钱都真的花掉了，但流里只有最后一条读数还亮着。
 *
 * ## 被接替的 run 照常计入
 *
 * 重试接替的那几轮在流里是灰的，但**钱是真花了**。账目里不能因为它「不算数」
 * 就漏掉——那正是「账面对不上」的来源。灰只表示"这轮的产出被替代了"。
 *
 * ## 两段是两个问题，不能只留一段
 *
 * 上面那段是「这个会话」，下面那段是「这台机器最近这些天」。后者读的是账本
 * （`usage_ledger`），它**不随会话删除消失**，也把压缩摘要、权限分类器、team
 * 那几笔一并算进去——所以它必然大于上面那段，这不是对不上。
 * 账本一直在写，只是在这之前只有 `qy usage` 这个命令行在读。
 */

interface UsageTotals {
  entries: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number | null
  reasoningTokens: number
  cost: Record<string, number>
}
interface UsageBucket extends UsageTotals {
  key: string
}
interface UsageResponse {
  days: number
  by: string
  totals: UsageTotals
  rows: UsageBucket[]
  workspaceTotals: UsageTotals
}

const GROUPS = [
  { by: 'model', label: '按模型' },
  { by: 'day', label: '按天' },
  { by: 'kind', label: '按类型' },
  { by: 'workspace', label: '按工作区' },
] as const

const RANGES = [7, 30, 90] as const

/** 把一轮的花费并进按币种分的桶里。**不跨币种相加。** */
function addCost(acc: Record<string, number>, usage: RunUsage | undefined): Record<string, number> {
  if (!usage?.cost) return acc
  return { ...acc, [usage.currency]: (acc[usage.currency] ?? 0) + usage.cost }
}

export default function RunDetails() {
  const [data, { refetch }] = createResource(
    () => state.activeConversation,
    (id) => client.api<{ runs: Run[] }>(`/api/conversations/${id}/runs`),
  )

  // `loaded()` 而不是 `data()`：后者出错时 `throw`，而这个应用没有 `ErrorBoundary`。
  const runs = () => loaded(data)?.runs ?? []
  const total = () =>
    runs().reduce(
      (acc, r) => ({
        input: acc.input + (r.usage?.inputTokens ?? 0),
        output: acc.output + (r.usage?.outputTokens ?? 0),
        // 按币种分桶。同一个会话里换过模型就可能混币种（切到 GLM 再切回来），
        // 加成一个数字要汇率，而我们不做换算。
        cost: addCost(acc.cost, r.usage),
        // 只要有一轮回报过缓存就算「有」；全程没回报保持 null，不显示成 0。
        cached:
          r.usage?.cachedTokens === null
            ? acc.cached
            : (acc.cached ?? 0) + (r.usage?.cachedTokens ?? 0),
      }),
      { input: 0, output: 0, cost: {} as Record<string, number>, cached: null as number | null },
    )

  return (
    <div class="settings-form">
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        <Show
          when={runs().length > 0}
          fallback={<div class="field-hint">这个会话还没有跑过任何一轮。</div>}
        >
          <div class="run-total">
            <span class="run-total-cost">{formatCosts(total().cost)}</span>
            <span class="field-hint">
              {runs().length} 轮 · 输入 {(total().input + (total().cached ?? 0)).toLocaleString()}
              （其中缓存命中 {total().cached === null ? '未回报' : total().cached!.toLocaleString()}
              ） · 输出 {total().output.toLocaleString()}
            </span>
          </div>

          <table class="args-table">
            <tbody>
              <For each={[...runs()].reverse()}>{(r) => <RunRow run={r} />}</For>
            </tbody>
          </table>

          {/* 边界说明，不折叠：压缩那次摘要调用也花钱，但它不属于任何一个 run，
              所以这张表加起来会略小于账本里的总数。不写的话「对不上」会被当成 bug。 */}
          <div class="field-hint">
            只统计对话轮次。压缩用的那次摘要调用也计费，但它不属于任何一轮，不在这张表里。
          </div>
        </Show>
      </Show>

      <UsageHistory />
    </div>
  )
}

/**
 * 一轮一行，展开是**逐请求账本**。
 *
 * ## 为什么必须逐请求
 *
 * 「这一轮花了 $0.003」回答不了「为什么这么贵」。一轮里模型被调用了几次、
 * 哪一次没吃到缓存、哪一次输出特别长——这些都在 `usage.turns` 里逐条记着
 * （`packages/agent/src/loop.ts` 每次调用 push 一条），而界面上一条都没显示过。
 * 列序是「# / 输入 / 输出 / 命中 / 写入 / 金额 / 来源」，跟中转站后台的账单同序——
 * 这样两边能逐行对账。
 *
 * ## 来源列不能省
 *
 * `provider` 是模型真回报的，`estimated` 是本地估算的兜底。两者混在一起看，
 * 「账对不上」就永远查不清是谁的问题。
 */
function RunRow(props: { run: Run }) {
  const r = () => props.run
  const elapsed = () => {
    const end = r().finishedAt
    return end == null ? null : (end - r().createdAt) / 1000
  }

  return (
    <tr classList={{ superseded: !!r().supersededBy }}>
      <th>{new Date(r().createdAt).toLocaleTimeString()}</th>
      <td>
        <div class="run-row-top">
          <code>{r().model}</code>
          {/* 被接替要标出来：它的产出不算数，但钱算数。 */}
          <Show when={r().supersededBy}>
            <span class="run-row-tag">已被重试接替</span>
          </Show>
          {/* 中文说法和会话流里的收尾条共用一张表，别在这里直接贴英文码。 */}
          <Show when={r().stopReason && r().stopReason !== 'completed'}>
            <span class="run-row-tag bad">{stopReasonLabel(r().stopReason!)}</span>
          </Show>
        </div>
        <div class="field-hint">
          输入 {((r().usage?.inputTokens ?? 0) + (r().usage?.cachedTokens ?? 0)).toLocaleString()} /
          输出 {(r().usage?.outputTokens ?? 0).toLocaleString()} · {r().stepCount} 步
          <Show when={elapsed() !== null}>
            {' · '}
            {elapsed()!.toFixed(1)}s
          </Show>
          <Show when={(r().usage?.cost ?? 0) > 0}>
            {' · '}
            {formatMoney(r().usage!.cost, r().usage!.currency)}
          </Show>
        </div>

        {/* 失败诊断：错误码和原文一直在落库（`runs.error_code` / `error_message`），
            但界面上从来没有出口。默认收起——正常轮次不该被它占地方。 */}
        <Show when={r().errorCode || r().errorMessage}>
          <details class="run-fold">
            <summary>失败诊断</summary>
            <div class="field-hint">
              <Show when={r().errorCode}>
                <div>
                  错误码 <code>{r().errorCode}</code>
                </div>
              </Show>
              <Show when={r().errorMessage}>
                <div class="run-error-raw">{r().errorMessage}</div>
              </Show>
            </div>
          </details>
        </Show>

        <RequestLedger run={props.run} />
      </td>
    </tr>
  )
}

/**
 * 账本历史。
 *
 * 和上面那段的区别写在标题下面那行里——会话没了账还在，而且它算的是全部花费
 * 不只是对话轮次。两个数字并排放着而不解释差异，只会让人以为其中一个是错的。
 */
function UsageHistory() {
  const [days, setDays] = createSignal<number>(30)
  const [by, setBy] = createSignal<string>('model')
  const [data, { refetch }] = createResource(
    () => ({ days: days(), by: by() }),
    (q) => client.api<UsageResponse>(`/api/usage?days=${q.days}&by=${q.by}`),
  )

  return (
    <div class="settings-section">
      <span class="settings-section-head">用量账本</span>

      <div class="usage-controls">
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

      <div class="usage-controls">
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

      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(u) => (
          <Show
            when={u().totals.entries > 0}
            fallback={<div class="field-hint">最近 {u().days} 天没有记录。</div>}
          >
            <div class="run-total">
              <span class="run-total-cost">{formatCosts(u().totals.cost)}</span>
              <span class="field-hint">
                {u().totals.entries} 笔 · 入 {u().totals.inputTokens.toLocaleString()} / 出{' '}
                {u().totals.outputTokens.toLocaleString()} · 本工作区{' '}
                {formatCosts(u().workspaceTotals.cost)}
              </span>
            </div>

            <table class="args-table">
              <tbody>
                <For each={u().rows}>
                  {(r) => (
                    <tr>
                      <th>{r.key}</th>
                      <td>
                        <div class="run-row-top">
                          <span>{formatCosts(r.cost)}</span>
                        </div>
                        <div class="field-hint">
                          {r.entries} 笔 · 入 {r.inputTokens.toLocaleString()} / 出{' '}
                          {r.outputTokens.toLocaleString()} · 命中{' '}
                          {r.cachedTokens === null ? '未回报' : r.cachedTokens.toLocaleString()}
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <div class="field-hint">
              账本不随会话删除消失，且包含压缩摘要、权限分类器与 team
              成员的花费，所以它比上面那张表大。
            </div>
          </Show>
        )}
      </Show>
    </div>
  )
}

/**
 * 逐请求账本。
 *
 * ## 为什么真源是 `provider_requests` 而不是 `usage.turns`
 *
 * 「这一轮发了几次」只有 `provider_requests` 答得出来：它在**发出之前**就落行，
 * 连接层失败后的重发是独立一行（`retry_index`）。`usage.turns` 只在拿到 usage
 * 回报时才 push，所以发出去没回执的那几次在它里面根本不存在——实测一条会话里
 * 两轮各真发了两次，面板都显示成一次。
 *
 * ## 金额为什么还是从 `usage.turns` 取
 *
 * 计价发生在拿到 usage 之后，`provider_requests` 上没有这个事实。两者按
 * `turnIndex` 对齐：同一轮的成功那次能对上，重发失败的那次对不上——
 * 而对不上正是实话，那一次**收没收费我们不知道**（`uncertain` 的定义）。
 */
function RequestLedger(props: { run: Run }) {
  const [data] = createResource(
    () => props.run.id,
    (id) => client.api<{ requests: ProviderRequest[] }>(`/api/runs/${id}/requests`),
  )
  const requests = () => loaded(data)?.requests ?? []
  const costOf = (turnIndex: number) =>
    (props.run.usage?.turns ?? []).find((t) => t.turnIndex === turnIndex)?.costUsd ?? 0

  return (
    <Show when={requests().length > 0}>
      <details class="run-fold">
        <summary>逐请求账本（{requests().length} 次请求）</summary>
        <table class="args-table ledger">
          <thead>
            {/* 列序对齐中转站后台：输入 → 输出 → 缓存命中 → 缓存写入。 */}
            <tr>
              <th>#</th>
              <th>输入</th>
              <th>输出</th>
              <th>缓存命中</th>
              <th>缓存写入</th>
              <th>金额</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <For each={requests()}>
              {(q) => {
                const input =
                  q.providerInputTokens === null
                    ? null
                    : q.providerInputTokens + (q.providerCachedTokens ?? 0)
                const cost = costOf(q.turnIndex)
                return (
                  <tr>
                    {/* 重发是同一轮的第 N 次，编号要看得出来，否则两行长得一样。 */}
                    <td>
                      #{q.turnIndex + 1}
                      {q.retryIndex > 0 ? `.${q.retryIndex + 1}` : ''}
                    </td>
                    {/* 输入给**含缓存命中**的口径：中转站后台账单就是这个数，
                        两边同口径才能逐行对账。 */}
                    <td>{input === null ? '—' : input.toLocaleString()}</td>
                    <td>{q.providerOutputTokens?.toLocaleString() ?? '—'}</td>
                    {/* null 是「没回报」，写成 0 会让「缓存根本没生效」
                        看起来像「生效了但没命中」。 */}
                    <td>{q.providerCachedTokens?.toLocaleString() ?? '—'}</td>
                    <td>{q.providerCacheWriteTokens?.toLocaleString() ?? '—'}</td>
                    <td>{cost > 0 ? formatMoney(cost, props.run.usage!.currency) : '—'}</td>
                    <td>{requestOutcome(q)}</td>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
        {/* 能力边界，不折叠：连接层失败的那次**我们不知道对端收没收到、计没计费**，
            所以它的 token 与金额是空的。不写这一句，空格子会被当成 bug。 */}
        <div class="field-hint">
          「结果不明」是发出去之后连接就断了：对端有没有收到、有没有计费，无从确定。
        </div>
      </details>
    </Show>
  )
}

/** 一次请求的结局。`finish_reason` 是 provider 的原话，能给就给原话。 */
function requestOutcome(q: ProviderRequest): string {
  if (q.status === 'received') return q.finishReason || '已回报'
  if (q.status === 'uncertain') return '结果不明'
  if (q.status === 'rejected') return q.errorCode || '被拒绝'
  return q.status === 'in_flight' ? '进行中' : '未发出'
}
