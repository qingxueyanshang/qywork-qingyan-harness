/**
 * 上下文面板的投影。
 *
 * 覆盖范围：`context-panel.ts` 全部，以及 `store/repos.ts` 里 provider_requests
 * 那一组（`openProviderRequest` / `markProviderRequestSent` /
 * `settleProviderRequest` / `latestSentProviderRequest` /
 * `latestAnchoredProviderRequest`）。
 *
 * 这一组测的是**一件具体的、用户实测报过的事**：上下文占用会无故下降，
 * 实测形状是 33% → 20%，会话内容一个字没变。根因不是算错，是
 * `total = max(全量估算, provider真值)` 这个公式里有**两把尺**——锚点一失效，
 * 显示值就从真值尺跌到系统性偏低的估算尺。
 *
 * 所以下面最重要的那条测的不是「算得对」，是「**锚点失效时不许换尺**」。
 */

import { describe, expect, test } from 'bun:test'
import { softLimit } from '@qywork/agent'
import { emptyBreakdown, emptyOmitted } from '@qywork/core'
import {
  createConversation,
  createRun,
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  listProviderRequests,
  markProviderRequestSent,
  openProviderRequest,
  Store,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import { contextPanel } from './context-panel.ts'

const sum = (b: Record<string, number>) => Object.values(b).reduce((n, v) => n + v, 0)

/** 夹具里的会话与逐请求账都记在模型 `m` 上。 */
const M = (contextWindow: number) => ({ id: 'm', contextWindow })

function fixture() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, 'C:/ws', 'ws')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'req-1',
    userMessageId: null,
    messageIdUpperBound: null,
  })
  return { store, conversationId: conv.id, runId: run.id }
}

let turn = 0
function send(
  store: Store,
  runId: ReturnType<typeof createRun>['id'],
  opts: { measured: number; categories?: Partial<ReturnType<typeof emptyBreakdown>> },
) {
  const row = openProviderRequest(store, {
    runId,
    turnIndex: turn++,
    retryIndex: 0,
    model: 'm',
    measuredInputTokens: opts.measured,
    sentCategories: { ...emptyBreakdown(), ...opts.categories },
    omittedCategories: emptyOmitted(),
    payloadHash: `h${turn}`,
  })
  markProviderRequestSent(store, row.id)
  return row.id
}

describe('逐请求账', () => {
  test('pending 的行不算已发送——面板不会把还没发出去的请求当成当前上下文', () => {
    const { store, conversationId, runId } = fixture()
    openProviderRequest(store, {
      runId,
      turnIndex: 99,
      retryIndex: 0,
      model: 'm',
      measuredInputTokens: 1234,
      sentCategories: emptyBreakdown(),
      omittedCategories: emptyOmitted(),
      payloadHash: 'h',
    })
    expect(latestSentProviderRequest(store, conversationId)).toBeNull()
    // 未发送 = 没占——但窗口是模型的属性，照样报得出来，面板显示 0 / 1M。
    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.total).toBe(0)
    expect(panel.percent).toBe(0)
    expect(panel.limit).toBe(1_000_000)
    expect(panel.freeSpace).toBe(1_000_000)
  })

  test('没有 usage 回报时四个字段留 null，不落 0', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 500 })
    settleProviderRequest(store, id, 'received', null, null)

    const row = latestSentProviderRequest(store, conversationId)
    expect(row?.providerInputTokens).toBeNull()
    // 落 0 的话，这一行会被当成一个「什么都没占」的合法锚点。
    expect(latestAnchoredProviderRequest(store, conversationId)).toBeNull()
  })
})

