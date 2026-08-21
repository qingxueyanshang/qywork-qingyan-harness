/**
 * Responses 协议适配器。
 *
 * 重点全在**形状**上：`input` 是条目序列不是消息序列，工具调用是顶层条目，
 * 工具定义扁平，输入侧文本用 `input_text` 输出侧用 `output_text`。
 * 这几条照搬 chat 协议都会得到一个「结构合法但语义错误」的请求——
 * 那种错不会报错，只会让模型看不到自己调过什么。
 */

import { describe, expect, test } from 'bun:test'
import { lookupModel } from '../catalog.ts'
import type { ProviderUsage, WireMessage } from '../types.ts'
import { applyUsage, buildInput, buildTools, readSse } from './openai-responses.ts'

describe('input 是条目序列，不是消息序列', () => {
  test('普通用户消息用 input_text', () => {
    const items = buildInput([{ role: 'user', content: '你好' }], 'none')
    expect(items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    ])
  })

  /** 输入侧与输出侧的文本块类型不同。写反了被拒，而错误只说「content 无效」。 */
  test('assistant 正文用 output_text', () => {
    const items = buildInput([{ role: 'assistant', content: '好的' }], 'none')
    expect((items[0]!.content as { type: string }[])[0]!.type).toBe('output_text')
  })

  /**
   * 工具调用是**顶层条目**，不是挂在 assistant message 上的字段。
   * 这是照搬 chat 协议最容易搬错的一处。
   */
  test('工具调用展开成顶层 function_call 条目', () => {
    const items = buildInput(
      [
        {
          role: 'assistant',
          content: '我来读一下',
          toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
        },
      ],
      'none',
    )
    expect(items).toHaveLength(2)
    expect(items[0]!.type).toBe('message')
    expect(items[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"a.ts"}',
    })
  })

  test('没有正文的工具轮只产出 function_call，不塞一条空 message', () => {
    const items = buildInput(
      [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'x', arguments: {} }] }],
      'none',
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.type).toBe('function_call')
  })

  test('工具结果是 function_call_output，按 call_id 对上', () => {
    const items = buildInput([{ role: 'tool', toolCallId: 'call_1', content: '读到了' }], 'none')
    expect(items[0]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '读到了',
    })
  })

  test('多模态：图片走 input_image 的 data URL', () => {
    const msg: WireMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '看这个' },
        { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'AAAA' } },
      ],
    }
    const content = buildInput([msg], 'none')[0]!.content as Record<string, string>[]
    expect(content[0]!.type).toBe('input_text')
    expect(content[1]!.type).toBe('input_image')
    expect(content[1]!.image_url).toBe('data:image/png;base64,AAAA')
  })

  test('一整轮对话的条目顺序保持原样', () => {
    const items = buildInput(
      [
        { role: 'user', content: '改一下' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'edit', arguments: {} }] },
        { role: 'tool', toolCallId: 'c1', content: '改好了' },
        { role: 'assistant', content: '完成' },
      ],
      'none',
    )
    expect(items.map((i) => i.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
      'message',
    ])
  })
})

/**
 * 回传由目录那一格（`spec.reasoningEcho`）声明，两个方向各有一个 400：
 * 声明要回传的端点少发就 `must be passed back to the API`，
 * 声明不回传的端点多发就 `array too long. Expected an array with maximum length 0`。
 *
 * 两者都只在**第二轮**发作：第一轮没有历史可回传，一路正常；模型一旦调了工具、
 * 把结果喂回去就炸。也就是说任何单轮测试都测不出它，而 agent 主循环全是多轮。
 * 实测规则见适配器文件头。
 */
