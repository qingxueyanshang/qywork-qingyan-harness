import type {
  ConversationUsageResponse,
  Currency,
  ProviderRequest,
  Run,
  UsageLedgerRow,
  UsageTotals,
} from '@qywork/core'
import { formatCosts, formatMoney } from '@qywork/core'
import { createMemo, createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { compact, stopReasonLabel } from '../lib/step-view.ts'
import { client, ledgerRevision, openSettings, state } from '../lib/store/index.ts'
import { IconChevron } from './Icons.tsx'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 运行：这条会话花了多少，以及每一笔花在哪。
 *
 * **只做对话流做不到的两件事：合计与下钻。** 对话流每一轮末尾那条读数条（`.run-strip`）已经逐轮显示
 * 耗时、入出 token、命中率、金额、停止原因。这一页重印那些字段就是同一件事说两遍。对话流给不出的只
 * 有两样：跨轮的合计（滚多少屏也加不出来），和一轮里逐次请求的账（一行装不下）。
 *
 * **合计取账本，不取 runs 相加。** 账本（`usage_ledger`）按会话 id 收着这条会话引发的**每一笔**：每
 * 一轮，以及夹在轮次之间的压缩摘要调用。把 run 加起来必然少算压缩那几笔——那不是口径选择，是漏
 * 账。清单里同样把非轮次的那几笔列出来，所以合计与清单对得上，不需要任何一句解释差额的话。
 */
export default function RunDetails() {
  /*
   * 判据按值去重，不能是每次都新建的那个对象字面量。
   *
   * `createResource` 把 source 包进 memo 按 `===` 比，对象字面量每次都不相等——
   * `ledgerRevision()` 那份「没变就别重取」因此白写：别的会话开跑一次、某一轮的
   * 金额原地改一次（分量都没动），这两张表就各重取一遍。同文件另外两处的判据是串，
   * 天生按值比。
   */
  const key = createMemo(
    () => ({ id: state.activeConversation, rev: ledgerRevision() }),
    undefined,
    { equals: (a, b) => a.id === b.id && a.rev === b.rev },
  )

  const [runData, { refetch: refetchRuns }] = createResource(key, async (k) =>
    k.id === null
      ? { runs: [] as Run[] }
      : await client.api<{ runs: Run[] }>(`/api/conversations/${k.id}/runs`),
  )
  const [ledger, { refetch: refetchLedger }] = createResource(key, async (k) =>
    k.id === null
      ? { totals: emptyTotals(), entries: [] as UsageLedgerRow[] }
      : await client.api<ConversationUsageResponse>(`/api/conversations/${k.id}/usage`),
  )

  // `loaded()` 而不是 `data()`：后者出错时 `throw`，而这个应用没有 `ErrorBoundary`。
  const runs = createMemo(() => [...(loaded(runData)?.runs ?? [])].reverse())
  /** 账本里非轮次的那几笔（压缩摘要等）。轮次那几笔由 `runs` 提供，它带得动展开区。 */
  const extras = createMemo(() => (loaded(ledger)?.entries ?? []).filter((e) => e.kind !== 'run'))

  /** 清单：轮次与非轮次按时间倒序并成一列。 */
  const rows = createMemo(() =>
    [
      ...runs().map((r) => ({ at: r.createdAt, run: r, extra: null as UsageLedgerRow | null })),
      ...extras().map((e) => ({ at: e.occurredAt, run: null as Run | null, extra: e })),
    ].sort((a, b) => b.at - a.at),
  )

  /** 展开的是哪一条。同时只展开一条：一次要读的是一轮的账，不是几轮并排。 */
  const [picked, setPicked] = createSignal<string | null>(null)

  const retry = () => {
    void refetchRuns()
    void refetchLedger()
  }

  return (
    <div class="run-panel">
      <div class="run-col">
        <Show
          when={loaded(runData) && loaded(ledger)}
          fallback={
            <div class="run-load">
              <LoadState error={runData.error ?? ledger.error} onRetry={retry} />
            </div>
          }
        >
          {/* 一笔都没有就空着：摆一排 0 是把「还没开始」说成「花了零元」。 */}
          <Show when={rows().length > 0}>
            <Summary runs={runs()} ledger={loaded(ledger)!.totals} />
            <ul class="run-list">
              <For each={rows()}>
                {(row) => (
                  <Show when={row.run} fallback={<ExtraRow entry={row.extra!} />} keyed>
                    {(r) => (
                      <RunRow
                        run={r}
                        open={picked() === r.id}
                        onPick={() => setPicked((cur) => (cur === r.id ? null : r.id))}
                      />
                    )}
                  </Show>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <LedgerLink />
      </div>
    </div>
  )
}

/** 读数卡里的一格。名字在上、值在下——每个数都自带标签，不靠位置去猜它是什么。 */
function Stat(props: { label: string; value: string }) {
  return (
    <div class="run-stat">
      <span class="run-stat-label">{props.label}</span>
      <span class="run-stat-value">{props.value}</span>
    </div>
  )
}

/**
 * 会话合计：金额跟在「本会话」右边，下面一张六格读数卡。
 *
 * **六格是一份完整的账。** 轮次 / 输入 / 输出 / 命中率 / 缓存命中 / 缓存写入，与中转站后台的读数同
 * 名同序。少任何一格都会让「这条会话的花销构成」缺一块：命中率答「缓存生效没有」，命中与写入答
 * 「省下多少、又为建缓存付了多少」。
 *
 * **正在跑的那一轮单独加。** 账本在**收尾时**才记一笔，所以正在跑的那一轮还不在里面。判据取
 * `finishedAt === null`——未结算的轮次一定不在账本里，两边不会重复计。
 * 不加的话，清单里那一行的金额在涨而上面的合计不动。
 *
 * **收成 K/M。** 这里回答量级，逐位对账在展开区那张逐请求表里——一格 110px 装不下九位数字。
 */
function Summary(props: { runs: Run[]; ledger: UsageTotals }) {
  const totals = createMemo(() =>
    props.runs
      .filter((r) => r.finishedAt === null)
      .reduce(
        (acc, r) => ({
          input: acc.input + (r.usage?.inputTokens ?? 0),
          output: acc.output + (r.usage?.outputTokens ?? 0),
          cost: addCost(acc.cost, r.usage?.cost, r.usage?.currency),
          cached: addMaybe(acc.cached, r.usage?.cachedTokens),
          cacheWrite: addMaybe(acc.cacheWrite, r.usage?.cacheWriteTokens),
        }),
        {
          input: props.ledger.inputTokens,
          output: props.ledger.outputTokens,
          cost: { ...props.ledger.cost },
          cached: props.ledger.cachedTokens,
          cacheWrite: props.ledger.cacheWriteTokens,
        },
      ),
  )

  /**
   * 缓存命中率。分母是「未命中 + 命中 + 写入」——`inputTokens` 只装未命中的那部分，
   * 拿它当分母算出来的比例恒偏高，命中高时能超过 100%。
   *
   * 与读数条那一格问的不是同一件事：那里看最后一次调用，答「现在缓存生效了吗」；
   * 这里看整条会话，答「这条会话总共省下多少」。
   */
  const hit = () => {
    const t = totals()
    if (t.cached === null) return NA
    const denom = t.input + t.cached + (t.cacheWrite ?? 0)
    return denom > 0 ? `${((t.cached / denom) * 100).toFixed(1)}%` : NA
  }

  return (
    <header class="run-sum">
      <div class="run-sum-top">
        <span class="run-sum-scope">本会话</span>
        <span class="run-sum-cost">{money(totals().cost)}</span>
      </div>
      <div class="run-stats">
        <Stat label="轮次" value={String(props.runs.length)} />
        {/* 输入给**含缓存命中**的口径：中转站后台账单就是这个数，两边同口径才能对账。 */}
        <Stat label="输入" value={compact(totals().input + (totals().cached ?? 0))} />
        <Stat label="输出" value={compact(totals().output)} />
        <Stat label="命中率" value={hit()} />
        <Stat label="缓存命中" value={maybeCount(totals().cached)} />
        <Stat label="缓存写入" value={maybeCount(totals().cacheWrite)} />
      </div>
    </header>
  )
}

/**
 * 一轮一行。**这一行就是这一轮的全部标题**：什么时候、哪个模型、跑了几步多久、
 * 出没出事、多少钱。
 *
 * 模型名与步数耗时不进展开区——放进去等于给同一轮做两个标题，上面一个时间、
 * 下面一个模型名，而它们说的是同一件事。展开区留给只有展开才看的内容：逐请求的账。
 */
function RunRow(props: { run: Run; open: boolean; onPick: () => void }) {
  const r = () => props.run
  const mark = () => runMark(r())
  /** 跑完才给耗时。还在跑的那一轮由「进行中」标记说，两处都说就是同一件事说两遍。 */
  const elapsed = () => {
    const end = r().finishedAt
    return end === null ? null : `${((end - r().createdAt) / 1000).toFixed(1)}s`
  }

  return (
    <li>
      <button class="run-row" type="button" aria-expanded={props.open} onClick={props.onPick}>
        <IconChevron size={10} dir={props.open ? 'down' : 'right'} />
        <span class="run-when">{clockOf(r().createdAt)}</span>
        {/* 模型名是这一行唯一长度不可控的一格，所以只有它让位。 */}
        <span class="run-model truncate">{r().model}</span>
        <span class="run-meta">{r().stepCount} 步</span>
        <Show when={elapsed()}>{(e) => <span class="run-meta">{e()}</span>}</Show>
        <Show when={mark()}>
          {(m) => (
            <span class="run-mark" classList={{ bad: m().bad }}>
              {m().text}
            </span>
          )}
        </Show>
        <span class="run-money">{runCost(r())}</span>
      </button>
      <Show when={props.open}>
        <RequestLedger run={props.run} />
      </Show>
    </li>
  )
}

/**
 * 不属于任何一轮的那一笔（压缩摘要）。
 *
 * **列出来是为了合计对得上**：这笔钱真花了，只是它发生在两轮之间。
 * 它没有 run，所以没有展开区，也不给折叠符号——占位空格保证时间列还在同一条竖线上。
 */
function ExtraRow(props: { entry: UsageLedgerRow }) {
  return (
    <li>
      <div class="run-row static">
        <span class="run-gap" />
        <span class="run-when">{clockOf(props.entry.occurredAt)}</span>
        <span class="run-mark">{KIND_LABEL[props.entry.kind] ?? props.entry.kind}</span>
        <span class="run-money">
          {props.entry.cost > 0 ? formatMoney(props.entry.cost, props.entry.currency) : NA}
        </span>
      </div>
    </li>
  )
}

/**
 * 展开之后才看的那份账：这一轮逐次请求的明细。
 *
 * **只有这张表。** 行上已经说了什么时候、哪个模型、几步多久、出没出事、多少钱；会话流末尾那条读数条
 * 说了为什么停、报错正文是什么。在这里再印一遍就是同一件事说两遍。
 * 出错的是某一次请求，它记在那一行的「结果」列上，不在轮次上另挂一块。
 *
 * **真源是 `provider_requests` 而不是 `usage.turns`。** 「这一轮发了几次」只有它答得出来：它在**发
 * 出之前**就落行，连接层失败后的重发是独立一行（`retry_index`）。`usage.turns` 只在拿到 usage 回报
 * 时才 push，所以发出去没回执的那几次在它里面不存在。
 *
 * **金额仍从 `usage.turns` 取。** 计价发生在拿到 usage 之后，`provider_requests` 上没有这个事实。两
 * 者按 `turnIndex` 对齐：成功那次对得上，重发失败那次对不上——而对不上正是实话，那一次收没收费不知
 * 道。
 *
 * **列序对齐中转站后台。** 输入 → 输出 → 命中 → 写入 → 金额 → 结果，与账单同序，两边能逐行扫下来。
 */
function RequestLedger(props: { run: Run }) {
  // 跑完的那一轮不会再多请求，判据里就不放账本修订号——否则每落一步都要为一张
  // 不会变的表重取一次。
  const [data] = createResource(
    () => `${props.run.id}:${props.run.finishedAt === null ? ledgerRevision() : ''}`,
    () => client.api<{ requests: ProviderRequest[] }>(`/api/runs/${props.run.id}/requests`),
  )
  const requests = () => loaded(data)?.requests ?? []
  const costOf = (turnIndex: number) =>
    (props.run.usage?.turns ?? []).find((t) => t.turnIndex === turnIndex)?.costUsd ?? 0

  return (
    <Show when={requests().length > 0}>
      <div class="run-detail">
        <table class="run-req">
          <thead>
            <tr>
              {/* 列名写「请求」而不是 `#`：行上那个「N 步」数的是 steps 表的行数
                  （每段思考、每段正文、每次工具调用各一条），这里数的是模型往返次数，
                  两个数不该、也不会相等。列名把单位说出来，省掉一次「为什么对不上」。 */}
              <th>请求</th>
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
                    <td>{num(q.providerCachedTokens)}</td>
                    <td>{num(q.providerCacheWriteTokens)}</td>
                    <td>{cost > 0 ? formatMoney(cost, props.run.usage!.currency) : NA}</td>
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
  const [data] = createResource(ledgerRevision, () =>
    client.api<{ totals: { cost: Record<string, number> } }>('/api/usage?days=30'),
  )
  const cost = () => {
    const c = loaded(data)?.totals.cost
    return c ? money(c) : NA
  }

  return (
    <button class="run-ledger" type="button" onClick={() => openSettings('usage')}>
      <span class="run-ledger-label">本机运行 · 近 30 天</span>
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
 * 正常完成的轮次不挂任何标记——一列干净的行本身就是「都正常」。
 */
function runMark(r: Run): { text: string; bad?: boolean } | null {
  // 中文说法和会话流里的收尾条共用一张表，别在这里直接贴英文码。
  if (r.stopReason && r.stopReason !== 'completed') {
    return { text: stopReasonLabel(r.stopReason), bad: true }
  }
  if (r.finishedAt === null) return { text: '进行中' }
  return null
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

/** 这一轮的金额。计价为 0 即这个模型没有价目，写 $0.00 是把「不知道」说成「免费」。 */
function runCost(r: Run): string {
  const u = r.usage
  return u && u.cost > 0 ? formatMoney(u.cost, u.currency) : NA
}

/** 金额合计。同上：一笔计价都没有时不是零元，是没有价目。 */
function money(cost: Record<string, number>): string {
  return Object.values(cost).some((v) => v > 0) ? formatCosts(cost) : NA
}

/**
 * 没有这个数时写它。
 *
 * **是术语，不是符号**：一根横线读者认不出它在说什么——是零、是省略、还是没取到。
 * `N/A` 是数据表里「此处无可用值」的通用写法，含义唯一，也不会被当成数字。
 *
 * 它盖着两种情形，两种都是「这个数不存在」而不是「这个数是 0」：
 * 接口没有回报这个字段（缓存那几格的 `null`），以及这个模型没有计价（金额为 0）。
 */
const NA = 'N/A'

/** 读数卡里的计数。 */
function maybeCount(n: number | null): string {
  return n === null ? NA : compact(n)
}

/** 表格里的计数。 */
function num(n: number | null): string {
  return n === null ? NA : n.toLocaleString()
}

/** 把一笔花费并进按币种分的桶里。**不跨币种相加。** */
function addCost(
  acc: Record<string, number>,
  cost: number | undefined,
  currency: Currency | undefined,
): Record<string, number> {
  if (!cost) return acc
  const cur = currency ?? 'USD'
  return { ...acc, [cur]: (acc[cur] ?? 0) + cost }
}

/** 累加一个「可能没给」的计数。两边都没给过时保持 `null`。 */
function addMaybe(acc: number | null, v: number | null | undefined): number | null {
  return v === null || v === undefined ? acc : (acc ?? 0) + v
}

/** 账本里非轮次那几笔的中文名。键与 `UsageKind` 一一对应。 */
const KIND_LABEL: Record<string, string> = {
  summary: '压缩摘要',
  classifier: '权限裁决',
  team: '协作成员',
}

/** 没有活动会话时的空账。给一份而不是不取，界面才有恒定的形状。 */
function emptyTotals(): UsageTotals {
  return {
    entries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    cost: {},
  }
}
