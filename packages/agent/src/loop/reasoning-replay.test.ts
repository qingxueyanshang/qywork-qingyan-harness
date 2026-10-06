/**
 * 覆盖 `loop/request.ts` 的 `replayReasoning` / `reasoningPrefix`，以及 `loop/index.ts` 装配点
 * 与 `loop/attempt.ts` 标记前缀这两处调用：原生推理只在产生它的前缀未变时回放，
 * 思考正文只在协议要求发送时保留在请求中。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import { lookupModel } from '@qywork/ai'
import type { ResponseReasoning } from '@qywork/core'
import { AgentLoop } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { envelopeHashOf, reasoningPrefix, replayReasoning } from './request.ts'

const OPAQUE = { opaque: true, text: 'none' } as const
const envelope = envelopeHashOf({ model: 'm', system: [{ text: 'sys' }], tools: [] })
const items = [{ type: 'thinking', thinking: '想', signature: 's' }]

/** 按装配点的同一算法，为在给定消息之后产生的响应标记前缀。 */
function stampAfter(messages: WireMessage[], env = envelope): ResponseReasoning {
  const req = {
    model: 'm',
    system: [{ text: 'sys' }],
    tools: [],
    messages: replayReasoning(messages, OPAQUE, env),
  } as unknown as ChatRequest
  return { items, tokens: 9, prefix: env === envelope ? reasoningPrefix(req) : 'other' }
}

describe('装配点裁剪', () => {
  const user: WireMessage = { role: 'user', content: '读 a.ts' }

  test('前缀未变时原样保留，不携带思考正文', () => {
    const turn: WireMessage = {
      role: 'assistant',
      content: '',
      reasoningContent: '想',
      responseReasoning: stampAfter([user]),
      toolCalls: [call('read_file', { path: 'a.ts' })],
    }
    const [, kept] = replayReasoning([user, turn], OPAQUE, envelope)
    expect(kept!.responseReasoning).toEqual(turn.responseReasoning)
    expect(kept!.reasoningContent).toBeUndefined()
  })

  test('更换模型或工具表（信封变化）时剥离', () => {
    const turn: WireMessage = {
      role: 'assistant',
      content: '好',
      responseReasoning: stampAfter([user]),
    }
    const other = envelopeHashOf({ model: 'n', system: [{ text: 'sys' }], tools: [] })
    expect(replayReasoning([user, turn], OPAQUE, other)[1]!.responseReasoning).toBeUndefined()
  })

  test('更早的消息被改写后，其后的原生条目全部剥离', () => {
    const first: WireMessage = {
      role: 'assistant',
      content: '一',
      responseReasoning: stampAfter([user]),
    }
    const next: WireMessage = { role: 'user', content: '继续' }
    const second: WireMessage = {
      role: 'assistant',
      content: '二',
      responseReasoning: stampAfter([user, first, next]),
    }
    const intact = replayReasoning([user, first, next, second], OPAQUE, envelope)
    expect(intact.map((m) => !!m.responseReasoning)).toEqual([false, true, false, true])

    const edited = replayReasoning(
      [{ ...user, content: '读 b.ts' }, first, next, second],
      OPAQUE,
      envelope,
    )
    expect(edited.map((m) => !!m.responseReasoning)).toEqual([false, false, false, false])
  })

  test('缓存断点与内部标记不算改写', () => {
    const turn: WireMessage = {
      role: 'assistant',
      content: '好',
      responseReasoning: stampAfter([user]),
    }
    const marked: WireMessage = { ...user, cacheBreakpoint: true, _group: 'historyMessages' }
    expect(replayReasoning([marked, turn], OPAQUE, envelope)[1]!.responseReasoning).toBeDefined()
  })

  test('没有前缀或协议不回放原生条目时剥离', () => {
    const { prefix: _p, ...unknown } = stampAfter([user])
    const turn: WireMessage = { role: 'assistant', content: '好', responseReasoning: unknown }
    expect(replayReasoning([user, turn], OPAQUE, envelope)[1]!.responseReasoning).toBeUndefined()
    const stamped: WireMessage = { ...turn, responseReasoning: stampAfter([user]) }
    const chat = replayReasoning([user, stamped], { opaque: false, text: 'all' }, envelope)
    expect(chat[1]!.responseReasoning).toBeUndefined()
  })

  test('思考正文按协议保留：工具轮始终携带，纯文本轮只在全量回放时携带', () => {
    const tool: WireMessage = {
      role: 'assistant',
      content: '',
      reasoningContent: '甲',
      toolCalls: [call('read_file', {})],
    }
    const text: WireMessage = { role: 'assistant', content: '好', reasoningContent: '乙' }
    const texts = (rule: { opaque: boolean; text: 'none' | 'tool_turns' | 'all' }) =>
      replayReasoning([user, tool, text], rule, envelope).map((m) => m.reasoningContent)
    expect(texts({ opaque: false, text: 'tool_turns' })).toEqual([undefined, '甲', undefined])
    expect(texts({ opaque: false, text: 'all' })).toEqual([undefined, '甲', '乙'])
    expect(texts({ opaque: true, text: 'none' })).toEqual([undefined, undefined, undefined])
  })
})

describe('循环集成', () => {
  test('Claude 的原生思考标记前缀后写入账本，此后每一轮原样回放，不带正文', async () => {
    const seen: WireMessage[][] = []
    const persisted: unknown[] = []
    const inner = fakeAdapter([])
    const reasoning = { items, tokens: 9 }
    const adapter: LlmAdapter = {
      ...inner,
      spec: lookupModel('claude-opus-5-5', 'anthropic_messages'),
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        seen.push(structuredClone(req.messages))
        yield { type: 'request_prepared', measuredInputTokens: 1 }
        yield { type: 'thinking_delta', delta: '想', at: Date.now() }
        if (seen.length < 3) {
          yield { type: 'response_reasoning', reasoning, at: Date.now() }
          const path = seen.length === 1 ? 'a.ts' : 'b.ts'
          yield { type: 'tool_calls', calls: [call('read_file', { path })], at: Date.now() }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: 'tool_use' }
        } else {
          yield { type: 'text_delta', delta: '完成', at: Date.now() }
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'end_turn' }
        }
      },
    }
    const persist = noopPersistence()
    const original = persist.openThinkingStep
    persist.openThinkingStep = (runId, seq, batchId, data) => {
      persisted.push(data)
      return original(runId, seq, batchId)
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist,
      makeToolContext: baseCtx,
    })
    for await (const _ of loop.run({
      runId: 'rn_claude_native' as never,
      history: [{ role: 'user', content: '读两个文件' }],
      signal: new AbortController().signal,
    })) {
      // 只检查请求与写入账本的内容。
    }
    // 思考正文单独记录的步骤不带载荷，此处只检查两条原生条目。
    expect(persisted.filter(Boolean)).toEqual([
      { ...reasoning, prefix: expect.any(String) },
      { ...reasoning, prefix: expect.any(String) },
    ])
    const assistants = (i: number) => seen[i]!.filter((m) => m.role === 'assistant')
    expect(assistants(1).map((m) => [!!m.responseReasoning, m.reasoningContent])).toEqual([
      [true, undefined],
    ])
    expect(assistants(2).map((m) => [!!m.responseReasoning, m.reasoningContent])).toEqual([
      [true, undefined],
      [true, undefined],
    ])
  })
})
