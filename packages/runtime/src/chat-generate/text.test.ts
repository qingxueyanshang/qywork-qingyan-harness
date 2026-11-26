/**
 * 覆盖范围：`text.ts` 的 `generateText`（经 `media.ts` 的 `makeMediaPort` 分派）与 `run.ts` 中两类共用的请求、计费、失败，
 * 以及参考视频的发送方式（`videoBlocks`：原生发送或经 Office worker 抽帧；art 另附视频相对页面的路径）。
 * 重发与重发日志由 `art.test.ts` 覆盖，两类经同一个 `runChatGeneration`。
 *
 * 对端是本机模拟的对话接口（OpenAI 兼容协议），按脚本返回 SSE 正文，并记录收到的请求体。
 * worker 由 tools 的 `office-worker.test-helper.ts`（由 Bun 执行）代替 Python。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaSpend } from '@qywork/core'
import type { OfficePort } from '@qywork/tools'
import type { QyConfig } from '../config.ts'
import { makeMediaPort } from '../media.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

/** 只有索引的 mp4：`mvhd` 写入时长，`tkhd` 写入画面尺寸；时长与尺寸由 `videoMetaOf` 读出。 */
function mp4(seconds: number, w: number, h: number): Uint8Array {
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt32BE(1000, 12)
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16)
  const tkhd = Buffer.alloc(84)
  tkhd.writeInt32BE(0x10000, 40)
  tkhd.writeUInt32BE(w * 65536, 76)
  tkhd.writeUInt32BE(h * 65536, 80)
  return new Uint8Array(
    Buffer.concat([
      box('ftyp', Buffer.from('isom0000', 'latin1')),
      box('mdat', Buffer.alloc(4096)),
      box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd))),
    ]),
  )
}

let server: ReturnType<typeof Bun.serve>
let bodies: Record<string, unknown>[] = []
let answer = ''
let finish = 'stop'

