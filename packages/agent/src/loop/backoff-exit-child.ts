/**
 * `resend-policy.test.ts` 的子进程入口：退避等待期间停止之后，进程能否立即退出。
 *
 * 停止之后仍在计时的定时器使进程保持存活，只能在独立进程中观察。接口地址经环境变量 `QY_FAULT_URL` 传递。
 * 本轮结束时在 stdout 输出一行 `finished <停止原因>`，之后不调用 `process.exit`：进程何时退出即是被测行为。
 */

import { buildAdapter, DEFAULT_DENSITY } from '@qywork/ai'
import { AgentLoop, type LoopPersistence } from '../index.ts'
import { ToolRegistry } from '../registry.ts'

let seq = 0
const persist: LoopPersistence = {
  nextSeq: () => ++seq,
  markImagesUndelivered: () => [],
  markRequestHeaders: () => {},
  markRequestHedge: () => {},
  markRequestFirstEvent: () => {},
  markRequestContent: () => {},
  recordRequestDiagnostic: () => {},
  openTextStep: () => `st_text_${seq}`,
  openThinkingStep: () => `st_think_${seq}`,
  landUserStep: () => `st_user_${seq}`,
  failThinkingSteps: () => {},
  appendText: () => {},
  openToolStep: () => `st_tool_${seq}`,
  markExecuting: () => {},
  settleTool: (_stepId, _status, outcome) => outcome,
  saveUsage: () => {},
  recordCompaction: () => {},
  openRequest: () => 'pr_child',
  markRequestSent: () => {},
  settleRequest: () => {},
}

const controller = new AbortController()
const loop = new AgentLoop({
  adapter: buildAdapter({
    kind: 'openai_responses',
    model: 'deepseek-flash',
    apiKey: 'sk-fault',
    baseUrl: process.env.QY_FAULT_URL ?? '',
  }),
  registry: new ToolRegistry(),
  systemPrompt: 'sys',
  makeToolContext: (runId) => ({
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
    signal: controller.signal,
    requestPermission: async () => ({ allowed: true }),
  }),
  persist,
  streamIdleTimeoutMs: 2_000,
})

for await (const ev of loop.run({
  compactPercent: 80,
  runId: 'rn_backoff_exit' as never,
  history: [],
  signal: controller.signal,
})) {
  // 该事件在退避之前发出，停止因此落在退避等待期间。
  if (ev.type === 'run.retrying') controller.abort()
  if (ev.type === 'run.finished') console.log(`finished ${ev.stopReason}`)
}
