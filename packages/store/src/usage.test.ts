import { describe, expect, test } from 'bun:test'
import { Store } from './db.ts'
import {
  createConversation,
  createRun,
  openProviderRequest,
  settleProviderRequest,
  upsertWorkspace,
} from './repos.ts'
import {
  pruneUsage,
  recordUsage,
  summaryOutputPercentile,
  type UsageEntry,
  usageBy,
  usageEntries,
  usageTotals,
} from './usage.ts'

const DAY = 86_400_000

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    kind: 'run',
    model: 'deepseek-v4-flash',
    provider: 'openai_chat_completions',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 10,
    reasoningTokens: 0,
    cost: 0.001,
    ...over,
  }
}

function fresh(): Store {
  return new Store({ path: ':memory:' })
}

/**
 * 会话花费包含其派发的子会话：账目仍记在各自的 conversation_id 下，
 * 汇总时按 `parent_conversation_id` 归入父会话。不包含时运行页无法显示子 agent 的花费。
 */
describe('会话口径含子会话', () => {
  test('父会话与两个子会话的合计等于三者之和，按币种分别统计', () => {
    const s = fresh()
    const ws = upsertWorkspace(s, '/tmp/ws', 'ws')
    const parent = createConversation(s, { workspaceId: ws.id, provider: 'openai', model: 'm' })
    const kids = ['build-glm', 'build-qwen'].map((roleId) =>
      createConversation(s, {
        workspaceId: ws.id,
        provider: 'openai',
        model: 'm',
        source: 'temp',
        sourceRef: roleId,
        parentConversationId: parent.id,
      }),
    )
    const other = createConversation(s, { workspaceId: ws.id, provider: 'openai', model: 'm' })

    recordUsage(s, entry({ conversationId: parent.id, cost: 1 }))
    recordUsage(s, entry({ conversationId: kids[0]!.id, cost: 2 }))
    recordUsage(s, entry({ conversationId: kids[1]!.id, cost: 4, currency: 'CNY' }))
    // 其他会话不计入。
    recordUsage(s, entry({ conversationId: other.id, cost: 8 }))

    const totals = usageTotals(s, { conversationId: parent.id })
    expect(totals.entries).toBe(3)
    expect(totals.cost.USD).toBeCloseTo(3, 6)
    expect(totals.cost.CNY).toBeCloseTo(4, 6)
    expect(usageEntries(s, { conversationId: parent.id })).toHaveLength(3)
    s.close()
  })
})

describe('记账', () => {
  test('渠道影币原样落账并与人民币和美元分开汇总', () => {
    const s = fresh()
    recordUsage(
      s,
      entry({
        runId: 'coin',
        kind: 'media',
        model: 'Seedance 2.5 720p',
        provider: '集梦',
        cost: 1000,
        currency: 'BINGUO_CREDIT',
      }),
    )
    recordUsage(s, entry({ runId: 'yuan', cost: 2, currency: 'CNY' }))
    recordUsage(s, entry({ runId: 'dollar', cost: 3, currency: 'USD' }))
    expect(usageTotals(s).cost).toEqual({ BINGUO_CREDIT: 1000, CNY: 2, USD: 3 })
    expect(usageEntries(s).find((row) => row.runId === 'coin')?.currency).toBe('BINGUO_CREDIT')
    s.close()
  })
  test('记录一笔后可查询到总数', () => {
    const s = fresh()
    recordUsage(s, entry())
    const t = usageTotals(s)
    expect(t.entries).toBe(1)
    expect(t.inputTokens).toBe(100)
    expect(t.cost.USD).toBeCloseTo(0.001, 6)
    s.close()
  })

  test('空账本返回 0 而不是抛错', () => {
    const s = fresh()
    expect(usageTotals(s).entries).toBe(0)
    // 空账本是 `{}` 不是 `{USD: 0}`：无花费的区间不应出现币种标记。
    expect(usageTotals(s).cost).toEqual({})
    s.close()
  })

  /**
   * 每个 run 只能有一笔。收尾逻辑若执行两次（重连补发、异常路径），
   * 唯一索引拒绝第二次写入：不报错的账目翻倍是最难发现的错误。
   */
  test('同一个 run 记录两次，第二次被拒绝且账目不变', () => {
    const s = fresh()
    expect(recordUsage(s, entry({ runId: 'rn_1' }))).toBe(true)
    expect(recordUsage(s, entry({ runId: 'rn_1' }))).toBe(false)
    expect(usageTotals(s).entries).toBe(1)
    s.close()
  })

  /** 摘要行记录其所属轮次；唯一索引只约束轮次收尾时写入的行，不约束摘要行。 */
  test('摘要行带 run id，不与本轮的收尾行冲突，且可以有多笔', () => {
    const s = fresh()
    expect(recordUsage(s, entry({ runId: 'rn_1' }))).toBe(true)
    expect(recordUsage(s, entry({ kind: 'summary', runId: 'rn_1' }))).toBe(true)
    expect(recordUsage(s, entry({ kind: 'summary', runId: 'rn_1' }))).toBe(true)
    expect(usageTotals(s).entries).toBe(3)
    s.close()
  })

  test('没有 runId 的摘要调用可以记录多笔', () => {
    const s = fresh()
    recordUsage(s, entry({ kind: 'summary', runId: null }))
    recordUsage(s, entry({ kind: 'summary', runId: null }))
    expect(usageTotals(s).entries).toBe(2)
    s.close()
  })

  /**
   * 账目的生命周期须长于业务数据：删除会话是正常操作，而本月花费不应因此减少。
   * 因此账本表没有外键，本测试锁定这一设计。
   */
  test('引用不存在的会话也能记录：账本不设外键', () => {
    const s = fresh()
    expect(recordUsage(s, entry({ conversationId: 'cv_从来没有过' }))).toBe(true)
    expect(usageTotals(s).entries).toBe(1)
    s.close()
  })
})

