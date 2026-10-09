/**
 * 生成模型的目录、参数校验与两个图像生成适配器。
 *
 * 覆盖范围：`media/catalog.ts` 的查找方式与计价（`mediaCost`、`quoteMedia` 与各模型的单价）、`media/params.ts` 的校验、
 * `media/adapters/openai-images.ts` 与 `media/adapters/dashscope.ts` 生成图像时实际发出的请求与响应（含计量）的解析方式、
 * `media/http.ts` 的错误原文与格式识别。视频适配器与任务等待见 `media-videos.test.ts`。
 *
 * 适配器测试必须检查真实请求：启动本机端点，原样保存收到的方法、路径、请求头与正文。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { MEDIA_KINDS, type MediaKind } from '@qywork/core'
import { findMediaModel, lookupMediaModel, mediaCost, quoteMedia } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'
import { MediaError, type MediaUsage } from './types.ts'

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
/** 下一次非下载请求的应答。 */
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

describe('目录查找', () => {
  test('精确匹配返回该模型自身的参数表', () => {
    const spec = lookupMediaModel('qwen-image-3.0', 'dashscope_images')
    expect(spec.catalogued).toBe(true)
    expect(spec.params.map((p) => p.name)).toContain('prompt_extend')
  })

  /** 图片兼容接口与百炼原生使用不同的尺寸格式。 */
  test('千问图片兼容接口使用 JSON 参考图和宽x高尺寸', () => {
    const spec = lookupMediaModel('qwen-image-3.0', 'openai_images')
    expect(spec.kind).toBe('openai_images')
    expect(spec.inputs.transport).toBe('json')
    expect(spec.params.map((p) => p.name)).toContain('prompt_extend')
  })

  test('目录中没有的 id 返回协议默认值，标为未收录', () => {
    const spec = lookupMediaModel('some-relay-image', 'openai_images')
    expect(spec.catalogued).toBe(false)
    expect(spec.params.map((p) => p.name)).toEqual(['size', 'n'])
    expect(findMediaModel('some-relay-image')).toBeUndefined()
  })
})

describe('参数校验', () => {
  const qwen = lookupMediaModel('qwen-image-3.0', 'dashscope_images')

  test('合法调用不报告问题', () => {
    expect(
      validateMediaCall(
        qwen,
        'generate',
        { size: '832*1248', n: 2, watermark: false },
        { images: 0, videos: 0 },
      ),
    ).toEqual([])
  })

  test('未知字段、越界取值、错误格式各报告一条，并给出合法取值', () => {
    const problems = validateMediaCall(
      qwen,
      'generate',
      { quality: 'high', n: 9, size: '1024x1536' },
      { images: 0, videos: 0 },
    )
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain('可用参数：size')
    expect(problems[1]).toContain('1–6')
    expect(problems[2]).toContain('星号')
  })

  test('参考图超出数量与仅对特定操作有效的参数', () => {
    const wan = lookupMediaModel('wan2.7-image', 'dashscope_images')
    expect(validateMediaCall(qwen, 'edit', {}, { images: 4, videos: 0 })[0]).toContain(
      '最多接受 3 张',
    )
    expect(
      validateMediaCall(wan, 'edit', { thinking_mode: false }, { images: 1, videos: 0 })[0],
    ).toContain('仅在生成时有效')
  })

  test('时长取「由模型决定」时不在范围内也合法，低于下限的其他值报错', () => {
    const wan = lookupMediaModel('wan3.0-video', 'dashscope_videos')
    const call = (duration: number) =>
      validateMediaCall(wan, 'text_to_video', { duration }, { images: 0, videos: 0 })
    expect(call(-1)).toEqual([])
    expect(call(2)).toEqual([])
    expect(call(1)[0]).toContain('范围 2–30，或 -1')
  })
})

