/**
 * Responses 适配器的**真实 HTTP 路径**：fetch → SSE → 事件 → 用量。
 *
 * **为什么单独一个文件，而且要起一个真的 HTTP server。** 隔壁 `openai-responses.test.ts` 测的是纯函
 * 数（`buildInput` / `applyUsage` / `readSse`），它锁得住形状，锁不住**这条链路真的能跑通**。这两
 * 件事之间出过一次错：`readSse` 一直是对的，而 `stream()` 只认
 * `response.reasoning_summary_text.delta`，因此 DeepSeek 发的 `response.reasoning_text.delta` 全程
 * 不被识别、一个 `thinking_delta` 都没有——纯函数测试全绿，思考内容全丢。
 *
 * 所以这里起 `Bun.serve`，让适配器真的发一次请求、真的收一次 SSE。
 *
 * **报文取自实测，不得自拟。** 下面的事件字节逐字取自 2026-08 对
 * `api.deepseek.com/v1/responses` 的一次实测（id 换成了固定值，便于断言）。
 * 自拟一份报文只能锁住预期形状，锁不住供应商实际发什么——上面那个 bug 正是
 * 两者不一致造成的。
 *
 * 它验的是**本仓的客户端**，不是 DeepSeek 的服务端。对着真实端点的那一次
 * 在 `scripts/smoke-responses.ts`，需要 key，不进单测。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { lookupModel } from '../catalog.ts'
import type { ProviderEvent, ProviderUsage } from '../types.ts'
import { OpenAIResponsesAdapter } from './openai-responses.ts'

// ───────────────────────── 实测报文 ─────────────────────────

const ITEM = '453bfa08'
const CALL_ITEM = 'ea80131b'
const CALL_ID = 'call_00_A1EUR9gVpZeGEpbQdg9Y2986'

function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/** 纯文本一轮：reasoning 条目 + 正文 + usage。 */
const TEXT_RUN = sse([
  { type: 'response.created', response: { id: 'r1', status: 'in_progress' }, sequence_number: 0 },
  { type: 'response.in_progress', response: { id: 'r1', status: 'in_progress' } },
  {
    type: 'response.output_item.added',
    item: { type: 'reasoning', id: ITEM, status: 'in_progress', content: [], summary: [] },
    output_index: 0,
  },
  {
    type: 'response.reasoning_text.delta',
    content_index: 0,
    delta: '3812*80',
    item_id: ITEM,
    output_index: 0,
  },
  {
    type: 'response.reasoning_text.delta',
    content_index: 0,
    delta: ' -3812',
    item_id: ITEM,
    output_index: 0,
  },
  {
    type: 'response.reasoning_text.done',
    content_index: 0,
    item_id: ITEM,
    output_index: 0,
    text: '3812*80 -3812',
  },
  {
    type: 'response.output_item.added',
    item: { type: 'message', id: 'm1', status: 'in_progress', content: [], role: 'assistant' },
    output_index: 1,
  },
  { type: 'response.output_text.delta', delta: '301', item_id: 'm1', output_index: 1 },
  { type: 'response.output_text.delta', delta: '148', item_id: 'm1', output_index: 1 },
  { type: 'response.output_text.done', text: '301148', item_id: 'm1', output_index: 1 },
  {
    type: 'response.completed',
    response: {
      id: 'r1',
      status: 'completed',
      incomplete_details: null,
      usage: {
        input_tokens: 1288,
        input_tokens_details: { cached_tokens: 1280 },
        output_tokens: 22,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 1310,
      },
    },
  },
])

