/**
 * 账本端点。覆盖 `api/usage.ts`。
 *
 * 账本表被写入、聚合函数存在，都不等于界面能看到钱。所以第一条测的是
 * 「记进去的钱能从 HTTP 查出来」——这条链路断了的话，界面上就一个入口都没有。
 */

import { describe, expect, test } from 'bun:test'
import type { UsageResponse } from '@qywork/core'
import { recordUsage, Store } from '@qywork/store'
import type { ApiRequestDeps } from './types.ts'
import { handleUsageApi } from './usage.ts'

const DAY = 86_400_000

function deps(store: Store, workspaceId = 'ws_a'): ApiRequestDeps {
  return { store, workspaceId } as unknown as ApiRequestDeps
}

function seed(store: Store) {
  recordUsage(store, {
    kind: 'run',
    runId: 'rn_1' as never,
    workspaceId: 'ws_a',
    model: '贵的',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 10,
    reasoningTokens: 0,
    cost: 0.5,
  })
  recordUsage(store, {
    kind: 'summary',
    workspaceId: 'ws_b',
    model: '便宜的',
    provider: 'openai_chat_completions',
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: null,
    reasoningTokens: 0,
    cost: 0.001,
  })
}

const call = (query = '', d?: ApiRequestDeps) =>
  handleUsageApi(
    new URL(`http://127.0.0.1/api/usage${query}`),
    new Request(`http://127.0.0.1/api/usage${query}`),
    d ?? deps(new Store({ path: ':memory:' })),
  )

describe('路由归属', () => {
  test('别的路径回 null，交给下一个域', async () => {
    const res = await handleUsageApi(
      new URL('http://127.0.0.1/api/models'),
      new Request('http://127.0.0.1/api/models'),
      deps(new Store({ path: ':memory:' })),
    )
    expect(res).toBeNull()
  })
})

describe('查账', () => {
  test('记进去的能查出来，且分组求和', async () => {
    const store = new Store({ path: ':memory:' })
    seed(store)
    const body = (await call('', deps(store)))!
    const j = (await body.json()) as UsageResponse
    expect(j.totals.entries).toBe(2)
    expect(j.totals.cost.USD).toBeCloseTo(0.501, 6)
    expect(j.rows.map((r) => r.key).sort()).toEqual(['便宜的', '贵的'])
    store.close()
  })

  /** 本机总量和本工作区是两个都会被问到的问题，不能让前端拿总量自己减。 */
  test('本工作区的那份单独给', async () => {
    const store = new Store({ path: ':memory:' })
    seed(store)
    const j = (await (await call('', deps(store, 'ws_a')))!.json()) as UsageResponse
    expect(j.totals.cost.USD).toBeCloseTo(0.501, 6)
    expect(j.workspaceTotals.cost.USD).toBeCloseTo(0.5, 6)
    store.close()
  })

  test('按天分组也能出，键是本地日期', async () => {
    const store = new Store({ path: ':memory:' })
    seed(store)
    const j = (await (await call('?by=day', deps(store)))!.json()) as UsageResponse
    expect(j.by).toBe('day')
    expect(j.rows).toHaveLength(1)
    expect(j.rows[0]?.key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    store.close()
  })

  /**
   * 窗口之外的不算进来。写死 `occurredAt` 而不是靠系统时间——
   * 靠时间的测试会在跨天的那一刻自己红一次。
   */
  test('区间外的不计入', async () => {
    const store = new Store({ path: ':memory:' })
    recordUsage(store, {
      kind: 'run',
      runId: 'rn_old' as never,
      model: 'm',
      provider: 'anthropic',
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
      reasoningTokens: 0,
      cost: 9,
      occurredAt: Date.now() - 40 * DAY,
    })
    expect(
      ((await (await call('?days=30', deps(store)))!.json()) as UsageResponse).totals.entries,
    ).toBe(0)
    expect(
      ((await (await call('?days=90', deps(store)))!.json()) as UsageResponse).totals.entries,
    ).toBe(1)
    store.close()
  })

  /** 多币种分开报，前端据此各列一行。合起来要汇率，而我们不做换算。 */
  test('两种币种分开报，不相加', async () => {
    const store = new Store({ path: ':memory:' })
    seed(store)
    recordUsage(store, {
      kind: 'run',
      runId: 'rn_cny' as never,
      workspaceId: 'ws_a',
      model: 'glm-5.2',
      provider: 'openai_chat_completions',
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
      reasoningTokens: 0,
      cost: 3,
      currency: 'CNY',
    })
    const j = (await (await call('', deps(store)))!.json()) as UsageResponse
    expect(j.totals.cost.USD).toBeCloseTo(0.501, 6)
    expect(j.totals.cost.CNY).toBeCloseTo(3, 6)
    store.close()
  })

  test('空账本回 0 而不是报错', async () => {
    const j = (await (await call())!.json()) as UsageResponse
    expect(j.totals.entries).toBe(0)
    // `{}` 不是 `{USD: 0}`：没花钱不该凭空冒出一个币种。
    expect(j.totals.cost).toEqual({})
    expect(j.rows).toEqual([])
  })
})

describe('参数校验', () => {
  /** 坏参数要 400 说清楚，不能悄悄回落到默认值——那会让人以为筛选生效了。 */
  test('days 非法回 400', async () => {
    for (const q of ['?days=0', '?days=-1', '?days=abc', '?days=99999']) {
      expect((await call(q))!.status).toBe(400)
    }
  })

  test('by 不在词表里回 400', async () => {
    expect((await call('?by=provider'))!.status).toBe(400)
  })
})
