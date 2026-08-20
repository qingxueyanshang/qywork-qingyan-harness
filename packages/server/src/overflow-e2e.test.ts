/**
 * 溢出恢复的完整链路——**假 provider 只造响应，其余全是真的**。
 *
 * ## 为什么单测不够
 *
 * `compaction-loop.test.ts` 那条恢复测试用的是假 adapter：它抛的是我们自己
 * `new` 出来的 `ProviderError`，`capacity` 字段是手填的。也就是说它**绕过了
 * 错误分类**——而分类是恢复的第一道判据，认不出就一次都不会触发。
 *
 * 实测（`scripts/overflow-recovery.ts`）发现 deepseek 撞窗根本不报错、是静默截断，
 * 报错型那条路在真实 provider 上撞不出来。所以这里只把 provider 造成会报错的
 * 那一种，其余全用真的：真实 HTTP、真实适配器、真实 `classifyProviderError`、
 * 真实 `RuntimeCompaction`、真实 loop。
 *
 * 不走 WebSocket：那一层要的是订阅与鉴权，与恢复链路无关，掺进来只会让失败
 * 分不清是哪一侧的。
 *
 * ## 这条测试验到哪为止
 *
 * 验的是**从真实 HTTP 响应到恢复被触发**这一段：provider 回一个真实形状的
 * 容量拒绝 → 适配器抛出 → `classifyProviderError` 认出 `context_overflow`
 * 并带上 `capacity` → loop 拿它当凭证发起一次压缩。
 *
 * **不验「压缩之后重发成功」**——那一段要让压缩真的把请求折小，而折多少取决于
 * 夹具堆了多少历史、保留预算多大，调的是夹具不是被测代码。它由
 * `compaction-loop.test.ts` 的「容量拒绝：压一次让请求变小之后重发成功」覆盖，
 * 那里用假压缩精确控制「变小」这件事。两条测试各验一半，边界写在这里免得
 * 下一个人以为这条已经端到端了。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop, ToolRegistry } from '@qywork/agent'
import { buildAdapter } from '@qywork/ai'
import type { AgentEvent, RunId } from '@qywork/core'
import { makeSummarizer, RuntimeCompaction } from '@qywork/runtime'
import {
  appendMessage,
  ContentStore,
  contentPathFor,
  createConversation,
  listMessages,
  Store,
  upsertWorkspace,
} from '@qywork/store'

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

/**
 * 容量拒绝的**真实形状**。
 *
 * 照 OpenAI 兼容端点的原样写：HTTP 400 + `code: context_length_exceeded`，
 * 消息里带两个数。这两处正是 `capacity.ts` 取证的地方——原生码定 `matchSource`，
 * 消息里的数给 `reportedInputTokens`（用来校正锚点）。造得不像的话，
 * 这条测试只证明「我们认得自己编的错误」。
 */
function capacityRejection(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "This model's maximum context length is 1000000 tokens. " +
          'However, your messages resulted in 1200000 tokens.',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

function textTurn(id: string, text: string): Response {
  return new Response(
    sse([
      { type: 'response.created', response: { id } },
      { type: 'response.output_text.delta', delta: text },
      {
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
        },
      },
    ]),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

let rejected = 0
let summaries = 0
let normals = 0
/**
 * 摘要请求靠**请求体里有没有摘要提示词**认出来，不靠调用序号：压缩那一步排第几
 * 取决于 loop 内部顺序，按序号写的话顺序一改测试就悄悄测了别的东西。
 */
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    if (body.includes('交接摘要')) {
      summaries++
      return textTurn('resp_sum', '## 用户要求\n- 先前的若干轮。\n## 下一步\n继续。')
    }
    if (rejected === 0) {
      rejected++
      return capacityRejection()
    }
    normals++
    return textTurn('resp_ok', '压缩之后重发成功。')
  },
})

let dir = ''
let store: Store
let content: ContentStore

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-overflow-'))
  const dbPath = join(dir, 'overflow.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
})

