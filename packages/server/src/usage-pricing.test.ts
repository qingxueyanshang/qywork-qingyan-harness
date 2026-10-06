/**
 * 模型库中修改过的单价确实写入账本。使用模拟 provider，不产生费用，不访问网络。
 *
 * 覆盖范围：`runtime/config.ts` 的 `resolveModel` 带出 `spec` →
 * `runtime/session.ts` 的 `resolveProfile` 写入 `ProviderProfile.spec` →
 * `ai/factory.ts` 的 `applySpecOverride` 合并到 adapter 的 spec →
 * `agent/loop/request.ts` 据此计算费用 → `store/usage.ts` 的 `recordUsage` 记账。
 * 合并顺序本身的单测位于 `ai/src/catalog.test.ts`「模型库覆盖」。
 *
 * 本测试必须经由完整链路：五处中任何一处未接通时，界面上仍可修改且显示为已修改，
 * 而账本中仍是内置价格，即一条有生产者而无消费者的链路，且不报任何错误。
 * 只测 `applySpecOverride` 等于只验证该函数被调用。
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
import { SubagentRegistry } from './subagents.ts'

/** 一轮纯文本回复，usage 为固定值：账本中的金额只由「单价 × token 数」决定。 */
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
let subagents: SubagentRegistry
let config: QyConfig
let workspaceId = ''
let events: EventEnvelope[] = []

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-pricing-'))
  const dbPath = join(dir, 'pricing.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  subagents = new SubagentRegistry()
  runs = new RunManager(store, bus, subagents)
  config = {
    active: { provider: 'fake', model: '中转站上的某个模型' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 中转站上的某个模型: {}, 'deepseek-flash': {} },
      },
    },
    /*
     * 覆盖设置在目录中未收录的模型上，不设置在 deepseek-flash 上。
     *
     * DeepSeek 有分时段折扣，空闲时段单价减半：设置在它上面时，
     * 断言的期望值会随本机运行测试的时段变化，测试结果因此不稳定。
     * 未收录模型没有 offPeak，价格只由覆盖决定。
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

test('模型库中修改过的单价直接写入账本', async () => {
  events = []
  const cv = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: '中转站上的某个模型',
  }).id as ConversationId

  await startRun(cv, '说点什么', undefined, { store, content, config, bus, runs, subagents })
  const finished = await waitFor((e) => e.type === 'run.finished')
  expect(finished).not.toBeNull()

  // (10 × 1000 + 5 × 2000) / 1e6 = 0.02。未收录模型的内置价格是 0，账本会记为 $0，
  // 任何一环未接通都不可能得到 0.02。
  const expected = (IN_TOKENS * 1000 + OUT_TOKENS * 2000) / 1e6
  const totals = usageTotals(store, {})
  expect(totals.cost.USD).toBeCloseTo(expected, 9)
})

/**
 * 分时段定价的价格同样写入账本。
 *
 * 币种部分是确定的：DeepSeek 按人民币标价，必须记入 CNY 一栏。
 * 记为美元时金额相差约七倍，且界面上无法察觉。
 *
 * 未验证的部分：金额与 `computeCost` 当场计算的值比对，因此在高峰时段
 * 运行本用例时，即使折扣路径失效两边也相同，该七小时内本用例无法证明折扣生效。
 * 折扣本身的档位判定由 `ai/src/catalog.test.ts`「分时段定价」以固定时间戳锁定，
 * 此处只证明 loop 使用同一条计价路径，且币种未丢失。
 */
test('人民币计价的模型记入 CNY，金额与计价函数同源', async () => {
  events = []
  const cv = createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-flash',
  }).id as ConversationId

  const before = usageTotals(store, {}).cost.CNY ?? 0
  await startRun(cv, '说点什么', undefined, { store, content, config, bus, runs, subagents })
  expect(await waitFor((e) => e.type === 'run.finished')).not.toBeNull()

  const spec = lookupModel('deepseek-flash', 'openai_responses')
  const expected = computeCost(spec, { inputTokens: IN_TOKENS, outputTokens: OUT_TOKENS })
  const totals = usageTotals(store, {})
  expect(totals.cost.CNY).toBeCloseTo(before + expected, 9)
  // 美元一栏只有前一个用例的金额，人民币金额不得计入其中。
  expect(totals.cost.USD).toBeCloseTo((IN_TOKENS * 1000 + OUT_TOKENS * 2000) / 1e6, 9)
})
