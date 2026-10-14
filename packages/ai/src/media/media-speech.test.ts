/**
 * 语音合成：两个语音适配器与按文件头识别格式。
 *
 * 覆盖范围：`media/adapters/openai-speech.ts`、`media/adapters/dashscope.ts` 的 `DashScopeSpeechAdapter`
 * 实际发出的请求与响应的解析方式，`media/http.ts` 的 `sniffMime` 对音视频文件头的识别。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { activeMediaParams } from '@qywork/core'
import { lookupMediaModel, mediaCost, quoteMedia } from './catalog.ts'
import { sniffMime } from './http.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'

const WAV = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVEfmt ')])
const MP3 = new Uint8Array([...Buffer.from('ID3'), 4, 0, 0])

interface Seen {
  path: string
  json?: Record<string, unknown>
}

let server: ReturnType<typeof Bun.serve>
let seen: Seen[] = []
let reply: () => Response = () => new Response(MP3)
const origin = () => `http://127.0.0.1:${server.port}`

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/files/out.wav') return new Response(WAV)
      seen.push({ path: url.pathname, json: (await req.json()) as Record<string, unknown> })
      return reply()
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  seen = []
})

const signal = () => ({ signal: new AbortController().signal })

test('按文件头识别音视频格式', () => {
  expect(sniffMime(WAV)).toBe('audio/wav')
  expect(sniffMime(MP3)).toBe('audio/mpeg')
  expect(sniffMime(new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom')]))).toBe('video/mp4')
  expect(sniffMime(new Uint8Array([...Buffer.from('OggS'), 0]))).toBe('audio/ogg')
})

describe('openai_speech', () => {
  test('未指定音色时发送目录中的必填默认音色', async () => {
    reply = () => new Response(MP3)
    await buildMediaAdapter({
      kind: 'openai_speech',
      model: 'gpt-4o-mini-tts',
      apiKey: 'test',
      baseUrl: origin(),
    }).run({ operation: 'speech', prompt: '你好', inputs: [], params: {} }, signal())
    expect(seen[0]?.json?.voice).toBe('alloy')
  })
  test('文字放入 input，参数原样发送，响应体即音频', async () => {
    reply = () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } })
    const out = await buildMediaAdapter({
      kind: 'openai_speech',
      model: 'gpt-4o-mini-tts',
      apiKey: 'sk',
      baseUrl: origin(),
    }).run(
      {
        operation: 'speech',
        prompt: '你好',
        inputs: [],
        params: { voice: 'coral', instructions: '温柔一点' },
      },
      signal(),
    )
    expect(seen[0]).toEqual({
      path: '/v1/audio/speech',
      json: { model: 'gpt-4o-mini-tts', input: '你好', voice: 'coral', instructions: '温柔一点' },
    })
    expect(out.files[0]).toEqual({ bytes: MP3, mime: 'audio/mpeg' })
  })
})

describe('dashscope_speech', () => {
  const adapter = () =>
    buildMediaAdapter({
      kind: 'dashscope_speech',
      model: 'qwen3-tts-flash',
      apiKey: 'sk',
      baseUrl: `${origin()}/compatible-mode/v1`,
    })

  /** 音色与语种误放入 `parameters` 时，接口按默认音色合成且不报错。 */
  test('音色、语种与文字一同放入 input；取得结果地址后立即下载，计量读取 characters', async () => {
    reply = () =>
      Response.json({
        output: { audio: { url: `${origin()}/files/out.wav` } },
        usage: { input_tokens: 0, output_tokens: 0, characters: 12 },
      })
    const out = await adapter().run(
      {
        operation: 'speech',
        prompt: '今天天气不错',
        inputs: [],
        params: { voice: 'Cherry', language_type: 'Chinese' },
      },
      signal(),
    )
    expect(seen[0]).toEqual({
      path: '/api/v1/services/aigc/multimodal-generation/generation',
      json: {
        model: 'qwen3-tts-flash',
        input: { text: '今天天气不错', voice: 'Cherry', language_type: 'Chinese' },
      },
    })
    expect(out.files[0]).toEqual({ bytes: WAV, mime: 'audio/wav' })
    expect(out.usage).toEqual({ characters: 12 })
  })

  test('结果是 base64 时直接解码', async () => {
    reply = () =>
      Response.json({ output: { audio: { data: Buffer.from(WAV).toString('base64') } } })
    const out = await adapter().run(
      { operation: 'speech', prompt: 'x', inputs: [], params: {} },
      signal(),
    )
    expect(out.files[0]).toEqual({ bytes: WAV, mime: 'audio/wav' })
    expect(seen[0]?.json?.input).toMatchObject({ voice: 'Cherry' })
  })
})