describe('缓存命中：未回报与实际为 0 不得混淆', () => {
  test('没有任何一笔回报 → null', () => {
    const s = fresh()
    recordUsage(s, entry({ cachedTokens: null }))
    expect(usageTotals(s).cachedTokens).toBeNull()
    s.close()
  })

  test('回报值为 0 → 0，不是 null', () => {
    const s = fresh()
    recordUsage(s, entry({ cachedTokens: 0 }))
    expect(usageTotals(s).cachedTokens).toBe(0)
    s.close()
  })

  test('部分回报 → 只累加已回报的记录', () => {
    const s = fresh()
    recordUsage(s, entry({ cachedTokens: null }))
    recordUsage(s, entry({ cachedTokens: 7 }))
    expect(usageTotals(s).cachedTokens).toBe(7)
    s.close()
  })
})

describe('区间与筛选', () => {
  test('since / until 是左闭右开', () => {
    const s = fresh()
    recordUsage(s, entry({ occurredAt: 1000 }))
    recordUsage(s, entry({ occurredAt: 2000 }))
    recordUsage(s, entry({ occurredAt: 3000 }))
    expect(usageTotals(s, { since: 2000, until: 3000 }).entries).toBe(1)
    s.close()
  })

  test('按工作区筛选', () => {
    const s = fresh()
    recordUsage(s, entry({ workspaceId: 'ws_a' }))
    recordUsage(s, entry({ workspaceId: 'ws_b' }))
    expect(usageTotals(s, { workspaceId: 'ws_a' }).entries).toBe(1)
    s.close()
  })

  test('按 kind 筛选：可单独查询压缩的花费', () => {
    const s = fresh()
    recordUsage(s, entry({ kind: 'run', runId: 'rn_1' }))
    recordUsage(s, entry({ kind: 'summary', cost: 0.005 }))
    expect(usageTotals(s, { kind: 'summary' }).cost.USD).toBeCloseTo(0.005, 6)
    s.close()
  })
})

