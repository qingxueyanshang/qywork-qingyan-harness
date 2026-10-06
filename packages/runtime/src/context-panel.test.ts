/**
 * 上下文面板的投影。
 *
 * 覆盖范围：`context-panel.ts` 全部，以及 `store/repos.ts` 中 provider_requests
 * 相关的函数（`openProviderRequest` / `markProviderRequestSent` /
 * `settleProviderRequest` / `latestSentProviderRequest` /
 * `latestAnchoredProviderRequest`）。
 *
 * 本组测试针对用户实测报告的问题：上下文占用无故下降，
 * 实测从 33% 降至 20%，而会话内容没有任何变化。根因不是计算错误，而是
 * `total = max(全量估算, provider真值)` 混用了两种计量口径：锚点失效时，
 * 显示值从真值口径降为系统性偏低的估算口径。
 *
 * 因此其中最重要的测试验证的不是计算正确，而是锚点失效时不更换计量口径。
 */

import { describe, expect, test } from 'bun:test'
import { softLimit } from '@qywork/agent'
import { emptyBreakdown, emptyOmitted, type ProviderKind } from '@qywork/core'
import {
  createConversation,
  createRun,
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  listProviderRequests,
  markProviderRequestSent,
  openProviderRequest,
  Store,
  setCompactionManifest,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import { contextPanel } from './context-panel.ts'

const sum = (b: Record<string, number>) => Object.values(b).reduce((n, v) => n + v, 0)

/** 夹具中的会话与逐请求账都记在模型 `m` 上。 */
const M = (contextWindow: number) => ({
  id: 'm',
  contextWindow,
  providerName: 'p',
  providerKind: 'openai_chat_completions' as const,
})

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
    contextSnapshot: [],
  })
  return { store, conversationId: conv.id, runId: run.id }
}

let turn = 0
function send(
  store: Store,
  runId: ReturnType<typeof createRun>['id'],
  opts: {
    measured: number
    /** 发出时的运行中读数；未提供时表示迁移前的旧行或摘要请求。 */
    occupancy?: number
    categories?: Partial<ReturnType<typeof emptyBreakdown>>
    fingerprint?: string
    providerName?: string
    providerKind?: ProviderKind
  },
) {
  const row = openProviderRequest(store, {
    runId,
    turnIndex: turn++,
    retryIndex: 0,
    providerName: opts.providerName ?? 'p',
    providerKind: opts.providerKind ?? 'openai_chat_completions',
    model: 'm',
    measuredInputTokens: opts.measured,
    ...(opts.occupancy !== undefined ? { occupancyTokens: opts.occupancy } : {}),
    sentCategories: { ...emptyBreakdown(), ...opts.categories },
    omittedCategories: emptyOmitted(),
    payloadHash: `h${turn}`,
    ...(opts.fingerprint ? { cacheRouteFingerprint: opts.fingerprint } : {}),
  })
  markProviderRequestSent(store, row.id)
  return row.id
}

describe('逐请求账', () => {
  test('pending 状态的行不计为已发送：面板不把尚未发出的请求视为当前上下文', () => {
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
    // 未发送 = 未占用；窗口是模型的属性，仍可报告，面板显示 0 / 1M。
    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.total).toBe(0)
    expect(panel.percent).toBe(0)
    expect(panel.limit).toBe(1_000_000)
    expect(panel.freeSpace).toBe(1_000_000)
  })

  test('没有 usage 回报时四个字段保留 null，不写入 0', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 500 })
    settleProviderRequest(store, id, 'received', null, null)

    const row = latestSentProviderRequest(store, conversationId)
    expect(row?.providerInputTokens).toBeNull()
    // 写入 0 时，该行会被当作占用为零的合法锚点。
    expect(latestAnchoredProviderRequest(store, conversationId)).toBeNull()
  })
})

