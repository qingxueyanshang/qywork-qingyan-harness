/**
 * 覆盖 strict 形状的工具参数还原（`ai/src/providers/openai-compat.ts` 的 `restoreStrictCalls`，两条 OpenAI 协议的适配器解析工具调用时调用）：
 * `background_command` 经真实适配器、执行循环与注册表的完整路径，以及全部内置工具的参数 schema 经 Chat Completions 适配器的还原。
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop, Ports, provide, type ToolOutcome, ToolRegistry } from '@qywork/agent'
import { baseCtx, noopPersistence } from '@qywork/agent/fixtures.test-helper'
import { buildAdapter, type ToolSchema } from '@qywork/ai'
import type { MediaOutput } from '@qywork/core'
import { MEDIA_TOOLS } from './generate.ts'
import { registerToolCatalog } from './index.ts'
import { CommandPort } from './shell/port.ts'
import { backgroundCommandTool } from './shell.ts'

const TASK = 'cmd_1b583aa7'
/** 账本中记录的原始参数：strict 形状下模型为不提供的 `wait_seconds` 填写 null。 */
const STRICT_ARGS = { stop: true, task_id: TASK, wait_seconds: null }

function sse(events: Record<string, unknown>[], named: boolean): Response {
  const text = events
    .map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`)
    .join('')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

/** 第一轮返回带 null 的工具调用，之后返回一段正文结束本轮。 */
function reply(kind: 'openai_responses' | 'openai_chat_completions', round: number): Response {
  const args = JSON.stringify(STRICT_ARGS)
  if (kind === 'openai_responses') {
    const output =
      round === 0
        ? [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'background_command',
              arguments: args,
            },
          ]
        : []
    return sse(
      [
        ...(round === 0
          ? []
          : [{ type: 'response.output_text.delta', delta: '已停止', output_index: 0 }]),
        {
          type: 'response.completed',
          response: { status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ],
      true,
    )
  }
  const delta =
    round === 0
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'background_command', arguments: args },
            },
          ],
        }
      : { content: '已停止' }
  return sse([{ choices: [{ delta, finish_reason: round === 0 ? 'tool_calls' : 'stop' }] }], false)
}

/** 只记录停止调用的后台命令端口，任务表中有一条运行中的命令。 */
function commandPort(stopped: string[]): CommandPort {
  const running = { command: 'npm run dev', stdout: 'ready\n', stderr: '' }
  return {
    steered: () => new Promise(() => {}),
    ended: (id) => (id === TASK ? new Promise(() => {}) : null),
    adopt: () => {
      throw new Error('本用例不启动命令')
    },
    list: () => [{ id: TASK, command: running.command }],
    output: (id) => (id === TASK ? { ...running, dropped: { stdout: 0, stderr: 0 } } : null),
    stop: (id) => {
      stopped.push(id)
      return id === TASK ? running.command : null
    },
    write: () => null,
  }
}

/**
 * 原始失败形状：strict 形状下模型无法省略 `wait_seconds`，只能填写 null；该值原样到达工具时，
 * `{stop: true, task_id, wait_seconds: null}` 被判为「wait_seconds 与 stop 不能同时使用」，
 * 重复三轮后本轮以 no_progress 停止。
 */
describe.each(['openai_responses', 'openai_chat_completions'] as const)(
  '%s 的 strict 形状：可选参数的 null 等同于未提供',
  (kind) => {
    test('stop 与 wait_seconds: null 一起到达时停止后台命令，工具与账本收到的参数中没有该键', async () => {
      const bodies: Record<string, unknown>[] = []
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
          bodies.push((await req.json()) as Record<string, unknown>)
          return reply(kind, bodies.length - 1)
        },
      })
      try {
        const received: Record<string, unknown>[] = []
        const ledger: Record<string, unknown>[] = []
        const stopped: string[] = []
        const registry = new ToolRegistry()
        registry.register({
          ...backgroundCommandTool,
          fn: (args, ctx) => {
            received.push(args)
            return backgroundCommandTool.fn(args, ctx)
          },
        })
        const persist = noopPersistence()
        const loop = new AgentLoop({
          adapter: buildAdapter({
            model: 'gpt-6.1-sol',
            kind,
            apiKey: 'test',
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          }),
          registry,
          systemPrompt: 'sys',
          persist: {
            ...persist,
            openToolStep: (...input) => {
              ledger.push(input[2].arguments)
              return persist.openToolStep(...input)
            },
          },
          makeToolContext: (runId) => ({
            ...baseCtx(runId),
            port: new Ports([provide(CommandPort, commandPort(stopped))]).get,
          }),
        })
        const outcomes: ToolOutcome[] = []
        let stopReason: string | undefined
        for await (const event of loop.run({
          compactPercent: 80,
          runId: 'rn_strict_null' as never,
          history: [{ role: 'user', content: `停止后台命令 ${TASK}` }],
          signal: new AbortController().signal,
        })) {
          if (event.type === 'tool.finished') outcomes.push(event.outcome)
          if (event.type === 'run.finished') stopReason = event.stopReason
        }

        // 工具 schema 以 strict 形状发出：wait_seconds 列入 required，类型允许 null。
        const tools = bodies[0]!.tools as Record<string, unknown>[]
        const sent = (kind === 'openai_responses' ? tools[0] : tools[0]!.function) as {
          strict?: boolean
          parameters: { required: string[]; properties: Record<string, { type: unknown }> }
        }
        expect(sent.strict).toBe(true)
        expect(sent.parameters.required).toContain('wait_seconds')
        expect(sent.parameters.properties.wait_seconds!.type).toEqual(['number', 'null'])

        expect(outcomes).toHaveLength(1)
        expect(outcomes[0]).toMatchObject({ status: 'success', executed: true })
        expect(outcomes[0]!.message).toContain(`已停止后台命令 ${TASK}`)
        expect(stopped).toEqual([TASK])
        expect(received).toEqual([{ stop: true, task_id: TASK }])
        expect(ledger).toEqual(received)
        expect(stopReason).toBe('completed')
      } finally {
        await server.stop(true)
      }
    })
  },
)

/** 注册全部内置工具，包括只在提供端口时注册的工具与按需工具的读取入口。 */
function builtinSchemas(): ToolSchema[] {
  const registry = new ToolRegistry()
  registerToolCatalog(registry, Object.keys(MEDIA_TOOLS) as MediaOutput[])
  return registry.schemas()
}

/** schema 中每个可选属性的位置（键名序列，`[]` 表示数组元素）与该属性的 schema。 */
function optionalProperties(
  schema: Record<string, unknown>,
  at: string[] = [],
): { at: string[]; schema: Record<string, unknown> }[] {
  const out: { at: string[]; schema: Record<string, unknown> }[] = []
  const items = schema.items as Record<string, unknown> | undefined
  if (items) out.push(...optionalProperties(items, [...at, '[]']))
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  const required = new Set((schema.required as string[] | undefined) ?? [])
  for (const [key, child] of Object.entries(props ?? {})) {
    if (!required.has(key)) out.push({ at: [...at, key], schema: child })
    out.push(...optionalProperties(child, [...at, key]))
  }
  return out
}

/** 沿位置逐层构造参数，末端的键取 `leaf`；`leaf` 为 undefined 时末端的键不出现。 */
function argsAt(at: string[], leaf: unknown): unknown {
  const [head, ...rest] = at
  if (head === undefined) return leaf
  if (head === '[]') return [argsAt(rest, leaf)]
  if (rest.length === 0) return leaf === undefined ? {} : { [head]: leaf }
  return { [head]: argsAt(rest, leaf) }
}

/** 经 Chat Completions 适配器解析一组工具调用，返回还原后的参数：模拟端点在一次答复中返回全部调用。 */
async function restoredArguments(
  tools: ToolSchema[],
  calls: { name: string; args: unknown }[],
): Promise<Record<string, unknown>[]> {
  const toolCalls = calls.map((c, index) => ({
    index,
    id: `call_${index}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      sse(
        [{ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }] }],
        false,
      ),
  })
  try {
    const adapter = buildAdapter({
      model: 'gpt-6.1-sol',
      kind: 'openai_chat_completions',
      apiKey: 'test',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    })
    for await (const event of adapter.stream({
      model: 'gpt-6.1-sol',
      system: [],
      messages: [{ role: 'user', content: '调用工具' }],
      tools,
      maxOutputTokens: null,
      idleTimeoutMs: 10_000,
    })) {
      if (event.type === 'tool_calls') return event.calls.map((c) => c.arguments)
    }
    throw new Error('适配器没有产出工具调用')
  } finally {
    await server.stop(true)
  }
}

