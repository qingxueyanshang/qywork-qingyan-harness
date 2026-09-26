/**
 * 生成模型的目录、参数校验与两个出图适配器。
 *
 * 覆盖范围：`media/catalog.ts` 的查法、`media/params.ts` 的校验、`media/adapters/openai-images.ts` 与
 * `media/adapters/dashscope.ts` 出图时实际发出的请求与对响应的读法、`media/http.ts` 的错误原文与格式识别。
 * 视频适配器与任务等待见 `media-videos.test.ts`。
 *
 * 适配器必须看真实请求：起一个本机端点，把收到的方法、路径、头与正文原样存下来。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { findMediaModel, lookupMediaModel } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'
import { MediaError } from './types.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])

interface Seen {
  method: string
  path: string
  auth: string | null
  contentType: string | null
  json?: Record<string, unknown>
  form?: Awaited<ReturnType<Request['formData']>>
}

let server: ReturnType<typeof Bun.serve>
let seen: Seen[] = []
/** 下一次非下载请求的回复。 */
let reply: () => Response = () => Response.json({})
const origin = () => `http://127.0.0.1:${server.port}`

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/files/out.jpg') {
        return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
      }
      const contentType = req.headers.get('content-type')
      const entry: Seen = {
        method: req.method,
        path: url.pathname,
        auth: req.headers.get('authorization'),
        contentType,
      }
      if (contentType?.includes('multipart')) entry.form = await req.formData()
      else if (contentType?.includes('json'))
        entry.json = (await req.json()) as Record<string, unknown>
      seen.push(entry)
      return reply()
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  seen = []
})

const signal = () => new AbortController().signal

describe('目录查法', () => {
  test('精确匹配带回该模型自己的参数表', () => {
    const spec = lookupMediaModel('qwen-image-3.0', 'dashscope_images')
    expect(spec.catalogued).toBe(true)
    expect(spec.params.map((p) => p.name)).toContain('prompt_extend')
  })

  /** 中转站上的同一个模型：参数名不变，参考图的传法按中转站那条协议走。 */
  test('协议对不上时按 id 兜底，保留参数表、换协议与传法', () => {
    const spec = lookupMediaModel('qwen-image-3.0', 'openai_images')
    expect(spec.kind).toBe('openai_images')
    expect(spec.inputs.transport).toBe('multipart')
    expect(spec.params.map((p) => p.name)).toContain('prompt_extend')
  })

  test('目录里没有的 id 回协议默认，标为未收录', () => {
    const spec = lookupMediaModel('some-relay-image', 'openai_images')
    expect(spec.catalogued).toBe(false)
    expect(spec.params.map((p) => p.name)).toEqual(['size', 'n'])
    expect(findMediaModel('some-relay-image')).toBeUndefined()
  })
})

describe('参数校验', () => {
  const qwen = lookupMediaModel('qwen-image-3.0', 'dashscope_images')

  test('合法调用没有问题', () => {
    expect(
      validateMediaCall(
        qwen,
        'generate',
        { size: '1024*1536', n: 2, watermark: false },
        { images: 0, videos: 0 },
      ),
    ).toEqual([])
  })

  test('不认识的字段、越界的值、错的格式各报一条，并给出合法取值', () => {
    const problems = validateMediaCall(
      qwen,
      'generate',
      { quality: 'high', n: 9, size: '1024x1536' },
      { images: 0, videos: 0 },
    )
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain('可用：size')
    expect(problems[1]).toContain('1–6')
    expect(problems[2]).toContain('星号')
  })

  test('参考图超数与只对某个操作有效的参数', () => {
    const wan = lookupMediaModel('wan2.7-image', 'dashscope_images')
    expect(validateMediaCall(qwen, 'edit', {}, { images: 4, videos: 0 })[0]).toContain(
      '最多收 3 张',
    )
    expect(
      validateMediaCall(wan, 'edit', { thinking_mode: false }, { images: 1, videos: 0 })[0],
    ).toContain('只在生成时有效')
  })
})

