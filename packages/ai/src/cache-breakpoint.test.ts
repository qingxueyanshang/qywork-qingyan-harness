/**
 * 消息历史的缓存断点。
 *
 * 覆盖范围：`providers/anthropic.ts` 的 `buildMessages` 断点落点，
 * 以及 `WireMessage.cacheBreakpoint` 这条协议差异在兼容路径上的**惰性**。
 *
 * ## 这一组要挡的是什么
 *
 * 在此之前 qywork 只有一个断点、打在系统提示词末尾，所以缓存住的只有
 * 工具 schema + 系统提示词（约 1.8k）——**消息历史每一轮都在全价重付**。
 * 而这条只对 Anthropic 成立：兼容协议的前缀缓存由服务端自动做
 * （DeepSeek 的 `prompt_cache_hit_tokens` 就是它），请求体里根本没有这个位置。
 *
 * 所以两件事都要锁住：Anthropic 上断点**真的落到线上**，
 * 兼容协议上这个字段**一个字节都不改变请求**。
 */

import { describe, expect, test } from 'bun:test'
import { buildAdapter } from './factory.ts'
import type { ChatRequest, WireMessage } from './types.ts'

const profile = { kind: 'anthropic_messages' as const, apiKey: 'sk-x', model: 'claude-opus-5' }

/** 够长的一段正文——短于 `minCacheablePrefix` 的断点不生效，那是另一条断言。 */
const long = (n: number) => 'x'.repeat(n)

function req(messages: WireMessage[]): ChatRequest {
  return {
    model: 'claude-opus-5',
    system: [{ text: '系统提示词', cacheBreakpoint: true }],
    messages,
    tools: [],
    maxOutputTokens: 1024,
  }
}

/** 从适配器内部取出即将上线的 body。`buildBody` 是私有的，走同一条装配路径。 */
function bodyOf(r: ChatRequest): Record<string, any> {
  const adapter = buildAdapter(profile) as unknown as {
    buildBody(req: ChatRequest): Record<string, any>
  }
  return adapter.buildBody(r)
}

function cacheMarks(body: Record<string, any>): number[] {
  const out: number[] = []
  body.messages.forEach((m: Record<string, any>, i: number) => {
    if (!Array.isArray(m.content)) return
    if (m.content.some((b: Record<string, any>) => b.cache_control)) out.push(i)
  })
  return out
}

describe('Anthropic 缓存断点', () => {
  test('标了断点的那条消息落上 cache_control', () => {
    const body = bodyOf(
      req([
        { role: 'user', content: long(8000), cacheBreakpoint: true },
        { role: 'assistant', content: '好的' },
      ]),
    )
    expect(cacheMarks(body)).toEqual([0])
  })

  /**
   * 短于这条模型的最短可缓存前缀时**不落断点**。
   *
   * 落了不会报错，只是不生效——但仍会记一次缓存写入，账面多一笔、实际一点没省。
   */
  test('前缀太短时不落断点', () => {
    const body = bodyOf(req([{ role: 'user', content: '短', cacheBreakpoint: true }]))
    expect(cacheMarks(body)).toEqual([])
  })

  /** 历史末尾 + 整串末尾各一个：跨轮命中靠前者，run 内逐步命中靠后者。 */
  test('两个断点可以共存', () => {
    const body = bodyOf(
      req([
        { role: 'user', content: long(8000), cacheBreakpoint: true },
        { role: 'assistant', content: long(8000) },
        { role: 'user', content: long(8000), cacheBreakpoint: true },
      ]),
    )
    expect(cacheMarks(body)).toEqual([0, 2])
  })

  /**
   * 工具结果被合并进**一条** user 消息，所以输入下标和输出下标不是一一对应的。
   * 断点必须落在合并后的那条上，落错位置就是缓存边界错位——
   * 而那**功能上完全无感**，唯一症状是命中率崩掉。
   */
  test('工具结果合并之后，断点落在合并后的那条上', () => {
    const body = bodyOf(
      req([
        {
          role: 'assistant',
          content: long(4000),
          toolCalls: [{ id: 'A', name: 't', arguments: {} }],
        },
        { role: 'tool', toolCallId: 'A', content: long(4000) },
        { role: 'tool', toolCallId: 'B', content: long(4000), cacheBreakpoint: true },
      ]),
    )
    // assistant 一条 + 合并后的 tool 结果一条 = 两条；断点在第二条。
    expect(body.messages).toHaveLength(2)
    expect(cacheMarks(body)).toEqual([1])
  })

  test('字符串正文会被摊成内容块才挂 cache_control', () => {
    const body = bodyOf(req([{ role: 'user', content: long(8000), cacheBreakpoint: true }]))
    expect(Array.isArray(body.messages[0].content)).toBe(true)
  })
})