describe('界面参数', () => {
  /** 各厂商文档的总像素范围与宽高比范围（2026-09-30 核对）。 */
  const LIMITS: Record<
    string,
    { area: [number, number]; ratio: number; tiers: string[]; side?: number }
  > = {
    'gpt-image-2.5-flare': {
      area: [655360, 8294400],
      ratio: 3,
      tiers: ['1K', '2K', '4K'],
      side: 3840,
    },
    'gpt-image-2.5-sunburst': {
      area: [655360, 8294400],
      ratio: 3,
      tiers: ['1K', '2K', '4K'],
      side: 3840,
    },
    'doubao-seedream-5-0-pro-260628': {
      area: [921600, 4624220],
      ratio: 16,
      tiers: ['1K', '1.5K', '2K'],
    },
    'doubao-seedream-5-0-flash-260915': {
      area: [921600, 4624220],
      ratio: 16,
      tiers: ['1K', '1.5K', '2K'],
    },
    'wan2.7-image-pro': { area: [768 * 768, 4096 * 4096], ratio: 8, tiers: ['1K', '2K', '4K'] },
    'wan2.7-image': { area: [768 * 768, 2048 * 2048], ratio: 8, tiers: ['1K', '2K'] },
    'qwen-image-3.0-pro': { area: [512 * 512, 2048 * 2048], ratio: 8, tiers: ['1K', '2K'] },
    'qwen-image-3.0': { area: [512 * 512, 2048 * 2048], ratio: 8, tiers: ['1K', '2K'] },
  }

  test('字符串参数提供选项、尺寸表，或受长度限制的高级文本输入', () => {
    for (const kind of MEDIA_KINDS) {
      for (const p of lookupMediaModel('some-relay-model', kind).params) {
        if (p.label && p.type === 'string')
          expect(p.presets ?? p.shapes ?? (p.advanced && p.maxLength)).toBeTruthy()
      }
    }
    for (const id of Object.keys(LIMITS)) {
      for (const p of findMediaModel(id)!.params) {
        if (p.label && p.type === 'string')
          expect(p.presets ?? p.shapes ?? (p.advanced && p.maxLength)).toBeTruthy()
      }
    }
  })

  test('尺寸对照表的每一项格式合法，且在文档的像素与宽高比范围内，档位与文档一致', () => {
    for (const [id, limit] of Object.entries(LIMITS)) {
      const size = findMediaModel(id)!.params.find((p) => p.name === 'size')!
      const pattern = new RegExp(size.pattern!)
      const tiers = new Set<string>()
      for (const s of size.shapes!) {
        if (s.tier) tiers.add(s.tier)
        if (s.value === undefined) continue
        expect(pattern.test(s.value)).toBe(true)
        const px = /^(\d+)[x*](\d+)$/.exec(s.value)
        if (!px) continue
        const w = Number(px[1])
        const h = Number(px[2])
        expect(w * h).toBeGreaterThanOrEqual(limit.area[0])
        expect(w * h).toBeLessThanOrEqual(limit.area[1])
        expect(Math.max(w / h, h / w)).toBeLessThanOrEqual(limit.ratio)
        expect(Math.max(w, h)).toBeLessThanOrEqual(limit.side ?? Number.POSITIVE_INFINITY)
        expect((w % 16) + (h % 16)).toBe(0)
        const [a, b] = s.ratio!.split(':').map(Number) as [number, number]
        expect(Math.abs(w / h - a / b) / (a / b)).toBeLessThan(0.03)
      }
      expect([...tiers]).toEqual(limit.tiers)
    }
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

  test('生成使用 JSON，参数原样发送，不带 response_format，读取 b64_json', async () => {
    reply = () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
    const out = await adapter('gpt-image-2.5-flare').run(
      {
        operation: 'generate',
        prompt: '一只猫',
        inputs: [],
        params: { size: '1024x1536', quality: 'max' },
      },
      { signal: signal() },
    )
    expect(seen[0]?.path).toBe('/v1/images/generations')
    expect(seen[0]?.auth).toBe('Bearer sk-test')
    expect(seen[0]?.json).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: '一只猫',
      size: '1024x1536',
      quality: 'max',
    })
    expect(out.files).toEqual([{ bytes: PNG, mime: 'image/png' }])
  })

  test('目录声明 multipart 的模型修改图像时使用 /edits，图片按文件上传', async () => {
    reply = () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
    await adapter('gpt-image-2.5-flare').run(
      {
        operation: 'edit',
        prompt: '背景换成蓝色',
        inputs: [{ role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' }],
        params: { n: 2, quality: 'max', output_format: 'webp', output_compression: 90 },
      },
      { signal: signal() },
    )
    expect(seen[0]?.path).toBe('/v1/images/edits')
    const form = seen[0]?.form
    expect(form?.get('model')).toBe('gpt-image-2.5-flare')
    expect(form?.get('n')).toBe('2')
    expect(form?.get('quality')).toBe('max')
    expect(form?.get('output_format')).toBe('webp')
    expect(form?.get('output_compression')).toBe('90')
    const file = form?.get('image[]') as File
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG)
  })

  /** 火山 Seedream 与百炼兼容模式生成图像：参考图是 JSON 中的 data URI，结果是临时地址，取得后立即下载。 */
  test('目录声明 JSON 的模型修改图像时仍使用 /generations，结果按地址下载', async () => {
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

  test('逐张失败时将每张的原因合并到消息中', async () => {
    reply = () => Response.json({ data: [{ error: { message: '内容审核未通过' } }] })
    const err = await adapter('doubao-seedream-5-0-pro-260628')
      .run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() })
      .catch((e: unknown) => e)
    expect((err as Error).message).toContain('内容审核未通过')
  })

  test('计量按接口字段读取：OpenAI 回报分文字与图片的输入 token，火山回报张数与 output_tokens', async () => {
    const run = (model: string) =>
      adapter(model).run(
        { operation: 'generate', prompt: 'x', inputs: [], params: {} },
        { signal: signal() },
      )
    reply = () =>
      Response.json({
        data: [{ b64_json: Buffer.from(PNG).toString('base64') }],
        usage: {
          input_tokens: 60,
          output_tokens: 1756,
          input_tokens_details: { text_tokens: 50, image_tokens: 10 },
        },
      })
    expect((await run('gpt-image-2.5-flare')).usage).toEqual({
      images: 1,
      inputTextTokens: 50,
      inputImageTokens: 10,
      outputTokens: 1756,
    })
    reply = () =>
      Response.json({
        data: [{ url: `${origin()}/files/out.jpg` }],
        usage: { generated_images: 1, input_images: 2, output_tokens: 16384 },
      })
    expect((await run('doubao-seedream-5-0-pro-260628')).usage).toEqual({
      images: 1,
      inputImages: 2,
      outputTokens: 16384,
    })
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

  /** 接口中填写的是对话用的兼容地址，原生路径位于 origin 下。 */
  test('原生同步端点：图片在前、文字在后，参数放入 parameters，结果按地址下载', async () => {
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
    expect(out.usage).toEqual({ images: 1 })
  })

  test('没有图片时报告接口返回的错误码与原文', async () => {
    reply = () => Response.json({ code: 'DataInspectionFailed', message: '输入内容不合规' })
    const err = await adapter(`${origin()}/compatible-mode/v1`)
      .run({ operation: 'generate', prompt: 'x', inputs: [], params: {} }, { signal: signal() })
      .catch((e: unknown) => e)
    expect((err as Error).message).toBe('接口没有返回图片：DataInspectionFailed 输入内容不合规')
  })
})

/**
 * 发送前显示的金额必须等于成功后账本记录的金额：同一组参数下，`quoteMedia` 的结果与按接口回报的计量
 * （`adapters/dashscope.ts` 的 `videoUsage` 规整后的形状）经 `mediaCost` 计算的结果相等。
 */
describe('发送前的花费', () => {
  const quote = (
    id: string,
    kind: MediaKind,
    params: Record<string, unknown>,
    inputs = { images: 0, videos: 0 },
  ) => quoteMedia(lookupMediaModel(id, kind), params, inputs)
  const ledger = (id: string, kind: MediaKind, usage: MediaUsage) =>
    mediaCost(lookupMediaModel(id, kind), usage)

  test('万相 3.0 720P 5 秒 ¥3.00，与账本金额一致；未填写的参数取接口默认值', () => {
    const q = quote('wan3.0-video', 'dashscope_videos', { resolution: '720P', duration: 5 })
    expect(q).toEqual({ cost: expect.closeTo(3, 10), currency: 'CNY' })
    expect(ledger('wan3.0-video', 'dashscope_videos', { seconds: 5, resolution: '720p' })).toEqual(
      q!,
    )
    // 默认 1080P、5 秒。
    expect(quote('wan3.0-video', 'dashscope_videos', {})?.cost).toBeCloseTo(6, 10)
  })

  test('可灵（百炼）按清晰度档位与声音估算，与账本金额一致', () => {
    const id = 'kling/kling-v3-video-generation'
    const q = quote(id, 'dashscope_videos', { mode: 'std', audio: true, duration: 5 })
    expect(q?.cost).toBeCloseTo(4.5, 10)
    expect(
      ledger(id, 'dashscope_videos', { seconds: 5, resolution: '720p', audio: true }).cost,
    ).toBeCloseTo(q!.cost, 10)
  })

  test('Seedream Flash 每张 ¥0.12', () => {
    expect(
      quote('doubao-seedream-5-0-flash-260915', 'openai_images', {}, { images: 2, videos: 0 }),
    ).toEqual({ cost: 0.12, currency: 'CNY' })
  })

  test('计量须由接口回报的情形不估算：Seedance、千问图像、万相带参考视频、时长由模型决定、可灵官方', () => {
    expect(quote('doubao-seedance-2-0-260128', 'ark_videos', { resolution: '720p' })).toBeNull()
    expect(quote('qwen-image-3.0-pro', 'dashscope_images', {})).toBeNull()
    expect(quote('wan3.0-video', 'dashscope_videos', {}, { images: 0, videos: 1 })).toBeNull()
    expect(quote('wan3.0-video', 'dashscope_videos', { duration: -1 })).toBeNull()
    expect(quote('kling-3.0', 'kling_videos', {})).toBeNull()
  })
})

describe('计价', () => {
  const cost = (id: string, kind: MediaKind, usage: MediaUsage) =>
    mediaCost(lookupMediaModel(id, kind), usage)

  test('GPT Image 2.5 按文字输入、图片输入、图片输出三种 token 分别计价', () => {
    const out = cost('gpt-image-2.5-sunburst', 'openai_images', {
      images: 1,
      inputTextTokens: 50,
      inputImageTokens: 100,
      outputTokens: 1756,
    })
    expect(out.currency).toBe('USD')
    expect(out.cost).toBeCloseTo((50 * 5 + 100 * 8 + 1756 * 30) / 1e6, 10)
  })

  /** 像素按 `output_tokens × 256 / 张数` 折算：2048² 是高档，1536² 是低档；首张参考图免费。 */
  test('Seedream 5.0 Pro 按每张像素分档，参考图第 2 张起收费', () => {
    const high = cost('doubao-seedream-5-0-pro-260628', 'openai_images', {
      images: 1,
      inputImages: 2,
      outputTokens: (2048 * 2048) / 256,
    })
    expect(high).toEqual({ cost: expect.closeTo(0.62, 10), currency: 'CNY' })
    const low = cost('doubao-seedream-5-0-pro-260628', 'openai_images', {
      images: 1,
      outputTokens: (1536 * 1536) / 256,
    })
    expect(low).toEqual({ cost: 0.3, currency: 'CNY' })
  })

  test('千问图像按接口回报的输出档位计价，档位缺失时金额不明', () => {
    const usage = { images: 1, inputImages: 1, imageTier: 'qima_output_2k' }
    expect(cost('qwen-image-3.0-pro', 'dashscope_images', usage)).toEqual({
      cost: expect.closeTo(0.52, 10),
      currency: 'CNY',
    })
    expect(cost('qwen-image-3.0-pro', 'dashscope_images', { images: 1 })).toEqual({
      cost: 0,
      currency: 'CNY',
    })
  })

  test('万相视频按秒与分辨率计价', () => {
    expect(
      cost('wan3.0-video-prime', 'dashscope_videos', { seconds: 5, resolution: '720p' }),
    ).toEqual({ cost: expect.closeTo(4.5, 10), currency: 'CNY' })
  })

  /** 官方价格页的算例：2.0 720p 16:9 5 秒约 108000 token，¥4.97。 */
  test('Seedance 按输出 token、分辨率与输入是否含视频计价', () => {
    expect(
      cost('doubao-seedance-2-0-260128', 'ark_videos', {
        outputTokens: 108_000,
        resolution: '720p',
        videoInput: false,
      }).cost,
    ).toBeCloseTo(4.968, 6)
    expect(
      cost('doubao-seedance-2-5-260628', 'ark_videos', {
        outputTokens: 1_000_000,
        resolution: '1080p',
        videoInput: true,
      }).cost,
    ).toBeCloseTo(46, 6)
  })

  test('千问语音合成按字符计价', () => {
    expect(cost('qwen3-tts-flash', 'dashscope_speech', { characters: 195 }).cost).toBeCloseTo(
      0.0156,
      10,
    )
  })

  test('百炼上的可灵按秒、清晰度、有无声音与参考视频计价；声音未回报时金额不明', () => {
    const omni = 'kling/kling-v3-omni-video-generation'
    expect(
      cost(omni, 'dashscope_videos', {
        seconds: 5,
        resolution: '1080p',
        audio: false,
        videoInput: true,
      }).cost,
    ).toBeCloseTo(6, 10)
    expect(
      cost('kling/kling-v3-video-generation', 'dashscope_videos', {
        seconds: 5,
        resolution: '720p',
        audio: false,
      }).cost,
    ).toBeCloseTo(3, 10)
    expect(
      cost('kling/kling-v3-video-generation', 'dashscope_videos', {
        seconds: 5,
        resolution: '720p',
      }).cost,
    ).toBe(0)
  })

  test('接口回报扣费金额时以回报为准；没有价目的模型金额不明', () => {
    expect(
      cost('kling-3.0', 'kling_videos', { seconds: 5, billed: { amount: 0.56, currency: 'CNY' } }),
    ).toEqual({ cost: 0.56, currency: 'CNY' })
    expect(cost('gpt-4o-mini-tts', 'openai_speech', {}).cost).toBe(0)
  })

  /** 经中转站调用的价格以中转站为准，回退时不保留目录中的官方价。 */
  test('按 id 回退到其他协议时不带单价', () => {
    expect(lookupMediaModel('doubao-seedance-2-5-260628', 'openai_videos').price).toBeUndefined()
  })
})