describe('分组', () => {
  /**
   * 按**笔数**倒序，不按金额：多币种下按金额倒序没有唯一解
   * （¥100 与 $20 的先后取决于汇率），而笔数无量纲，可跨币种比较。
   */
  test('按模型分组，使用次数多的在前', () => {
    const s = fresh()
    recordUsage(s, entry({ model: '少用的', cost: 0.5 }))
    recordUsage(s, entry({ model: '常用的', runId: 'rn_a', cost: 0.001 }))
    recordUsage(s, entry({ model: '常用的', runId: 'rn_b', cost: 0.001 }))
    const rows = usageBy(s, 'model')
    expect(rows[0]!.key).toBe('常用的')
    expect(rows).toHaveLength(2)
    s.close()
  })

  /**
   * **两种币种分开列出，不相加。** 合计需要汇率，而汇率每天变动：
   * 写入磁盘后该数值即不再准确，但看起来仍是确切的金额。
   */
  test('多币种分开合计', () => {
    const s = fresh()
    recordUsage(s, entry({ model: 'claude', cost: 0.5 }))
    recordUsage(s, entry({ model: 'glm', runId: 'rn_c', cost: 3, currency: 'CNY' }))
    const t = usageTotals(s)
    expect(t.cost.USD).toBeCloseTo(0.5, 6)
    expect(t.cost.CNY).toBeCloseTo(3, 6)
    expect(t.entries).toBe(2)
    s.close()
  })

  /** 同一分组中也可能有两种币种，`--by day` 是典型情况。 */
  test('同一分组中的两种币种分别统计', () => {
    const s = fresh()
    recordUsage(s, entry({ model: 'm', cost: 0.5, occurredAt: 1000 }))
    recordUsage(s, entry({ model: 'm', runId: 'rn_d', cost: 3, currency: 'CNY', occurredAt: 1000 }))
    const row = usageBy(s, 'day')[0]!
    expect(row.cost.USD).toBeCloseTo(0.5, 6)
    expect(row.cost.CNY).toBeCloseTo(3, 6)
    s.close()
  })

  /** 币种本身可作为分组维度：人民币部分的总花费是常见的查询。 */
  test('可按币种分组', () => {
    const s = fresh()
    recordUsage(s, entry({ cost: 0.5 }))
    recordUsage(s, entry({ runId: 'rn_e', cost: 3, currency: 'CNY' }))
    const rows = usageBy(s, 'currency')
    expect(rows.map((r) => r.key).sort()).toEqual(['CNY', 'USD'])
  })

  test('按天分组', () => {
    const s = fresh()
    const now = Date.now()
    recordUsage(s, entry({ occurredAt: now }))
    recordUsage(s, entry({ occurredAt: now - 2 * DAY }))
    expect(usageBy(s, 'day')).toHaveLength(2)
    s.close()
  })

  test('按 kind 分组可单独列出摘要开销', () => {
    const s = fresh()
    recordUsage(s, entry({ kind: 'run', runId: 'rn_1' }))
    recordUsage(s, entry({ kind: 'summary' }))
    expect(
      usageBy(s, 'kind')
        .map((r) => r.key)
        .sort(),
    ).toEqual(['run', 'summary'])
    s.close()
  })

  test('没有 workspace 的记录归入「(无)」而不是被丢弃', () => {
    const s = fresh()
    recordUsage(s, entry({ workspaceId: null }))
    expect(usageBy(s, 'workspace')[0]!.key).toBe('(无)')
    s.close()
  })

  test('分组中的缓存统计口径与总计一致（未回报仍为 null）', () => {
    const s = fresh()
    recordUsage(s, entry({ model: 'm', cachedTokens: null }))
    expect(usageBy(s, 'model')[0]!.cachedTokens).toBeNull()
    s.close()
  })
})

describe('清理账目', () => {
  test('只删除指定时间之前的记录', () => {
    const s = fresh()
    recordUsage(s, entry({ occurredAt: 1000 }))
    recordUsage(s, entry({ occurredAt: 5000 }))
    expect(pruneUsage(s, 3000)).toBe(1)
    expect(usageTotals(s).entries).toBe(1)
    s.close()
  })
})

/**
 * 记账失败的可见性。
 *
 * 本组针对一类不报错的失败：为 `kind` 新增值而未同步 schema 上的 CHECK 约束时，
 * 插入直接抛错，而 `catch {}` 会将其与重复记账一并忽略。
 * 结果是功能全部正常、账本没有任何记录，且任何地方都不报错。
 */