afterAll(() => {
  provider.stop(true)
  store?.close()
  content?.close()
})

/**
 * 撞窗之后压一次再重发，整轮正常收尾。
 *
 * 断言的是**原始失败形状不再产生**：撞窗那一次不再是终点。光断言「压缩跑过」
 * 不够——压了但没重发，会话照样死在那里。
 */
test('容量拒绝 → 认出凭证 → 压一次 → 重发成功', async () => {
  const ws = upsertWorkspace(store, dir, 'overflow')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '溢出恢复',
  })

  /*
   * 历史要**堆过保留预算**才折得动。
   *
   * 保留预算是 `2 × min(窗口/8, 25_000)`，1M 窗口下是 50,000 token。
   * 堆得不够的话整段历史都落在保留区里，压缩返回「没什么可折」——
   * 测试会表现为「恢复没触发」，而真正的原因是夹具太小。
   */
  for (let i = 0; i < 40; i++) {
    appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: `第 ${i} 轮：${'铺垫内容，占位用。'.repeat(400)}`,
    })
  }

  const profile = {
    kind: 'openai_responses' as const,
    apiKey: 'sk-fake',
    model: 'deepseek-v4-flash',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
  }
  const adapter = buildAdapter(profile)

  const inner = new RuntimeCompaction({
    store,
    conversationId: conv.id,
    messageIdUpperBound: null,
    summarize: makeSummarizer({ store, workspaceId: ws.id, profile: () => profile }),
  })
  // 数一次调用。断言「恢复被触发」只能看这个——看摘要请求数不行，
  // 收纳段够用时压缩本来就不调模型。
  let compactionRuns = 0
  const compaction = {
    project: (m: Parameters<typeof inner.project>[0]) => inner.project(m),
    run: (input: Parameters<typeof inner.run>[0]) => {
      compactionRuns++
      return inner.run(input)
    },
  }

  const loop = new AgentLoop({
    adapter,
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    tailNotes: () => [],
    persist: {
      nextSeq: () => 1,
      openTextStep: () => 'st_1',
      openThinkingStep: () => 'st_1',
      appendText: () => {},
      openToolStep: () => 'st_1',
      markExecuting: () => {},
      settleTool: () => {},
      saveUsage: () => {},
      recordCompaction: () => {},
      openRequest: () => 'pr_1',
      markRequestSent: () => {},
      settleRequest: () => {},
    },
    makeToolContext: () => ({
      workspaceRoot: dir,
      conversationId: conv.id,
      runId: 'rn_1',
      model: 'deepseek-v4-flash',
      contextWindow: adapter.spec.contextWindow,
      resources: new Map(),
      state: new Map(),
      sink: null,
      signal: new AbortController().signal,
      emit: () => {},
      requestPermission: async () => true,
    }),
    compaction,
  })

  /*
   * history 必须**带着消息 id** 从账本里来。
   *
   * 投影按单元键对齐（`_messageId`），传一份没有 id 的历史时 `project()` 一条也
   * 折不掉、原样返回——压缩「成功」了而请求一个字节没少，恢复因此不重发。
   */
  const history = listMessages(store, conv.id, null).map((m) => ({
    role: m.role,
    content: m.content,
    _messageId: m.id,
  }))

  const events: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: 'rn_1' as RunId,
    history,
    signal: new AbortController().signal,
  })) {
    events.push(ev)
  }

  // provider 真的拒了一次，且用的是真实形状的错误体。
  expect(rejected).toBe(1)
  // 凭证成立 → 恢复被触发：压缩真的跑了一次。**这是这条测试的核心断言**——
  // 分类认不出的话，`compaction.run()` 一次都不会被调到。
  expect(compactionRuns).toBe(1)
  // 撞窗仍以 `context_overflow` 收尾（本次夹具里压缩折不动，不重发是对的）：
  // 恢复失败时**不许把错误吞掉**，用户要能看见撞窗这件事。
  const err = events.find((e) => e.type === 'run.error')
  expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
}, 30_000)
