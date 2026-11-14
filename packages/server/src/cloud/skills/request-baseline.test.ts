/**
 * 未提供云端技能端口的会话：经请求装配与三家适配器序列化得到的请求体与期望值逐字节相同。
 *
 * 覆盖范围：`runtime/session.ts` 的装配（系统提示词、工具表、上下文末尾的技能索引、历史投影），
 * `read_skill` 与 `tools` 中识别云端技能路径的读取工具（`read_file`、`list_dir`、`glob`、`grep`）在未提供端口时的结果，
 * 以及 `ai` 三家适配器的序列化。模型由本进程内的端点按脚本回复。
 *
 * 期望值是不含云端技能改动的代码对同一夹具的输出。请求体中随机器与运行变化的部分在比较前替换为占位：
 * 工作区路径、会话与运行的编号、日期、平台名称、运行环境一节、`grep` 的引擎名称，以及路径中的反斜杠。
 * 修改这些工具的说明、系统提示词或技能索引的格式后，按失败信息中的实际值更新期望值。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderKind } from '@qywork/core'
import { type QyConfig, Session } from '@qywork/runtime'
import { ContentStore, Store } from '@qywork/store'

const SCRIPT: [string, Record<string, unknown>][] = [
  ['read_skill', { name: 'demo' }],
  ['read_file', { path: 'notes.md' }],
  ['list_dir', { path: '.' }],
  ['glob', { pattern: 'src/*.ts' }],
  ['grep', { pattern: '步骤', path: 'notes.md' }],
]

const PROTOCOLS: { provider: string; kind: ProviderKind; model: string }[] = [
  { provider: 'anthropic', kind: 'anthropic_messages', model: 'claude-opus-5' },
  { provider: 'chat', kind: 'openai_chat_completions', model: 'deepseek-chat' },
  { provider: 'responses', kind: 'openai_responses', model: 'deepseek-flash' },
]

/** 期望值：各协议全部请求体按顺序以换行连接、替换占位后的 SHA-256。 */
const EXPECTED: Record<string, string> = {
  anthropic: 'd8fa9cd1aef44e11bbe0e2228850d9df1aa544503a1c58b6efcd3214133331f7',
  chat: '18f8fc7ebc8bdc4279df07c1a48d131d3cadb05f8f8321f38957886bff6dc06a',
  responses: 'b2da2d62f40e001cb0f85270af5edf15fa02374d79f7cdb7e7b7a9df852b124d',
}

function sse(events: Record<string, unknown>[], named: boolean): string {
  return (
    events
      .map((e) => `${named ? `event: ${String(e.type)}\n` : ''}data: ${JSON.stringify(e)}\n\n`)
      .join('') + (named ? '' : 'data: [DONE]\n\n')
  )
}

/** 一次回复：调用一个工具，或 `call` 为 null 时输出一段文字并结束。 */
function reply(kind: ProviderKind, step: number, call: [string, Record<string, unknown>] | null) {
  const id = `call_${step}`
  const args = call ? JSON.stringify(call[1]) : ''
  if (kind === 'openai_chat_completions') {
    const delta = call
      ? {
          tool_calls: [
            { index: 0, id, type: 'function', function: { name: call[0], arguments: args } },
          ],
        }
      : { content: '完成' }
    return sse(
      [
        { choices: [{ index: 0, delta }] },
        { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
      ],
      false,
    )
  }
  if (kind === 'openai_responses') {
    const item = call
      ? {
          type: 'function_call',
          id: `fc_${step}`,
          call_id: id,
          name: call[0],
          arguments: args,
          status: 'completed',
        }
      : {
          type: 'message',
          id: `msg_${step}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '完成', annotations: [] }],
        }
    return sse(
      [
        { type: 'response.created', response: { id: `resp_${step}`, status: 'in_progress' } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, ...(call ? { arguments: '' } : { content: [] }) },
        },
        call
          ? {
              type: 'response.function_call_arguments.done',
              item_id: `fc_${step}`,
              output_index: 0,
              arguments: args,
            }
          : {
              type: 'response.output_text.delta',
              item_id: `msg_${step}`,
              output_index: 0,
              content_index: 0,
              delta: '完成',
            },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: `resp_${step}`,
            status: 'completed',
            usage: { input_tokens: 100, output_tokens: 10 },
          },
        },
      ],
      true,
    )
  }
  return sse(
    [
      {
        type: 'message_start',
        message: {
          id: `msg_${step}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: call
          ? { type: 'tool_use', id, name: call[0], input: {} }
          : { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: call
          ? { type: 'input_json_delta', partial_json: args }
          : { type: 'text_delta', text: '完成' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    ],
    true,
  )
}

let server: ReturnType<typeof Bun.serve>
let kind: ProviderKind = 'anthropic_messages'
let step = 0
const bodies: string[] = []
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'request-baseline-'))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.text())
      const call = SCRIPT[step] ?? null
      const body = reply(kind, step, call)
      step++
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
})

