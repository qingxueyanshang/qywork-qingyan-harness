/**
 * 覆盖 `loop/run-state.ts` 的 `RunState`：信封换了时锚点只换头部、换模型时作废，
 * 空转判据在第二次重复时交出提示、第三次重复时停，以及执行事实的落账与追加。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest } from '@qywork/ai'
import { emptyBreakdown } from '@qywork/core'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { envelopeHashOf } from './request.ts'
import { RunState } from './run-state.ts'

function state(anchor?: { model: string; headTokens: number; envelopeFingerprint: string }) {
  return new RunState(
    {
      adapter: fakeAdapter([]),
      registry: new ToolRegistry(),
      systemPrompt: 's',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    },
    {
      runId: 'rn_state' as never,
      history: [],
      signal: new AbortController().signal,
      ...(anchor ? { anchor: { tokens: 10_000, throughMessageId: null, ...anchor } } : {}),
    },
  )
}

function request(model: string, system: string): ChatRequest {
  return { model, system: [{ text: system }], messages: [], tools: [] } as unknown as ChatRequest
}

describe('锚点的信封修正', () => {
  const breakdown = { ...emptyBreakdown(), systemPrompt: 300, systemTools: 200 }

  test('信封没变时锚点原样保留', () => {
    const req = request('m', 'a')
    const run = state({ model: 'm', headTokens: 400, envelopeFingerprint: envelopeHashOf(req) })
    run.rebaseAnchor(req, breakdown)
    expect(run.anchor).toMatchObject({ tokens: 10_000, headTokens: 400 })
  })

  test('同一模型下信封换了，只按头部差额修正', () => {
    const run = state({ model: 'm', headTokens: 400, envelopeFingerprint: 'old' })
    const req = request('m', 'b')
    run.rebaseAnchor(req, breakdown)
    expect(run.anchor).toMatchObject({
      tokens: 10_000 - 400 + 500,
      headTokens: 500,
      envelope: envelopeHashOf(req),
    })
  })

  test('换了模型时锚点作废', () => {
    const run = state({ model: 'other', headTokens: 400, envelopeFingerprint: 'old' })
    run.rebaseAnchor(request('m', 'b'), breakdown)
    expect(run.anchor).toBeNull()
  })
})

describe('空转判据', () => {
  test('第二次重复交出提示，第三次重复才停', () => {
    const run = state()
    const same = { cycle: 'c', noProgress: true }
    run.progress.push(same)
    expect(run.stalled()).toBe(false)
    expect(run.transcript).toEqual([])
    run.progress.push(same)
    expect(run.stalled()).toBe(false)
    expect(run.transcript).toHaveLength(1)
    run.progress.push(same)
    expect(run.stalled()).toBe(true)
  })
})

describe('执行事实', () => {
  /**
   * 提示必须落账并留在 transcript：只附在下一次请求末尾的话，再下一次请求的前缀
   * 就与产生那轮响应时不同，那轮之后的思考块被 provider 作废。
   */
  test('落一条带 notice 标记的用户 step，并以运行上下文分组追加到 transcript', () => {
    const landed: unknown[] = []
    const persist = {
      ...noopPersistence(),
      landUserStep: (_r: unknown, _s: unknown, input: unknown) => {
        landed.push(input)
        return 'st_notice'
      },
    }
    const run = new RunState(
      {
        adapter: fakeAdapter([]),
        registry: new ToolRegistry(),
        systemPrompt: 's',
        persist,
        makeToolContext: (runId) => baseCtx(runId),
      },
      { runId: 'rn_notice' as never, history: [], signal: new AbortController().signal },
    )
    run.notify('本轮未结束。')
    expect(landed).toEqual([{ text: '本轮未结束。', notice: true }])
    expect(run.transcript).toEqual([
      {
        role: 'user',
        content: '本轮未结束。',
        _group: 'workspaceState',
        _step: expect.any(String),
      },
    ])
  })
})