describe('openai_images', () => {
  const adapter = (model: string) =>
    buildMediaAdapter({
      kind: 'openai_images',
      model,
      apiKey: 'sk-test',
      baseUrl: `${origin()}/v1`,
    })

  test('生成走 JSON，参数原样发出、不带 response_format，读 b64_json', async () => {
    reply = () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
    const out = await adapter('gpt-image-2.5-flare').run(
      {
        operation: 'generate',
        prompt: '一只猫',
        inputs: [],
        params: { size: '1024x1536', quality: 'high' },
      },
      { signal: signal() },
    )
    expect(seen[0]?.path).toBe('/v1/images/generations')
    expect(seen[0]?.auth).toBe('Bearer sk-test')
    expect(seen[0]?.json).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: '一只猫',
      size: '1024x1536',
      quality: 'high',
    })
    expect(out.files).toEqual([{ bytes: PNG, mime: 'image/png' }])
  })

  test('目录声明 multipart 的模型改图走 /edits，图按文件上传', async () => {
    reply = () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
    await adapter('gpt-image-2.5-flare').run(
      {
        operation: 'edit',
        prompt: '背景换成蓝色',
        inputs: [{ role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' }],
        params: { n: 2 },
      },
      { signal: signal() },
    )
    expect(seen[0]?.path).toBe('/v1/images/edits')
    const form = seen[0]?.form
    expect(form?.get('model')).toBe('gpt-image-2.5-flare')
    expect(form?.get('n')).toBe('2')
    const file = form?.get('image[]') as File
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
  })

  /** 火山 Seedream 与百炼兼容出图：参考图是 JSON 里的 data URI，结果是临时地址，拿到就下载。 */
  test('目录声明 JSON 的模型改图仍走 /generations，结果按地址下载', async () => {
    reply = () => Response.json({ data: [{ url: `${origin()}/files/out.jpg` }] })
    const out = await adapter('doubao-seedream-5-0-pro-260628').run(
      {
        operation: 'edit',
        prompt: '换成夜景',
        inputs: [{ role: 'reference', bytes: PNG, mime: 'image/PNG', path: '/w/a.png' }],
        params: { size: '2K' },
      },
      { signal: signal() },
    )
    expect(seen[0]?.path).toBe('/v1/images/generations')
    expect(seen[0]?.json?.image).toEqual([
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    ])
    expect(out.files).toEqual([{ bytes: JPEG, mime: 'image/jpeg' }])
  })

  test('非 2xx 带状态码与接口原文，不重试', async () => {
    reply = () => Response.json({ error: { message: 'Invalid size' } }, { status: 400 })
    const err = await adapter('gpt-image-2.5-flare')
      .run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MediaError)
    expect((err as MediaError).status).toBe(400)
    expect((err as MediaError).message).toBe('HTTP 400：Invalid size')
    expect(seen).toHaveLength(1)
  })

  test('逐张失败时把每张的原因并进消息', async () => {
    reply = () => Response.json({ data: [{ error: { message: '内容审核未通过' } }] })
    const err = await adapter('doubao-seedream-5-0-pro-260628')
      .run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() })
      .catch((e: unknown) => e)
    expect((err as Error).message).toContain('内容审核未通过')
  })
})

describe('dashscope_images', () => {
  const adapter = (baseUrl: string) =>
    buildMediaAdapter({
      kind: 'dashscope_images',
      model: 'qwen-image-3.0',
      apiKey: 'sk-ds',
      baseUrl,
    })

  /** 接口里填的是对话用的兼容地址，原生路径挂在 origin 上。 */
  test('原生同步端点：图在前、文字在后，参数进 parameters，结果按地址下载', async () => {
    reply = () =>
      Response.json({
        output: { choices: [{ message: { content: [{ image: `${origin()}/files/out.jpg` }] } }] },
        usage: { output_image_count: 1 },
      })
    const out = await adapter(`${origin()}/compatible-mode/v1`).run(
      {
        operation: 'edit',
        prompt: '加一顶帽子',
        inputs: [{ role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' }],
        params: { size: '1024*1024' },
      },
      { signal: signal() },
    )
    expect(seen[0]?.path).toBe('/api/v1/services/aigc/multimodal-generation/generation')
    expect(seen[0]?.auth).toBe('Bearer sk-ds')
    expect(seen[0]?.json).toEqual({
      model: 'qwen-image-3.0',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { image: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` },
              { text: '加一顶帽子' },
            ],
          },
        ],
      },
      parameters: { size: '1024*1024' },
    })
    expect(out.files).toEqual([{ bytes: JPEG, mime: 'image/jpeg' }])
  })

  test('没有图时报接口给的码与原文', async () => {
    reply = () => Response.json({ code: 'DataInspectionFailed', message: '输入内容不合规' })
    const err = await adapter(`${origin()}/compatible-mode/v1`)
      .run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() })
      .catch((e: unknown) => e)
    expect((err as Error).message).toBe('接口没有返回图片：DataInspectionFailed 输入内容不合规')
  })
})