/** 工具调用一轮。注意 reasoning 占 output_index 0，工具调用是 1。 */
const TOOL_RUN = sse([
  { type: 'response.created', response: { id: 'r2', status: 'in_progress' } },
  {
    type: 'response.output_item.added',
    item: { type: 'reasoning', id: ITEM, status: 'in_progress', content: [], summary: [] },
    output_index: 0,
  },
  {
    type: 'response.reasoning_text.delta',
    delta: '要调 get_weather',
    item_id: ITEM,
    output_index: 0,
  },
  {
    type: 'response.output_item.done',
    item: {
      type: 'reasoning',
      id: ITEM,
      status: 'completed',
      content: [{ type: 'reasoning_text', text: '要调 get_weather' }],
      summary: [],
    },
    output_index: 0,
  },
  {
    type: 'response.output_item.added',
    item: {
      type: 'function_call',
      id: CALL_ITEM,
      status: 'in_progress',
      arguments: '',
      call_id: CALL_ID,
      name: 'get_weather',
    },
    output_index: 1,
  },
  {
    type: 'response.function_call_arguments.delta',
    delta: '{"city"',
    item_id: CALL_ITEM,
    output_index: 1,
  },
  {
    type: 'response.function_call_arguments.delta',
    delta: ': "北京"}',
    item_id: CALL_ITEM,
    output_index: 1,
  },
  {
    type: 'response.function_call_arguments.done',
    arguments: '{"city": "北京"}',
    item_id: CALL_ITEM,
    output_index: 1,
  },
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: CALL_ITEM,
      status: 'completed',
      arguments: '{"city": "北京"}',
      call_id: CALL_ID,
      name: 'get_weather',
    },
    output_index: 1,
  },
  {
    type: 'response.completed',
    response: {
      id: 'r2',
      status: 'completed',
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 10 },
      },
    },
  },
])

/** 分片全丢，只有收尾事件。中转站漏发增量时的样子。 */
const DONE_ONLY = sse([
  { type: 'response.created', response: { id: 'r3', status: 'in_progress' } },
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: CALL_ITEM,
      status: 'completed',
      arguments: '{"city": "上海"}',
      call_id: CALL_ID,
      name: 'get_weather',
    },
    output_index: 0,
  },
  { type: 'response.completed', response: { id: 'r3', status: 'completed' } },
])

const TRUNCATED = sse([
  {
    type: 'response.incomplete',
    response: {
      id: 'r4',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 88, input_tokens_details: { cached_tokens: 0 }, output_tokens: 32 },
    },
  },
])

// ───────────────────────── fixture server ─────────────────────────

let script: { status: number; body: string; contentType: string } = {
  status: 200,
  body: TEXT_RUN,
  contentType: 'text/event-stream',
}
/** 上一次发出去的请求体。用来断言**发出去**的内容，不只是收回来的；只声明这份测试真的读的那几格。 */
interface SentBody {
  input?: { type: string }[]
  store?: boolean
  prompt_cache_key?: string
  reasoning?: { summary?: string; effort?: string }
}

let lastBody: SentBody = {}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    lastBody = ((await req.json().catch(() => ({}))) ?? {}) as SentBody
    return new Response(script.body, {
      status: script.status,
      headers: { 'content-type': script.contentType },
    })
  },
})
const BASE = `http://127.0.0.1:${server.port}/v1`

afterAll(() => server.stop(true))

function adapter() {
  return new OpenAIResponsesAdapter(
    { kind: 'openai_responses', apiKey: 'sk-test', baseUrl: BASE, model: 'deepseek-v4-flash' },
    lookupModel('deepseek-v4-flash', 'openai_responses'),
  )
}

async function run(
  body: string,
  over: Partial<Parameters<OpenAIResponsesAdapter['stream']>[0]> = {},
  status = 200,
): Promise<ProviderEvent[]> {
  script = { status, body, contentType: status === 200 ? 'text/event-stream' : 'application/json' }
  const events: ProviderEvent[] = []
  for await (const ev of adapter().stream({
    model: 'deepseek-v4-flash',
    system: [],
    messages: [{ role: 'user', content: '你好' }],
    tools: [],
    maxOutputTokens: 1024,
    ...over,
  })) {
    events.push(ev)
  }
  return events
}

// ───────────────────────── 断言 ─────────────────────────

