/**
 * 同一对象的当前视图在历史里只留最新一份。
 *
 * 覆盖范围：`loop.ts` 的 `collapseSuperseded`（取代规则、收纳信封形状、纯函数与幂等），
 * 以及它接在 `buildRequest` 上之后适配器实际收到的那份请求。回放侧给消息打同一个
 * `_view` 由 `runtime/transcript.test.ts` 锁。
 *
 * 原始失败形状：同一窗口的 12 份整窗控件表全部随历史重发，末次请求约九成是旧表，
 * 而动作只接受最新一份的观察编号。
 */

import { expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateRequest, lookupModel } from '@qywork/ai'
import type { CurrentView } from '@qywork/core'
import type { LoopPersistence } from './loop.ts'
import { AgentLoop, collapseSuperseded } from './loop.ts'
import type { ToolContextBase } from './registry.ts'
import { ToolRegistry } from './registry.ts'

function envelope(callId: string, table: string, resources?: string[]): string {
  return JSON.stringify({
    call_id: callId,
    tool: 'desktop_observe',
    status: 'success',
    executed: true,
    summary: `观察 ${callId}`,
    ...(resources ? { resources } : {}),
    result: { windowId: 'dw_1', elements: table },
  })
}

function observed(
  callId: string,
  view: CurrentView | undefined,
  table = `控件表 ${callId}`,
  resources?: string[],
): WireMessage {
  return {
    role: 'tool',
    toolCallId: callId,
    content: envelope(callId, table, resources),
    _group: 'executionRecords',
    ...(view ? { _view: view } : {}),
  }
}

function calls(callId: string): WireMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: callId, name: 'desktop_observe', arguments: {} }],
    _group: 'executionRecords',
  }
}

const W1: CurrentView = { key: 'desktop:dw_1' }
const W2: CurrentView = { key: 'desktop:dw_2' }

function isCondensed(m: WireMessage | undefined): boolean {
  if (m?.role !== 'tool' || typeof m.content !== 'string') return false
  return (JSON.parse(m.content) as { result_omitted?: boolean }).result_omitted === true
}

test('同一窗口的整窗视图：只留最后一份，前面的换成收纳信封', () => {
  const out = collapseSuperseded([
    calls('c1'),
    observed('c1', W1),
    calls('c2'),
    observed('c2', W1),
    calls('c3'),
    observed('c3', W1),
  ])
  expect(isCondensed(out[1])).toBe(true)
  expect(isCondensed(out[3])).toBe(true)
  expect(isCondensed(out[5])).toBe(false)
})

test('收纳信封保留调用、执行事实与资源 id，去掉正文', () => {
  const [first] = collapseSuperseded([observed('c1', W1, '大表', ['rs_1']), observed('c2', W1)])
  const env = JSON.parse(String(first?.content)) as Record<string, unknown>
  expect(env).toEqual({
    call_id: 'c1',
    tool: 'desktop_observe',
    status: 'success',
    executed: true,
    summary: '观察 c1',
    resources: ['rs_1'],
    result_omitted: true,
  })
})

test('不同窗口互不取代，没有声明视图的结果不动', () => {
  const plain: WireMessage = { role: 'tool', toolCallId: 'x', content: '{"call_id":"x"}' }
  const input = [observed('c1', W1), observed('c2', W2), plain, observed('c3', W2)]
  const out = collapseSuperseded(input)
  expect(isCondensed(out[0])).toBe(false)
  expect(isCondensed(out[1])).toBe(true)
  expect(out[2]).toBe(plain)
  expect(isCondensed(out[3])).toBe(false)
})

test('子树视图只被同一子树或整窗取代；整窗不被后面的子树取代', () => {
  const sub = { ...W1, scope: 'w.1#4' }
  const other = { ...W1, scope: 'w.2#9' }
  const out = collapseSuperseded([
    observed('c1', W1),
    observed('c2', sub),
    observed('c3', other),
    observed('c4', sub),
  ])
  expect(isCondensed(out[0])).toBe(false)
  expect(isCondensed(out[1])).toBe(true)
  expect(isCondensed(out[2])).toBe(false)
  expect(isCondensed(out[3])).toBe(false)

  const later = collapseSuperseded([observed('c1', sub), observed('c2', W1)])
  expect(isCondensed(later[0])).toBe(true)
})

test('按条件筛过的视图不取代别的结果，自己被后面的完整视图取代', () => {
  const filtered = { ...W1, partial: true as const }
  const out = collapseSuperseded([
    observed('c1', W1),
    observed('c2', filtered),
    observed('c3', filtered),
  ])
  expect(out.some(isCondensed)).toBe(false)

  const later = collapseSuperseded([observed('c1', filtered), observed('c2', W1)])
  expect(isCondensed(later[0])).toBe(true)
})

test('纯函数：没有被取代时交回原引用，收起过的再收一次逐字不变', () => {
  const lone = observed('c1', W1)
  expect(collapseSuperseded([lone])[0]).toBe(lone)

  const input = [observed('c1', W1), observed('c2', W1)]
  const once = collapseSuperseded(input)
  const twice = collapseSuperseded(once)
  expect(twice.map((m) => m.content)).toEqual(once.map((m) => m.content))
  expect(collapseSuperseded(input).map((m) => m.content)).toEqual(once.map((m) => m.content))
})

function persistence(): LoopPersistence {
  let seq = 0
  let requests = 0
  return {
    nextSeq: () => ++seq,
    landUserStep: () => `st_user_${seq}`,
    openTextStep: () => `st_text_${seq}`,
    openThinkingStep: () => `st_think_${seq}`,
    failThinkingSteps: () => {},
    appendText: () => {},
    openToolStep: () => `st_tool_${seq}`,
    markExecuting: () => {},
    settleTool: () => {},
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: () => `pr_${++requests}`,
    markRequestSent: () => {},
    settleRequest: () => {},
  }
}

function capturingAdapter(): LlmAdapter & { seen: ChatRequest[] } {
  const base = lookupModel('claude-opus-5', 'anthropic_messages')
  const seen: ChatRequest[] = []
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: base,
    seen,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, base.density) }
      yield { type: 'text_delta', delta: '完成', at: Date.now() }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
    },
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

test('适配器收到的请求里，被取代的控件表已换成收纳信封，最新一份原样', async () => {
  const adapter = capturingAdapter()
  const loop = new AgentLoop({
    adapter,
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist: persistence(),
  })
  const history: WireMessage[] = [
    { role: 'user', content: '登录', _group: 'historyMessages' },
    calls('c1'),
    observed('c1', W1, '第一份整窗表'),
    calls('c2'),
    observed('c2', W1, '第二份整窗表'),
  ]
  for await (const _ of loop.run({
    runId: 'rn_views' as never,
    history,
    signal: new AbortController().signal,
  })) {
    // 断言落在适配器收到的请求上。
  }
  const tools = (adapter.seen[0]?.messages ?? []).filter((m) => m.role === 'tool')
  expect(tools).toHaveLength(2)
  expect(isCondensed(tools[0])).toBe(true)
  expect(String(tools[0]?.content)).not.toContain('第一份整窗表')
  expect(String(tools[1]?.content)).toContain('第二份整窗表')
})