describe('思考内容回传', () => {
  const withReasoning: WireMessage[] = [
    { role: 'user', content: '北京天气？' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: '北京' } }],
      reasoningContent: '要调 get_weather',
    },
    { role: 'tool', toolCallId: 'c1', content: '晴 28 度' },
  ]

  test('reasoning 条目排在它对应的 function_call 之前', () => {
    const items = buildInput(withReasoning, 'reasoning_text')
    expect(items.map((i) => i.type)).toEqual([
      'message',
      'reasoning',
      'function_call',
      'function_call_output',
    ])
    expect(items[1]).toEqual({
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: '要调 get_weather' }],
    })
  })

  /** 有正文的工具轮，顺序是 reasoning → 正文 → 调用。实测这个顺序端点认。 */
  test('带正文时 reasoning 仍在最前', () => {
    const items = buildInput(
      [
        {
          role: 'assistant',
          content: '我查一下',
          toolCalls: [{ id: 'c1', name: 'x', arguments: {} }],
          reasoningContent: '想了想',
        },
      ],
      'reasoning_text',
    )
    expect(items.map((i) => i.type)).toEqual(['reasoning', 'message', 'function_call'])
  })

  /**
   * 压缩投影或旧记录会让某一轮丢掉思考内容。补一个占位——
   * **空串等于没传**，照样 400，所以占位文本不能为空。
   */
  test('声明要回传时，缺失思考内容的轮次补占位而不是留空', () => {
    const items = buildInput(
      [
        ...withReasoning,
        { role: 'user', content: '上海呢？' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c2', name: 'get_weather', arguments: {} }],
        },
      ],
      'reasoning_text',
    )
    const reasonings = items.filter((i) => i.type === 'reasoning')
    expect(reasonings).toHaveLength(2)
    const second = reasonings[1] as { content: { text: string }[] }
    expect(second.content[0]!.text.length).toBeGreaterThan(0)
    expect(second.content[0]!.text).not.toContain('get_weather')
  })

  /**
   * 反方向那个 400 的回归锁。
   *
   * 摘要型端点（`reasoning.summary`）照样会给出思考内容，历史里因此**有**
   * `reasoningContent`——按「历史里有就回传」判就是假阳性，而它的代价是
   * `Invalid 'input[1].content': array too long. Expected an array with maximum
   * length 0`：每一轮工具调用之后都发不出去。判据只能来自目录。
   */
  test('声明不回传时，历史里带着思考内容也不产出 reasoning 条目', () => {
    const items = buildInput(withReasoning, 'none')
    expect(items.map((i) => i.type)).toEqual(['message', 'function_call', 'function_call_output'])
  })

  test('声明要回传时，空白的 reasoningContent 补占位而不是留空', () => {
    const items = buildInput(
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'x', arguments: {} }],
          reasoningContent: '   ',
        },
      ],
      'reasoning_text',
    )
    const reasoning = items.find((i) => i.type === 'reasoning') as { content: { text: string }[] }
    expect(reasoning.content[0]!.text.trim().length).toBeGreaterThan(0)
  })

  /**
   * 触发点必须留在 `toolCalls` 分支里：纯文本轮在落盘投影那侧本来就不带思考
   * （`runtime/transcript.ts`），扩到文本轮会跟投影形状打架。
   */
  test('没有工具调用的 assistant 轮不回传', () => {
    const items = buildInput(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '你好', reasoningContent: '打个招呼' },
      ],
      'reasoning_text',
    )
    expect(items.some((i) => i.type === 'reasoning')).toBe(false)
  })
})

describe('工具定义是扁平的', () => {
  const tools = [
    { name: 'b_tool', description: 'b', parameters: { type: 'object' } },
    { name: 'a_tool', description: 'a', parameters: { type: 'object' } },
  ]

  test('没有 chat 协议那层 function 包装', () => {
    const out = buildTools(tools)
    expect(out[0]).toEqual({
      type: 'function',
      name: 'a_tool',
      description: 'a',
      parameters: { type: 'object' },
    })
    expect('function' in out[0]!).toBe(false)
  })

  /** 工具渲染在前缀最前面，顺序一抖整段缓存失效。 */
  test('按名排序，顺序确定', () => {
    expect(buildTools(tools).map((t) => t.name)).toEqual(['a_tool', 'b_tool'])
  })
})

describe('用量口径', () => {
  const fresh = (): ProviderUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    source: 'estimated',
  })

  /**
   * Responses 的 `input_tokens` **含**缓存命中，Anthropic 的不含。
   * 不减的话缓存命中越多账单错得越离谱——这条实测在兼容适配器上踩过一次。
   */
  test('input_tokens 减去缓存命中，收敛到排他口径', () => {
    const u = fresh()
    applyUsage(u, {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens: 50,
    })
    expect(u.inputTokens).toBe(200)
    expect(u.cachedTokens).toBe(800)
  })

  test('没有缓存明细时 cachedTokens 是 null，不是 0', () => {
    const u = fresh()
    applyUsage(u, { input_tokens: 100, output_tokens: 10 })
    expect(u.cachedTokens).toBeNull()
    expect(u.inputTokens).toBe(100)
  })

  /**
   * 写入那项也含在 `input_tokens` 里。不减掉的话它会同时留在 inputTokens 并进
   * cacheWriteTokens，`computeCost` 按 1.0x 和 1.25x 各算一遍。
   */
  test('input_tokens 同时减去命中与新写入', () => {
    const u = fresh()
    applyUsage(u, {
      input_tokens: 2600,
      input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 400 },
      output_tokens: 50,
    })
    expect(u.cachedTokens).toBe(2000)
    expect(u.cacheWriteTokens).toBe(400)
    expect(u.inputTokens).toBe(200)
  })

  test('没有 cache_write_tokens 时是 null，且不影响 inputTokens', () => {
    const u = fresh()
    applyUsage(u, {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens: 10,
    })
    expect(u.cacheWriteTokens).toBeNull()
    expect(u.inputTokens).toBe(200)
  })

  test('推理 token 单独取', () => {
    const u = fresh()
    applyUsage(u, {
      input_tokens: 10,
      output_tokens: 90,
      output_tokens_details: { reasoning_tokens: 70 },
    })
    expect(u.reasoningTokens).toBe(70)
  })

  test('回报过就标 provider，不再当估算', () => {
    const u = fresh()
    applyUsage(u, { input_tokens: 1, output_tokens: 1 })
    expect(u.source).toBe('provider')
  })

  test('没有 usage 字段时保持原样', () => {
    const u = fresh()
    applyUsage(u, undefined)
    expect(u.source).toBe('estimated')
  })
})

