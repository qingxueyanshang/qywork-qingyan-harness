import type { ProviderRequest, Run } from '@qywork/core'
import { formatCosts, formatMoney } from '@qywork/core'
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { stopReasonLabel } from '../lib/step-view.ts'
import { client, isRunning, openSettings, state } from '../lib/store/index.ts'
import { IconChevron } from './Icons.tsx'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 运行：这条会话花了多少，以及每一轮里面发生了什么。
 *
 * ## 只做对话流做不到的两件事：合计与下钻
 *
 * 对话流每一轮末尾那条读数条（`.run-strip`）已经逐轮显示耗时、入出 token、命中率、
 * 金额、停止原因。这一页凡是重印那些字段的地方都是废话。对话流给不出的只有两样：
 * 跨轮的合计（滚多少屏也加不出来），和一轮里面逐次请求的账（一行装不下）。
 *
 * ## 收起的行只放挑选轴
 *
 * 用户在清单上做的动作是「挑出那一轮」，挑选轴只有三个：什么时候、出没出事、贵不贵。
 * 模型名、步数、耗时、token 全部只在展开区出现——它们是选中之后才要的。
 * 金额是唯一与对话流重复的字段，理由是竖着可扫的金额列是「哪一轮贵」的唯一载体。
 *
 * ## 一页一个尺度
 *
 * 机器账本（30 天、四种分组）不在这里，它在设置的「用量」页。底部那一行给出 30 天
 * 合计并通向那一页——把两个尺度摆在同一页的代价是两套筛选钮先于任何数字。
 */