describe('推理增量：两种事件名都要认', () => {
  /**
   * 这条是这个文件存在的理由。DeepSeek 发 `response.reasoning_text.delta`，
   * 只认 OpenAI 的 `reasoning_summary_text` 时**一个错都不报**，只是思考内容
   * 凭空消失。断言「有 thinking_delta」才抓得住「什么都没有」。
   */
  test('DeepSeek 的 reasoning_text.delta 变成 thinking_delta', async () => {
    const events = await run(TEXT_RUN)
    const thinking = events.filter((e) => e.type === 'thinking_delta')
    expect(thinking).toHaveLength(2)
    expect(thinking.map((e) => (e as { delta: string }).delta).join('')).toBe('3812*80 -3812')
  })

  test('OpenAI 的 reasoning_summary_text.delta 同样认', async () => {
    const events = await run(
      sse([
        { type: 'response.reasoning_summary_text.delta', delta: '摘要', output_index: 0 },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
    )
    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(1)
  })

  test('思考内容不混进正文', async () => {
    const events = await run(TEXT_RUN)
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as { delta: string }).delta)
      .join('')
    expect(text).toBe('301148')
  })
})

describe('工具调用', () => {
  test('从 added → delta → done 收出一条完整调用', async () => {
    const events = await run(TOOL_RUN)
    const calls = events.find((e) => e.type === 'tool_calls') as
      | { calls: { id: string; name: string; arguments: Record<string, unknown> }[] }
      | undefined
    expect(calls?.calls).toEqual([
      { id: CALL_ID, name: 'get_weather', arguments: { city: '北京' } },
    ])
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'tool_use',
      rawStopReason: 'completed',
    })
  })

  /**
   * reasoning 占了 output_index 0，工具调用在 1。按 output_index 建槽位是对的，
   * 但**不能**假设工具调用从 0 开始——那样会把参数分片写进一个不存在的槽位，
   * 结果是一条参数为空的调用。
   */
  test('reasoning 占了 index 0 时工具调用仍然收得到', async () => {
    const events = await run(TOOL_RUN)
    const calls = events.find((e) => e.type === 'tool_calls') as
      | { calls: { name: string; arguments: Record<string, unknown> }[] }
      | undefined
    // 槽位对错的可观察形状是**参数对不对**：写进不存在的槽位会得到一条空参数的调用。
    expect(calls?.calls[0]?.name).toBe('get_weather')
    expect(calls?.calls[0]?.arguments).toEqual({ city: '北京' })
  })

  /**
   * 只有收尾事件也要收得下。丢掉它等于「模型调了工具而本地当作没调」，
   * 下一轮模型会重复调用——用户看到的是它卡在同一步反复打转。
   */
  test('分片全丢、只有 output_item.done 时照样收得到', async () => {
    const events = await run(DONE_ONLY)
    const calls = events.find((e) => e.type === 'tool_calls') as
      | { calls: { arguments: Record<string, unknown> }[] }
      | undefined
    expect(calls?.calls[0]?.arguments).toEqual({ city: '上海' })
  })
})

describe('用量与终态', () => {
  test('缓存命中从 input_tokens 里减掉', async () => {
    const events = await run(TEXT_RUN)
    const usage = (events.find((e) => e.type === 'usage') as { usage: ProviderUsage }).usage
    expect(usage.cachedTokens).toBe(1280)
    expect(usage.inputTokens).toBe(8)
    expect(usage.reasoningTokens).toBe(20)
    expect(usage.source).toBe('provider')
  })

  test('输出截断报 max_tokens，不报 end_turn', async () => {
    const events = await run(TRUNCATED)
    expect(events.at(-1)).toEqual({
      type: 'done',
      stopReason: 'max_tokens',
      rawStopReason: 'incomplete:max_output_tokens',
    })
  })

  test('请求前先报一次估算量，并标明它是估算', async () => {
    const events = await run(TEXT_RUN)
    expect(events[0]).toMatchObject({ type: 'request_prepared' })
  })
})

