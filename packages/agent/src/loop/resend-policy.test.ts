/**
 * 覆盖范围：`loop/attempt.ts` 的单一退避策略与重发预算（`resendBackoffMs`、`RESEND_LIMIT`、
 * `LoopDeps.sleep`），对 `@qywork/ai` 的 `providers/fault-server.test-helper.ts`
 * 三协议故障端点执行真实 HTTP 请求。
 *
 * 退避经注入的 `sleep` 执行，断言其收到的毫秒序列：实际等待时，
 * 耗尽一次预算约需一分钟。停止相关的用例例外，它们需要真实计时。
 *
 * 退避档位（2 / 4 / 8 / 16 / 30 秒）在本文件中独立列出，不从 `loop/attempt.ts` 导入：
 * 导入后的断言等于用实现校验实现自身。
 *
 * 另覆盖发往各家官方地址的请求：拦截 fetch，以按官方错误码文档构造的正文答复，经真实的适配器、
 * 按接口地址判定的上游错误码归类（`@qywork/ai` 的 `upstreamFailureCode`）与重发判定，断言失败码与是否重发；
 * 以及云端网关改写后的流内错误事件（类型与错误码为网关的归类）在电脑端的归类与重发。
 */

import { expect, spyOn, test } from 'bun:test'
import { buildAdapter, DEFAULT_DENSITY } from '@qywork/ai'
import {
  closedPortBaseUrl,
  type FaultServer,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent, ProviderKind } from '@qywork/core'
import { RESEND_LIMIT } from '@qywork/core'
import { AgentLoop, type LoopPersistence, type ToolContextBase } from '../index.ts'
import { ToolRegistry } from '../registry.ts'

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
  kind?: ProviderKind
}