export default function RunDetails() {
  const [data, { refetch }] = createResource(
    // 刷新键带上轮次：这一页常驻在面板里，只按会话 id 取一次的话新跑完的那一轮
    // 永远进不来。`lastRunId` 管「又起了一轮」，`isRunning()` 管「那一轮跑完了」。
    () => ({ id: state.activeConversation, run: state.lastRunId, busy: isRunning() }),
    async (k) =>
      k.id === null
        ? { runs: [] as Run[] }
        : await client.api<{ runs: Run[] }>(`/api/conversations/${k.id}/runs`),
  )
  // `loaded()` 而不是 `data()`：后者出错时 `throw`，而这个应用没有 `ErrorBoundary`。
  const runs = createMemo(() => [...(loaded(data)?.runs ?? [])].reverse())

  /**
   * 当前那一轮。**窄宽两态共用这一个状态**：窄态它是「展开的那一条」，宽态是
   * 「选中的那一条」。两个信号的话，拖宽面板时选中会跳到别处。
   */
  const [picked, setPicked] = createSignal<string | null>(null)
  const current = () => {
    const list = runs()
    // 宽态右栏不能空着，没挑过就落在最新那一轮；窄态默认全部收起。
    return list.find((r) => r.id === picked()) ?? (wide() ? list[0] : undefined)
  }

  /**
   * 面板拖到足够宽时改成左右两栏。
   *
   * 判据是**这块面板量出来的宽度**，不是窗口宽度也不是 `panelWidth()`：后者是用户
   * 「想要多宽」，窗口放不下时网格只给到上限，两者能差出好几百像素。
   */
  const [wide, setWide] = createSignal(false)
  let root!: HTMLDivElement
  onMount(() => {
    const ro = new ResizeObserver((entries) => {
      setWide((entries[0]?.contentRect.width ?? 0) >= 640)
    })
    ro.observe(root)
    onCleanup(() => ro.disconnect())
  })

  return (
    <div class="run-panel" classList={{ wide: wide() }} ref={root}>
      <div class="run-col">
        <Show
          when={loaded(data)}
          fallback={
            <div class="run-load">
              <LoadState error={data.error} onRetry={() => void refetch()} />
            </div>
          }
        >
          {/* 一轮都没跑过就空着：摆一排 0 和「—」是把「还没开始」说成「花了零元」。 */}
          <Show when={runs().length > 0}>
            <Summary runs={runs()} />
            <ul class="run-list">
              <For each={runs()}>
                {(r) => (
                  <RunRow
                    run={r}
                    wide={wide()}
                    active={current()?.id === r.id}
                    onPick={() => setPicked((cur) => (!wide() && cur === r.id ? null : r.id))}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <LedgerLink />
      </div>

      {/* 宽态的右栏。放大面板的真实场景是拿这张表和中转站后台并排对账，
          所以宽度全给它，而不是让正文停在一个 560px 的框里、右边空一大片。 */}
      <Show when={wide()}>
        <div class="run-detail-col">
          <Show when={current()}>{(r) => <RunDetail run={r()} />}</Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * 会话合计。**全页唯一的大字是那笔钱**——字号层级按提问频率给：
 * 「烧了多少」每次瞥一眼都在问，「哪一轮」偶尔问，「逐请求对账」排查时才问。
 */
function Summary(props: { runs: Run[] }) {
  const totals = createMemo(() =>
    props.runs.reduce(
      (acc, r) => ({
        input: acc.input + (r.usage?.inputTokens ?? 0),
        // 按币种分桶。同一个会话里换过模型就可能混币种，加成一个数字要汇率，
        // 而我们不做换算。
        cost: addCost(acc.cost, r),
        cached: addMaybe(acc.cached, r.usage?.cachedTokens),
        cacheWrite: addMaybe(acc.cacheWrite, r.usage?.cacheWriteTokens),
      }),
      {
        input: 0,
        cost: {} as Record<string, number>,
        cached: null as number | null,
        cacheWrite: null as number | null,
      },
    ),
  )

  /**
   * 会话累计命中率。分母是「未命中 + 命中 + 写入」——`inputTokens` 只装未命中的
   * 那部分，拿它当分母算出来的比例恒偏高，命中高时能超过 100%。
   *
   * 与读数条那一格问的不是同一件事：那里看最后一次调用，答「现在缓存生效了吗」；
   * 这里看整条会话，答「这条会话总共省下多少」。
   */
  const hit = () => {
    const t = totals()
    if (t.cached === null) return '未回报'
    const denom = t.input + t.cached + (t.cacheWrite ?? 0)
    return denom > 0 ? `${((t.cached / denom) * 100).toFixed(1)}%` : '—'
  }

  return (
    <header class="run-sum">
      <span class="run-sum-scope">本会话</span>
      <span class="run-sum-cost">{money(totals().cost)}</span>
      <span class="run-sum-meta">
        {props.runs.length} 轮 · 缓存命中 {hit()}
      </span>
      {/* 能力边界，不折叠：压缩摘要那次调用也计费，但它不属于任何一轮，
          所以这个合计会小于账本。不写的话「对不上」会被当成 bug。 */}
      <span class="run-sum-note">压缩摘要的调用不计在内。</span>
    </header>
  )
}

/** 一轮一行。只有时间、异常、金额三样——其余进展开区。 */
function RunRow(props: { run: Run; wide: boolean; active: boolean; onPick: () => void }) {
  const r = () => props.run
  const mark = () => runMark(r())

  return (
    <li classList={{ superseded: !!r().supersededBy }}>
      <button
        class="run-row"
        classList={{ active: props.wide && props.active }}
        type="button"
        aria-expanded={props.wide ? undefined : props.active}
        onClick={props.onPick}
      >
        {/* 宽态没有折叠动作，那里的行是「选中」不是「展开」，不给折叠符号。 */}
        <Show when={!props.wide}>
          <IconChevron size={10} dir={props.active ? 'down' : 'right'} />
        </Show>
        <span class="run-when">{clockOf(r().createdAt)}</span>
        <Show when={mark()}>
          {(m) => (
            <span class="run-mark" classList={{ bad: m().bad }}>
              {m().text}
            </span>
          )}
        </Show>
        <span class="run-money">{runCost(r())}</span>
      </button>
      <Show when={!props.wide && props.active}>
        <RunDetail run={props.run} />
      </Show>
    </li>
  )
}

/** 选中那一轮的全部：元信息、失败原文、逐请求账。窄态在行下面，宽态在右栏。 */
function RunDetail(props: { run: Run }) {
  const r = () => props.run
  const elapsed = () => {
    const end = r().finishedAt
    return end === null ? '进行中' : `${((end - r().createdAt) / 1000).toFixed(1)}s`
  }

  return (
    <div class="run-detail">
      <div class="run-detail-meta">
        <span class="truncate">{r().model}</span>
        <span>{r().stepCount} 步</span>
        <span>{elapsed()}</span>
      </div>

      {/* 失败原文：错误码与原文一直在落库，选中就直接给，不套折叠。 */}
      <Show when={r().errorCode || r().errorMessage}>
        <div class="run-err">
          <Show when={r().errorCode}>
            <code>{r().errorCode}</code>
          </Show>
          <Show when={r().errorMessage}>
            <span class="run-err-msg">{r().errorMessage}</span>
          </Show>
        </div>
      </Show>

      <RequestLedger run={props.run} />
    </div>
  )
}

/**
 * 逐请求账本。
 *
 * ## 真源是 `provider_requests` 而不是 `usage.turns`
 *
 * 「这一轮发了几次」只有它答得出来：它在**发出之前**就落行，连接层失败后的重发是
 * 独立一行（`retry_index`）。`usage.turns` 只在拿到 usage 回报时才 push，
 * 所以发出去没回执的那几次在它里面根本不存在。
 *
 * ## 金额仍从 `usage.turns` 取
 *
 * 计价发生在拿到 usage 之后，`provider_requests` 上没有这个事实。两者按 `turnIndex`
 * 对齐：成功那次对得上，重发失败那次对不上——而对不上正是实话，那一次收没收费不知道。
 *
 * ## 列序对齐中转站后台
 *
 * 输入 → 输出 → 命中 → 写入 → 金额 → 结果，与账单同序，两边能逐行扫下来。
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
      <div class="run-req-scroll">
        <table class="run-req">
          <thead>
            <tr>
              <th>#</th>
              <th>输入</th>
              <th>输出</th>
              <th>命中</th>
              <th>写入</th>
              <th>金额</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <For each={requests()}>
              {(q) => {
                // 输入给**含缓存命中**的口径：中转站后台账单就是这个数。
                const input =
                  q.providerInputTokens === null
                    ? null
                    : q.providerInputTokens + (q.providerCachedTokens ?? 0)
                const cost = costOf(q.turnIndex)
                const outcome = requestOutcome(q)
                return (
                  <tr>
                    {/* 重发是同一轮的第 N 次，编号要看得出来，否则两行长得一样。 */}
                    <td>
                      {q.turnIndex + 1}
                      {q.retryIndex > 0 ? `.${q.retryIndex + 1}` : ''}
                    </td>
                    <td>{num(input)}</td>
                    <td>{num(q.providerOutputTokens)}</td>
                    {/* null 是「没回报」，写成 0 会让「缓存根本没生效」
                        看起来像「生效了但没命中」。 */}
                    <td>{num(q.providerCachedTokens)}</td>
                    <td>{num(q.providerCacheWriteTokens)}</td>
                    <td>{cost > 0 ? formatMoney(cost, props.run.usage!.currency) : '—'}</td>
                    {/* 原话长度不可控（`completed:max_output_tokens`），截断，全文留 title。 */}
                    <td class="run-req-out" title={outcome}>
                      {outcome}
                    </td>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </div>
      {/* 能力边界，只在真出现时才占地方：连接层失败的那次**我们不知道对端收没收到、
          计没计费**，所以它那一行的 token 与金额是空的。 */}
      <Show when={requests().some((q) => q.status === 'uncertain')}>
        <p class="run-note">结果不明：发出去之后连接就断了，对端收没收到、计没计费无从确定。</p>
      </Show>
    </Show>
  )
}

/**
 * 通向账本的那一行。**只给一个数**：这台机器近 30 天一共多少钱。
 *
 * 它是「这个月花了多少」的入口，明细在设置的「用量」页。这一行不做加载态与错误态
 * ——值位保持「—」，行高恒定；完整的两种状态在它点进去的那一页。
 */
function LedgerLink() {
  const [data] = createResource(
    () => ({ busy: isRunning() }),
    () => client.api<{ totals: { cost: Record<string, number> } }>('/api/usage?days=30'),
  )
  const cost = () => {
    const c = loaded(data)?.totals.cost
    return c ? money(c) : '—'
  }

  return (
    <button class="run-ledger" type="button" onClick={() => openSettings('usage')}>
      <span class="run-ledger-label">这台机器 · 近 30 天</span>
      <span class="run-ledger-cost">{cost()}</span>
      <IconChevron size={11} dir="right" />
    </button>
  )
}

/** 一次请求的结局。`finishReason` 是 provider 的原话，能给就给原话。 */
function requestOutcome(q: ProviderRequest): string {
  if (q.status === 'received') return q.finishReason || '已回报'
  if (q.status === 'uncertain') return '结果不明'
  if (q.status === 'rejected') return q.errorCode || '被拒绝'
  return q.status === 'in_flight' ? '进行中' : '未发出'
}

/**
 * 这一行要不要挂标记，挂哪一个。**最多一枚**：三个标记同时出现的那一行会长过金额列。
 * 正常完成的轮次不挂任何东西——一列干净的行本身就是「都正常」。
 */
function runMark(r: Run): { text: string; bad?: boolean } | null {
  // 中文说法和会话流里的收尾条共用一张表，别在这里直接贴英文码。
  if (r.stopReason && r.stopReason !== 'completed') {
    return { text: stopReasonLabel(r.stopReason), bad: true }
  }
  if (r.finishedAt === null) return { text: '进行中' }
  // 被接替的产出不算数，但钱算数，所以照常列出，只标出来并整行压暗。
  return r.supersededBy ? { text: '已被接替' } : null
}

/** 行首的时间。当天只给时分，跨天补日期——不另做日期分隔行，那会把清单切成几段。 */
function clockOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** 这一轮的金额。计价为 0 时给「—」：未知计价冒充免费更误导。 */
function runCost(r: Run): string {
  const u = r.usage
  return u && u.cost > 0 ? formatMoney(u.cost, u.currency) : '—'
}

/** 金额合计。一笔计价都没有时给「—」——写成 $0.00 是把「不知道」说成「免费」。 */
function money(cost: Record<string, number>): string {
  return Object.values(cost).some((v) => v > 0) ? formatCosts(cost) : '—'
}

/** 表格里的计数。`null` 是「没回报」，给「—」不给 0。 */
function num(n: number | null): string {
  return n === null ? '—' : n.toLocaleString()
}

/** 把一轮的花费并进按币种分的桶里。**不跨币种相加。** */
function addCost(acc: Record<string, number>, r: Run): Record<string, number> {
  const u = r.usage
  if (!u?.cost) return acc
  return { ...acc, [u.currency]: (acc[u.currency] ?? 0) + u.cost }
}

/** 累加一个「可能没回报」的计数。两边都没回报过时保持 `null`。 */
function addMaybe(acc: number | null, v: number | null | undefined): number | null {
  return v === null || v === undefined ? acc : (acc ?? 0) + v
}
