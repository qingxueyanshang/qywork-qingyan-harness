import type { Run, RunUsage } from '@qywork/core'
import { formatCosts, formatMoney } from '@qywork/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { stopReasonLabel } from '../lib/step-view.ts'
import { client, state } from '../lib/store/index.ts'

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
  const [data] = createResource(
    () => state.activeConversation,
    (id) => client.api<{ runs: Run[] }>(`/api/conversations/${id}/runs`),
  )

  const runs = () => data()?.runs ?? []
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
      <Show when={data()} fallback={<div class="settings-loading">读取中…</div>}>
        <Show
          when={runs().length > 0}
          fallback={<div class="field-hint">这个会话还没有跑过任何一轮。</div>}
        >
          <div class="run-total">
            <span class="run-total-cost">{formatCosts(total().cost)}</span>
            <span class="field-hint">
              {runs().length} 轮 · 入 {total().input.toLocaleString()} / 出{' '}
              {total().output.toLocaleString()} · 命中{' '}
              {total().cached === null ? '未回报' : total().cached!.toLocaleString()}
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
 * 参照物（青研魔盒的运行详情）那张表就是按「# / 输入 / 输出 / 命中 / 写入 / 金额 /
 * 来源」七列排的，列序对齐中转站后台，这样两边能逐行对账。
 *
 * ## 来源列不能省
 *
 * `provider` 是模型真回报的，`estimated` 是本地估算的兜底。两者混在一起看，
 * 「账对不上」就永远查不清是谁的问题。
 */
function RunRow(props: { run: Run }) {
  const r = () => props.run
  const turns = () => r().usage?.turns ?? []
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
          {/* 中文说法和会话流里的收尾条共用一张表——这里曾经直接贴英文码。 */}
          <Show when={r().stopReason && r().stopReason !== 'completed'}>
            <span class="run-row-tag bad">{stopReasonLabel(r().stopReason!)}</span>
          </Show>
        </div>
        <div class="field-hint">
          入 {(r().usage?.inputTokens ?? 0).toLocaleString()} / 出{' '}
          {(r().usage?.outputTokens ?? 0).toLocaleString()} · {r().stepCount} 步
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

        <Show when={turns().length > 0}>
          <details class="run-fold">
            <summary>逐请求账本（{turns().length} 次调用）</summary>
            <table class="args-table ledger">
              <thead>
                {/* 列序对齐中转站后台：输入 → 输出 → 命中(读) → 写入。 */}
                <tr>
                  <th>#</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>命中</th>
                  <th>写入</th>
                  <th>金额</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                <For each={turns()}>
                  {(t) => (
                    <tr>
                      <td>#{t.turnIndex + 1}</td>
                      <td>{t.input.toLocaleString()}</td>
                      <td>{t.output.toLocaleString()}</td>
                      {/* null 是「没回报」，写成 0 会让「缓存根本没生效」
                          看起来像「生效了但没命中」。 */}
                      <td>{t.cached === null ? '—' : t.cached.toLocaleString()}</td>
                      <td>{t.cacheWrite === null ? '—' : t.cacheWrite.toLocaleString()}</td>
                      {/* 字段名叫 `costUsd`，但它和 `usage.cost` 是同一次计算的产物，
                          币种由模型决定（阿里 / 月之暗面 / 智谱按人民币标价）。
                          所以按这一轮的币种显示，不按字段名显示。 */}
                      <td>{t.costUsd > 0 ? formatMoney(t.costUsd, r().usage!.currency) : '—'}</td>
                      <td>{t.source === 'provider' ? 'provider' : '估算'}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </details>
        </Show>
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
  const [data] = createResource(
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
              class="side-tab"
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
              class="side-tab"
              classList={{ active: by() === g.by }}
              type="button"
              onClick={() => setBy(g.by)}
            >
              {g.label}
            </button>
          )}
        </For>
      </div>

      <Show when={data()} fallback={<div class="settings-loading">读取中…</div>}>
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