describe('错误路径', () => {
  test('400 的正文被读出来带进错误，不只剩一个状态码', async () => {
    const body = JSON.stringify({
      error: {
        message: 'The `reasoning_text` in the thinking mode must be passed back to the API.',
      },
    })
    await expect(run(body, {}, 400)).rejects.toThrow(/reasoning_text/)
  })

  /** SSE 已经 200 了，流内错误只能从事件里出。不认它的表现是「流正常结束但什么都没有」。 */
  test('流内 response.failed 抛出来，不当成正常结束', async () => {
    const body = sse([{ type: 'response.failed', response: { error: { message: '模型过载' } } }])
    await expect(run(body)).rejects.toThrow(/模型过载/)
  })

  /**
   * 终态事件没到就断流。默认值 `end_turn` 会把它落成正常完成——
   * 界面上是「写到一半就停、run 显示成功」，账本上那一轮无从对账。
   */
  test('没等到终态事件就断流的，报传输失败而不是完成', async () => {
    const body = sse([
      { type: 'response.output_text.delta', delta: '写到一半', item_id: 'm1', output_index: 0 },
    ])
    await expect(run(body)).rejects.toThrow(/流在终态事件之前结束/)
  })

  /** 判据是「终态事件到过没有」，不是 `rawStatusOf` 回没回空串。 */
  test('终态事件里没有 status 字段的不算断流', async () => {
    const events = await run(sse([{ type: 'response.completed', response: {} }]))
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'end_turn' })
  })
})

describe('发出去的请求', () => {
  test('带工具调用的历史会回传 reasoning 条目，且排在 function_call 之前', async () => {
    await run(TEXT_RUN, {
      messages: [
        { role: 'user', content: '北京天气？' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: '北京' } }],
          reasoningContent: '要调 get_weather',
        },
        { role: 'tool', toolCallId: 'c1', content: '晴 28 度' },
      ],
    })
    const types = (lastBody.input ?? []).map((i) => i.type)
    expect(types).toEqual(['message', 'reasoning', 'function_call', 'function_call_output'])
  })

  test('store 恒为 false —— 不把用户的对话留在供应商那边', async () => {
    await run(TEXT_RUN)
    expect(lastBody.store).toBe(false)
  })

  test('cacheKey 变成 prompt_cache_key', async () => {
    await run(TEXT_RUN, { cacheKey: 'cv_1' })
    expect(lastBody.prompt_cache_key).toBe('cv_1')
  })
})

describe('思考字段', () => {
  test('默认要摘要 —— 不要的话推理过程完全不可见', async () => {
    await run(TEXT_RUN)
    expect(lastBody.reasoning?.summary).toBe('auto')
  })

  /**
   * `effortLevels` 是 `[]` 是**实测结论**不是保守默认：四档全被接受，
   * 但 reasoning_tokens 三次采样都是 899~900，没有一档被采纳。
   * 所以即使调用方指定了 effort，也不该发出去——发一个不起作用的字段，
   * 只会让面板上显示的「已按 high 运行」变成一句假话。
   */
  test('目录说没有可用 effort 档位时，不发 effort 字段', async () => {
    await run(TEXT_RUN, { effort: 'high' })
    expect(lastBody.reasoning?.effort).toBeUndefined()
  })
})

/**
 * 连接超时与「用户按了停止」是两个信号，**认错了就把连不上报成已取消**。
 *
 * 这条适配器手写 fetch（没有 SDK 的超时层），所以自己起了一个定时器 controller。
 * 它和 `req.signal` 合成同一个信号交给 fetch——合成之后再区分，
 * 靠的是「谁真的 abort 了」，不是 fetch 抛出来的错误长什么样（两边都是 AbortError）。
 */
describe('停止与超时分开认', () => {
  test('用户按停止报「已取消」，不报连接超时', async () => {
    const ctl = new AbortController()
    ctl.abort()
    try {
      await run(TEXT_RUN, { signal: ctl.signal })
      throw new Error('应当抛出')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toBe('已取消')
      expect(message).not.toContain('超时')
    }
  })
})