describe('全部内置工具的可选参数', () => {
  /**
   * 新增工具的可选属性若写成 strict 形状无法表示「不提供」的类型（没有 `type`、或 `type` 为数组），
   * 模型在 strict 形状下只能为它填写实际值，本用例列出该属性。类型已含 null 的属性按其声明保留 null，不在检查范围内。
   */
  test('strict 形状下填写 null 与省略该键，经适配器还原后的参数相同', async () => {
    const schemas = builtinSchemas()
    expect(schemas.length).toBeGreaterThan(50)
    const cases: { label: string; name: string; withNull: unknown; omitted: unknown }[] = []
    for (const tool of schemas) {
      // 按需工具在请求中只有桩定义，不以 strict 发送；完整定义由 load_tool 以文本返回，参数不经 strict 还原。
      if (tool.parameters.additionalProperties === true) {
        expect(tool.strict).toBe(false)
        continue
      }
      expect(tool.strict).toBe(true)
      for (const { at, schema } of optionalProperties(tool.parameters)) {
        const type = schema.type
        if (Array.isArray(type) && type.includes('null')) continue
        cases.push({
          label: `${tool.name}.${at.join('.')}`,
          name: tool.name,
          withNull: argsAt(at, null),
          omitted: argsAt(at, undefined),
        })
      }
    }
    expect(cases.length).toBeGreaterThan(100)
    const restored = await restoredArguments(
      schemas,
      cases.flatMap((c) => [
        { name: c.name, args: c.withNull },
        { name: c.name, args: c.omitted },
      ]),
    )
    expect(restored).toHaveLength(cases.length * 2)
    const differing = cases
      .filter((_, i) => !Bun.deepEquals(restored[2 * i], restored[2 * i + 1]))
      .map((c) => c.label)
    expect(differing).toEqual([])
  })
})
