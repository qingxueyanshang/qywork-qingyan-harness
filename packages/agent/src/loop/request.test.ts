/**
 * 覆盖 `loop/request.ts` 与 `loop/index.ts` 的请求装配：上下文分组占用、effort 透传、
 * 花费币种、上下文读数与锚点信封、工具图片经真实 serializer 的形状。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter } from '@qywork/ai'
import { buildAdapter, DEFAULT_DENSITY, estimateText, lookupModel } from '@qywork/ai'
import type { ContextBreakdown } from '@qywork/core'
import { CONTEXT_GROUPS } from '@qywork/core'
import { AgentLoop, type ToolContext } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'

describe('上下文分组占用', () => {
  /**
   * 回归测试：压缩之后 breakdown 必须随之变化。
   *
   * `breakdownOf` 计算的是 `req.messages`，即 `compaction.project()` 的产物。
   * 改为直接读取 `input.history` 时本测试失败：压缩已生效而占用面板不变，
   * 用户无法从界面确认压缩结果。
   */
  test('压缩投影之后，历史分组减少、摘要分组增加', async () => {
    const registry = new ToolRegistry()
    const long = '历史正文'.repeat(200)

    const captured: { historyMessages: number; summary: number }[] = []
    const makeLoop = (projected: boolean) =>
      new AgentLoop({
        adapter: fakeAdapter([null]),
        registry,
        systemPrompt: 'sys',
        persist: noopPersistence(),
        // project() 模拟压缩：将历史替换为一条 summary，与 RuntimeCompaction 的输出形状相同。
        compaction: {
          project: (history) =>
            projected
              ? [{ role: 'assistant', content: '压缩摘要', _group: 'summary' as const }]
              : history,
          run: async () => ({ status: 'skipped', reasonCode: 'nothing_to_compact' }) as never,
        },
        makeToolContext: (runId) => ({
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model: 'test',
          contextWindow: 200_000,
          density: DEFAULT_DENSITY,
          vision: null,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          requestPermission: async () => ({ allowed: true }),
        }),
      })

    for (const projected of [false, true]) {
      const events = []
      for await (const ev of makeLoop(projected).run({
        runId: 'rn_proj' as never,
        history: [{ role: 'user', content: long, _group: 'historyMessages' }],
        signal: new AbortController().signal,
      })) {
        events.push(ev)
      }
      const ctx = events.find((e) => e.type === 'context')
      const b = ctx?.type === 'context' ? ctx.breakdown : null
      expect(b).toBeDefined()
      captured.push({ historyMessages: b!.historyMessages, summary: b!.summary })
    }

    const [before, after] = captured
    // 未压缩：历史分组占用较大，摘要为 0。
    expect(before!.historyMessages).toBeGreaterThan(100)
    expect(before!.summary).toBe(0)
    // 压缩后：摘要非零，历史分组占用下降。
    expect(after!.summary).toBeGreaterThan(0)
    expect(after!.historyMessages).toBeLessThan(before!.historyMessages)
  })

  /**
   * 回归测试：`context` 事件的 `breakdown` 必须是实际计算值。
   *
   * 字段存在而值无效比缺少字段更难发现：界面据此渲染的饼图为空，
   * 且无法从界面判断数据无效。
   *
   * 断言的是计算口径而不是具体数字：系统提示词与工具 schema 各自非零、
   * 带 `_group` 的消息计入对应分组、不带 `_group` 的计入 historyMessages。
   */
  test('breakdown 不全为零，且按 _group 分组', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'noop',
      description: '占位工具，只为让 tools schema 非空。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '空操作',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        return { status: 'success', message: 'ok' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry,
      systemPrompt: '这是一段足够长的系统提示词，用来让 systemPrompt 那一桶明确非零。',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        density: DEFAULT_DENSITY,
        vision: null,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        requestPermission: async () => ({ allowed: true }),
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_breakdown' as never,
      history: [
        {
          role: 'context',
          content: '当前工作区状态：分支 main，无未提交改动。',
          _group: 'workspaceState',
        },
        { role: 'user', content: '历史消息一', _group: 'historyMessages' },
        { role: 'assistant', content: '这是上一轮的摘要', _group: 'summary' },
        // 不带 _group 的消息计入 historyMessages，不另设「其他」分组。
        { role: 'user', content: '没有分组标记的消息' },
      ],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type).toBe('context')
    const b = ctx?.type === 'context' ? ctx.breakdown : null
    expect(b).toBeDefined()

    expect(b!.systemPrompt).toBeGreaterThan(0)
    // 内置工具计入 systemTools；本例没有 mcp__ 工具。
    expect(b!.systemTools).toBeGreaterThan(0)
    expect(b!.mcpTools).toBe(0)
    expect(b!.summary).toBeGreaterThan(0)
    expect(b!.workspaceState).toBeGreaterThan(0)
    // 两条历史消息（一条带标记、一条不带）均计入 historyMessages。
    expect(b!.historyMessages).toBeGreaterThan(0)
    // 全部为零即本测试要拦截的回归。
    expect(Object.values(b!).some((v) => v > 0)).toBe(true)
    // 分组集合必须与协议定义一致：数量不同说明出现了第二套分组定义。
    expect(Object.keys(b!).sort()).toEqual([...CONTEXT_GROUPS].sort())
  })

  /**
   * 回归测试：各分组之和必须等于标题显示的总数。
   *
   * 复现的是实测形状：`tokens` 采用锚定计量（provider 真值 + 锚点后的增量），`breakdown`
   * 是本地估算，两者必然不等。live 事件不对账时，差额被计入「剩余空间」且没有提示：
   * 实测界面上各分组之和为 36.9%，标题为 64.2%，相差的 271k 未归入任何分组。
   *
   * 会话面板（`runtime/context-panel.ts`）始终对账，因此 live 事件不对账时同一个面板
   * 经两条路径显示两组数值：打开会话时显示一组，run 开始执行后换成另一组。
   */
  test('锚定计量下各分组之和等于读数', async () => {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        density: DEFAULT_DENSITY,
        vision: null,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        requestPermission: async () => ({ allowed: true }),
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_reconcile' as never,
      history: [{ role: 'user', content: '继续', _group: 'historyMessages', _messageId: 'ms_9' }],
      // 真值远大于该历史的本地估算，差额必须分摊到可变分组，不得丢失。
      anchor: {
        tokens: 33_000,
        throughMessageId: 'ms_8',
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type).toBe('context')
    if (ctx?.type !== 'context') return
    expect(ctx.source).toBe('projected')
    expect(Object.values(ctx.breakdown).reduce((n, v) => n + v, 0)).toBe(ctx.tokens)
    // 分摊方式是吸收而不是缩放：可逐字计数的固定类目保留实测值，不得被差额改写。
    expect(ctx.breakdown.systemPrompt).toBe(estimateText('sys', DEFAULT_DENSITY))
  })

  /**
   * 回归测试：执行记录与工具结果的拆分必须使用同一种估算方式。
   *
   * 复现的形状取自实测：`write_file` 返回 summary「创建 src/car.js」，没有 result。
   * 信封按 `estimateJson`（2 字符/token）估算而整条按 `estimateText`（4 字符/token）
   * 估算时，信封估值偏高一倍，正文差额为负数并被 `Math.min` 截为零，面板因此
   * 显示该调用没有返回正文。同一会话的 327 次调用中有 167 次是这种形状。
   *
   * 断言针对账本而不是事件：事件中的 `breakdown` 已经对账（`reconcileBreakdown`），
   * 差额会掩盖拆分结果。`sentCategories` 是原始估算，也是会话面板重新投影时读取的数据。
   */
  test('带 summary 的工具结果不会被记为没有正文', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'write_file',
      description: '回一句话，用于验证工具结果的二分。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'write',
      objectLabel: '文件',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        return { status: 'success', message: '创建 src/car.js' }
      },
    })

    const recorded: ContextBreakdown[] = []
    const persist = noopPersistence()
    const loop = new AgentLoop({
      adapter: fakeAdapter([[{ id: 'call_0mt3zi7wa01', name: 'write_file', arguments: {} }], null]),
      registry,
      systemPrompt: 'sys',
      persist: {
        ...persist,
        openRequest: (r) => {
          recorded.push(r.sentCategories)
          return persist.openRequest(r)
        },
      },
      makeToolContext: (runId) => baseCtx(runId),
    })

    for await (const _ev of loop.run({
      runId: 'rn_split' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 只检查账本。
    }

    // 第二次请求才包含工具结果：第一次装配时 tool 消息尚不存在。
    const b = recorded.at(-1)
    expect(recorded).toHaveLength(2)
    expect(b).toBeDefined()
    // 信封与正文各占一部分，两个分组均不得为零。
    expect(b!.executionRecords).toBeGreaterThan(0)
    expect(b!.intermediateContent).toBeGreaterThan(0)
  })
})