describe('记账失败必须报告', () => {
  test('run 以外的 kind 可以写入：CHECK 约束覆盖 TS 类型的每一个值', () => {
    const store = new Store({ path: ':memory:' })
    const ok = recordUsage(store, {
      kind: 'summary',
      model: 'm',
      provider: 'openai_chat_completions',
      inputTokens: 10,
      outputTokens: 2,
      cost: 0.0001,
    })
    expect(ok).toBe(true)
    expect(usageTotals(store, { kind: 'summary' }).entries).toBe(1)
    store.close()
  })

  /** 重复记账仍须被拒绝，且**不输出日志**：这是该 catch 的设计用途。 */
  test('同一个 run 重复记账返回 false，不输出日志', () => {
    const store = new Store({ path: ':memory:' })
    const entry = {
      kind: 'run' as const,
      runId: 'rn_dup',
      model: 'm',
      provider: 'anthropic' as const,
      inputTokens: 1,
      outputTokens: 1,
      cost: 0,
    }
    expect(recordUsage(store, entry)).toBe(true)
    expect(recordUsage(store, entry)).toBe(false)
    expect(usageTotals(store, {}).entries).toBe(1)
    store.close()
  })

  /**
   * 非唯一约束冲突的失败必须输出到 stderr。
   *
   * 断言的是已报告而不是具体文案：文案可能修改，不报告才是要防止的缺陷。
   */
  test('非冲突的失败输出到 stderr', () => {
    const store = new Store({ path: ':memory:' })
    const original = process.stderr.write.bind(process.stderr)
    let said = ''
    process.stderr.write = ((chunk: string) => {
      said += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      recordUsage(store, {
        kind: '不存在的种类' as never,
        model: 'm',
        provider: 'anthropic',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0,
      })
    } finally {
      process.stderr.write = original
    }
    expect(said).toContain('记账失败')
    store.close()
  })
})

/**
 * 会话的花费合计。
 *
 * 界面上的合计**必须包含不属于任何轮次的摘要费用**：摘要由该会话引发且计费。
 * 只累加 run 会遗漏这部分，压缩越频繁遗漏越多，且遗漏部分在界面上无处可查。
 */
describe('按会话汇总账目', () => {
  test('合计包含非轮次的账目，且只统计当前会话', () => {
    const store = new Store({ path: ':memory:' })
    recordUsage(store, entry({ conversationId: 'cv_a', runId: 'run_1', cost: 0.01 }))
    recordUsage(store, entry({ kind: 'summary', conversationId: 'cv_a', cost: 0.004 }))
    recordUsage(store, entry({ conversationId: 'cv_b', runId: 'run_2', cost: 0.5 }))

    const a = usageTotals(store, { conversationId: 'cv_a' })
    expect(a.entries).toBe(2)
    expect(a.cost.USD).toBeCloseTo(0.014, 6)

    // 清单必须能单独列出该笔，否则合计大于清单之和且无法看出差额来源。
    const rows = usageEntries(store, { conversationId: 'cv_a' })
    expect(rows.map((r) => r.kind).sort()).toEqual(['run', 'summary'])
    expect(rows.find((r) => r.kind === 'summary')?.runId).toBe(null)
    store.close()
  })

  test('没有任何一笔回报缓存写入时为 null，不是 0', () => {
    const store = new Store({ path: ':memory:' })
    recordUsage(store, entry({ conversationId: 'cv_c', cacheWriteTokens: null }))
    expect(usageTotals(store, { conversationId: 'cv_c' }).cacheWriteTokens).toBe(null)
    recordUsage(store, entry({ conversationId: 'cv_c', runId: 'run_9', cacheWriteTokens: 7 }))
    expect(usageTotals(store, { conversationId: 'cv_c' }).cacheWriteTokens).toBe(7)
    store.close()
  })
})

/** 摘要长度的样本有两个来源：请求表中的摘要请求（purpose = summary）与账本中的历史摘要行。 */
describe('摘要长度统计', () => {
  test('请求表中的摘要请求与账本中的摘要行一起计入样本', () => {
    const s = fresh()
    const ws = upsertWorkspace(s, '/tmp/ws', 'ws')
    const cv = createConversation(s, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(s, {
      conversationId: cv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'pct',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const req = openProviderRequest(s, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      purpose: 'summary',
      model: 'm',
      measuredInputTokens: 1,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'h',
    })
    settleProviderRequest(s, req.id, 'received', {
      inputTokens: 1,
      outputTokens: 300,
      cachedTokens: null,
      cacheWriteTokens: null,
    })
    recordUsage(s, entry({ kind: 'summary', runId: null, workspaceId: ws.id, outputTokens: 100 }))

    expect(summaryOutputPercentile(s, ws.id, 0)).toBe(100)
    expect(summaryOutputPercentile(s, ws.id, 0.99)).toBe(300)
    s.close()
  })
})
