/**
 * 覆盖范围：`loop/attempt.ts` 的单一退避策略与重发预算（`resendBackoffMs`、`MAX_RESENDS`、
 * `LoopDeps.sleep`），对 `@qywork/ai` 的 `providers/fault-server.test-helper.ts`
 * 三协议故障端点执行真实 HTTP 请求。
 *
 * 退避经注入的 `sleep` 执行，断言其收到的毫秒序列：实际等待时，
 * 耗尽一次预算约需一分钟。停止相关的用例例外，它们需要真实计时。
 *
 * 退避档位（2 / 4 / 8 / 16 / 30 秒）在本文件中独立列出，不从 `loop/attempt.ts` 导入：
 * 导入后的断言等于用实现校验实现自身。
 */

import { expect, test } from 'bun:test'
import { buildAdapter, DEFAULT_DENSITY } from '@qywork/ai'
import {
  closedPortBaseUrl,
  type FaultServer,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent } from '@qywork/core'
import { AgentLoop, type LoopPersistence, type ToolContextBase } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { MAX_RESENDS } from './attempt.ts'

const BACKOFF_STEPS = [2_000, 4_000, 8_000, 16_000, 30_000] as const
const BACKOFF_JITTER_MAX = 1.1

function expectBackoff(actual: number | undefined, resends: number): void {
  const step = BACKOFF_STEPS[resends]!
  expect(actual).toBeGreaterThanOrEqual(step)
  expect(actual).toBeLessThanOrEqual(step * BACKOFF_JITTER_MAX)
}

function noopPersistence(): LoopPersistence {
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

function baseCtx(runId: string): ToolContextBase {
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

interface RunOptions {
  baseUrl: string
  runId: string
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

async function runAgainst(opts: RunOptions): Promise<AgentEvent[]> {
  const loop = new AgentLoop({
    adapter: buildAdapter({
      kind: 'openai_responses',
      model: 'deepseek-flash',
      apiKey: 'sk-fault',
      baseUrl: opts.baseUrl,
    }),
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist: noopPersistence(),
    streamIdleTimeoutMs: 2_000,
    sleep: opts.sleep,
  })
  const events: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: opts.runId as never,
    history: [],
    signal: opts.signal ?? new AbortController().signal,
  })) {
    events.push(ev)
  }
  return events
}

/** 上游给出等待时间时按该时间等待，不按本地档位。 */
test('503 带 Retry-After 60：按上游给出的 60 秒等待，随后一次成功', async () => {
  const fault: FaultServer = startFaultServer('retry_after_then_ok')
  fault.retryAfterSeconds = 60
  const backoffs: number[] = []
  try {
    const events = await runAgainst({
      baseUrl: fault.openaiBaseUrl,
      runId: 'rn_retry_after',
      sleep: async (ms) => {
        backoffs.push(ms)
      },
    })

    expect(backoffs).toEqual([60_000])
    // 服务端的独立记录：退避期间没有第三次接收，重发只发生一次。
    expect(fault.receipts.length).toBe(2)
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  } finally {
    fault.stop()
  }
}, 20_000)

/** 连接被拒时没有可用的等待时间，六次尝试之间按指数退避。 */
test('连接被拒：首发加五次重发，间隔按 2 / 4 / 8 / 16 / 30 秒递增', async () => {
  const backoffs: number[] = []
  const events = await runAgainst({
    baseUrl: `${closedPortBaseUrl()}/v1`,
    runId: 'rn_refused',
    sleep: async (ms) => {
      backoffs.push(ms)
    },
  })

  expect(backoffs).toHaveLength(MAX_RESENDS)
  backoffs.forEach((ms, i) => {
    expectBackoff(ms, i)
  })
  const err = events.find((e) => e.type === 'run.error')
  expect(err?.type === 'run.error' && err.code).toBe('network_error')
  expect(err?.type === 'run.error' && err.message).toContain(`已重发 ${MAX_RESENDS} 次`)
  const finished = events.find((e) => e.type === 'run.finished')
  expect(finished?.type === 'run.finished' && finished.stopReason).toBe('provider_error')
}, 20_000)

/**
 * 可恢复错误交替出现：503 无 Retry-After → 终态前 EOF → 正常完成。
 *
 * 错误码变化不重置计数：一轮中实际发出几次即计几次，第二次退避使用第二档。
 */
test('可恢复错误交替出现：预算共用一份，尝试序号只增不重置', async () => {
  const fault: FaultServer = startFaultServer('retry_after_then_ok')
  // 不带 Retry-After 的 503：等待时长只能由本地退避策略决定。
  fault.retryAfterSeconds = null
  const backoffs: number[] = []
  try {
    const events = await runAgainst({
      baseUrl: fault.openaiBaseUrl,
      runId: 'rn_mixed',
      // 每次退避把夹具切换到下一种故障形态，因此三次尝试各遇到一种。
      sleep: async (ms) => {
        backoffs.push(ms)
        fault.mode = backoffs.length === 1 ? 'eof_before_terminal' : 'complete'
      },
    })

    expect(fault.receipts.length).toBe(3)
    expect(backoffs).toHaveLength(2)
    expectBackoff(backoffs[0], 0)
    expectBackoff(backoffs[1], 1)
    expect(
      events
        .filter((e) => e.type === 'run.retrying')
        .map((e) => (e.type === 'run.retrying' ? [e.attempt, e.max] : null)),
    ).toEqual([
      [1, MAX_RESENDS],
      [2, MAX_RESENDS],
    ])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  } finally {
    fault.stop()
  }
}, 20_000)

/** 退避使用真实计时，等待期间的停止必须立即结束整轮。 */
test('退避等待期间停止：立即以 user_interrupt 结束，不再发送请求', async () => {
  const fault: FaultServer = startFaultServer('retry_after_then_ok')
  // 等待时长远超测试的超时上限：停止若不中断等待，本用例以超时结束，而不是断言失败。
  fault.retryAfterSeconds = 600
  const controller = new AbortController()
  try {
    const loop = new AgentLoop({
      adapter: buildAdapter({
        kind: 'openai_responses',
        model: 'deepseek-flash',
        apiKey: 'sk-fault',
        baseUrl: fault.openaiBaseUrl,
      }),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      makeToolContext: baseCtx,
      persist: noopPersistence(),
      streamIdleTimeoutMs: 2_000,
    })
    const types: string[] = []
    let stopReason = ''
    for await (const ev of loop.run({
      runId: 'rn_stop_backoff' as never,
      history: [],
      signal: controller.signal,
    })) {
      types.push(ev.type)
      // 该事件在退避之前发出，因此停止恰好发生在等待期间。
      if (ev.type === 'run.retrying') controller.abort()
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(types).toContain('run.retrying')
    expect(stopReason).toBe('user_interrupt')
    expect(types).not.toContain('run.error')
    expect(fault.receipts.length).toBe(1)
  } finally {
    controller.abort()
    fault.stop()
  }
}, 20_000)