async function runAgainst(opts: RunOptions): Promise<AgentEvent[]> {
  const loop = new AgentLoop({
    adapter: buildAdapter({
      kind: opts.kind ?? 'openai_responses',
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
    compactPercent: 80,
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

/**
 * Retry-After 的规则与生成的重试相同（`core` 的 `resendDelay`）：不短于退避间隔，不超过 60 秒。
 * 原始失败形状：完全按 Retry-After 等待，给出 600 秒时本轮停在等待中 10 分钟，给出 0 秒时不等待即重发。
 */
test.each([
  [600, '等待 60 秒', 60_000],
  [0, '按退避间隔等待', null],
] as const)(
  '503 带 Retry-After %d 秒：%s，随后一次成功',
  async (seconds, _, expected) => {
    const fault: FaultServer = startFaultServer('retry_after_then_ok')
    fault.retryAfterSeconds = seconds
    const backoffs: number[] = []
    try {
      const events = await runAgainst({
        baseUrl: fault.openaiBaseUrl,
        runId: `rn_retry_after_${seconds}`,
        sleep: async (ms) => {
          backoffs.push(ms)
        },
      })

      expect(backoffs).toHaveLength(1)
      if (expected === null) expectBackoff(backoffs[0], 0)
      else expect(backoffs[0]).toBe(expected)
      expect(fault.receipts.length).toBe(2)
      const finished = events.find((e) => e.type === 'run.finished')
      expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
    } finally {
      fault.stop()
    }
  },
  20_000,
)

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

  expect(backoffs).toHaveLength(RESEND_LIMIT)
  backoffs.forEach((ms, i) => {
    expectBackoff(ms, i)
  })
  const err = events.find((e) => e.type === 'run.error')
  expect(err?.type === 'run.error' && err.code).toBe('network_error')
  expect(err?.type === 'run.error' && err.message).toContain(`已重发 ${RESEND_LIMIT} 次`)
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
      [1, RESEND_LIMIT],
      [2, RESEND_LIMIT],
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
      compactPercent: 80,
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

const DASHSCOPE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai'
const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4'
const ARK = 'https://ark.cn-beijing.volces.com/api/v3'
const MOONSHOT = 'https://api.moonshot.cn/v1'
const OPENAI = 'https://api.openai.com/v1'
const STEPFUN = 'https://api.stepfun.com/v1'
const ANTHROPIC = 'https://api.anthropic.com'

/**
 * 原始失败形状：错误码表只用于生成请求，对话请求按状态码与原文归类。百炼以 400 `Arrearage` 报告欠费时归为参数错误；
 * 百炼与 Gemini API 的限流原文与 OpenAI 额度用尽相同，归为额度用尽而不重发；火山方舟以 403 报告欠费时归为鉴权失败；
 * 智谱、月之暗面、阶跃星辰、OpenAI 与 Anthropic 以 429 报告的套餐到期、余额不足与支出上限归为限流，重发 5 次后才报告。
 * 正文按各家错误码文档的字段与取值构造；Gemini API 的 403 只给出「citing an outstanding balance」，原文据此构造。
 */
test.each([
  [
    '百炼 429 insufficient_quota（TPS / TPM 限流）',
    'openai_chat_completions',
    DASHSCOPE,
    429,
    '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}',
    'rate_limited',
  ],
  [
    '百炼 400 Arrearage（账号欠费）',
    'openai_chat_completions',
    DASHSCOPE,
    400,
    '{"error":{"message":"Access denied, please make sure your account is in good standing.","type":"Arrearage","param":null,"code":"Arrearage"}}',
    'insufficient_quota',
  ],
  [
    'Gemini API 429 RESOURCE_EXHAUSTED（速率限制）',
    'openai_chat_completions',
    GEMINI,
    429,
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
    'rate_limited',
  ],
  [
    'Gemini API 403 PERMISSION_DENIED（账单未结清）',
    'openai_chat_completions',
    GEMINI,
    403,
    '{"error":{"code":403,"message":"Your project has an outstanding balance.","status":"PERMISSION_DENIED"}}',
    'insufficient_quota',
  ],
  [
    '智谱 429 1302（速率限制）',
    'openai_chat_completions',
    ZHIPU,
    429,
    '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}',
    'rate_limited',
  ],
  [
    '智谱 429 1310（每周 / 每月使用上限）',
    'openai_chat_completions',
    ZHIPU,
    429,
    '{"error":{"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-11-18 00:00:00 重置"}}',
    'insufficient_quota',
  ],
  [
    '智谱 429 1311（套餐未开放该模型）',
    'openai_chat_completions',
    ZHIPU,
    429,
    '{"error":{"code":"1311","message":"当前订阅套餐暂未开放glm-5.3权限"}}',
    'auth_failed',
  ],
  [
    '火山方舟 403 AccountOverdueError（欠费）',
    'openai_chat_completions',
    ARK,
    403,
    '{"error":{"code":"AccountOverdueError","message":"The request failed because your account has an overdue balance. Request ID: r.","param":"","type":"Forbidden"}}',
    'insufficient_quota',
  ],
  [
    '火山方舟 429 ModelAccountTpmRateLimitExceeded（TPM 限流）',
    'openai_chat_completions',
    ARK,
    429,
    '{"error":{"code":"ModelAccountTpmRateLimitExceeded","message":"TPM (Tokens Per Minute) limit of the model is exceeded.","param":"","type":"TooManyRequests"}}',
    'rate_limited',
  ],
  [
    '月之暗面 429 exceeded_current_quota_error（余额不足）',
    'openai_chat_completions',
    MOONSHOT,
    429,
    '{"error":{"type":"exceeded_current_quota_error","message":"Account balance is insufficient or the account has been disabled"}}',
    'insufficient_quota',
  ],
  [
    '月之暗面 429 engine_overloaded_error（节点负载较高）',
    'openai_chat_completions',
    MOONSHOT,
    429,
    '{"error":{"type":"engine_overloaded_error","message":"The engine is currently overloaded, please try again later"}}',
    'rate_limited',
  ],
  [
    'OpenAI 429 organization_spend_limit_exceeded（组织支出上限）',
    'openai_responses',
    OPENAI,
    429,
    '{"error":{"message":"Your organization reached its enforced spend limit.","type":"insufficient_quota","param":null,"code":"organization_spend_limit_exceeded"}}',
    'insufficient_quota',
  ],
  [
    'OpenAI 429 slow_down（请求速率增长过快）',
    'openai_responses',
    OPENAI,
    429,
    '{"error":{"message":"Your request rate increased too quickly.","type":"rate_limit_error","param":null,"code":"slow_down"}}',
    'rate_limited',
  ],
  [
    '阶跃星辰 429 project_credit_limit_exceeded（项目 Credit 上限）',
    'openai_chat_completions',
    STEPFUN,
    429,
    '{"error":{"message":"项目达到当期 Credit 上限","type":"project_credit_limit_exceeded"}}',
    'insufficient_quota',
  ],
  [
    'Anthropic 429 enforced_spend_limit_reached（月度支出上限）',
    'anthropic_messages',
    ANTHROPIC,
    429,
    '{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-12-01 at 00:00 UTC.","details":{"error_code":"enforced_spend_limit_reached"}},"request_id":"req_1"}',
    'insufficient_quota',
  ],
  [
    'Anthropic 400 自设支出上限',
    'anthropic_messages',
    ANTHROPIC,
    400,
    '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."},"request_id":"req_1"}',
    'insufficient_quota',
  ],
] as const)(
  '发往官方地址的对话请求：%s，协议 %s；按错误码文档归类，限流重发 5 次，其余不重发',
  async (_, kind, baseUrl, status, body, expected) => {
    let requests = 0
    const answered = spyOn(globalThis, 'fetch').mockImplementation((async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      requests++
      return new Response(body, { status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch)
    const backoffs: number[] = []
    try {
      const events = await runAgainst({
        kind,
        baseUrl,
        runId: 'rn_official',
        sleep: async (ms) => {
          backoffs.push(ms)
        },
      })
      const err = events.find((e) => e.type === 'run.error')
      expect(err?.type === 'run.error' && err.code).toBe(expected)
      const resends = expected === 'rate_limited' ? RESEND_LIMIT : 0
      expect(backoffs).toHaveLength(resends)
      expect(requests).toBe(resends + 1)
    } finally {
      answered.mockRestore()
    }
  },
  20_000,
)

/**
 * 经云端网关的对话请求，上游在流中报告失败：网关按上游的渠道商归类，把错误事件的类型与错误码改写为归类所得的错误码，
 * 电脑端连接云端时渠道商为 null，按该错误码归类。原始失败形状：百炼以 `insufficient_quota` 报告 TPM 限流，事件保留上游的
 * 类型与错误码，电脑端按错误码表归为额度用尽，不重发。改写后的事件（云端网关输出的字节）归为限流，重发 5 次。
 */
test('经云端网关的流内错误事件：类型与错误码为网关归类所得的 rate_limited 时归为限流，重发 5 次', async () => {
  let requests = 0
  const answered = spyOn(globalThis, 'fetch').mockImplementation((async () => {
    requests++
    return new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"error":{"message":"上游请求过多，请稍后重试","type":"rate_limited","param":null,"code":"rate_limited"}}\n\n' +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof fetch)
  const backoffs: number[] = []
  try {
    const events = await runAgainst({
      kind: 'openai_chat_completions',
      baseUrl: 'https://cloud.example.com/v1',
      runId: 'rn_gateway_stream',
      sleep: async (ms) => {
        backoffs.push(ms)
      },
    })
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('rate_limited')
    expect(backoffs).toHaveLength(RESEND_LIMIT)
    expect(requests).toBe(RESEND_LIMIT + 1)
  } finally {
    answered.mockRestore()
  }
}, 20_000)
