import type {
  ConversationRunsResponse,
  ConversationUsageResponse,
  GenerateOutput,
  ProviderRequest,
  Run,
  UsageLedgerRow,
  UsageTotals,
} from '@qywork/core'
import { formatCosts, formatMoney, MEDIA_OUTPUT_UNIT, runCosts } from '@qywork/core'
import { createMemo, createResource, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { sessionSignal } from '../lib/session.ts'
import { compact, requestOutcome, stopReasonLabel } from '../lib/step-view.ts'
import { client, ledgerRevision, openSettings, state } from '../lib/store/index.ts'
import { IconChevron } from './Icons.tsx'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 运行页：当前会话的费用合计与逐项明细。
 *
 * **只提供会话流无法提供的两项内容：合计与明细。** 会话流每轮末尾的读数条（`.run-strip`）已逐轮显示
 * 耗时、输入与输出 token、命中率、金额与停止原因，本页不重复显示这些字段。会话流无法提供的是：
 * 跨轮次的合计，以及单轮内逐次请求的明细（一行无法容纳）。
 *
 * **合计取自账本，不由 runs 相加得出。** 账本（`usage_ledger`）按会话 id 记录该会话产生的**每一笔**费用：
 * 每一轮，以及轮次之间的压缩摘要调用。由 runs 相加会遗漏压缩调用的费用。清单同样列出
 * 非轮次的条目，因此合计与清单一致，无需另加说明差额的文字。
 */
export default function RunDetails() {
  /*
   * 重取判据必须按值去重，不能直接使用每次新建的对象字面量。
   *
   * `createResource` 把 source 包进 memo 并按 `===` 比较，对象字面量每次都不相等，
   * `ledgerRevision()` 的「未变化则不重取」因此失效：其他会话每开始执行一次、某一轮的
   * 金额每原地更新一次（各分量均未变化），两张表都会各重取一次。同文件另外两处的判据是
   * 字符串，本身按值比较。
   */
  const key = createMemo(
    () => ({ id: state.activeConversation, rev: ledgerRevision() }),
    undefined,
    { equals: (a, b) => a.id === b.id && a.rev === b.rev },
  )

  const [runData, { refetch: refetchRuns }] = createResource(key, async (k) =>
    k.id === null
      ? { runs: [] as Run[], childRuns: [] as ConversationRunsResponse['childRuns'] }
      : await client.api<ConversationRunsResponse>(`/api/conversations/${k.id}/runs`),
  )
  const [ledger, { refetch: refetchLedger }] = createResource(key, async (k) =>
    k.id === null
      ? { totals: emptyTotals(), entries: [] as UsageLedgerRow[] }
      : await client.api<ConversationUsageResponse>(`/api/conversations/${k.id}/usage`),
  )

  // 使用 `loaded()` 而不是 `data()`：后者出错时 `throw`，而本应用没有 `ErrorBoundary`。
  const runs = createMemo(() => [...(loaded(runData)?.runs ?? [])].reverse())
  /** 子会话的轮次：派发的子任务，费用计入当前会话。 */
  const childRuns = createMemo(() => loaded(runData)?.childRuns ?? [])
  /**
   * 账本中不属于任何轮次的条目（手动压缩的摘要等）。轮次条目由 `runs` 提供，它带有展开区所需的数据。
   * 轮次内的压缩请求是该轮的普通请求，显示在该轮的逐请求表中；带 runId 的账本行归属该轮，
   * 不单独成行。
   */
  const extras = createMemo(() =>
    (loaded(ledger)?.entries ?? []).filter((e) => e.kind !== 'run' && e.runId === null),
  )

  /** 清单：本会话轮次、子会话轮次与不属于任何轮次的条目按时间倒序合并为一列。 */
  const rows = createMemo(() =>
    [
      ...runs().map((r) => ({
        at: r.createdAt,
        run: r,
        name: '',
        extra: null as UsageLedgerRow | null,
      })),
      ...childRuns().map((c) => ({
        at: c.run.createdAt,
        run: c.run,
        name: c.name,
        extra: null as UsageLedgerRow | null,
      })),
      ...extras().map((e) => ({
        at: e.occurredAt,
        run: null as Run | null,
        name: '',
        extra: e,
      })),
    ].sort((a, b) => b.at - a.at),
  )

  /** 当前展开的行。同一时刻只展开一行：每次查看的是单轮明细，不并排比较多轮。 */
  const [picked, setPicked] = sessionSignal<string | null>('qywork.runs.picked', null)

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
          {/* 没有任何条目时留空：显示一排 0 会把「尚未开始」表达为「费用为零」。 */}
          <Show when={rows().length > 0}>
            <Summary
              runs={[...runs(), ...childRuns().map((c) => c.run)]}
              ledger={loaded(ledger)!.totals}
            />
            <ul class="run-list">
              <For each={rows()}>
                {(row) => (
                  <Show when={row.run} fallback={<ExtraRow entry={row.extra!} />} keyed>
                    {(r) => (
                      <RunRow
                        run={r}
                        name={row.name}
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

/** 读数卡中的一项。名称在上、值在下：每个数值都带有标签，无需按位置推断含义。 */
function Stat(props: { label: string; value: string }) {
  return (
    <div class="run-stat">
      <span class="run-stat-label">{props.label}</span>
      <span class="run-stat-value">{props.value}</span>
    </div>
  )
}

/**
 * 会话合计：「本会话」旁边是一句边界声明，金额靠右，下方是六项读数卡。
 *
 * **六项构成完整的用量数据。** 轮次 / 输入 / 输出 / 命中率 / 缓存命中 / 缓存写入，与中转站后台的读数
 * 同名同序。缺少任何一项，会话的费用构成都不完整：命中率表示缓存是否生效，缓存命中与缓存写入
 * 分别表示节省的用量与建立缓存的开销。
 *
 * **运行中的轮次单独累加。** 账本在轮次**收尾时**才写入记录，运行中的轮次尚未计入。判据为
 * `finishedAt === null`：未结算的轮次一定不在账本中，因此不会重复计算。
 * 不累加时，清单中该行的金额持续增长而合计保持不变。
 *
 * **数值缩写为 K/M。** 此处只显示量级，精确数值在展开区的逐请求表中：110px 宽的读数项无法容纳九位数字。
 */
function Summary(props: { runs: Run[]; ledger: UsageTotals }) {
  const totals = createMemo(() =>
    props.runs
      .filter((r) => r.finishedAt === null)
      .reduce(
        (acc, r) => ({
          input: acc.input + (r.usage?.inputTokens ?? 0),
          output: acc.output + (r.usage?.outputTokens ?? 0),
          cost: addCosts(acc.cost, r.usage ? runCosts(r.usage) : {}),
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
   * 缓存命中率。分母为「未命中 + 命中 + 写入」：`inputTokens` 只包含未命中的部分，
   * 以它为分母算出的比例偏高，命中率高时可超过 100%。
   *
   * 与读数条中的命中率含义不同：读数条按最后一次调用计算，表示缓存当前是否生效；
   * 此处按整个会话计算，表示会话总共节省的用量。
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
        {/* 边界：外部 CLI 是本机的另一个进程，其费用由其他服务商计费，此处无法取得。 */}
        <span class="run-sum-note">不含外部 CLI</span>
        <span class="run-sum-cost">{money(totals().cost)}</span>
      </div>
      <div class="run-stats">
        <Stat label="轮次" value={String(props.runs.length)} />
        {/* 输入按**包含缓存命中**的口径显示：中转站后台账单使用同一口径，口径一致才能对账。 */}
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
 * 每轮一行。**该行即该轮的完整标题**：开始时间、模型、执行步数与耗时、
 * 是否出错、金额。
 *
 * 模型名与步数耗时不放入展开区：放入后同一轮会有两个标题。
 * 展开区只放需要展开才查看的内容：逐请求明细。
 */
function RunRow(props: { run: Run; name: string; open: boolean; onPick: () => void }) {
  const r = () => props.run
  const mark = () => runMark(r())
  /** 执行完毕后才显示耗时。运行中的轮次由「进行中」标记表示，不重复显示耗时。 */
  const elapsed = () => {
    const end = r().finishedAt
    return end === null ? null : `${((end - r().createdAt) / 1000).toFixed(1)}s`
  }

  return (
    <li>
      <button class="run-row" type="button" aria-expanded={props.open} onClick={props.onPick}>
        <IconChevron size={10} dir={props.open ? 'down' : 'right'} />
        <span class="run-when">{clockOf(r().createdAt)}</span>
        {/* 派发对象。本会话自身的轮次不显示该字段：这些行属于用户当前查看的会话。 */}
        <Show when={props.name}>{(name) => <span class="run-role truncate">{name()}</span>}</Show>
        {/* 宽度不足时模型名最先截断，收缩顺序见 panel.css 的 `.run-row`。 */}
        <span class="run-model truncate">{r().model}</span>
        <span class="run-meta">{r().stepCount} 步</span>
        <Show when={elapsed()}>{(e) => <span class="run-meta">{e()}</span>}</Show>
        <Show when={mark()}>
          {(m) => (
            <span class="run-mark" classList={{ bad: m().bad }} title={m().text}>
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
 * 不属于任何轮次的条目（手动压缩的摘要）。
 *
 * **列出该条目是为了使合计与清单一致**：这项费用已实际产生，但不在任何轮次的 usage 中。
 * 它没有 run，因此没有展开区与折叠符号；占位元素使时间列保持对齐。
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
 * 展开后显示的明细：该轮逐次请求的用量与金额。
 *
 * **展开区只有这张表。** 轮次行已显示时间、模型、步数、耗时、是否出错与金额；会话流末尾的读数条
 * 已显示停止原因与报错正文，此处不重复显示。
 * 某一次请求出错时，错误记在该请求行的「结果」列，不在轮次上另行显示。
 *
 * **真源是 `provider_requests` 而不是 `usage.turns`。** 只有它能给出该轮的请求次数：它在**发出之前**
 * 就写入一行，连接层失败后的重发是独立一行（`retry_index`）。`usage.turns` 只在取得 usage 回报
 * 时才写入，已发出但无回执的请求不在其中。
 *
 * **金额仍从 `usage.turns` 取得。** 计价发生在取得 usage 之后，`provider_requests` 中没有金额。两者
 * 按 `turnIndex` 对齐：成功的请求能对齐，重发失败的请求无法对齐，与该请求是否计费无法确定的事实
 * 一致。
 *
 * **列序与中转站后台一致。** 请求编号之后是账单字段：
 * 输入 → 输出 → 命中 → 写入 → 金额 → 结果，便于逐行对照。
 */
function RequestLedger(props: { run: Run }) {
  // 执行完毕的轮次不会再有新请求，判据中不包含账本修订号，否则每写入一步都会
  // 重取一张不再变化的表。
  const [data] = createResource(
    () => `${props.run.id}:${props.run.finishedAt === null ? ledgerRevision() : ''}`,
    () => client.api<{ requests: ProviderRequest[] }>(`/api/runs/${props.run.id}/requests`),
  )
  const requests = () => loaded(data)?.requests ?? []
  const costOf = (turnIndex: number) =>
    (props.run.usage?.turns ?? []).find((t) => t.turnIndex === turnIndex)?.costUsd ?? 0
  /** 该轮中的生成（图像、视频、语音）。每次生成一行，排在模型请求之后。 */
  const media = () => props.run.usage?.media ?? []

  return (
    <Show when={requests().length > 0 || media().length > 0}>
      <div class="run-detail">
        <table class="run-req">
          <thead>
            <tr>
              {/* 列名写「请求」而不是 `#`：轮次行上的「N 步」是 steps 表的行数
                  （每段思考、每段正文、每次工具调用各一条），此处计数的是模型往返次数，
                  两个数值不相等。列名写明计数对象，避免两者被误认为同一计数。 */}
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
                // 输入按**包含缓存命中**的口径显示，与中转站后台账单一致。
                const input =
                  q.providerInputTokens === null
                    ? null
                    : q.providerInputTokens + (q.providerCachedTokens ?? 0)
                const cost = costOf(q.turnIndex)
                const outcome = requestOutcome(q)
                return (
                  <tr>
                    {/* 重发是同一请求编号下的第 N 次尝试，编号必须标出重发序号，否则两行无法区分。 */}
                    <td>
                      {q.turnIndex + 1}
                      {q.retryIndex > 0 ? `.${q.retryIndex + 1}` : ''}
                    </td>
                    <td>{num(input)}</td>
                    <td>{num(q.providerOutputTokens)}</td>
                    <td>{num(q.providerCachedTokens)}</td>
                    <td>{num(q.providerCacheWriteTokens)}</td>
                    <td>{cost > 0 ? formatMoney(cost, props.run.usage!.currency) : NA}</td>
                    <td class="run-req-out">{outcome}</td>
                  </tr>
                )
              }}
            </For>
            {/* 生成行：请求列显示类别，模型名放在 title 中：面板较窄，表格宽度增加十几像素即会裁掉最右一列；
                按模型统计的费用在「用量」页。输出列显示接口返回的数量（张 / 秒 / 字符，Art 为输出 token），没有输入与缓存数据。
                生成模型只有成功的生成才有对应行（各服务商对失败的生成均不计费）；Art 收到用量即有对应行（对话接口对不完整的回复
                同样计费），页面是否取得由画布卡片与工具回执报告。结果列表示请求已完成并计费，显示「已完成」。 */}
            <For each={media()}>
              {(m) => (
                <tr data-tip={m.model}>
                  <td>{MEDIA_REQUEST[m.output]}</td>
                  <td>{NA}</td>
                  <td>
                    {m.quantity === null
                      ? NA
                      : `${m.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${MEDIA_OUTPUT_UNIT[m.output]}`}
                  </td>
                  <td>{NA}</td>
                  <td>{NA}</td>
                  <td>{m.cost > 0 ? formatMoney(m.cost, m.currency) : NA}</td>
                  <td class="run-req-out">已完成</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  )
}

/**
 * 账本入口行。**只显示一个数值**：本机近 30 天的费用合计。
 *
 * 它是近期费用的入口，明细在设置的「用量」页。该行不显示加载态与错误态：
 * 取得数值之前显示 `N/A`，行高保持不变；完整的加载态与错误态在「用量」页中显示。
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

/**
 * 决定该行是否显示标记以及显示哪一个。**最多一个**：三个标记同时出现时，该行会超出金额列。
 * 正常完成的轮次不显示标记，没有标记即表示正常。
 */
function runMark(r: Run): { text: string; bad?: boolean } | null {
  // 中文名称与会话流的收尾条共用同一张映射表，不要在此处直接显示英文代码。
  // 红色按 run 状态判定：等待用户回复的轮次执行正确（`done`），不是出错。
  if (r.stopReason && r.stopReason !== 'completed') {
    const text = stopReasonLabel(r.stopReason)
    return text ? { text, bad: r.status !== 'done' } : null
  }
  if (r.finishedAt === null) return { text: '进行中' }
  return null
}

/** 行首的时间。当天只显示时分，非当天加上日期；不另设日期分隔行，以免清单被分成多段。 */
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

/**
 * 该轮的金额：模型调用与生成之和，与会话流读数条口径相同（`runCosts`）。
 * 计价为 0 表示没有价目，显示 $0.00 会把「未知」表达为「免费」。
 */
function runCost(r: Run): string {
  return r.usage ? money(runCosts(r.usage)) : NA
}

/** 金额合计。同上：没有任何计价时表示没有价目，而不是零元。 */
function money(cost: Record<string, number>): string {
  return Object.values(cost).some((v) => v > 0) ? formatCosts(cost) : NA
}

/**
 * 数值不存在时显示的文字。
 *
 * **使用术语，不使用符号**：一条横线无法区分零、省略与未取得。
 * `N/A` 是数据表中「此处无可用值」的通用写法，含义唯一，也不会被误读为数字。
 *
 * 它覆盖两种情形，均表示数值不存在而不是数值为 0：
 * 接口未返回该字段（缓存相关字段为 `null`），以及该模型没有计价（金额为 0）。
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

/** 把一轮的费用按币种累加。**不跨币种相加。** */
function addCosts(
  acc: Record<string, number>,
  costs: Record<string, number>,
): Record<string, number> {
  const out = { ...acc }
  for (const [cur, v] of Object.entries(costs)) out[cur] = (out[cur] ?? 0) + v
  return out
}

/** 累加可能缺失的计数。两侧均缺失时保持 `null`。 */
function addMaybe(acc: number | null, v: number | null | undefined): number | null {
  return v === null || v === undefined ? acc : (acc ?? 0) + v
}

/** 逐请求表中生成行的请求列：显示类别，名称与模型库页签、画布的新建菜单一致。 */
const MEDIA_REQUEST: Record<GenerateOutput, string> = {
  image: '图像',
  video: '视频',
  audio: '音频',
  art: 'Art',
}

/** 账本中非轮次条目的中文名称。键取自 `UsageKind`。 */
const KIND_LABEL: Record<string, string> = {
  summary: '压缩摘要',
}

/** 没有活动会话时的空合计。返回空合计而不是跳过获取，使界面结构保持不变。 */
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
