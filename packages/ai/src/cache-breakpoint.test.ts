/**
 * 消息历史的缓存断点。
 *
 * 覆盖范围：`providers/anthropic.ts` 的 `buildMessages` 断点位置，
 * 以及 `WireMessage.cacheBreakpoint` 这一协议差异在兼容路径上**不产生作用**。
 *
 * **本组测试防止的问题。** 只在系统提示词末尾设一个断点时，缓存只覆盖
 * 工具 schema + 系统提示词（约 1.8k），**消息历史每一轮都按全价重复计费**。
 * 该问题只在 Anthropic 上成立：兼容协议的前缀缓存由服务端自动完成
 * （DeepSeek 的 `prompt_cache_hit_tokens` 即为此机制），请求体中没有断点字段。
 *
 * 因此须同时锁定两点：Anthropic 上断点**实际发送到线上**，
 * 兼容协议上该字段**不改变请求的任何字节**。
 */

import { describe, expect, test } from 'bun:test'
import { buildAdapter } from './factory.ts'
import type { AnthropicOutMessage } from './providers/anthropic.ts'
import { STREAM_IDLE_TIMEOUT_MS } from './transport.ts'
import type { ChatRequest, WireMessage } from './types.ts'

const profile = { kind: 'anthropic_messages' as const, apiKey: 'sk-x', model: 'claude-opus-5' }

/** 足够长的正文：短于 `minCacheablePrefix` 时断点不生效，该情形由另一条断言覆盖。 */
const long = (n: number) => 'x'.repeat(n)

function req(messages: WireMessage[]): ChatRequest {
  return {
    model: 'claude-opus-5',
    system: [{ text: '系统提示词', cacheBreakpoint: true }],
    messages,
    tools: [],
    maxOutputTokens: 1024,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  }
}

/**
 * 从适配器内部取出即将发送的 body。`buildBody` 是私有方法，与发送使用同一条装配路径。
 *
 * 只声明本测试实际读取的字段（`messages`），其元素类型直接取适配器的
 * `AnthropicOutMessage`：本文件断言的正是该协议的装配结果，另行定义形状时，
 * 装配代码修改字段名后本测试不会失败。
 */
type BodyShape = { messages: AnthropicOutMessage[] }

function bodyOf(r: ChatRequest): BodyShape {
  const adapter = buildAdapter(profile) as unknown as {
    buildBody(req: ChatRequest): BodyShape
  }
  return adapter.buildBody(r)
}

function cacheMarks(body: BodyShape): number[] {
  const out: number[] = []
  body.messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return
    if (m.content.some((b) => b.cache_control)) out.push(i)
  })
  return out
}

describe('Anthropic 缓存断点', () => {
  test('标记断点的消息带有 cache_control', () => {
    const body = bodyOf(
      req([
        { role: 'user', content: long(8000), cacheBreakpoint: true },
        { role: 'assistant', content: '好的' },
      ]),
    )
    expect(cacheMarks(body)).toEqual([0])
  })

  /**
   * 短于该模型的最短可缓存前缀时**不设断点**。
   *
   * 设置后不会报错，只是不生效，但仍会记录一次缓存写入：账面增加一笔费用，实际没有节省。
   */
  test('前缀过短时不设断点', () => {
    const body = bodyOf(req([{ role: 'user', content: '短', cacheBreakpoint: true }]))
    expect(cacheMarks(body)).toEqual([])
  })

  /** 历史末尾与消息序列末尾各设一个：跨轮命中依赖前者，run 内逐步命中依赖后者。 */
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
   * 工具结果被合并为**一条** user 消息，因此输入下标与输出下标不一一对应。
   * 断点必须设在合并后的消息上，设错位置即缓存边界错位：
   * 功能上没有任何异常，唯一的表现是命中率大幅下降。
   */
  test('工具结果合并之后，断点设在合并后的消息上', () => {
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
    // assistant 一条 + 合并后的 tool 结果一条 = 两条；断点位于第二条。
    expect(body.messages).toHaveLength(2)
    expect(cacheMarks(body)).toEqual([1])
  })

  test('字符串正文先展开为内容块再附加 cache_control', () => {
    const body = bodyOf(req([{ role: 'user', content: long(8000), cacheBreakpoint: true }]))
    expect(Array.isArray(body.messages[0]?.content)).toBe(true)
  })
})

describe('运行上下文并入真实用户消息', () => {
  const bodyFor = (model: string, messages: WireMessage[]) => {
    const adapter = buildAdapter({
      kind: 'anthropic_messages',
      apiKey: 'sk-x',
      model,
    }) as unknown as {
      buildBody(req: ChatRequest): BodyShape
    }
    return adapter.buildBody({ ...req(messages), model })
  }

  test.each(['claude-opus-5', 'claude-sonnet-5'])('%s 上不新增消息轮次', (model) => {
    const body = bodyFor(model, [
      { role: 'context', content: '当前日期：2026-08-16' },
      { role: 'user', content: '帮我改一下' },
    ])
    expect(body.messages.map((m) => m.role)).toEqual(['user'])
    expect(body.messages[0]?.content).toBe('当前日期：2026-08-16\n\n帮我改一下')
  })

  test.each(['claude-opus-5', 'claude-sonnet-5'])('%s 上断点随所属用户消息发送', (model) => {
    const body = bodyFor(model, [
      { role: 'context', content: '工作区：/tmp/ws' },
      { role: 'user', content: long(8000), cacheBreakpoint: true },
    ])
    expect(body.messages).toHaveLength(1)
    expect(cacheMarks(body)).toEqual([0])
    expect(JSON.stringify(body.messages)).toContain('工作区：/tmp/ws')
  })

  test.each(['claude-opus-5', 'claude-sonnet-5'])('%s 上孤立上下文直接拒绝', (model) => {
    expect(() => bodyFor(model, [{ role: 'context', content: '孤立' }])).toThrow(
      '内部上下文缺少所属的用户消息',
    )
  })
})

describe('兼容协议忽略断点字段', () => {
  /**
   * **为 DeepSeek 设置断点不得产生任何副作用。** 其前缀缓存由服务端自动完成，
   * 请求体中没有 `cache_control` 字段：此路径上的断点标注不得改变任何字节。
   */
  test('标记与不标记断点生成完全相同的请求体', () => {
    const compat = {
      kind: 'openai_chat_completions' as const,
      apiKey: 'sk-x',
      model: 'deepseek-flash',
    }
    const adapter = buildAdapter(compat) as unknown as {
      buildBody(req: ChatRequest): Record<string, unknown>
    }
    const base: ChatRequest = {
      model: 'deepseek-flash',
      system: [{ text: '系统提示词' }],
      messages: [{ role: 'user', content: long(8000) }],
      tools: [],
      maxOutputTokens: 1024,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    }
    const marked: ChatRequest = {
      ...base,
      messages: [{ role: 'user', content: long(8000), cacheBreakpoint: true }],
    }
    expect(JSON.stringify(adapter.buildBody(marked))).toBe(JSON.stringify(adapter.buildBody(base)))
  })
})
