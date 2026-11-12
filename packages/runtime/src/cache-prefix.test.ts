/**
 * 新会话首轮的前两次 Anthropic 请求：第 2 次请求能否命中第 1 次在断点处写入的缓存条目。
 *
 * 覆盖范围：`session.ts` 装配的系统提示词、工具与首条用户消息，`agent/loop/index.ts` 的断点位置，
 * `ai/providers/anthropic.ts` 的请求体与 `cache_control`。经真实 `Session`、真实 `read_file`、真实 `Store`
 * 与本地 HTTP 端点执行，断言针对端点实际收到的请求体。
 *
 * 对照的现象：账本中部分新会话的第 2 次请求缓存读取为 0、整段重新写入。本用例锁定本机一侧的前提：
 * 第 2 次请求体以第 1 次的全部已标记前缀开头，且在同一位置带断点，命中与否只取决于两次请求是否落在同一份缓存上。
 */

import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attachment } from '@qywork/core'
import { ContentStore, Store } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { Session } from './session.ts'

function sse(events: Record<string, unknown>[]): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

const START = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
}

const readCall = () =>
  sse([
    START,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'notes.md' }) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])

const done = () =>
  sse([
    START,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已读完。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])

type Block = Record<string, unknown>

/**
 * 按渲染顺序（tools → system → messages）展开为块序列，每块去掉 `cache_control` 后序列化；
 * `marks` 为带 `cache_control` 的块的下标。
 */
function flatten(body: { tools: Block[]; system: Block[]; messages: Block[] }) {
  const blocks: string[] = []
  const marks: number[] = []
  const push = (scope: string, block: Block) => {
    const { cache_control, ...rest } = block
    if (cache_control) marks.push(blocks.length)
    blocks.push(`${scope}:${JSON.stringify(rest)}`)
  }
  for (const t of body.tools) push('tool', t)
  for (const s of body.system) push('system', s)
  for (const m of body.messages) {
    const content =
      typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Block[])
    for (const b of content) push(String(m.role), b)
  }
  return { blocks, marks }
}

/** 1×1 的 PNG：在附件的缩放上限以内，按原样编码。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test.each([
  ['首条消息只有文字', false],
  ['首条消息带图片附件', true],
])(
  '新会话首轮（%s）：第 2 次请求以第 1 次的全部已标记前缀开头，并在同一位置带断点',
  async (_, image) => {
    const bodies: { tools: Block[]; system: Block[]; messages: Block[] }[] = []
    const script = [readCall, done]
    const provider = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as (typeof bodies)[number])
        return (script.shift() ?? done)()
      },
    })
    const store = new Store({ path: ':memory:' })
    const config: QyConfig = {
      active: { provider: 'relay', model: 'claude-opus-5-5' },
      providers: {
        relay: {
          kind: 'anthropic_messages',
          apiKey: 'test-key',
          baseUrl: `http://127.0.0.1:${provider.port}`,
          models: { 'claude-opus-5-5': {} },
        },
      },
    }
    const workspaceRoot = await mkdtemp(
      join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'cache-prefix-'),
    )
    await writeFile(join(workspaceRoot, 'notes.md'), '# 笔记\n\n第一行。\n')
    await writeFile(join(workspaceRoot, 'shot.png'), PNG)
    const attachments: Attachment[] = image
      ? [{ type: 'image', name: 'shot.png', mime: 'image/png', size: PNG.length, path: 'shot.png' }]
      : []
    const session = new Session({
      content: new ContentStore(':memory:'),
      store,
      config,
      workspaceRoot,
      signal: new AbortController().signal,
      allowedTools: ['read_file'],
    })
    try {
      for await (const _ of session.ask('读一下 notes.md', undefined, { attachments })) {
        // 断言针对端点收到的请求体。
      }
      expect(bodies).toHaveLength(2)
      const [first, second] = bodies.map(flatten)
      expect(first!.blocks.some((b) => b.startsWith('user:{"type":"image"'))).toBe(image)
      expect(JSON.stringify(bodies[1]!.tools)).toBe(JSON.stringify(bodies[0]!.tools))
      expect(JSON.stringify(bodies[1]!.system)).toBe(JSON.stringify(bodies[0]!.system))
      // 第 1 次在每个断点处写入一个条目，最长的一个止于其最后一个断点。
      const written = first!.marks.at(-1)!
      expect(written).toBe(first!.blocks.length - 1)
      expect(second!.blocks.slice(0, written + 1)).toEqual(first!.blocks.slice(0, written + 1))
      expect(second!.marks).toContain(written)
      expect(second!.blocks.length).toBeGreaterThan(first!.blocks.length)
    } finally {
      session.dispose()
      store.close()
      provider.stop(true)
    }
  },
  20_000,
)