describe('上下文面板', () => {
  /**
   * 真值口径：input + cached + cacheWrite + output。
   *
   * 只取 `inputTokens` 是错的——三个适配器已经把它统一收敛成**排除缓存**的口径，
   * 而冻结前缀设计下第二轮起大头正是 cache_read。漏掉它会让一个 100k 的会话
   * 显示成不到 1%，「真值地板」因此永远压不过估算，整条改动形同虚设。
   */
  test('总数取四项之和，不是只取 inputTokens', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 100 })
    settleProviderRequest(
      store,
      id,
      'received',
      { inputTokens: 1000, outputTokens: 500, cachedTokens: 8000, cacheWriteTokens: 200 },
      null,
    )

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.total).toBe(9700)
    expect(panel.source).toBe('actual')
    expect(panel.freeSpace).toBe(1_000_000 - 9700)
  })

  /**
   * **本组最重要的一条。**
   *
   * 第二次请求没拿到 usage（中转站漏报、超时、被拒都会这样）。此时面板
   * **必须继续显示上一个真值锚点**，而不是退回本地估算。
   *
   * 退回估算就是用户实测报的那个 33%→20%：会话只增不减，数字却掉了三成，
   * 而界面上没有任何一处解释它。
   */
  test('锚点失效时不换尺：仍显示上一次真值，不跌回估算', () => {
    const { store, conversationId, runId } = fixture()

    const first = send(store, runId, { measured: 3000 })
    settleProviderRequest(
      store,
      first,
      'received',
      { inputTokens: 20_000, outputTokens: 1000, cachedTokens: 12_000, cacheWriteTokens: 0 },
      null,
    )
    const anchored = contextPanel(store, conversationId, M(1_000_000))
    expect(anchored.total).toBe(33_000)

    // 第二次：发出去了，但 provider 没报 usage。本地测得值远低于真值。
    const second = send(store, runId, { measured: 3200 })
    settleProviderRequest(store, second, 'received', null, null)

    const after = contextPanel(store, conversationId, M(1_000_000))
    // 数字不许掉——上下文只多不少，而这次请求没有任何证据说明它变小了。
    expect(after.total).toBe(33_000)
    expect(after.source).toBe('actual')
    // 分组明细跟着最近一次已发送的请求走，与锚点是两条判据；
    // 但会按对账把差额摊进可变桶，所以和恒等于总数。
    expect(sum(after.breakdown)).toBe(33_000)
  })

  /**
   * **各行加起来必须等于标题上那个数。**
   *
   * 不要用「各组之和略小于总数：总数含请求体本身的结构开销」这类话糊过去——
   * 那句是错的，差额里有真实内容（tool call 参数、思考正文），还结构性地含着
   * 上一轮的输出 token。一个错的解释比没有解释更糟。
   */
  test('对账：分组之和恒等于总数，且不动逐字可数的那几桶', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, {
      measured: 100,
      categories: {
        systemPrompt: 254,
        systemTools: 1519,
        memory: 823,
        historyMessages: 100,
        executionRecords: 300,
      },
    })
    settleProviderRequest(
      store,
      id,
      'received',
      { inputTokens: 5000, outputTokens: 1000, cachedTokens: null, cacheWriteTokens: null },
      null,
    )

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.total).toBe(6000)
    expect(sum(panel.breakdown)).toBe(6000)
    // 逐字可数的三桶原样不动——把最准的数摊掉才是真的不准。
    expect(panel.breakdown.systemPrompt).toBe(254)
    expect(panel.breakdown.systemTools).toBe(1519)
    expect(panel.breakdown.memory).toBe(823)
  })

  test('对账：可变桶全为零时整块归历史消息，不凭空造执行记录', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 100, categories: { systemPrompt: 200 } })
    settleProviderRequest(
      store,
      id,
      'received',
      { inputTokens: 900, outputTokens: 0, cachedTokens: null, cacheWriteTokens: null },
      null,
    )

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.breakdown.executionRecords).toBe(0)
    expect(panel.breakdown.historyMessages).toBe(700)
    expect(sum(panel.breakdown)).toBe(900)
  })

  test('一次 usage 都没有过时才标 estimated', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 4242 })
    settleProviderRequest(store, id, 'rejected', null, 'context_overflow')

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.total).toBe(4242)
    expect(panel.source).toBe('estimated')
  })

  /** 1M 窗口下取整会把 2139 显示成 0%——那一位小数是有信息量的。 */
  test('百分比保留一位小数', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 2139 })
    settleProviderRequest(store, id, 'received', null, null)

    expect(contextPanel(store, conversationId, M(1_000_000)).percent).toBe(0.2)
  })

  /**
   * `measured` 取各桶之和：两个数出自同一次装配，生产上不可能不等
   * （`breakdownOf` 与 `estimateRequest` 量的是同一个 `req`）。
   * 给一个对不上的 `measured`，测的就不再是「桶带得出来」而是对账怎么摊。
   */
  test('分组桶原样带出，键集与协议恒等', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, {
      measured: 1519 + 6 + 823,
      categories: { systemTools: 1519, historyMessages: 6, memory: 823 },
    })
    settleProviderRequest(store, id, 'received', null, null)

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.breakdown.systemTools).toBe(1519)
    expect(panel.breakdown.memory).toBe(823)
    // 落库走 JSON，读回来必须补齐全部十个键——缺键会让面板某一行是 undefined。
    expect(Object.keys(panel.breakdown).sort()).toEqual(Object.keys(emptyBreakdown()).sort())
  })
})

/**
 * 触发线。
 *
 * 面板与 loop 必须给出同一个数：面板上画一条不会触发的刻度，比不画更坏。
 */
/**
 * 换模型之后那条回执不再作数。
 *
 * 各家 tokenizer 对同一份内容算出的 token 数差到 1.8 倍（中文实测 deepseek 0.569、
 * claude 约 1.03 token/字）。旧口径下这里不判模型，切到另一个模型之后面板因此继续
 * 拿上一个模型的回执当锚点，还挂着「真值」的标签——**分子是 A 的尺，分母是 B 的窗口**。
 * 手动压缩走的是同一个数（`server/run-control.ts` 拿 `contextPanel().total` 当占用），
 * 偏低就会少压。
 */
