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
   * 原始失败形状：run 挂在等 provider 事件的 await 上，此时 abort 让底层请求抛出，
   * 被归类成 ProviderError('internal_error','已取消') 走异常路径——
   * loop 里三处 `signal.aborted` 检查全在「两个事件之间」，一个都赶不上。
   * 结果是用户主动点停止，DB 记 failed、界面弹一条红色 internal_error。
   */
  function abortingAdapter(controller: AbortController): LlmAdapter {
    return {
      kind: 'anthropic_messages' as const,
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        // 在「两个事件之间」之外的地方中断，并像真实 SDK 那样抛出。
        controller.abort()
        throw new ProviderError({
          code: 'internal_error',
          message: '已取消',
          provider: 'anthropic_messages',
        })
      },
    }
  }

  test('流式等待中被中断 —— 终态是 interrupted，且不发 run.error', async () => {
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
    // 报红的那条不能出现——中断不该走错误通道。
    expect(types).not.toContain('run.error')
    // provider 没有返回错误；账本不能把 SDK 的取消异常伪装成上游 internal_error。
    expect(settlement).toEqual({ status: 'uncertain', errorCode: null, errorMessage: null })
  })
})
