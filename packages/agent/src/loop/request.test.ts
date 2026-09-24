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
   * 回归测试：**压缩之后 breakdown 必须跟着变**。
   *
   * `breakdownOf` 算的是 `req.messages`，而那是 `compaction.project()` 的产物。
   * 如果哪天有人改成「直接读 input.history」，这条会红——
   * 而界面上的表现是：压缩生效了（模型确实看不到远期历史了），
   * 占用面板却一动不动，界面上等同于压缩没生效，用户会反复点压缩。
   */
  test('压缩投影之后，历史那一桶让位给摘要桶', async () => {
    const registry = new ToolRegistry()
    const long = '历史正文'.repeat(200)

    const captured: { historyMessages: number; summary: number }[] = []
    const makeLoop = (projected: boolean) =>
      new AgentLoop({
        adapter: fakeAdapter([null]),
        registry,
        systemPrompt: 'sys',
        persist: noopPersistence(),
        // project() 模拟压缩：把历史换成一条 summary。这正是 RuntimeCompaction 的形状。
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
    // 未压缩：历史那一桶很大、摘要为 0。
    expect(before!.historyMessages).toBeGreaterThan(100)
    expect(before!.summary).toBe(0)
    // 压缩后：摘要有了，历史那一桶塌下去。
    expect(after!.summary).toBeGreaterThan(0)
    expect(after!.historyMessages).toBeLessThan(before!.historyMessages)
  })

  /**
   * 回归测试：`context` 事件的 `breakdown` 必须是**真值**。
   *
   * 「字段在、值是假的」比没有这个字段更坏：界面照着它画出来的饼图会是空的，
   * 而没人能从界面看出那是假数据。
   *
   * 断言的是**口径**不是具体数字：系统提示词与工具 schema 各自非零、
   * 带 `_group` 的消息落进对应的桶、不带 `_group` 的落进 historyMessages。
   */
  test('breakdown 不是七个零，且按 _group 分桶', async () => {
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
        // 不带 _group：按口径落进 historyMessages，不单开「其他」桶。
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
    // 内置工具进 systemTools，不进已删的 toolSchemas；本例没有 mcp__ 工具。
    expect(b!.systemTools).toBeGreaterThan(0)
    expect(b!.mcpTools).toBe(0)
    expect(b!.summary).toBeGreaterThan(0)
    expect(b!.workspaceState).toBeGreaterThan(0)
    // 两条历史（一条带标记、一条不带）都归到 historyMessages。
    expect(b!.historyMessages).toBeGreaterThan(0)
    // 全零就是这条测试要挡的那个回归。
    expect(Object.values(b!).some((v) => v > 0)).toBe(true)
    // 桶集必须与协议恒等：多一个少一个都说明有人又另立了一套。
    expect(Object.keys(b!).sort()).toEqual([...CONTEXT_GROUPS].sort())
  })

  /**
   * 回归测试：**各行加起来必须等于标题上那个数**。
   *
   * 复现的是实测形状：`tokens` 走锚定尺（provider 真值 + 一轮尾巴），`breakdown`
   * 是本地估算，两者天然不等。live 事件不对账时，差额无声地落进「剩余空间」——
   * 界面上各行加起来只有 36.9%，标题写着 64.2%，而那 271k 的去向没有任何一行指向它。
   *
   * 会话面板那侧（`runtime/context-panel.ts`）一直是对过账的，所以不对账的表现
   * 是同一个面板两条路显示两组数：打开会话看到一组，run 一跑起来换成另一组。
   */
  test('锚定尺下各分组之和恒等于读数', async () => {
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
      // 真值远大于这点历史的本地估算，差额必须被摊回可变桶而不是消失。
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
    // 摊法是吸收不是缩放：逐字可数的固定类目保实测值，不许被差额改写。
    expect(ctx.breakdown.systemPrompt).toBe(estimateText('sys', DEFAULT_DENSITY))
  })

  /**
   * 回归测试：**执行记录 / 工具结果的二分要同尺量**。
   *
   * 复现的形状取自实测：`write_file` 回一句「创建 src/car.js」、没有 result。
   * 信封按 `estimateJson`（2 字符/token）量而整条按 `estimateText`（4 字符/token）
   * 量时，信封虚高一倍，差额从正文里扣到负数、被 `Math.min` 夹成零——面板因此
   * 读作「这次调用没带回任何正文」。同一条会话 327 次调用里 167 条是这个形状，
   * 上面这句 summary 就是其中一种。
   *
   * **断言落在账本上不是事件上**：事件里的 `breakdown` 已经对过账
   * （`reconcileBreakdown`），差额会盖住二分本身。`sentCategories` 是原始估算，
   * 也正是会话面板回头投影时读的那一份。
   */
  test('带 summary 的工具结果不会被记成没有正文', async () => {
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
      // 只看账本。
    }

    // 第二次请求才带着工具结果：第一次装配时那条 tool 消息还不存在。
    const b = recorded.at(-1)
    expect(recorded).toHaveLength(2)
    expect(b).toBeDefined()
    // 信封与正文各占一部分——两个桶都不许是零。
    expect(b!.executionRecords).toBeGreaterThan(0)
    expect(b!.intermediateContent).toBeGreaterThan(0)
  })
})