const sse = (text: string) => {
  const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
  return (
    chunk({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    chunk({
      choices: [{ delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 800, completion_tokens: 512 },
    }) +
    'data: [DONE]\n\n'
  )
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      bodies.push((await req.json()) as Record<string, unknown>)
      return new Response(sse(answer), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  bodies = []
  finish = 'stop'
})

const config = (): QyConfig => ({
  active: { provider: 'relay', model: 'chat-model' },
  providers: {
    relay: {
      kind: 'openai_chat_completions',
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: { 'chat-model': {} },
    },
  },
})

const generate = (over: Record<string, unknown>, onSpend?: (s: MediaSpend) => void) =>
  makeMediaPort(config(), onSpend).generate(
    { type: 'text', prompt: '为图1写三句旁白', inputs: [], params: {}, ...over },
    new AbortController().signal,
  )

describe('文本生成', () => {
  test('请求依次带编号的参考图与要求，不带工具；产物是回复全文的 Markdown 文件，花费按输出 token 记账', async () => {
    answer = '\n\n雨夜，小满推开门。\n灯光落在她的肩上。\n她没有回头。\n\n'
    const spends: MediaSpend[] = []
    const result = await generate(
      { inputs: [{ role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' }] },
      (s) => spends.push(s),
    )
    if (!result.ok) throw new Error(result.message)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.mime).toBe('text/markdown')
    expect(new TextDecoder().decode(result.files[0]!.bytes)).toBe(
      '雨夜，小满推开门。\n灯光落在她的肩上。\n她没有回头。\n',
    )
    expect(result.warning).toBeUndefined()

    const body = bodies[0]!
    const messages = body.messages as { role: string; content: unknown }[]
    expect(JSON.stringify(messages[0])).toContain('Markdown')
    const user = JSON.stringify(messages.find((m) => m.role === 'user'))
    const order = ['图1：', 'data:image/png;base64,', '要求：为图1写三句旁白']
    const at = order.map((s) => user.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(body.tools).toBeUndefined()
    expect(spends).toEqual([
      expect.objectContaining({
        provider: 'relay',
        model: 'chat-model',
        output: 'text',
        quantity: 512,
      }),
    ])
  })

  test('输出达到上限时返回已写出的部分并附带警告；回复为空时失败，花费照常记账', async () => {
    finish = 'length'
    answer = '第一段。\n第二段写到一半'
    const truncated = await generate({})
    if (!truncated.ok) throw new Error(truncated.message)
    expect(new TextDecoder().decode(truncated.files[0]!.bytes)).toBe('第一段。\n第二段写到一半\n')
    expect(truncated.warning).toBe('输出达到上限，文本不完整')

    finish = 'stop'
    answer = '   '
    const spends: MediaSpend[] = []
    expect(await generate({}, (s) => spends.push(s))).toEqual({
      ok: false,
      message: 'relay / chat-model：回复为空',
    })
    expect(spends).toHaveLength(1)
  })
})

describe('文本生成：参考视频', () => {
  const OFFICE: OfficePort = {
    python: process.execPath,
    worker: join(import.meta.dir, '../../../tools/src/office-worker.test-helper.ts'),
    apps: {
      docx: { available: true, reason: '' },
      xlsx: { available: true, reason: '' },
      pptx: { available: true, reason: '' },
    },
    videoDecoder: true,
    enabled: () => true,
  }
  const withModel = (model: string): QyConfig => ({
    active: { provider: 'relay', model },
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'sk-test',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        models: { [model]: {} },
      },
    },
  })
  /** 工作区中的一段 5 秒、640×360 的视频；返回工作区与视频的绝对路径。 */
  async function clip(): Promise<{ root: string; path: string; bytes: Uint8Array }> {
    const root = await mkdtemp(join(tmpdir(), 'qywork-chat-video-'))
    const path = join(root, 'clip.mp4')
    const bytes = mp4(5, 640, 360)
    await writeFile(path, bytes)
    return { root, path, bytes }
  }

  test('模型接受原生视频时以视频块发送，前面写明名称、时长与画面尺寸', async () => {
    answer = '镜头从门口推进。'
    const { root, path, bytes } = await clip()
    const result = await makeMediaPort(withModel('qwen3.8-flash')).generate(
      {
        type: 'text',
        prompt: '描述视频1',
        inputs: [{ role: 'video', bytes, mime: 'video/mp4', path }],
        params: {},
        workspaceRoot: root,
      },
      new AbortController().signal,
    )
    if (!result.ok) throw new Error(result.message)
    const user = JSON.stringify((bodies[0]!.messages as { role: string }[]).at(-1))
    const order = ['视频1（时长 5 秒，640×360）：', 'data:video/mp4;base64,', '要求：描述视频1']
    const at = order.map((s) => user.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  /** 原始需求：Art 卡与文本生成卡接视频，常用的对话模型不接受原生视频。 */
  test('模型不接受原生视频时按画面变化抽帧，帧作为图片发送并写明时刻；抽帧的临时目录随即删除', async () => {
    answer = '门开了。'
    const { root, path, bytes } = await clip()
    const result = await makeMediaPort(withModel('chat-model'), undefined, OFFICE).generate(
      {
        type: 'text',
        prompt: '描述视频1',
        inputs: [{ role: 'video', bytes, mime: 'video/mp4', path }],
        params: {},
        workspaceRoot: root,
      },
      new AbortController().signal,
    )
    if (!result.ok) throw new Error(result.message)
    const user = JSON.stringify((bodies[0]!.messages as { role: string }[]).at(-1))
    expect(user).not.toContain('data:video/mp4')
    const order = [
      '视频1（时长 5 秒，640×360）：按画面变化抽取的 2 帧',
      '视频1 00:00.0：',
      'data:image/',
      '视频1 00:01.0：',
      '要求：描述视频1',
    ]
    const at = order.map((s) => user.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(await readdir(join(root, '.tmp', 'media-frames', 'office'))).toEqual([])
  })

  test('Art 的参考视频另附相对页面的路径，系统提示词写明页面中播放视频的写法', async () => {
    answer = '<!doctype html><html><body><video src="../clip.mp4"></video></body></html>'
    const { root, path, bytes } = await clip()
    const result = await makeMediaPort(withModel('qwen3.8-flash')).generate(
      {
        type: 'art',
        prompt: '把视频1放在页面中央',
        inputs: [{ role: 'video', bytes, mime: 'video/mp4', path }],
        params: {},
        outputDir: join(root, 'generated'),
        workspaceRoot: root,
      },
      new AbortController().signal,
    )
    if (!result.ok) throw new Error(result.message)
    const messages = bodies[0]!.messages as { role: string }[]
    expect(JSON.stringify(messages[0])).toContain('<video> 的 src 直接写这个路径')
    expect(JSON.stringify(messages.at(-1))).toContain('视频1（../clip.mp4，时长 5 秒，640×360）：')
  })

  test('模型不接受原生视频且没有 Office 端口时不发出请求，写明原因', async () => {
    const { root, path, bytes } = await clip()
    const result = await makeMediaPort(withModel('chat-model')).generate(
      {
        type: 'text',
        prompt: '描述视频1',
        inputs: [{ role: 'video', bytes, mime: 'video/mp4', path }],
        params: {},
        workspaceRoot: root,
      },
      new AbortController().signal,
    )
    expect(result).toEqual({
      ok: false,
      message:
        '视频1（clip.mp4）：当前模型不接受该视频，按画面抽帧需要 Office 的 Python 运行环境，当前没有可用的环境',
    })
    expect(bodies).toHaveLength(0)
  })
})
