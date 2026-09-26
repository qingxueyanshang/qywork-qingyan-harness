/**
 * 生成端口与参数表快照。
 *
 * 覆盖范围：`media.ts` 的 `makeMediaPort`（选模型、发出前校验、接口错误的转述）与 `operationOf`，
 * 以及 `prompt.ts` 里「可用的生成模型」那一节。
 *
 * 端口对面是一个本机假百炼端点：参数不合法时它必须一次都没收到请求。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { QyConfig } from './config.ts'
import { listMediaModels } from './config.ts'
import { makeMediaPort, operationOf } from './media.ts'
import { buildTailNotes } from './prompt.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1])

let server: ReturnType<typeof Bun.serve>
let hits: string[] = []
let reply: () => Response = () => Response.json({})

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/files/out.jpg') return new Response(JPEG)
      hits.push(path)
      return reply()
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  hits = []
  reply = () =>
    Response.json({
      output: {
        choices: [
          { message: { content: [{ image: `http://127.0.0.1:${server.port}/files/out.jpg` }] } },
        ],
      },
    })
})

const config = (over: Partial<QyConfig> = {}): QyConfig => ({
  providers: {
    qwen: {
      kind: 'openai_chat_completions',
      apiKey: 'sk-qwen',
      baseUrl: `http://127.0.0.1:${server.port}/compatible-mode/v1`,
      models: {},
      media: {
        'qwen-image-3.0': { kind: 'dashscope_images' },
        'wan2.7-image': { kind: 'dashscope_images' },
      },
    },
  },
  mediaDefaults: { image: { provider: 'qwen', model: 'qwen-image-3.0' } },
  ...over,
})

const signal = () => new AbortController().signal
const call = (over: Record<string, unknown> = {}) => ({
  type: 'image' as const,
  prompt: '一只猫',
  inputs: [],
  params: {},
  ...over,
})

describe('生成端口', () => {
  test('不点名用默认模型，结果是下载好的字节', async () => {
    const out = await makeMediaPort(config()).generate(
      call({ params: { size: '1024*1536' } }),
      signal(),
    )
    expect(out).toEqual({
      ok: true,
      provider: 'qwen',
      model: 'qwen-image-3.0',
      files: [{ bytes: JPEG, mime: 'image/jpeg' }],
    })
    expect(hits).toEqual(['/api/v1/services/aigc/multimodal-generation/generation'])
  })

  /** 生成按次计费：参数错的调用一次都不能发出去。 */
  test('参数不合法时不发请求，消息里给出合法取值', async () => {
    const out = await makeMediaPort(config()).generate(
      call({ params: { n: 9, quality: 'high' } }),
      signal(),
    )
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toContain('范围 1–6')
    expect(!out.ok && out.message).toContain('可用：size')
    expect(hits).toEqual([])
  })

  test('点名的模型不存在、没有默认模型、接口没有 key，各自说清怎么改', async () => {
    const port = makeMediaPort(config())
    const missing = await port.generate(call({ provider: 'qwen', model: '没有' }), signal())
    expect(!missing.ok && missing.message).toContain(
      '可选：qwen / qwen-image-3.0、qwen / wan2.7-image',
    )
    const noDefault = await makeMediaPort(config({ mediaDefaults: {} })).generate(call(), signal())
    expect(!noDefault.ok && noDefault.message).toContain('没有默认的图像模型')
    const noKey = config()
    delete noKey.providers.qwen!.apiKey
    const keyless = await makeMediaPort(noKey).generate(call(), signal())
    expect(!keyless.ok && keyless.message).toContain('没有配置 API Key')
    expect(hits).toEqual([])
  })

  test('接口报错时带模型名与接口原文', async () => {
    reply = () =>
      Response.json({ code: 'InvalidParameter', message: 'size 不合法' }, { status: 400 })
    const out = await makeMediaPort(config()).generate(call(), signal())
    expect(!out.ok && out.message).toBe('qwen / qwen-image-3.0：HTTP 400：size 不合法')
  })
})

describe('参数表快照', () => {
  test('按类别列出模型、默认标记与该模型的原生参数', () => {
    const notes = buildTailNotes({
      workspaceRoot: '/w',
      platform: 'linux',
      mode: 'auto',
      mediaModels: listMediaModels(config()),
    })
    const text = notes.map((n) => n.content).join('\n')
    expect(text).toContain('### 图像 · generate_image')
    expect(text).toContain('model `qwen-image-3.0`（默认）：生成、修改，参考图最多 3 张')
    expect(text).toContain('  - prompt_extend：true | false')
    expect(text).toContain('model `wan2.7-image`：生成、修改，参考图最多 9 张')
    // 参数表排在工作区状态行之前：排在最后时，紧跟的用户请求被模型读成参数表的一部分。
    expect(text.indexOf('可用的生成模型')).toBeLessThan(text.indexOf('工作区：'))
  })

  test('没有生成模型时不出现这一节', () => {
    const notes = buildTailNotes({ workspaceRoot: '/w', platform: 'linux', mode: 'auto' })
    expect(notes.map((n) => n.content).join('\n')).not.toContain('可用的生成模型')
  })
})

describe('视频：由输入推操作', () => {
  const input = (role: 'reference' | 'first_frame' | 'last_frame' | 'video') => ({
    role,
    bytes: new Uint8Array([1]),
    mime: role === 'video' ? 'video/mp4' : 'image/png',
    path: `/w/${role}`,
  })

  test('各种输入组合对应的操作', () => {
    expect(operationOf('video', [])).toEqual({ operation: 'text_to_video' })
    expect(operationOf('video', [input('first_frame')])).toEqual({ operation: 'image_to_video' })
    expect(operationOf('video', [input('first_frame'), input('last_frame')])).toEqual({
      operation: 'first_last_frame',
    })
    expect(operationOf('video', [input('reference')])).toEqual({ operation: 'reference_to_video' })
    expect(operationOf('video', [input('video'), input('reference')])).toEqual({
      operation: 'video_to_video',
    })
    expect(operationOf('image', [input('reference')])).toEqual({ operation: 'edit' })
  })

  test('不成立的组合直接退回', () => {
    expect(operationOf('video', [input('last_frame')])).toEqual({ problem: '给了尾帧就要给首帧' })
    expect(operationOf('video', [input('first_frame'), input('reference')])).toMatchObject({
      problem: expect.stringContaining('不能与参考图'),
    })
  })
})

test('语音合成不收输入文件', () => {
  expect(operationOf('audio', [])).toEqual({ operation: 'speech' })
  expect(
    operationOf('audio', [
      { role: 'reference', bytes: new Uint8Array([1]), mime: 'image/png', path: '/w/a' },
    ]),
  ).toEqual({ problem: '语音合成不收输入文件' })
})