describe('上下文面板', () => {
  test('手动压缩后采用 manifest 的派生读数，发出新请求后立即恢复使用逐请求账', () => {
    const { store, conversationId, runId } = fixture()
    const first = send(store, runId, {
      measured: 100_000,
      categories: { historyMessages: 80_000, systemPrompt: 20_000 },
    })
    settleProviderRequest(
      store,
      first,
      'received',
      { inputTokens: 100_000, outputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )
    setCompactionManifest(store, conversationId, {
      revision: 1,
      compactedThroughMessageId: null,
      compactedMessageCount: 0,
      summary: '',
      facts: { filesTouched: [], openItems: [], userConstraints: [] },
      contextAfter: {
        basedOnProviderRequestId: first,
        model: 'm',
        total: 40_000,
        measured: 39_000,
      },
      createdAt: Date.now(),
    })

    const compacted = contextPanel(store, conversationId, M(1_000_000))
    expect(compacted.total).toBe(40_000)
    expect(compacted.measured).toBe(39_000)
    expect(compacted.percent).toBe(4)
    expect(compacted.source).toBe('estimated')
    expect(sum(compacted.breakdown)).toBe(40_000)

    const second = send(store, runId, { measured: 45_000 })
    settleProviderRequest(
      store,
      second,
      'received',
      { inputTokens: 45_000, outputTokens: 500, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )
    const refreshed = contextPanel(store, conversationId, M(1_000_000))
    expect(refreshed.total).toBe(45_500)
    expect(refreshed.source).toBe('actual')
    store.close()
  })

  /**
   * 真值口径：input + cached + cacheWrite + output。
   *
   * 只取 `inputTokens` 是错误的：三个适配器已将其统一为排除缓存的口径，
   * 而在冻结前缀设计下，第二轮起的主要部分正是 cache_read。遗漏它会使 100k 的会话
   * 显示为不到 1%，真值下限因此始终低于估算，无法发挥作用。
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
   * 本组最重要的测试。
   *
   * 第二次请求未取得 usage（中转站漏报、超时、被拒绝都会导致这种情况）。此时面板
   * 必须继续显示上一个真值锚点，而不是退回本地估算。
   *
   * 退回估算即用户报告的 33%→20%：会话内容只增不减，读数却下降三成，
   * 且界面上没有任何说明。
   */
  test('锚点失效时不更换计量口径：仍显示上一次真值，不退回估算', () => {
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

    // 第二次请求已发出，但 provider 未回报 usage。本地测得值远低于真值；发出时的运行中读数
    // 是锚点真值 33,000 加其后增量 200。
    const second = send(store, runId, { measured: 3200, occupancy: 33_200 })
    settleProviderRequest(store, second, 'received', null, null)

    const after = contextPanel(store, conversationId, M(1_000_000))
    // 与运行中读数条数值相同，不退回本地估算 3,200。
    expect(after.total).toBe(33_200)
    expect(after.source).toBe('projected')
    // 分组明细取最近一次已发送的请求，与锚点的判据不同；
    // 对账会把差额分摊到可变桶，因此各桶之和恒等于总数。
    expect(sum(after.breakdown)).toBe(33_200)
  })

  /**
   * 在途请求读取发出时的运行中读数，面板不另行计算。面板另用「上次输入真值 + 本地估算差」计算时，
   * 实测同一时刻读数条为 13.6%、面板为 8.2%、真值为 6.1%。
   */
  test('在途请求与读数条数值相同；未记录读数的旧行退回估算并如实标注', () => {
    const { store, conversationId, runId } = fixture()
    const first = send(store, runId, { measured: 89_651 })
    settleProviderRequest(
      store,
      first,
      'received',
      { inputTokens: 2, outputTokens: 106_692, cachedTokens: 0, cacheWriteTokens: 28_803 },
      null,
    )
    send(store, runId, { measured: 143_310, occupancy: 135_600 })
    const inFlight = contextPanel(store, conversationId, M(1_000_000))
    expect(inFlight.total).toBe(135_600)
    expect(inFlight.source).toBe('projected')

    send(store, runId, { measured: 150_000 })
    const legacy = contextPanel(store, conversationId, M(1_000_000))
    expect(legacy.total).toBe(150_000)
    expect(legacy.source).toBe('estimated')
  })

  /**
   * 各行之和必须等于标题中的总数。
   *
   * 不要用「各组之和略小于总数：总数含请求体本身的结构开销」解释差额：
   * 该说法错误，差额中有真实内容（tool call 参数、思考正文），且结构性地包含
   * 上一轮的输出 token。错误的解释比没有解释危害更大。
   */
  test('对账：分组之和恒等于总数，且不改动可逐字计数的桶', () => {
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
    // 可逐字计数的三个桶保持原值：它们最准确，不参与分摊。
    expect(panel.breakdown.systemPrompt).toBe(254)
    expect(panel.breakdown.systemTools).toBe(1519)
    expect(panel.breakdown.memory).toBe(823)
  })

  test('对账：可变桶全为零时差额全部归入历史消息，不虚构执行记录', () => {
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

  test('从未取得 usage 时才标为 estimated', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 4242 })
    settleProviderRequest(store, id, 'rejected', null, 'context_overflow')

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.total).toBe(4242)
    expect(panel.source).toBe('estimated')
  })

  /** 1M 窗口下取整会把 2139 显示为 0%，因此保留一位小数。 */
  test('百分比保留一位小数', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, { measured: 2139 })
    settleProviderRequest(store, id, 'received', null, null)

    expect(contextPanel(store, conversationId, M(1_000_000)).percent).toBe(0.2)
  })

  /**
   * `measured` 取各桶之和：两个数出自同一次装配，生产环境中必然相等
   * （`breakdownOf` 与 `estimateRequest` 计量的是同一个 `req`）。
   * 传入不一致的 `measured` 时，测试对象就从桶的传出变为对账分摊。
   */
  test('分组桶原样传出，键集与协议一致', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, {
      measured: 1519 + 6 + 823,
      categories: { systemTools: 1519, historyMessages: 6, memory: 823 },
    })
    settleProviderRequest(store, id, 'received', null, null)

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.breakdown.systemTools).toBe(1519)
    expect(panel.breakdown.memory).toBe(823)
    // 落库使用 JSON，读取时必须补齐全部十个键：缺少键会使面板中对应行为 undefined。
    expect(Object.keys(panel.breakdown).sort()).toEqual(Object.keys(emptyBreakdown()).sort())
  })
})

