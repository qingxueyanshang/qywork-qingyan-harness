/**
 * 覆盖 `loop/index.ts` 的 run 终态：用户中断不是错误。
 */

import { describe, expect, test } from 'bun:test'
import type { LlmAdapter, ProviderEvent } from '@qywork/ai'
import { lookupModel, ProviderError } from '@qywork/ai'
import { AgentLoop } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { noopPersistence } from './fixtures.test-helper.ts'

describe('用户中断不是错误', () => {
  /**
   * 原始失败形状：run 阻塞于等待 provider 事件的 await，此时 abort 使底层请求抛出异常，
   * 该异常被归类为 ProviderError('internal_error','已取消') 并进入异常路径。
   * loop 中三处 `signal.aborted` 检查都位于两个事件之间，无法捕获这次中断。
   * 用户主动停止后，数据库记为 failed，界面显示一条 internal_error 错误。
   */
  function abortingAdapter(controller: AbortController): LlmAdapter {
    return {
      kind: 'anthropic_messages' as const,
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        // 在两个事件之间以外的位置中断，并按真实 SDK 的行为抛出异常。
        controller.abort()
        throw new ProviderError({
          code: 'internal_error',
          message: '已取消',
          provider: 'anthropic_messages',
        })
      },
    }
  }

  test('流式等待中被中断：终态为 interrupted，且不发送 run.error', async () => {
    const controller = new AbortController()
    let settlement:
      | { status: string; errorCode: string | null; errorMessage: string | null }
      | undefined
    const loop = new AgentLoop({
      adapter: abortingAdapter(controller),
      registry: new ToolRegistry(),
      systemPrompt: 's',
      makeToolContext: () => ({}) as never,
      persist: {
        ...noopPersistence(),
        settleRequest: (_id, status, _usage, errorCode, _finishReason, errorMessage) => {
          settlement = { status, errorCode, errorMessage: errorMessage ?? null }
        },
      },
    })

    const types: string[] = []
    let finished: { status: string; stopReason: string } | undefined
    for await (const ev of loop.run({
      runId: 'rn_abort' as never,
      history: [],
      signal: controller.signal,
    })) {
      types.push(ev.type)
      if (ev.type === 'run.finished') finished = ev
    }

    expect(finished?.status).toBe('interrupted')
    expect(finished?.stopReason).toBe('user_interrupt')
    // 不得出现 run.error：中断不经由错误通道。
    expect(types).not.toContain('run.error')
    // provider 未返回错误；账本不得把 SDK 的取消异常记为上游 internal_error。
    expect(settlement).toEqual({ status: 'uncertain', errorCode: null, errorMessage: null })
  })
})