/**
 * 尾区注记是**故意**压在历史之后的 `role:'system'` 消息——挪进顶层 `system`
 * 等于挪进冻结前缀，改一条记忆就把整段缓存打掉。位置是对的，问题在于
 * **会话中间的 system 轮是分模型的能力**：Opus 4.8/5 这一档收，其余回 400
 * `role 'system' is not supported on this model`——那不是格式错，是整条会话
 * 在那个模型上发不出去。
 */
describe('尾区注记按模型能力落地', () => {
  const bodyFor = (model: string, messages: WireMessage[]) => {
    const adapter = buildAdapter({
      kind: 'anthropic_messages',
      apiKey: 'sk-x',
      model,
    }) as unknown as {
      buildBody(req: ChatRequest): Record<string, any>
    }
    return adapter.buildBody({ ...req(messages), model })
  }

  test('收 system 轮的模型：原样发出去，不换角色', () => {
    const body = bodyFor('claude-opus-5', [
      { role: 'user', content: '帮我改一下' },
      { role: 'system', content: '当前日期：2026-08-16' },
    ])
    expect(body.messages.map((m: Record<string, unknown>) => m.role)).toEqual(['user', 'system'])
    expect(body.messages[1].content).toBe('当前日期：2026-08-16')
  })

  /**
   * 不收的那些落成 user 轮里的 `<system-reminder>`：位置不变、缓存前缀不变，
   * 只是换了个承载角色。
   */
  test('不收 system 轮的模型：换成 user 轮里的 system-reminder', () => {
    const body = bodyFor('claude-sonnet-5', [
      { role: 'user', content: '帮我改一下' },
      { role: 'system', content: '当前日期：2026-08-16' },
    ])
    expect(body.messages.map((m: Record<string, unknown>) => m.role)).toEqual(['user', 'user'])
    expect(body.messages[1].content[0].text).toBe(
      '<system-reminder>\n当前日期：2026-08-16\n</system-reminder>',
    )
  })

  /**
   * **绝不并进前一条。** 前一条通常是历史的末尾，缓存断点之二正落在那儿——
   * 并进去的话 `cache_control` 会挂到跨轮必变的注记上，那个断点每轮失配。
   */
  test.each(['claude-opus-5', 'claude-sonnet-5'])('%s 上注记自成一条，不并进历史末尾', (model) => {
    const body = bodyFor(model, [
      { role: 'user', content: long(8000), cacheBreakpoint: true },
      { role: 'system', content: '工作区：/tmp/ws' },
    ])
    expect(body.messages).toHaveLength(2)
    // 断点仍然落在历史那一条上，不是注记那一条。
    expect(cacheMarks(body)).toEqual([0])
    expect(JSON.stringify(body.messages)).toContain('工作区：/tmp/ws')
  })

  /** 空注记不该在历史里留一条空消息，两条路都是。 */
  test.each(['claude-opus-5', 'claude-sonnet-5'])('%s 上空注记整条丢掉', (model) => {
    const body = bodyFor(model, [
      { role: 'assistant', content: '好的' },
      { role: 'system', content: '   ' },
    ])
    expect(body.messages).toHaveLength(1)
  })
})

describe('兼容协议上这个字段是惰性的', () => {
  /**
   * **给 DeepSeek 打断点不能有任何副作用。** 它的前缀缓存由服务端自动做，
   * 请求体里没有 `cache_control` 这个位置——标注在这条路上必须一个字节都不改。
   */
  test('标与不标产出完全相同的请求体', () => {
    const compat = {
      kind: 'openai_chat_completions' as const,
      apiKey: 'sk-x',
      model: 'deepseek-v4-flash',
    }
    const adapter = buildAdapter(compat) as unknown as {
      buildBody(req: ChatRequest): Record<string, unknown>
    }
    const base: ChatRequest = {
      model: 'deepseek-v4-flash',
      system: [{ text: '系统提示词' }],
      messages: [{ role: 'user', content: long(8000) }],
      tools: [],
      maxOutputTokens: 1024,
    }
    const marked: ChatRequest = {
      ...base,
      messages: [{ role: 'user', content: long(8000), cacheBreakpoint: true }],
    }
    expect(JSON.stringify(adapter.buildBody(marked))).toBe(JSON.stringify(adapter.buildBody(base)))
  })
})