/**
 * 触发线。
 *
 * 面板与 loop 必须给出相同的数值：显示一条不会触发的刻度比不显示更具误导性。
 */
/**
 * 更换模型后，之前的回执不再有效。
 *
 * 各家 tokenizer 对同一份内容计算出的 token 数相差可达 1.8 倍（中文实测 deepseek 0.569、
 * claude 约 1.03 token/字）。不按模型判定锚点时，切换到另一个模型后面板仍以
 * 上一个模型的回执作为锚点并标为真值：分子按 A 的口径计量，分母是 B 的窗口。
 * 手动压缩使用同一个数值（`server/run-control.ts` 以 `contextPanel().total` 作为占用），
 * 数值偏低会导致压缩不足。
 */
describe('锚点按模型判定', () => {
  test('更换模型后不以上一个模型的回执作为锚点', () => {
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

    // 会话切换到另一个模型：该回执描述的不是当前模型看到的上下文。
    const other = contextPanel(store, conversationId, {
      ...M(200_000),
      id: 'other',
    })
    expect(other.source).toBe('estimated')
    expect(other.total).not.toBe(33_000)
    expect(other.limit).toBe(200_000)
  })

  /**
   * 不向前查找同模型的回执。更早的回执描述的是更短的上下文，是另一份内容的
   * 真值；其误差比估算更难察觉，因为标签显示为实测值。
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
    // 中途换用其他模型执行了一轮，也取得了回执。
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

    // 会话当前模型为 `m`，而最近一条回执属于 `other`：退回估算，不使用 5100 那条回执。
    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.source).toBe('estimated')
    expect(panel.total).not.toBe(5100)
    expect(panel.total).not.toBe(30_500)
  })
})

describe('真值锚点按接口路线判定', () => {
  test('同名模型更换接口后不复用上一条路线的 usage 真值', () => {
    const { store, conversationId, runId } = fixture()
    const id = send(store, runId, {
      measured: 3000,
      providerName: 'relay-a',
      providerKind: 'openai_chat_completions',
    })
    settleProviderRequest(
      store,
      id,
      'received',
      { inputTokens: 20_000, outputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )

    const otherRoute = contextPanel(store, conversationId, {
      ...M(1_000_000),
      providerName: 'relay-b',
      providerKind: 'openai_chat_completions',
    })
    expect(otherRoute.source).toBe('estimated')
    expect(otherRoute.total).toBe(3000)
  })

  test('缺少接口信息的旧请求只保留诊断，不作为当前路线的锚点', () => {
    const { store, conversationId, runId } = fixture()
    const id = openProviderRequest(store, {
      runId,
      turnIndex: turn++,
      retryIndex: 0,
      model: 'm',
      measuredInputTokens: 3000,
      sentCategories: emptyBreakdown(),
      omittedCategories: emptyOmitted(),
      payloadHash: 'old-route-less',
    }).id
    markProviderRequestSent(store, id)
    settleProviderRequest(
      store,
      id,
      'received',
      { inputTokens: 20_000, outputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )

    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.source).toBe('estimated')
    expect(panel.total).toBe(3000)
    store.close()
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

  /** 从未发送请求的会话同样给出触发线：窗口是模型的属性，不是请求的属性。 */
  test('新会话也给出触发线', () => {
    const { store, conversationId } = fixture()
    expect(contextPanel(store, conversationId, M(200_000)).compactAt).toBe(160_000)
  })
})

