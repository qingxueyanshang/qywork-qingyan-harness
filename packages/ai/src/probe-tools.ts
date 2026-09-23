/** 工具契约检测：只验证生成的参数及工具结果回传，不执行任何外部动作。 */
import type { ToolCallCheck, ToolSchemaMode } from '@qywork/core'
import { ProviderError } from './errors.ts'
import { buildAdapter } from './factory.ts'
import type { ProbeStep } from './probe.ts'
import type { ChatRequest, ProviderProfile, WireMessage, WireToolCall } from './types.ts'

const TOOL = 'qy_tool_probe'
const URL = 'pelican-bicycle.html'
const tools: ChatRequest['tools'] = [
  {
    name: TOOL,
    description: '检查参数并回传凭据的诊断工具，无外部副作用。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        url: { type: 'string' },
        tabId: { type: 'string' },
        count: { type: 'integer' },
        enabled: { type: 'boolean' },
        payload: {
          type: 'object',
          properties: { tags: { type: 'array', items: { type: 'string' } } },
          required: ['tags'],
          additionalProperties: false,
        },
      },
      required: ['label', 'count', 'enabled', 'payload'],
      additionalProperties: false,
    },
  },
]

function validArguments(call: WireToolCall, label: string, schema: ToolSchemaMode): boolean {
  const a = call.arguments
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false
  const payload = a.payload as { tags?: unknown } | undefined
  return (
    a.label === label &&
    a.url === URL &&
    a.count === 7 &&
    a.enabled === false &&
    (schema === 'openai_strict' ? a.tabId === null : a.tabId === undefined) &&
    Object.keys(a).every((k) =>
      ['label', 'url', 'tabId', 'count', 'enabled', 'payload'].includes(k),
    ) &&
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 1 &&
    JSON.stringify(payload.tags) === '["甲","乙"]'
  )
}

export async function probeToolCalls(
  profile: ProviderProfile,
  signal?: AbortSignal,
): Promise<{
  check: ToolCallCheck
  steps: ProbeStep[]
}> {
  const adapter = buildAdapter(profile)
  const check: ToolCallCheck = {
    kind: profile.kind,
    model: profile.model,
    baseUrl: profile.baseUrl ?? '',
    schema: adapter.spec.chatToolSchema,
    checkedAt: Date.now(),
    status: 'inconclusive',
  }
  const steps: ProbeStep[] = []
  const messages: WireMessage[] = [
    {
      role: 'user',
      content: `进行两轮工具协议检测。先调用 ${TOOL}：label="probe"，url="${URL}"，count=7，enabled=false，payload={"tags":["甲","乙"]}；tabId 不提供（严格模式可填 null）。收到工具结果的 receipt 后，再调用同一工具，将 label 改为 receipt 原值，其余参数不变。每轮只调用一次，不要用普通文字代替调用。`,
    },
  ]
  let label = 'probe'
  for (let round = 0; round < 2; round++) {
    const name = round === 0 ? '工具参数' : '工具结果回传'
    let text = '',
      reasoning = ''
    let responseReasoning: WireMessage['responseReasoning']
    let stop: string | undefined
    let calls: WireToolCall[] = []
    try {
      const timeout = AbortSignal.timeout(90_000)
      for await (const event of adapter.stream({
        model: profile.model,
        system: [],
        messages,
        tools,
        maxOutputTokens: 2048,
        idleTimeoutMs: 60_000,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })) {
        if (event.type === 'text_delta') text += event.delta
        if (event.type === 'thinking_delta') reasoning += event.delta
        if (event.type === 'response_reasoning') responseReasoning = event.reasoning
        if (event.type === 'tool_calls') calls = event.calls
        if (event.type === 'done') stop = event.stopReason
      }
      if (stop === 'max_tokens') {
        steps.push({
          name,
          ok: false,
          inconclusive: true,
          detail: '检测输出达到上限，工具契约未确认',
        })
        break
      }
      if (calls.length === 0) {
        const malformed = text.includes('<tool_call>')
        check.status = malformed ? 'failed' : 'inconclusive'
        steps.push({
          name,
          ok: false,
          ...(!malformed ? { inconclusive: true } : {}),
          detail: malformed
            ? '工具调用标记出现在正文，未收到结构化工具调用'
            : '未返回工具调用，工具能力未确认',
        })
        break
      }
      const call = calls[0]!
      if (
        calls.length !== 1 ||
        call.name !== TOOL ||
        call.argumentsError !== undefined ||
        !validArguments(call, label, check.schema) ||
        text.includes('<tool_call>')
      ) {
        check.status = 'failed'
        steps.push({
          name,
          ok: false,
          detail:
            call.argumentsError !== undefined
              ? `工具参数不是完整 JSON：${call.argumentsError.slice(0, 240)}`
              : '工具名、参数类型或回传凭据不符合检测约定',
        })
        break
      }
      steps.push({
        name,
        ok: true,
        detail:
          round === 0
            ? '字符串、可选字段、数字、布尔和嵌套参数完整'
            : '下一轮正确使用工具返回的凭据',
      })
      if (round === 1) {
        check.status = 'passed'
        break
      }
      // 回传的只有真实收到的模型消息。凭据在工具结果中首次出现，下一轮必须读到它。
      label = crypto.randomUUID()
      messages.push(
        {
          role: 'assistant',
          content: text,
          toolCalls: calls,
          ...(reasoning ? { reasoningContent: reasoning } : {}),
          ...(responseReasoning ? { responseReasoning } : {}),
        },
        { role: 'tool', toolCallId: call.id, content: JSON.stringify({ receipt: label }) },
      )
    } catch (err) {
      const rejected = err instanceof ProviderError && err.code === 'invalid_request'
      check.status = rejected ? 'failed' : 'inconclusive'
      steps.push({
        name,
        ok: false,
        ...(!rejected ? { inconclusive: true } : {}),
        detail: err instanceof Error ? err.message : String(err),
      })
      break
    }
  }
  return { check, steps }
}
