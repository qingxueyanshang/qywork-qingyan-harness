/**
 * 上下文面板的投影。
 *
 * 覆盖范围：`context-panel.ts` 全部，以及 `store/repos.ts` 里 provider_requests
 * 那一组（`openProviderRequest` / `markProviderRequestSent` /
 * `settleProviderRequest` / `latestSentProviderRequest` /
 * `latestAnchoredProviderRequest`）。
 *
 * 这一组测的是**一件具体的、用户实测报过的事**：上下文占用会莫名其妙掉下去，
 * 实测形状是 33% → 20%，会话内容一个字没变。根因不是算错，是
 * `total = max(全量估算, provider真值)` 这个公式里有**两把尺**——锚点一失效，
 * 显示值就从真值尺跌到系统性偏低的估算尺。
 *
 * 所以下面最重要的那条测的不是「算得对」，是「**锚点失效时不许换尺**」。
 */

import { describe, expect, test } from 'bun:test'
import { emptyBreakdown, emptyOmitted } from '@qywork/core'
import {
  createConversation,
  createRun,
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  markProviderRequestSent,
  openProviderRequest,
  Store,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import { contextPanel } from './context-panel.ts'

const sum = (b: Record<string, number>) => Object.values(b).reduce((n, v) => n + v, 0)

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
    measurementExact: false,
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
      measurementExact: false,
      sentCategories: emptyBreakdown(),
      omittedCategories: emptyOmitted(),
      payloadHash: 'h',
    })
    expect(latestSentProviderRequest(store, conversationId)).toBeNull()
    // 未发送 = 没占——但窗口是模型的属性，照样报得出来，面板显示 0 / 1M。
    const panel = contextPanel(store, conversationId, 1_000_000)
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
   * 显示成不到 1%，「真值地板」于是永远压不过估算，整条改动形同虚设。
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

    const panel = contextPanel(store, conversationId, 1_000_000)
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
   * 而界面上没有任何东西解释它。
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
    const anchored = contextPanel(store, conversationId, 1_000_000)
    expect(anchored.total).toBe(33_000)

    // 第二次：发出去了，但 provider 没报 usage。本地测得值远低于真值。
    const second = send(store, runId, { measured: 3200 })
    settleProviderRequest(store, second, 'received', null, null)

    const after = contextPanel(store, conversationId, 1_000_000)
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

    const panel = contextPanel(store, conversationId, 1_000_000)
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

    const panel = contextPanel(store, conversationId, 1_000_000)
    expect(panel.breakdown.executionRecords).toBe(0)
    expect(panel.breakdown.historyMessages).toBe(700)
    expect(sum(panel.breakdown)).toBe(900)
  })

  test('一次 usage 都没有过时才标 estimated', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 4242 })
    settleProviderRequest(store, id, 'rejected', null, 'context_overflow')

    const panel = contextPanel(store, conversationId, 1_000_000)
    expect(panel.total).toBe(4242)
    expect(panel.source).toBe('estimated')
  })

  /** 1M 窗口下取整会把 2139 显示成 0%——那一位小数是有信息量的。 */
  test('百分比保留一位小数', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 2139 })
    settleProviderRequest(store, id, 'received', null, null)

    expect(contextPanel(store, conversationId, 1_000_000).percent).toBe(0.2)
  })

  test('分组桶原样带出，键集与协议恒等', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, {
      measured: 100,
      categories: { systemTools: 1519, historyMessages: 6, memory: 823 },
    })
    settleProviderRequest(store, id, 'received', null, null)

    const panel = contextPanel(store, conversationId, 1_000_000)
    expect(panel.breakdown.systemTools).toBe(1519)
    expect(panel.breakdown.memory).toBe(823)
    // 落库走 JSON，读回来必须补齐全部十个键——缺键会让面板某一行是 undefined。
    expect(Object.keys(panel.breakdown).sort()).toEqual(Object.keys(emptyBreakdown()).sort())
  })
})