afterAll(() => server.stop(true))

/** 替换随机器与运行变化的部分。 */
function normalize(raw: string, workspace: string): string {
  const once = JSON.stringify(workspace).slice(1, -1)
  const twice = JSON.stringify(once).slice(1, -1)
  return raw
    .replaceAll(twice, '<ws>')
    .replaceAll(once, '<ws>')
    .replaceAll(workspace, '<ws>')
    .replace(/\b[a-z]{2}_[0-9a-z]{12,}\b/g, '<id>')
    .replace(/当前日期：\d{4}-\d{2}-\d{2}/g, '当前日期：<date>')
    .replace(/平台：(Windows|macOS|Linux)/g, '平台：<os>')
    .replace(/## 运行环境（本轮开始时读取本机目录）.*?\\n\\n/g, '<environment>')
    .replace(/（ripgrep）|（内置遍历，未找到 ripgrep）/g, '（<engine>）')
    .replace(/\\"engine\\":\\"(ripgrep|builtin)\\"/g, '<engine>')
    .replace(/(\\\\)+/g, '/')
}

test('未提供云端技能端口时三家协议的请求体与期望值逐字节相同', async () => {
  const actual: Record<string, string> = {}
  for (const p of PROTOCOLS) {
    const workspace = await mkdtemp(join(root, 'ws-'))
    await mkdir(join(workspace, '.agents', 'skills', 'demo'), { recursive: true })
    await writeFile(
      join(workspace, '.agents', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: 演示流程\n---\n\n1. 读取 notes.md\n2. 汇总步骤\n',
    )
    await writeFile(join(workspace, 'notes.md'), '第一步：准备\n第二步：汇总步骤\n')
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
    const store = new Store({ path: ':memory:' })
    const content = new ContentStore(':memory:')
    const config: QyConfig = {
      active: { provider: p.provider, model: p.model },
      providers: {
        [p.provider]: {
          kind: p.kind,
          apiKey: 'test-key',
          baseUrl: `http://127.0.0.1:${server.port}`,
          models: { [p.model]: {} },
        },
      },
      officePython: join(root, 'no-python.exe'),
    }
    kind = p.kind
    step = 0
    bodies.length = 0
    const session = new Session({
      content,
      store,
      config,
      workspaceRoot: workspace,
      signal: new AbortController().signal,
      allowedTools: ['read_skill', 'read_file', 'list_dir', 'glob', 'grep'],
    })
    const errors: unknown[] = []
    for await (const ev of session.ask('按 demo 技能整理笔记')) {
      if (ev.type === 'run.error') errors.push(ev)
    }
    await session.dispose()
    store.close()
    content.close()
    expect(errors).toEqual([])
    expect(bodies).toHaveLength(SCRIPT.length + 1)
    const joined = bodies.map((b) => normalize(b, workspace)).join('\n')
    actual[p.provider] = new Bun.CryptoHasher('sha256').update(joined).digest('hex')
  }
  expect(actual).toEqual(EXPECTED)
}, 60_000)