describe('逐请求账本记录重发', () => {
  /**
   * 复现面板上的原始失败形状：`usage.turns` 只在取得 usage 回报时 push，
   * 因此「连接层失败 → 重发 → 成功」的两次请求在其中只记录一次，面板显示「1 次调用」。
   *
   * 真源是 `provider_requests`：发出之前即写入行，重发是独立的一行。
   */
  test('同一轮的失败与重发是两行，各自带有终态与 provider 原文', () => {
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
    // 结果不明的请求不得填为 0：无法确定对端是否收到、是否计费。
    expect(rows[0]!.providerInputTokens).toBeNull()
    expect(rows[0]!.finishReason).toBe('')
    expect(rows[0]!.errorMessage).toBeNull()
    // provider 的原文写入账本：没有原文就无法区分正常结束与调用工具。
    expect(rows[1]!.finishReason).toBe('stop')
  })

  test('明确拒绝的原始正文随请求落盘', () => {
    const { store, runId } = fixture()
    const id = send(store, runId, { measured: 100 })
    settleProviderRequest(store, id, 'rejected', null, 'rate_limited', '', 'Rate limit reached')

    expect(listProviderRequests(store, runId)[0]?.errorMessage).toBe('Rate limit reached')
  })
})

/**
 * 信封变化时只修正头部：修正由运行中读数完成（`agent/loop/run-state.ts` 的
 * `rebaseAnchor`，由 `run-state.test.ts` 锁定），面板读取其记录的读数，不另行计算。
 */
describe('信封变化时只修正头部', () => {
  test('信封已变化的在途请求，面板显示运行中已修正的读数', () => {
    const { store, conversationId, runId } = fixture()
    const anchored = send(store, runId, {
      measured: 30_000,
      categories: { systemPrompt: 1000, systemTools: 9000, mcpTools: 0 },
      fingerprint: 'env-a',
    })
    settleProviderRequest(
      store,
      anchored,
      'received',
      { inputTokens: 100_000, outputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )
    // 信封相同：真值保持原值。
    expect(contextPanel(store, conversationId, M(1_000_000)).total).toBe(101_000)

    // 安装 MCP 后：运行中按头部差 +4,000 修正锚点，再加上其后增量 300。
    send(store, runId, {
      measured: 34_300,
      occupancy: 101_000 + 4000 + 300,
      categories: { systemPrompt: 1000, systemTools: 9000, mcpTools: 4000 },
      fingerprint: 'env-b',
    })
    const panel = contextPanel(store, conversationId, M(1_000_000))
    expect(panel.total).toBe(105_300)
    expect(panel.source).toBe('projected')
  })

  test('更换模型时仍整体退回估算，头部修正不参与', () => {
    const { store, conversationId, runId } = fixture()
    const anchored = send(store, runId, {
      measured: 3000,
      categories: { systemPrompt: 1000, systemTools: 9000 },
      fingerprint: 'env-a',
    })
    settleProviderRequest(
      store,
      anchored,
      'received',
      { inputTokens: 100_000, outputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 },
      null,
    )
    const other = contextPanel(store, conversationId, {
      ...M(200_000),
      id: 'other',
    })
    expect(other.source).toBe('estimated')
    expect(other.total).toBe(3000)
  })
})