describe('锚点认模型', () => {
  test('换模型之后不拿上一个模型的回执当锚点', () => {
    const { store, conversationId, runId } = fixture()
    const first = send(store, runId, { measured: 3000 })
    settleProviderRequest(
      store,
      first,
      'received',
      { inputTokens: 20_000, outputTokens: 1000, cachedTokens: 12_000, cacheWriteTokens: 0 },
      null,
    )
    // 同一个模型：照常锚定。
    expect(contextPanel(store, conversationId, M(1_000_000)).source).toBe('actual')

    // 会话切到另一个模型：那条回执描述的不是这个模型看到的上下文。
    const other = contextPanel(store, conversationId, { id: 'other', contextWindow: 200_000 })
    expect(other.source).toBe('estimated')
    expect(other.total).not.toBe(33_000)
    expect(other.limit).toBe(200_000)
  })

  /**
   * **不往前找同模型的那一条。** 更早那条描述的是更短的上下文，它是「另一份内容的
   * 真值」——比估算错得更隐蔽，因为标签会说它是实测的。
   */
  test('不回退到更早的同模型回执', () => {
    const { store, conversationId, runId } = fixture()
    const early = send(store, runId, { measured: 1000 })
    settleProviderRequest(
      store,
      early,
      'received',
      { inputTokens: 5000, outputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )
    // 中途换到别的模型跑了一轮，也拿到了回执。
    const row = openProviderRequest(store, {
      runId,
      turnIndex: 900,
      retryIndex: 0,
      model: 'other',
      measuredInputTokens: 9000,
      sentCategories: emptyBreakdown(),
      omittedCategories: emptyOmitted(),
      payloadHash: 'h-other',
    })
    markProviderRequestSent(store, row.id)
    settleProviderRequest(
      store,
      row.id,
      'received',
      { inputTokens: 30_000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )

    // 会话现在是 `m`，而最近一条回执是 `other` 的：退回估算，不去捡 5100 那条。
    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.source).toBe('estimated')
    expect(panel.total).not.toBe(5100)
    expect(panel.total).not.toBe(30_500)
  })
})

describe('压缩触发线', () => {
  test('与 loop 的软阈值同源', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 100 })
    settleProviderRequest(store, id, 'received', null, null)

    expect(contextPanel(store, conversationId, M(1_000_000)).compactAt).toBe(
      softLimit({ contextWindow: 1_000_000 }),
    )
    expect(contextPanel(store, conversationId, M(200_000)).compactAt).toBe(160_000)
  })

  /** 一条请求都没发过的会话也知道线在哪——窗口是模型的属性，不是请求的属性。 */
  test('新会话也给出触发线', () => {
    const { store, conversationId } = fixture()
    expect(contextPanel(store, conversationId, M(200_000)).compactAt).toBe(160_000)
  })
})

describe('逐请求账本读得出重发', () => {
  /**
   * 复现的是面板上的原始失败形状：`usage.turns` 只在拿到 usage 回报时才 push，
   * 因此「连接层失败 → 重发 → 成功」这两次在它里面只剩一次，面板显示「1 次调用」。
   *
   * 真源是 `provider_requests`——它在发出之前就落行，重发是独立一行。
   */
  test('同一轮的失败与重发是两行，各带各的终态与 provider 原话', () => {
    const { store, runId } = fixture()
    const first = openProviderRequest(store, {
      runId,
      turnIndex: 0,
      retryIndex: 0,
      model: 'm',
      measuredInputTokens: 30_000,
      sentCategories: emptyBreakdown(),
      omittedCategories: emptyOmitted(),
      payloadHash: 'h0',
    })
    markProviderRequestSent(store, first.id)
    settleProviderRequest(store, first.id, 'uncertain', null, 'network_error')

    const retry = openProviderRequest(store, {
      runId,
      turnIndex: 0,
      retryIndex: 1,
      model: 'm',
      measuredInputTokens: 30_000,
      sentCategories: emptyBreakdown(),
      omittedCategories: emptyOmitted(),
      payloadHash: 'h0',
    })
    markProviderRequestSent(store, retry.id)
    settleProviderRequest(
      store,
      retry.id,
      'received',
      { inputTokens: 8539, outputTokens: 298, cachedTokens: 16_576, cacheWriteTokens: null },
      null,
      'stop',
    )

    const rows = listProviderRequests(store, runId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => `${r.turnIndex}.${r.retryIndex}:${r.status}`)).toEqual([
      '0.0:uncertain',
      '0.1:received',
    ])
    // 结果不明的那次不许被填成 0：收没收到、计没计费都不知道。
    expect(rows[0]!.providerInputTokens).toBeNull()
    expect(rows[0]!.finishReason).toBe('')
    // provider 的原话进账本——没有它就分不出「说完了」和「要调工具」。
    expect(rows[1]!.finishReason).toBe('stop')
  })
})