describe('effort 传到请求上', () => {
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
      // 跑完即可。
    }
    return seen
  }

  test('传了就带上，且原样传', async () => {
    expect((await runWith('max'))[0]?.effort).toBe('max')
    expect((await runWith('low'))[0]?.effort).toBe('low')
  })

  /** 不传是**不带这个键**，不是带一个 undefined——省略和显式空值在协议上不等价。 */
  test('没传就不带这个键', async () => {
    const req = (await runWith())[0]!
    expect('effort' in req).toBe(false)
  })
})

describe('花费带币种', () => {
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

  test('美元标价的模型记 USD', async () => {
    expect((await usageOf('claude-opus-5'))?.currency).toBe('USD')
  })

  /** 月之暗面官网按人民币标价。目录里记的是 ¥，这一轮的花费就得是 ¥。 */
  test('人民币标价的模型记 CNY', async () => {
    expect((await usageOf('kimi-k3'))?.currency).toBe('CNY')
  })
})

describe('上下文读数：一把尺', () => {
  /**
   * **跨 run 不换尺。**
   *
   * 没有锚点时，每个 run 的第一次请求只能报本地估算（系统性偏低），
   * 第二次起才切到真值——用户看到的就是每轮开头掉一次、然后弹回去。
   * 用户实测报的「一个轮会话里上下文跳了好几次」，跨轮的那一半就是它。
   */
  test('带着上一轮真值开跑，首个读数只投影新增内容', async () => {
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

  test('没有锚点时如实标 estimated，不假装是实测', async () => {
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
})

/**
 * 名字不在注册表里的调用**不进执行链**。
 *
 * 放它进去就会开出一条 tool step、发一条 `tool.started`，界面上多出一条没有动作、
 * 也没有执行事实的记录。注册表是工具的唯一权威：名字不在表里就是未注册调用，
 * 不是一种工具。
 *
 * 但结果必须回给模型：provider 的契约是每个 tool_call 都要有一条对应 id 的
 * tool 结果，少一条下一轮直接 400。
 */

describe('工具图片贯穿 AgentLoop 与真实 serializer', () => {
  /**
   * 复现原始失败形状的最小版：每一波读一张图，第三次请求体里只能有第二张。
   * 第一张的 tool 消息必须是字符串信封且标 `images_omitted`：缺了标记，信封与图仍在场的成功信封同形。
   */
  test('只有最后一个工具波次的图进请求体，更早的换成 images_omitted 信封', async () => {
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
        // 读完整轮即可，请求体由本机端点记录。
      }

      expect(bodies).toHaveLength(3)
      const tools = (bodies[2]!.messages as { role?: string; content?: unknown }[]).filter(
        (m) => m.role === 'tool',
      )
      expect(tools).toHaveLength(2)
      // 第一波：字符串信封，带标记，一个图像字节都没有。
      expect(typeof tools[0]!.content).toBe('string')
      expect(JSON.parse(tools[0]!.content as string)).toMatchObject({
        call_id: 'call_1',
        images_omitted: true,
      })
      expect(JSON.stringify(bodies[2])).not.toContain('IMG1')
      // 第二波：图仍在。
      const second = tools[1]!.content as { type?: string; image_url?: { url?: string } }[]
      expect(second[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,IMG2' },
      })
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
        // 读完整轮即可，请求体由本机端点记录。
      }

      expect(bodies).toHaveLength(2)
      const messages = bodies[1]!.messages as {
        role?: string
        tool_call_id?: string
        content?: unknown
      }[]
      const tool = messages.find((message) => message.role === 'tool')
      expect(tool?.tool_call_id).toBe('call_image')
      const content = tool?.content as {
        type?: string
        text?: string
        image_url?: { url?: string }
      }[]
      expect(content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,QUJD' },
      })
      expect(JSON.parse(content[0]!.text ?? '')).toMatchObject({
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
 * 传输断了怎么收场。
 *
 * 起因是一次真实断流：
 * 第 4 次请求发出后 262 秒一个字节都没回来，run 就此终结，账本里那行到现在还是
 * `in_flight`，而系统没有替用户试第二次——他只能自己把那句话重打一遍。
 *
 * 这一组锁三件事：**账本必须落终态**、**零输出才重发**、**重发过要说出来**。
 */

describe('锚点的信封校验', () => {
  /**
   * 复现的是用户报的那种偏差：装完一个 MCP 或升一次构建之后的第一次发送，
   * 信封换了一份而消息侧一个字没变，读数却整条掉到估算尺上——实测一条真实
   * 占用 54.5% 的会话读作 80.0%。
   *
   * 判据是**只换头部、不整条作废**：读数留在真值尺上，数值等于真值减旧头部
   * 加本轮头部。换模型是另一回事，另一把尺量出来的数修正不回来。
   */
  test('信封变了只换头部，换模型才退回估算尺', async () => {
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

    // 空工具表下本轮头部只有冻结前缀那一段。
    const head = estimateText('sys', lookupModel('claude-opus-5', 'anthropic_messages').density)

    // 指纹对不上但还是同一个 tokenizer：真值仍然成立，只把头部那一段换掉。
    expect(await runOnce('not-the-current-envelope', 'claude-opus-5')).toEqual([
      { tokens: 12_345 - 5_000 + head, source: 'actual' },
    ])
    // 换了模型：退回估算尺，标签如实跟着走。
    expect((await runOnce('not-the-current-envelope', 'other-model'))[0]?.source).toBe('estimated')
    // 没记过指纹的存量行不作为「变了」的证据，锚点原样照用。
    expect(await runOnce(null, 'claude-opus-5')).toEqual([{ tokens: 12_345, source: 'actual' }])
  })
})