describe('effort 传递到请求', () => {
  function capturing(): { adapter: LlmAdapter; seen: ChatRequest[] } {
    const seen: ChatRequest[] = []
    const inner = fakeAdapter([null])
    return {
      seen,
      adapter: {
        ...inner,
        async *stream(req: ChatRequest) {
          seen.push(req)
          yield* inner.stream(req)
        },
      },
    }
  }

  async function runWith(effort?: 'low' | 'max') {
    const { adapter, seen } = capturing()
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 's',
      persist: noopPersistence(),
      makeToolContext: (runId) =>
        ({
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model: 'test',
          contextWindow: 200_000,
          density: DEFAULT_DENSITY,
          vision: null,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          emit: () => {},
          requestPermission: async () => ({ allowed: true }),
        }) as ToolContext,
    })
    for await (const _ of loop.run({
      runId: 'rn_test' as never,
      history: [],
      ...(effort ? { effort } : {}),
      signal: new AbortController().signal,
    })) {
      // 执行完毕即可。
    }
    return seen
  }

  test('传入时原样带上', async () => {
    expect((await runWith('max'))[0]?.effort).toBe('max')
    expect((await runWith('low'))[0]?.effort).toBe('low')
  })

  /** 未传入时不带该键，而不是带 undefined：省略与显式空值在协议上不等价。 */
  test('未传入时不带该键', async () => {
    const req = (await runWith())[0]!
    expect('effort' in req).toBe(false)
  })
})

