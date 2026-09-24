/**
 * `loop/` 下各测试共用的夹具：按脚本回放的假 adapter、不落库的持久化、最小 ToolContext，
 * 以及重发退避的断言。
 */

import { expect } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireToolCall } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateRequest, lookupModel } from '@qywork/ai'
import type { LoopPersistence, ToolContextBase } from '../index.ts'

/**
 * 第 n 次重发之前的退避基准（毫秒）与允许的抖动上界。
 *
 * 数字在这里独立写一遍，不从 `attempt.ts` 导入：导进来的断言等于拿实现校验实现。
 */
export const BACKOFF_STEPS = [2_000, 4_000, 8_000, 16_000, 30_000] as const
export const BACKOFF_JITTER_MAX = 1.1

export function expectBackoff(actual: number | null | undefined, resends: number): void {
  const step = BACKOFF_STEPS[resends]!
  expect(actual).toBeGreaterThanOrEqual(step)
  expect(actual).toBeLessThanOrEqual(step * BACKOFF_JITTER_MAX)
}

/** 按脚本回放的假 adapter：每次 stream() 产出预设的一轮。 */
export function fakeAdapter(turns: (WireToolCall[] | null)[], model = 'claude-opus-5'): LlmAdapter {
  let turn = 0
  const spec = lookupModel(
    model,
    model === 'claude-opus-5' ? 'anthropic_messages' : 'openai_chat_completions',
  )
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      const calls = turns[turn++] ?? null
      // 三个真适配器都是 `estimateRequest(req)`，假的必须同口径：没有锚点时
      // 面板的总数就是这个值，而分组明细是同一次装配的估算，两者相等是恒等式。
      // 给一个与请求无关的常数，等于让假适配器造出真适配器造不出的状态。
      yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, spec.density) }
      yield { type: 'response_started', headersAt: Date.now() }
      if (calls) {
        yield { type: 'tool_calls', calls, at: Date.now() }
      } else {
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          source: 'provider',
        },
      }
      yield { type: 'done', stopReason: calls ? 'tool_use' : 'end_turn', rawStopReason: '' }
    },
  }
}

export function noopPersistence(): LoopPersistence {
  let seq = 0
  return {
    nextSeq: () => ++seq,
    openTextStep: () => `st_text_${seq}`,
    openThinkingStep: () => `st_think_${seq}`,
    landUserStep: () => `st_user_${seq}`,
    failThinkingSteps: () => {},
    appendText: () => {},
    openToolStep: () => `st_tool_${seq}`,
    markExecuting: () => {},
    settleTool: () => {},
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: () => 'pr_test',
    markRequestSent: () => {},
    settleRequest: () => {},
  }
}

export function call(name: string, args: Record<string, unknown> = {}): WireToolCall {
  return { id: `c_${Math.random().toString(36).slice(2)}`, name, arguments: args }
}

/** 最小可用的 ToolContext。测试只关心 loop 的编排，工具本身不碰这些字段。 */
export function baseCtx(runId: string): ToolContextBase {
  return {
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
  }
}
