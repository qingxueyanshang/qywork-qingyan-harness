/**
 * 溢出恢复的完整链路：**假 provider 只构造响应，其余全部使用真实实现**。
 *
 * **单元测试不足的原因。** `agent/loop/compact.test.ts` 中的恢复测试使用假 adapter：它抛出的是测试内
 * 直接构造的 `ProviderError`，`capacity` 字段由手工填写。它**绕过了
 * 错误分类**，而分类是恢复的第一道判据，无法识别时恢复一次都不会触发。
 *
 * 实测（`scripts/overflow-recovery.ts`）发现 deepseek 超出窗口时不报错，而是静默截断，
 * 报错型路径在真实 provider 上无法触发。因此这里只把 provider 模拟为会报错的
 * 类型，其余全部使用真实实现：真实 HTTP、真实适配器、真实 `classifyProviderError`、
 * 真实 `RuntimeCompaction`、真实 loop。
 *
 * 不经由 WebSocket：该层负责订阅与鉴权，与恢复链路无关，加入后只会使失败
 * 无法区分来自哪一侧。
 *
 * **本测试的验证范围。** 验证**从真实 HTTP 响应到恢复被触发**这一段：provider 返回一个真实形状的
 * 容量拒绝 → 适配器抛出 → `classifyProviderError` 识别出 `context_overflow`
 * 并带上 `capacity` → loop 以其为凭证发起一次压缩。
 *
 * **不验证「压缩之后重发成功」**：该段要求压缩确实缩小请求，而缩小多少取决于
 * 夹具累积的历史量与保留预算大小，调整的是夹具而不是被测代码。它由
 * `agent/loop/compact.test.ts` 的「容量拒绝：压缩一次使请求变小后重发成功」覆盖，
 * 该用例用假压缩精确控制请求的缩小。两条测试各验证一半，此处写明边界，
 * 避免把本测试当作端到端覆盖。
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
 * 按 OpenAI 兼容端点的原始格式编写：HTTP 400 + `code: context_length_exceeded`，
 * 消息中带两个数值。这两处正是 `capacity.ts` 取证的位置：原生错误码决定 `matchSource`，
 * 消息中的数值提供 `reportedInputTokens`（用于校正锚点）。构造得与真实格式不一致时，
 * 本测试只能证明分类器能识别测试自己构造的错误。
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
/**
 * 摘要请求按**请求体中是否含摘要提示词**识别，不按调用序号：压缩步骤的次序
 * 取决于 loop 内部顺序，按序号编写时顺序一旦改变，测试会在无提示的情况下检查另一个请求。
 */
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text()
    if (body.includes('交接摘要')) {
      return textTurn('resp_sum', '## 用户要求\n- 先前的若干轮。\n## 下一步\n继续。')
    }
    if (rejected === 0) {
      rejected++
      return capacityRejection()
    }
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
 * 超出窗口后以容量拒绝为凭证触发一次压缩。
 *
 * 断言的是**分类识别出容量拒绝并触发恢复**：仅断言以 `context_overflow` 结束不够，
 * 分类无法识别时压缩一次都不会执行，而结束状态相同。
 */
test('容量拒绝 → 识别凭证 → 压缩一次 → 无法缩小时以 context_overflow 结束', async () => {
  const ws = upsertWorkspace(store, dir, 'overflow')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '溢出恢复',
  })

  /*
   * 历史必须**超过保留预算**才能被压缩。
   *
   * 保留预算是 `tailRetain`（`@qywork/agent`）：`min(窗口/4, 60_000)`，1M 窗口下为 60,000 token。
   * 历史不足时整段历史都位于保留区内，压缩返回「无可压缩内容」，
   * 测试结果为「恢复未触发」，而真正的原因是夹具过小。
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
    summarize: makeSummarizer({
      profile: () => profile,
    }),
  })
  // 记录调用次数。断言「恢复被触发」只能依据该计数，不能依据摘要请求数：
  // 收纳段足够时压缩不调用模型。
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
    persist: {
      nextSeq: () => 1,
      openTextStep: () => 'st_1',
      openThinkingStep: () => 'st_1',
      landUserStep: () => 'st_user_1',
      failThinkingSteps: () => {},
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
      density: adapter.spec.density,
      vision: adapter.spec.vision,
      resources: new Map(),
      state: new Map(),
      sink: null,
      signal: new AbortController().signal,
      emit: () => {},
      requestPermission: async () => ({ allowed: true }),
    }),
    compaction,
  })

  /*
   * history 必须**带有消息 id**，从账本中读取。
   *
   * 投影按单元键对齐（`_messageId`），传入没有 id 的历史时 `project()` 无法压缩任何
   * 条目、原样返回：压缩「成功」而请求未减少任何字节，恢复因此不重发。
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

  // provider 确实拒绝了一次，且使用的是真实形状的错误体。
  expect(rejected).toBe(1)
  // 凭证成立 → 恢复被触发：压缩确实执行了一次。**这是本测试的核心断言**：
  // 分类无法识别时，`compaction.run()` 一次都不会被调用。
  expect(compactionRuns).toBe(1)
  // 超出窗口仍以 `context_overflow` 收尾（本次夹具中压缩无法缩小请求，不重发是正确的）：
  // 恢复失败时**不得丢弃错误**，用户必须能看到超出窗口这一事件。
  const err = events.find((e) => e.type === 'run.error')
  expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
}, 30_000)