describe('Qwen-Audio 3.1', () => {
  const flash = 'qwen-audio-3.1-tts-flash'
  const next = 'qwen-audio-3.1-tts-next'
  const spec = (id: string) => lookupMediaModel(id, 'dashscope_speech')
  const adapter = (model: string) =>
    buildMediaAdapter({
      kind: 'dashscope_speech',
      model,
      apiKey: 'sk',
      baseUrl: `${origin()}/ali/compatible-mode/v1`,
    })

  test('Flash 使用新端点、新音色及 instruction，按输入输出 Token 计价', async () => {
    reply = () =>
      Response.json({
        output: { audio: { url: `${origin()}/files/out.wav` } },
        usage: { input_tokens: 1000, output_tokens: 2000, characters: 99999 },
      })
    const out = await adapter(flash).run(
      {
        operation: 'speech',
        prompt: '[excited] 你好！',
        inputs: [],
        params: { instruction: '用温柔的语气', format: 'wav', rate: 1.2 },
      },
      signal(),
    )
    expect(seen[0]).toEqual({
      path: '/ali/api/v1/services/audio/tts/SpeechSynthesizer',
      json: {
        model: flash,
        input: {
          text: '[excited] 你好！',
          voice: 'longanhuan_v3.1',
          sample_rate: 22050,
          instruction: '用温柔的语气',
          format: 'wav',
          rate: 1.2,
        },
      },
    })
    expect(out.files).toEqual([{ bytes: WAV, mime: 'audio/wav' }])
    expect(out.usage).toEqual({ inputTokens: 1000, outputTokens: 2000 })
    expect(mediaCost(spec(flash), out.usage!)).toEqual({ cost: 0.0255, currency: 'CNY' })
    expect(quoteMedia(spec(flash), {}, { images: 0, videos: 0 })).toBeNull()
  })

  test('Flash 选择 Opus 时省略采样率也不会发送非法默认 22050', async () => {
    reply = () =>
      Response.json({ output: { audio: { data: Buffer.from(WAV).toString('base64') } } })
    await adapter(flash).run(
      { operation: 'speech', prompt: '你好', inputs: [], params: { format: 'opus' } },
      signal(),
    )
    expect(seen[0]?.json?.input).toMatchObject({ format: 'opus', sample_rate: 24000 })
    expect(
      validateMediaCall(
        spec(flash),
        'speech',
        { format: 'opus', sample_rate: 22050 },
        { images: 0, videos: 0 },
      ),
    ).toHaveLength(1)
  })

  test('Next 以 text_prompt 和有序 data URI 发送三段参考音频，不混入系统音色', async () => {
    const inputs = [WAV, MP3, new Uint8Array(Buffer.from('OggS\0OpusHead'))].map((bytes, i) => ({
      role: 'audio' as const,
      bytes,
      mime: ['audio/wav', 'audio/mpeg', 'audio/ogg'][i]!,
      path: `/w/${i}`,
    }))
    reply = () =>
      Response.json({
        output: { audio: { url: `${origin()}/files/out.wav` } },
        usage: { duration: 30 },
      })
    const prompt = '@voice1 和 @voice2 对话，@voice3 旁白，伴有鸟鸣'
    const out = await adapter(next).run(
      {
        operation: 'speech',
        prompt,
        inputs,
        params: { format: 'wav', sample_rate: 48000, channels: 2 },
      },
      signal(),
    )
    expect(seen[0]).toEqual({
      path: '/ali/api/v1/services/audio/tts/SpeechSynthesizer',
      json: {
        model: next,
        input: {
          text_prompt: prompt,
          references: inputs.map((i) => ({
            audio_data: `data:${i.mime};base64,${Buffer.from(i.bytes).toString('base64')}`,
          })),
          format: 'wav',
          sample_rate: 48000,
          channels: 2,
        },
      },
    })
    expect(out.files).toEqual([{ bytes: WAV, mime: 'audio/wav' }])
    expect(out.usage).toEqual({})
    expect(spec(next).price!.cost(out.usage!)).toBeNull()
    expect(mediaCost(spec(next), out.usage!)).toEqual({ cost: 0, currency: 'CNY' })
    expect(mediaCost(spec(next), { inputTokens: 1000, outputTokens: 2000 })).toEqual({
      cost: 0.03,
      currency: 'CNY',
    })
    expect(spec(next).price!.cost({ inputTokens: 1000 })).toBeNull()
    expect(spec(flash).price!.cost({ outputTokens: 2000 })).toBeNull()
  })

  test('Next 纯文本请求省略 references 和 voice，并保留服务端错误', async () => {
    reply = () =>
      Response.json({ output: { audio: { data: Buffer.from(MP3).toString('base64') } } })
    const out = await adapter(next).run(
      { operation: 'speech', prompt: '森林环境音', inputs: [], params: {} },
      signal(),
    )
    expect(seen[0]?.json?.input).toEqual({ text_prompt: '森林环境音' })
    expect(out.files).toEqual([{ bytes: MP3, mime: 'audio/mpeg' }])
    reply = () => Response.json({ code: 'InvalidParameter', message: 'Model not exist.' })
    await expect(
      adapter(next).run({ operation: 'speech', prompt: 'x', inputs: [], params: {} }, signal()),
    ).rejects.toThrow('InvalidParameter Model not exist.')
  })

  test('参数面板和提交校验分别限制新旧音色、采样率、声道及编码参数', () => {
    const counts = { images: 0, videos: 0 }
    expect(validateMediaCall(spec(flash), 'speech', { voice: 'Cherry' }, counts)).toHaveLength(1)
    expect(
      validateMediaCall(
        spec(flash),
        'speech',
        { voice: 'Emily_v3.1', instruction: '温柔' },
        counts,
      ),
    ).toEqual([])
    for (const params of [
      { voice: 'longanhuan_v3.1' },
      { format: 'opus' },
      { channels: '2' },
      { channels: 3 },
      { sample_rate: 22050 },
      { quality: 10 },
      { rate: 2.1 },
      { volume: 101 },
    ]) {
      expect(validateMediaCall(spec(next), 'speech', params, counts).length).toBeGreaterThan(0)
    }
    expect(
      activeMediaParams(spec(next).params, 'speech', {
        format: 'wav',
        quality: 4,
        bit_rate: 192,
        enable_cbr: true,
      }),
    ).toEqual({ format: 'wav' })
    expect(
      activeMediaParams(spec(next).params, 'speech', {
        format: 'mp3',
        quality: 4,
        bit_rate: 192,
        enable_cbr: false,
      }),
    ).toEqual({ format: 'mp3', quality: 4, enable_cbr: false })
    expect(
      validateMediaCall(
        spec(next),
        'speech',
        { format: 'mp3', enable_cbr: true, sample_rate: 8000, bit_rate: 128 },
        counts,
      ),
    ).toHaveLength(1)
    expect(validateMediaCall(spec(next), 'speech', {}, { ...counts, audios: 3 })).toEqual([])
    expect(validateMediaCall(spec(next), 'speech', {}, { ...counts, audios: 4 })).toHaveLength(1)
    expect(validateMediaCall(spec(flash), 'speech', {}, { ...counts, audios: 1 })).toHaveLength(1)
  })
})