describe('SSE 解析', () => {
  function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    })
  }

  async function collect(text: string) {
    const out: Record<string, unknown>[] = []
    for await (const e of readSse(streamOf(text))) out.push(e)
    return out
  }

  test('逐条解析 data 行', async () => {
    const events = await collect(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"好"}\n\n',
    )
    expect(events.map((e) => e.delta)).toEqual(['你', '好'])
  })

  test('[DONE] 与空行被跳过', async () => {
    expect(await collect('data: [DONE]\n\n\n')).toEqual([])
  })

  /** 心跳或半行不能把整轮 run 打断——代价完全不成比例。 */
  test('非 JSON 的行忽略而不是抛', async () => {
    const events = await collect('data: 不是json\n\ndata: {"type":"ok"}\n\n')
    expect(events).toEqual([{ type: 'ok' }])
  })

  test('跨 chunk 的半行能拼回来', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"a","de'))
        c.enqueue(new TextEncoder().encode('lta":"x"}\n\n'))
        c.close()
      },
    })
    const out: Record<string, unknown>[] = []
    for await (const e of readSse(stream)) out.push(e)
    expect(out).toEqual([{ type: 'a', delta: 'x' }])
  })
})

describe('装配', () => {
  test('factory 现在真的能造出 responses 适配器', async () => {
    const { buildAdapter } = await import('../factory.ts')
    const a = buildAdapter({ kind: 'openai_responses', apiKey: 'sk-x', model: 'gpt-5' })
    expect(a.kind).toBe('openai_responses')
  })

  /**
   * `transmits` 必须按 spec 的参数格式算，不能是类级常量，也不能只看档位表非空。
   *
   * `gpt-5` 不在目录里 → `thinking:'none'` + `effortLevels:[]` → 装配期把 reasoning
   * 整个省掉，请求里一个字节都没有。此处若声明成 true，`qy probe` 的探针会「通过」
   * （不是端点支持，是我们压根没发），`--save` 再把这份凭空的结论覆盖回目录。
   *
   * `claude-opus-5` 是另一头：`lookupModel` 的兜底只改写协议、保留能力约束，
   * 于是它带着五档 effort 落到 Responses 上——**但 `output_config.effort` 那套在这条
   * 协议上发不出去**，声明成会发同样是假通过。
   */
  test('按参数格式声明：发不出去的就不能声明成会发', async () => {
    const { buildAdapter } = await import('../factory.ts')
    const unknown = buildAdapter({ kind: 'openai_responses', apiKey: 'sk-x', model: 'gpt-5' })
    expect(unknown.transmits).toEqual({ effort: false })

    const rewritten = buildAdapter({
      kind: 'openai_responses',
      apiKey: 'sk-x',
      model: 'claude-opus-5',
    })
    expect(rewritten.transmits).toEqual({ effort: false })

    const native = buildAdapter({
      kind: 'openai_responses',
      apiKey: 'sk-x',
      model: 'gemini-3.7-flash',
    })
    expect(native.transmits).toEqual({ effort: true })
  })

  test('spec 未知时用保守默认值，不假装认识它', async () => {
    const { buildAdapter } = await import('../factory.ts')
    const a = buildAdapter({ kind: 'openai_responses', apiKey: 'sk-x', model: '没听说过' })
    expect(a.spec.id).toBe('没听说过')
    expect(a.spec.pricing.input).toBe(0)
  })

  test('lookupModel 对 responses 供应商同样给保守默认', () => {
    expect(lookupModel('x', 'openai_responses').thinking).toBe('none')
  })
})