/**
 * 每轮的费用携带其自身的币种。
 *
 * 币种固定为美元不会触发任何报错：`cost` 仍是数字，界面仍能渲染，
 * 但 ¥ 会显示为 $，金额相差约七倍。这类错误只能由此类测试拦截。
 */
describe('花费记录币种', () => {
  async function usageOf(model: string) {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null], model),
      registry: new ToolRegistry(),
      systemPrompt: 's',
      persist: noopPersistence(),
      makeToolContext: (runId) =>
        ({
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model,
          contextWindow: 200_000,
          density: DEFAULT_DENSITY,
          vision: null,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          emit: () => {},
          requestPermission: async () => ({ allowed: true }),
        }) as ToolContext,
    })
    const events = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    const finished = events.find((e) => e.type === 'run.finished')
    return finished?.type === 'run.finished' ? finished.usage : null
  }

  test('美元标价的模型记为 USD', async () => {
    expect((await usageOf('claude-opus-5'))?.currency).toBe('USD')
  })

  /** 月之暗面官网按人民币标价，目录中记为 ¥，本轮花费也必须是 ¥。 */
  test('人民币标价的模型记为 CNY', async () => {
    expect((await usageOf('kimi-k3'))?.currency).toBe('CNY')
  })
})

describe('上下文读数：统一计量', () => {
  /**
   * 跨 run 不改变计量方式。
   *
   * 没有锚点时，每个 run 的第一次请求只能报告本地估算（系统性偏低），
   * 第二次请求起才切换到真值，读数因此在每轮开头下降一次后恢复。
   * 用户报告的「一个轮会话里上下文跳了好几次」中，跨轮的部分由此产生。
   */
  test('携带上一轮真值开始执行，首个读数只投影新增内容', async () => {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        density: DEFAULT_DENSITY,
        vision: null,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        requestPermission: async () => ({ allowed: true }),
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_anchor' as never,
      history: [{ role: 'user', content: '继续', _group: 'historyMessages', _messageId: 'ms_9' }],
      anchor: {
        tokens: 33_000,
        throughMessageId: 'ms_8',
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type === 'context' && ctx.source).toBe('projected')
    // “继续”按当前模型的本地结构估算为 7 token；旧请求的整体误差不能外推到新消息。
    expect(ctx?.type === 'context' && ctx.tokens).toBe(33_007)
  })

  test('没有锚点时标为 estimated，不标为实测', async () => {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        density: DEFAULT_DENSITY,
        vision: null,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        requestPermission: async () => ({ allowed: true }),
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_noanchor' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type === 'context' && ctx.source).toBe('estimated')
  })

  /** 请求账记录的发出时读数与读数条显示的值相同：面板读取该值，不另行计算。 */
  test('请求账的 occupancyTokens 与同一次请求的读数事件同值', async () => {
    const recorded: (number | undefined)[] = []
    const persist = {
      ...noopPersistence(),
      openRequest: (input: { occupancyTokens?: number }) => {
        recorded.push(input.occupancyTokens)
        return `pr_${recorded.length}`
      },
    }
    const loop = new AgentLoop({
      adapter: fakeAdapter([[{ id: 'c1', name: 'nope', arguments: {} }], null]),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist,
      makeToolContext: (runId) => baseCtx(runId),
    })
    const shown: number[] = []
    for await (const ev of loop.run({
      runId: 'rn_occupancy' as never,
      history: [{ role: 'user', content: '开始' }],
      anchor: {
        tokens: 20_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'context') shown.push(ev.tokens)
    }
    expect(recorded).toHaveLength(2)
    expect(shown).toEqual([recorded[0]!, 15, recorded[1]!, 15])
  })
})

/**
 * 名称不在注册表中的调用不进入执行链。
 *
 * 进入执行链会创建一条 tool step 并发出 `tool.started`，界面上出现一条没有动作、
 * 也没有执行事实的记录。注册表是工具的唯一权威：名称不在表中即为未注册调用，
 * 不是一种工具。
 *
 * 结果仍必须返回给模型：provider 要求每个 tool_call 都有一条对应 id 的
 * tool 结果，缺少时下一轮请求返回 400。
 */

describe('工具图片贯穿 AgentLoop 与真实 serializer', () => {
  /**
   * 每个工具批次读取一张图片，第三次请求体中两张都在：总量在保留上限内时不移除图片，
   * 前缀不变，模型无需重新读取。每张图片位于所属批次回执之后的观察消息中。
   */
  test('上限内每个工具波次的图片保留在后续请求体中，各自位于本批回执之后', async () => {
    const bodies: Record<string, unknown>[] = []
    let requestIndex = 0
    const call = (id: string) => ({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: { name: 'read_image', arguments: JSON.stringify({ path: `${id}.png` }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    const endpoint = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>)
        requestIndex++
        const events =
          requestIndex <= 2
            ? [
                call(`call_${requestIndex}`),
                { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              ]
            : [
                { choices: [{ delta: { content: '完成' }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }] },
              ]
        const stream = [
          ...events.map((event) => `data: ${JSON.stringify(event)}`),
          'data: [DONE]',
          '',
        ].join('\n\n')
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      },
    })

    try {
      const adapter = buildAdapter({
        kind: 'openai_chat_completions',
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash-vision-exp',
        baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
      })
      const registry = new ToolRegistry()
      let reads = 0
      registry.register({
        name: 'read_image',
        description: '读取图片。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        actionKind: 'read',
        objectLabel: '图片',
        category: 'files',
        facet: '测试',
        summary: '测试夹具',
        permissionEffect: 'read',
        fn: async () => {
          reads++
          return {
            status: 'success',
            executed: true,
            message: `读取 shot_${reads}.png（图片）`,
            data: { images: [{ data: `IMG${reads}`, mime: 'image/png' }] },
          }
        },
      })
      const loop = new AgentLoop({
        adapter,
        registry,
        systemPrompt: 'sys',
        persist: noopPersistence(),
        makeToolContext: (runId) => baseCtx(runId),
      })
      for await (const _ of loop.run({
        runId: 'rn_image_scope' as never,
        history: [],
        signal: new AbortController().signal,
      })) {
        // 执行完整轮即可，请求体由本机端点记录。
      }

      expect(bodies).toHaveLength(3)
      const messages = bodies[2]!.messages as { role?: string; content?: unknown }[]
      const tools = messages.filter((m) => m.role === 'tool')
      expect(tools).toHaveLength(2)
      for (const t of tools) {
        expect(t.content).toContain('[图像 1：见本批工具结果之后的观察消息]')
        expect(String(t.content)).not.toContain('images_omitted')
      }
      // 两张图片均在请求中，各自位于紧随本批回执的观察消息内，不在 tool 消息中。
      const observations = messages.filter((m) => m.role === 'user' && Array.isArray(m.content))
      expect(observations.map((m) => m.content)).toEqual([
        [
          { type: 'text', text: expect.any(String) },
          { type: 'text', text: 'call_id call_1 · 图像 1' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG1' } },
        ],
        [
          { type: 'text', text: expect.any(String) },
          { type: 'text', text: 'call_id call_2 · 图像 1' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,IMG2' } },
        ],
      ])
    } finally {
      endpoint.stop(true)
    }
  })

  test('工具结果的信封、图片字节、MIME 与 call id 进入下一次请求体', async () => {
    const bodies: Record<string, unknown>[] = []
    let requestIndex = 0
    const endpoint = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>)
        requestIndex++
        const events =
          requestIndex === 1
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_image',
                            function: {
                              name: 'read_image',
                              arguments: JSON.stringify({ path: 'probe.png' }),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
                { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              ]
            : [
                { choices: [{ delta: { content: '完成' }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }] },
              ]
        const stream = [
          ...events.map((event) => `data: ${JSON.stringify(event)}`),
          'data: [DONE]',
          '',
        ].join('\n\n')
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      },
    })

    try {
      const adapter = buildAdapter({
        kind: 'openai_chat_completions',
        apiKey: 'sk-test',
        model: 'deepseek-v4-flash-vision-exp',
        baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
      })
      const registry = new ToolRegistry()
      registry.register({
        name: 'read_image',
        description: '读取图片。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        actionKind: 'read',
        objectLabel: '图片',
        category: 'files',
        facet: '测试',
        summary: '测试夹具',
        permissionEffect: 'read',
        fn: async () => ({
          status: 'success',
          executed: true,
          message: '读取 probe.png（图片）',
          data: { images: [{ data: 'QUJD', mime: 'image/png' }] },
        }),
      })
      const loop = new AgentLoop({
        adapter,
        registry,
        systemPrompt: 'sys',
        persist: noopPersistence(),
        makeToolContext: (runId) => baseCtx(runId),
      })

      for await (const _ of loop.run({
        runId: 'rn_image_to_wire' as never,
        history: [],
        signal: new AbortController().signal,
      })) {
        // 执行完整轮即可，请求体由本机端点记录。
      }

      expect(bodies).toHaveLength(2)
      const messages = bodies[1]!.messages as {
        role?: string
        tool_call_id?: string
        content?: unknown
      }[]
      const toolIndex = messages.findIndex((message) => message.role === 'tool')
      const tool = messages[toolIndex]
      expect(tool?.tool_call_id).toBe('call_image')
      const [envelope, placeholder] = String(tool?.content).split('\n')
      expect(placeholder).toBe('[图像 1：见本批工具结果之后的观察消息]')
      expect(messages[toolIndex + 1]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: expect.any(String) },
          { type: 'text', text: 'call_id call_image · 图像 1' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      })
      expect(JSON.parse(envelope ?? '')).toMatchObject({
        call_id: 'call_image',
        tool: 'read_image',
        status: 'success',
        executed: true,
        summary: '读取 probe.png（图片）',
      })
    } finally {
      endpoint.stop(true)
    }
  })
})

/**
 * 传输中断后的处理。
 *
 * 实测案例：第 4 次请求发出后 262 秒未收到任何字节，run 随即结束，账本中该行停留在
 * `in_flight`，且系统未自动重发，用户只能重新输入同一条消息。
 *
 * 本组锁定三项行为：账本必须写入终态；仅在零输出时重发；发生过重发时必须告知用户。
 */

describe('锚点的信封校验', () => {
  /**
   * 复现用户报告的偏差：安装一个 MCP 或升级构建后的第一次发送，信封已变化而消息部分
   * 未变，读数却整体改用本地估算：实测真实占用 54.5% 的会话显示为 80.0%。
   *
   * 判据是只替换头部、不整体作废：读数保持 provider 真值口径，数值等于真值减旧头部
   * 加本轮头部。换模型时不同：另一个 tokenizer 计量的数值无法修正。
   */
  test('信封变化时只替换头部，换模型时才改用本地估算', async () => {
    const runOnce = async (fingerprint: string | null, model: string) => {
      const seen: { tokens: number; source: string }[] = []
      const loop = new AgentLoop({
        adapter: fakeAdapter([null]),
        registry: new ToolRegistry(),
        systemPrompt: 'sys',
        persist: noopPersistence(),
        makeToolContext: (runId) => baseCtx(runId),
      })
      for await (const ev of loop.run({
        runId: 'rn_env' as never,
        history: [],
        signal: new AbortController().signal,
        anchor: {
          tokens: 12_345,
          throughMessageId: null,
          model,
          headTokens: 5_000,
          envelopeFingerprint: fingerprint,
        },
      })) {
        if (ev.type === 'context') seen.push({ tokens: ev.tokens, source: ev.source })
      }
      return seen
    }

    // 工具表为空时，本轮头部只包含冻结前缀。
    const head = estimateText('sys', lookupModel('claude-opus-5', 'anthropic_messages').density)

    // 指纹不一致但 tokenizer 相同：真值仍然有效，只替换头部。
    expect(await runOnce('not-the-current-envelope', 'claude-opus-5')).toEqual([
      { tokens: 12_345 - 5_000 + head, source: 'actual' },
      { tokens: 15, source: 'actual' },
    ])
    // 换模型后改用本地估算，source 标为 estimated。
    expect((await runOnce('not-the-current-envelope', 'other-model'))[0]?.source).toBe('estimated')
    // 未记录指纹的存量行不作为信封变化的证据，锚点按原值使用。
    expect(await runOnce(null, 'claude-opus-5')).toEqual([
      { tokens: 12_345, source: 'actual' },
      { tokens: 15, source: 'actual' },
    ])
  })
})
