/**
 * 模型库里改过的单价，**真的会出现在账本里**。用假 provider，不花钱、不联网。
 *
 * **覆盖范围**：`runtime/config.ts` 的 `resolveModel` 带出 `spec` →
 * `runtime/session.ts` 的 `resolveProfile` 塞进 `ProviderProfile.spec` →
 * `ai/factory.ts` 的 `applySpecOverride` 叠进 adapter 的 spec →
 * `agent/loop.ts` 用它算钱 → `store/usage.ts` 的 `recordUsage` 落账。
 * 合并顺序本身的单测在 `ai/src/catalog.test.ts`「模型库覆盖」。
 *
 * ## 为什么这条必须走真链路
 *
 * 那五处任何一处漏接，界面上都照样能改、改完也照样显示成改过的样子，
 * 而账本里仍然是内置价——**一条有产出没有消费者的链路，且完全静默**。
 * 只测 `applySpecOverride` 是在测「我调了我自己写的那个函数」。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeCost, lookupModel } from '@qywork/ai'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  Store,
  upsertWorkspace,
  usageTotals,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'

/** 一轮纯文本收尾，usage 写死——账本上的数只由「单价 × 这几个 token」决定。 */
const IN_TOKENS = 10
const OUT_TOKENS = 5

function textTurn(text: string): string {
  const events = [
    { type: 'response.created', response: { id: 'resp' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id: 'resp',
        status: 'completed',
        usage: {
          input_tokens: IN_TOKENS,
          output_tokens: OUT_TOKENS,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ]
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const provider = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(textTurn('好了。'), { headers: { 'content-type': 'text/event-stream' } }),
})

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let config: QyConfig
let workspaceId = ''
let events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-pricing-'))
  const dbPath = join(dir, 'pricing.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  runs = new RunManager(store, bus)
  config = {
    active: { provider: 'fake', model: '中转站上的某个模型' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 中转站上的某个模型: {}, 'deepseek-v4-flash': {} },
      },
    },
    /*
     * 覆盖挂在一个**目录里没有**的模型上，不挂 deepseek-v4-flash。
     *
     * DeepSeek 现在有分时段折扣，空闲时段单价减半——挂在它上面的话，
     * 这条断言的期望值会随这台机器跑测试的钟点变，是一条会随机红的测试。
     * 未收录模型没有 offPeak，价钱只由覆盖决定。
     */
    catalog: {
      '中转站上的某个模型|openai_responses': { input: 1000, output: 2000 },
    },
    mode: 'auto',
  }
  workspaceId = upsertWorkspace(store, dir, 'pricing-ws').id
  bus.subscribe({
    id: 'test',
    origin: 'cli',
    conversations: null,
    send: (frame) => events.push(frame),
  })
})

afterAll(async () => {
  provider.stop(true)
  store?.close()
  content?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

async function waitFor(what: (e: AgentEvent) => boolean, ms = 10_000): Promise<AgentEvent | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const hit = events.find((f) => what(f.event))
    if (hit) return hit.event
    await Bun.sleep(10)
  }
  return null
}

test('模型库里改过的单价直接进账本', async () => {
  events = []
  const cv = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: '中转站上的某个模型',
  }).id as ConversationId

  await startRun(cv, '说点什么', undefined, { store, content, config, bus, runs })
  const finished = await waitFor((e) => e.type === 'run.finished')
  expect(finished).not.toBeNull()

  // (10 × 1000 + 5 × 2000) / 1e6 = 0.02。未收录模型的内置价是 0 —— 账本会报 $0，
  // 漏接任何一环都不可能凑出 0.02。
  const expected = (IN_TOKENS * 1000 + OUT_TOKENS * 2000) / 1e6
  const totals = usageTotals(store, {})
  expect(totals.cost.USD).toBeCloseTo(expected, 9)
})

/**
 * 分时段定价那一档也要**真的**进账本。
 *
 * 币种那半条是确定的：DeepSeek 现在按人民币标价，落账必须落在 CNY 那一栏。
 * 上一版把它记成美元，账面差着七倍而界面上看不出来。
 *
 * **没验到的写出来**：金额这半条拿 `computeCost` 现算的值比对，所以在**高峰时段**
 * 跑这个用例时，即使折扣那条路断了两边也会一样——那七个小时里它证明不了折扣。
 * 折扣本身的判档由 `ai/src/catalog.test.ts`「分时段定价」按固定时间戳钉死，
 * 这里只负责证明「loop 用的是同一条计价路径，且币种没丢」。
 */
test('人民币模型落账落在 CNY，金额与计价函数同源', async () => {
  events = []
  const cv = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  }).id as ConversationId

  const before = usageTotals(store, {}).cost.CNY ?? 0
  await startRun(cv, '说点什么', undefined, { store, content, config, bus, runs })
  expect(await waitFor((e) => e.type === 'run.finished')).not.toBeNull()

  const spec = lookupModel('deepseek-v4-flash', 'openai_responses')
  const expected = computeCost(spec, { inputTokens: IN_TOKENS, outputTokens: OUT_TOKENS })
  const totals = usageTotals(store, {})
  expect(totals.cost.CNY).toBeCloseTo(before + expected, 9)
  // 美元那一栏只有前一个用例那笔，人民币这笔不许混进去。
  expect(totals.cost.USD).toBeCloseTo((IN_TOKENS * 1000 + OUT_TOKENS * 2000) / 1e6, 9)
})
