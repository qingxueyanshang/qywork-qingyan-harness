/**
 * 覆盖 `openai-compat.ts` 的 `buildReasoning`（实际发出去的思考控制字段）
 * 与 `createThinkingSplitter`（正文里的思考标签改判通道）。
 *
 * **必须看真实请求体**，不能只测那个纯函数：这条链路上一次出问题正是
 * 「目录里声明了档位、界面也画了控件、请求里一个字段都没有」——
 * 两头都对，中间那节把值丢了，而任何一端的单测都看不见。
 *
 * 所以这里起一个本机 server 当端点，把收到的 body 原样存下来。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { lookupModel, unknownModel } from '../catalog.ts'
import type { ProviderProfile, ToolSchema, WireMessage } from '../types.ts'
import {
  createThinkingSplitter,
  normalizeBaseUrl,
  OpenAICompatAdapter,
  strictify,
} from './openai-compat.ts'

const bodies: Record<string, unknown>[] = []
const requestHeaders: Headers[] = []
let server: ReturnType<typeof Bun.serve>
let base = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requestHeaders.push(new Headers(req.headers))
      bodies.push((await req.json()) as Record<string, unknown>)
      // 最小可解析的 SSE：一个 delta + 一个终止。适配器只要能读完就行。
      const body =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  base = `http://127.0.0.1:${server.port}/v1`
})

afterAll(() => server.stop(true))

async function send(
  model: string,
  effort?: string,
  tools: ToolSchema[] = [],
  messages: WireMessage[] = [{ role: 'user', content: '嗨' }],
): Promise<Record<string, unknown>> {
  bodies.length = 0
  requestHeaders.length = 0
  const profile: ProviderProfile = {
    kind: 'openai_chat_completions',
    apiKey: 'sk-x',
    model,
    baseUrl: base,
  }
  const adapter = new OpenAICompatAdapter(profile, lookupModel(model, 'openai_chat_completions'))
  for await (const _ of adapter.stream({
    model,
    system: [],
    messages,
    tools,
    maxOutputTokens: 64,
    ...(effort ? { effort: effort as never } : {}),
    signal: new AbortController().signal,
  })) {
    // 读完即可，产出不关心。
  }
  return bodies[0]!
}

/** 申报值和规格上限都能单独给的发送口。上面那个 `send` 固定 64，测不到不申报那一档。 */
async function sendWithCap(
  model: string,
  requested: number | null,
  spec = lookupModel(model, 'openai_chat_completions'),
): Promise<Record<string, unknown>> {
  bodies.length = 0
  const adapter = new OpenAICompatAdapter(
    { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
    spec,
  )
  for await (const _ of adapter.stream({
    model,
    system: [],
    messages: [{ role: 'user', content: '嗨' }],
    tools: [],
    maxOutputTokens: requested,
    signal: new AbortController().signal,
  })) {
    // 读完即可。
  }
  return bodies[0]!
}

/*
 * ── 输出上限：没测过就不申报 ──
 *
 * 原始失败形状：未收录模型被灌一个编出来的 8192，长回答在那里静默截断，
 * 用户只看到一个 `max_tokens` 停止原因，而没有任何地方说过这个数由客户端填入。
 */
describe('输出上限：没测过就整个字段不发', () => {
  test('未收录模型不申报，body 里没有 max_tokens', async () => {
    const spec = unknownModel('中转站上的某个模型', 'openai_chat_completions')
    const body = await sendWithCap('中转站上的某个模型', null, spec)
    expect('max_tokens' in body).toBe(false)
  })

  test('收录的模型照常申报，且按规格上限钳住', async () => {
    const body = await sendWithCap('deepseek-v4-flash', 999_999_999)
    expect(body.max_tokens).toBe(
      lookupModel('deepseek-v4-flash', 'openai_chat_completions').maxOutputTokens,
    )
  })

  /** 探针那一档：规格没测过，但调用方明确给了数——照发，否则每次探测都变成一整篇回答。 */
  test('规格没测过而调用方给了数：照发那个数', async () => {
    const spec = unknownModel('中转站上的某个模型', 'openai_chat_completions')
    const body = await sendWithCap('中转站上的某个模型', 16, spec)
    expect(body.max_tokens).toBe(16)
  })
})

/*
 * ── 工具结果图片的 wire 形状 ──
 *
 * 官方文档把 tool 消息的 content 写成字符串；带图数组是实测立住的形状
 * （依据见 `openai-compat.ts` 的 `buildMessages` 注释）。这里锁请求体：
 * 图片块必须原样落进 tool 消息，不得被压成字符串或静默丢弃。
 */
describe('工具结果带图片', () => {
  test('tool 消息发成 text + image_url 数组，call id 与块顺序保留', async () => {
    const body = await send(
      'deepseek-v4-flash',
      undefined,
      [],
      [
        { role: 'user', content: '看图' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c_img', name: 'read_file', arguments: { path: 'a.png' } }],
        },
        {
          role: 'tool',
          toolCallId: 'c_img',
          content: [
            { type: 'text', text: '{"call_id":"c_img","status":"success"}' },
            { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'QUJD' } },
          ],
        },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    const tool = messages.find((m) => m.role === 'tool')
    expect(tool).toBeDefined()
    expect(tool!.tool_call_id).toBe('c_img')
    expect(tool!.content).toEqual([
      { type: 'text', text: '{"call_id":"c_img","status":"success"}' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ])
  })

  test('纯文本工具结果仍是字符串，不改发数组', async () => {
    const body = await send(
      'deepseek-v4-flash',
      undefined,
      [],
      [
        { role: 'user', content: '看' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c_t', name: 'x', arguments: {} }] },
        { role: 'tool', toolCallId: 'c_t', content: '读到了' },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages.find((m) => m.role === 'tool')!.content).toBe('读到了')
  })
})

describe('DeepSeek 要两个字段一起发', () => {
  /**
   * 复现原始失败形状：只发 `reasoning_effort` 时实测「每一档 reasoning_tokens
   * 都一样」，据此会把 DeepSeek 记成「不支持 effort」。现象没错，归因错了——
   * `thinking` 开关没开，思考没启动。
   */
  test('thinking 开关和档位同时出现在请求体里', async () => {
    const body = await send('deepseek-v4-flash', 'max')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })

  test('没指定档位就一个字段都不发', async () => {
    const body = await send('deepseek-v4-flash')
    expect('thinking' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
  })
})

describe('OpenAI 那套只发 reasoning_effort', () => {
  test('不带 DeepSeek 的 thinking 开关', async () => {
    const body = await send('gpt-5.6-sol', 'high')
    expect(body.reasoning_effort).toBe('high')
    expect('thinking' in body).toBe(false)
  })

  test('Gemini 同样走这条', async () => {
    expect((await send('gemini-3.1-pro-preview', 'low')).reasoning_effort).toBe('low')
  })
})

describe('逐模型的历史思考协议', () => {
  const history: WireMessage[] = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答', reasoningContent: '完整思考' },
    { role: 'user', content: '继续' },
  ]

  test('Qwen3.8 始终声明保留思考，并发官方档位', async () => {
    const bare = await send('qwen3.8-flash')
    expect(bare.preserve_thinking).toBe(true)
    expect('reasoning_effort' in bare).toBe(false)

    const xhigh = await send('qwen3.8-flash', 'xhigh')
    expect(xhigh.preserve_thinking).toBe(true)
    expect(xhigh.reasoning_effort).toBe('xhigh')
  })

  test('Qwen3.8 的纯文本历史原样回放 reasoning_content', async () => {
    const body = await send('qwen3.8-flash', 'low', [], history)
    expect((body.messages as Record<string, unknown>[])[1]?.reasoning_content).toBe('完整思考')
  })

  test('GLM-5.3 Flash 始终保留思考，并可单独选档', async () => {
    const bare = await send('glm-5.3-flash')
    expect(bare.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect('reasoning_effort' in bare).toBe(false)

    const low = await send('glm-5.3-flash', 'low', [], history)
    expect(low.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(low.reasoning_effort).toBe('low')
    expect((low.messages as Record<string, unknown>[])[1]?.reasoning_content).toBe('完整思考')
  })

  test('未特调模型的请求形状不变', async () => {
    const body = await send('gpt-5.6-sol', 'high', [], history)
    expect('preserve_thinking' in body).toBe(false)
    expect(body.thinking).toBeUndefined()
    expect((body.messages as Record<string, unknown>[])[1]?.reasoning_content).toBeUndefined()
  })
})

/**
 * 档位不在这个模型的档位面里，一个字节都不发。
 *
 * 另两条协议各有各的写法：`openai-responses` 是
 * `effortLevels.includes(req.effort) ? … : undefined`，`anthropic` 会降到最高可用档。
 * 这条别只判「有没有给」就把 `effort` 原样发出去。
 *
 * 只调一家模型时档位面一致，用不上这道闸；本仓不是：档位选定值挂在
 * 「接口 × 模型」那一格，同一个模型换条协议档位面就变，Agent Team 的角色还
 * 各带各的模型。越界值到这里不拦，就是发给 provider 的一个 400。
 */
describe('越界的档位不发', () => {
  /** DeepSeek 只有 high/max。`xhigh` 是 Claude 那边的档，它在这里不存在。 */
  test('DeepSeek 收不到 xhigh', async () => {
    const body = await send('deepseek-v4-flash', 'xhigh')
    expect('thinking' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
  })

  /** Gemini 只有 low/medium/high，`max` 同样越界。 */
  test('Gemini 收不到 max', async () => {
    expect('reasoning_effort' in (await send('gemini-3.1-pro', 'max'))).toBe(false)
  })

  /** 档位面里的照常发——这道闸只拦越界的，不是把 effort 整个关掉。 */
  test('档位面里的照常发', async () => {
    const body = await send('deepseek-v4-flash', 'high')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })
})

describe('不该发的时候一个字节都不多发', () => {
  /**
   * 自建端点 / 中转站的模型目录里没有，`unknownModel()` 的 `thinking` 是 `'none'`。
   * 这条锁住的是：把兼容协议从「一律不发」改成「按模型发」之后，
   * **那些端点不会突然开始收到它没见过的键**——那会表现成「昨天正常，今天 400」。
   */
  test('未收录的模型不发思考字段', async () => {
    const body = await send('某个中转站上的模型', 'max')
    expect('reasoning_effort' in body).toBe(false)
    expect('thinking' in body).toBe(false)
  })

  /** 有默认思考但没有命名 effort 档的模型，不可把别家的档位原样发过去。 */
  test('没有命名档位的模型不发 reasoning_effort', async () => {
    const body = await send('qwen3.7-max', 'high')
    expect('reasoning_effort' in body).toBe(false)
  })

  /**
   * 经中转站以兼容协议调 Claude：`lookupModel` 的兜底会保留 Claude 的能力约束、
   * 只改写 provider，因此 `effortLevels` 还是那五档。但 Anthropic 的
   * `output_config.effort` 在这条协议上发不出去，所以**什么都不该发**。
   */
  test('中转的 Claude 不发 Anthropic 的思考字段', async () => {
    const body = await send('claude-opus-5', 'high')
    expect('reasoning_effort' in body).toBe(false)
    expect('thinking' in body).toBe(false)
    expect('output_config' in body).toBe(false)
  })
})

/**
 * Base URL 归一。
 *
 * 复现过的故障：用户填 `https://中转站/`（少了 `/v1`），SDK 因此请求
 * `https://中转站/chat/completions`，中转站对这种错误路径回 **200 + 一个 HTML 首页**。
 * 解析器读不出任何 chunk 也不报错，那一轮 0 token、0 步骤、`completed`
 * ——界面上是「消息发出去了，什么也没发生」。
 */
describe('Base URL 归一', () => {
  test('少了 /v1 就补上', () => {
    expect(normalizeBaseUrl('https://direct.example.xyz/')).toBe('https://direct.example.xyz/v1')
    expect(normalizeBaseUrl('https://direct.example.xyz')).toBe('https://direct.example.xyz/v1')
  })

  test('已经带了版本段就原样，不重复追加 /v1', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    )
    expect(normalizeBaseUrl('https://relay.example/v27/')).toBe('https://relay.example/v27')
  })

  test('空值走官方根', () => {
    expect(normalizeBaseUrl(undefined)).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('   ')).toBe('https://api.openai.com/v1')
  })
})

describe('无名工具调用', () => {
  /**
   * 复现的是原始失败形状：中转站把工具名那一片丢了，旧代码 `continue` 掉整条调用，
   * 因此 provider 报 `tool_calls` 而解析结果为零——run 记成正常完成、账本无痕。
   *
   * 这里断言的是**显式失败**：不允许出现「静默少一条调用」这种中间状态。
   */
  test('名字分片没到齐就报错，不静默丢弃', async () => {
    const drop = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          // 只有 id 与参数，从头到尾没有 function.name。
          [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
              '"function":{"arguments":"{}"}}]},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    try {
      const adapter = new OpenAICompatAdapter(
        {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          model: 'deepseek-v4-flash',
          baseUrl: `http://127.0.0.1:${drop.port}/v1`,
        },
        lookupModel('deepseek-v4-flash', 'openai_chat_completions'),
      )
      const run = async () => {
        for await (const _ of adapter.stream({
          model: 'deepseek-v4-flash',
          system: [],
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          maxOutputTokens: 64,
        })) {
          // 只关心它抛不抛，事件本身不看。
        }
      }
      expect(run()).rejects.toThrow(/没有名字的工具调用/)
    } finally {
      drop.stop(true)
    }
  })
})

describe('缓存路由亲和键', () => {
  /**
   * 复现的是一次真账：同一个中转站的 grok，前缀逐字节稳定（字节级测试证过），
   * 命中却在 192 与 16576 之间跳，随后整段会话连 `cached_tokens` 字段都不回。
   *
   * 成因是中转站在多个上游节点之间轮询，而隐式前缀缓存是按分片存的——
   * 不带 `prompt_cache_key` 就是每次随机落一个分片。这个字段本仓早就有、
   * `openai-responses` 也一直在发，只有这条路径漏了，而各家中转全走这条。
   *
   * 断言的是**上线字节**：装配层填了值不算数，要它真的出现在请求体里。
   */
  test('cacheKey 落成请求体里的 prompt_cache_key', async () => {
    bodies.length = 0
    requestHeaders.length = 0
    const adapter = new OpenAICompatAdapter(
      {
        kind: 'openai_chat_completions',
        apiKey: 'sk-x',
        model: 'deepseek-v4-flash',
        baseUrl: base,
      },
      lookupModel('deepseek-v4-flash', 'openai_chat_completions'),
    )
    for await (const _ of adapter.stream({
      model: 'deepseek-v4-flash',
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      cacheKey: 'cv_0mt0x92q10000mx0dff',
      signal: new AbortController().signal,
    })) {
      // 只看请求体
    }
    expect(bodies[0]!.prompt_cache_key).toBe('cv_0mt0x92q10000mx0dff')
    expect(requestHeaders[0]?.get('x-grok-conv-id')).toBeNull()
  })

  /** xAI 把同一个亲和键放在 Chat Completions 请求头；body 字段只属于 Responses。 */
  test('Grok cacheKey 只落成 x-grok-conv-id 请求头', async () => {
    bodies.length = 0
    requestHeaders.length = 0
    const adapter = new OpenAICompatAdapter(
      {
        kind: 'openai_chat_completions',
        apiKey: 'sk-x',
        model: 'grok-4.6',
        baseUrl: base,
      },
      lookupModel('grok-4.6', 'openai_chat_completions'),
    )
    for await (const _ of adapter.stream({
      model: 'grok-4.6',
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      cacheKey: 'cv_grok_1',
      signal: new AbortController().signal,
    })) {
      // 只看真实 HTTP 请求
    }
    expect(requestHeaders[0]?.get('x-grok-conv-id')).toBe('cv_grok_1')
    expect('prompt_cache_key' in bodies[0]!).toBe(false)
  })

  /** 没有键就一个字节都不发——自建端点不该因为这个开始收到它不认识的字段。 */
  test('没有 cacheKey 时不出现这个字段', async () => {
    const body = await send('deepseek-v4-flash')
    expect('prompt_cache_key' in body).toBe(false)
  })

  test('Grok 没有 cacheKey 时也不编请求头', async () => {
    const body = await send('grok-4.6')
    expect('prompt_cache_key' in body).toBe(false)
    expect(requestHeaders[0]?.get('x-grok-conv-id')).toBeNull()
  })

  /**
   * **发不发由目录里那条模型说了算，不是协议说了算。**
   *
   * 未收录的模型（自建端点、中转站上那些没人探过的名字）落在 `cacheRouting: 'none'`
   * ——那是「没测过」不是「不支持」。往那些端点乱发未知字段，失败形状是
   * 「昨天正常，今天每条请求都 400」。要开就在模型库那一格改，或 `qy probe --save`。
   */
  test('未收录的模型不发亲和键', async () => {
    bodies.length = 0
    const model = '某个中转站上的模型'
    const spec = lookupModel(model, 'openai_chat_completions')
    expect(spec.cacheRouting).toBe('none')
    const adapter = new OpenAICompatAdapter(
      { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
      spec,
    )
    for await (const _ of adapter.stream({
      model,
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      cacheKey: 'cv_x',
      signal: new AbortController().signal,
    })) {
      // 只看请求体
    }
    expect('prompt_cache_key' in bodies[0]!).toBe(false)
  })

  test('Qwen3.8 与 GLM-5.3 走各自的隐式缓存协议，不混入 OpenAI 路由键', async () => {
    for (const model of ['qwen3.8-flash', 'glm-5.3-flash']) {
      bodies.length = 0
      const spec = lookupModel(model, 'openai_chat_completions')
      expect(spec.cacheRouting).toBe('none')
      const adapter = new OpenAICompatAdapter(
        { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
        spec,
      )
      for await (const _ of adapter.stream({
        model,
        system: [],
        messages: [{ role: 'user', content: '嗨' }],
        tools: [],
        maxOutputTokens: 64,
        cacheKey: 'cv_should_not_cross_protocols',
        signal: new AbortController().signal,
      })) {
        // 只看请求体。
      }
      expect('prompt_cache_key' in bodies[0]!).toBe(false)
    }
  })
})

describe('正文里的思考标签', () => {
  /** SSE 的事件分隔符是两个换行。写成常量而不是字面量：源码里两个空行看不出是它。 */
  const SEP = String.fromCharCode(10, 10)

  /** 把一串分片喂进去，收敛成两个通道各自的全文。 */
  function feed(chunks: string[]): { thinking: string; text: string } {
    const sp = createThinkingSplitter()
    let thinking = ''
    let text = ''
    for (const c of chunks) {
      const r = sp.push(c)
      thinking += r.thinking
      text += r.text
    }
    text += sp.flush()
    return { thinking, text }
  }

  /**
   * 复现原始形状：会话 `cv_0mt10yhy20000vace5y` 的 step 32、43、57。
   * 中转站把一部分推理摘要放进了 `content` 并自己加了标签。
   */
  test('开头的成对标签整块判给思考，后面的正文照常是正文', () => {
    expect(feed(['<thinking>**Updating inspection checklist**</thinking>'])).toEqual({
      thinking: '**Updating inspection checklist**',
      text: '',
    })
    expect(feed(['<thinking>**Finalizing summary**</thinking>项目检查已经完成'])).toEqual({
      thinking: '**Finalizing summary**',
      text: '项目检查已经完成',
    })
  })

  /** 标签被切在任意位置都要认得——SSE 分片边界与内容无关。 */
  test('标签跨分片切开仍然认得', () => {
    expect(feed(['<thin', 'king>', '想', '一', '</think', 'ing>说'])).toEqual({
      thinking: '想一',
      text: '说',
    })
  })

  /**
   * 这条是这个函数最要紧的边界：**收宽一点就会吞掉模型正当输出的字面量**。
   * 只认第 0 字符起的那一个，之后出现多少次都是正文。
   */
  test('不在开头的同样字符串留在正文里', () => {
    expect(feed(['这段代码会输出 <thinking>x</thinking> 标签'])).toEqual({
      thinking: '',
      text: '这段代码会输出 <thinking>x</thinking> 标签',
    })
    // 认过一次之后就不再认，第二个块是正文。
    expect(feed(['<thinking>一</thinking>正文 <thinking>二</thinking>'])).toEqual({
      thinking: '一',
      text: '正文 <thinking>二</thinking>',
    })
  })

  /** 判错的最坏结果只能是「显示在错的区」，不能是内容消失。 */
  test('流在闭合之前结束，攒着的连同开标签原样退回正文', () => {
    expect(feed(['<thinking>没等到闭合就断了'])).toEqual({
      thinking: '',
      text: '<thinking>没等到闭合就断了',
    })
    expect(feed(['<thin'])).toEqual({ thinking: '', text: '<thin' })
  })

  /** 接线也要测：纯函数对了但没挂上去，表现和没修一样。 */
  test('适配器真的按两个通道分发', async () => {
    const sse = (payload: string) => `data: ${payload}${SEP}`
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          sse('{"choices":[{"delta":{"content":"<thinking>想"},"finish_reason":null}]}') +
            sse('{"choices":[{"delta":{"content":"法</thinking>答案"},"finish_reason":null}]}') +
            sse('{"choices":[{"delta":{},"finish_reason":"stop"}]}') +
            sse('[DONE]'),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    try {
      const model = 'gpt-5.6-terra'
      const adapter = new OpenAICompatAdapter(
        {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          model,
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        },
        lookupModel(model, 'openai_chat_completions'),
      )
      let thinking = ''
      let text = ''
      for await (const ev of adapter.stream({
        model,
        system: [],
        messages: [{ role: 'user', content: '嗨' }],
        tools: [],
        maxOutputTokens: 64,
        signal: new AbortController().signal,
      })) {
        if (ev.type === 'thinking_delta') thinking += ev.delta
        if (ev.type === 'text_delta') text += ev.delta
      }
      expect(thinking).toBe('想法')
      expect(text).toBe('答案')
    } finally {
      server.stop(true)
    }
  })
})

describe('strict 工具定义', () => {
  const readFile: ToolSchema = {
    name: 'read_file',
    description: '读文件',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径' },
        offset: { type: 'integer', description: '起始行号（1 起），默认 1' },
        limit: { type: 'integer', description: '最多读取行数' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  }

  /**
   * 复现原始失败形状：非 strict 下模型把 `offset` 回成字符串
   * （实测 grok-4.6 三次采样三次都是 `"1.0"`，其中一次还把工具模板漏进了值里），
   * `read_file` 因此读到 0 行还报 success。
   *
   * strict 的两条硬要求少一条就等于没开——**只加标志位而留着可选属性时端点静默降级**，
   * 所以这里两条都断言：可选属性进 `required`，类型里补 `null`。
   */
  test('可选属性进 required，类型里补 null', () => {
    const out = strictify(readFile.parameters)
    expect(out.required).toEqual(['path', 'offset', 'limit'])
    expect(out.additionalProperties).toBe(false)
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.path?.type).toBe('string')
    expect(props.offset?.type).toEqual(['integer', 'null'])
    expect(props.limit?.type).toEqual(['integer', 'null'])
    // 描述原样留着——模型靠它知道这个参数是干什么的。
    expect(props.offset?.description).toBe('起始行号（1 起），默认 1')
  })

  test('数组的 items 也要转，嵌套对象同样补齐 required', () => {
    const out = strictify({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, note: { type: 'string' } },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    })
    const items = (out.properties as Record<string, Record<string, unknown>>).todos
      ?.items as Record<string, unknown>
    expect(items.required).toEqual(['content', 'note'])
    expect(items.additionalProperties).toBe(false)
    const inner = items.properties as Record<string, Record<string, unknown>>
    expect(inner.note?.type).toEqual(['string', 'null'])
  })

  test('同一份输入给出同一份输出——前缀缓存的前提', () => {
    expect(JSON.stringify(strictify(readFile.parameters))).toBe(
      JSON.stringify(strictify(readFile.parameters)),
    )
  })

  test('请求体里带 strict，且发的是重排后的 schema', async () => {
    const body = await send('deepseek-v4-flash', undefined, [readFile])
    const tool = (body.tools as { function: Record<string, unknown> }[])[0]!.function
    expect(tool.strict).toBe(true)
    expect((tool.parameters as Record<string, unknown>).required).toEqual([
      'path',
      'offset',
      'limit',
    ])
  })

  /**
   * GLM-5.3 Flash 与 Grok 4.6 的真实失败形状相同：适配器把可选 `probe_url` 改成
   * required + nullable 后，模型被迫给它编值。两家官方都公开标准 JSON Schema 的
   * required/optional 形状，所以只给映射声明 native 的模型保留注册表原样。
   */
  test('GLM 与 Grok 不套 OpenAI strict，可选属性仍可省略', async () => {
    for (const model of ['glm-5.3', 'glm-5.3-flash', 'grok-4.5', 'grok-4.6']) {
      const body = await send(model, undefined, [readFile])
      const tool = (body.tools as { function: Record<string, unknown> }[])[0]!.function
      expect(tool.strict).toBeUndefined()
      expect((tool.parameters as Record<string, unknown>).required).toEqual(['path'])
      const props = (tool.parameters as { properties: Record<string, Record<string, unknown>> })
        .properties
      expect(props.offset?.type).toBe('integer')
      expect(props.limit?.type).toBe('integer')
    }
  })

  /**
   * 第三方 schema 原样发，一个字节都不改。
   *
   * 改动一个第三方 schema，模型按改过的形状传参、server 按原形状校验，
   * 两边对不上；而它是不是恰好合格并不构成改它的理由——判据是谁写的。
   */
  test('strict 为假的工具原样发，不带标志位也不重排', async () => {
    const third: ToolSchema = {
      name: 'mcp_thing',
      description: '第三方',
      parameters: { type: 'object', properties: { a: { type: 'string' } }, required: [] },
      strict: false,
    }
    const body = await send('grok-4.6', undefined, [third])
    const tool = (body.tools as { function: Record<string, unknown> }[])[0]!.function
    expect('strict' in tool).toBe(false)
    expect(tool.parameters).toEqual(third.parameters)
  })
})

describe('运行上下文的上线形状', () => {
  test('上下文并入所属真实用户，不增加 system 或 user 轮次', async () => {
    bodies.length = 0
    const model = 'deepseek-v4-flash'
    const adapter = new OpenAICompatAdapter(
      { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
      lookupModel(model, 'openai_chat_completions'),
    )
    for await (const _ of adapter.stream({
      model,
      system: [{ text: '冻结前缀', cacheBreakpoint: true }],
      messages: [
        { role: 'context', content: '## 当前待办清单\n1. [进行中] 建模' },
        { role: 'user', content: '嗨' },
      ],
      tools: [],
      maxOutputTokens: 64,
      signal: new AbortController().signal,
    })) {
      // 只看请求体
    }
    const messages = bodies[0]!.messages as { role: string; content: string }[]
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(messages[0]).toEqual({ role: 'system', content: '冻结前缀' })
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: '## 当前待办清单\n1. [进行中] 建模\n\n嗨',
    })
    expect(messages).toHaveLength(2)
  })
})
