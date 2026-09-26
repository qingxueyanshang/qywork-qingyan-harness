/**
 * 语音合成：两个语音适配器与按文件头认格式。
 *
 * 覆盖范围：`media/adapters/openai-speech.ts`、`media/adapters/dashscope.ts` 的 `DashScopeSpeechAdapter`
 * 实际发出的请求与对响应的读法，`media/http.ts` 的 `sniffMime` 对音视频文件头的识别。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sniffMime } from './http.ts'
import { buildMediaAdapter } from './index.ts'

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

test('按文件头认出音视频格式', () => {
  expect(sniffMime(WAV)).toBe('audio/wav')
  expect(sniffMime(MP3)).toBe('audio/mpeg')
  expect(sniffMime(new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom')]))).toBe('video/mp4')
  expect(sniffMime(new Uint8Array([...Buffer.from('OggS'), 0]))).toBe('audio/ogg')
})

describe('openai_speech', () => {
  test('文字放 input、参数原样发，响应体就是音频', async () => {
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

  /** 音色与语种放错到 `parameters` 里，接口按默认音色合成、不报错。 */
  test('音色与语种和文字一起放进 input；结果地址拿到就下载', async () => {
    reply = () => Response.json({ output: { audio: { url: `${origin()}/files/out.wav` } } })
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
  })

  test('结果是 base64 时直接解码', async () => {
    reply = () =>
      Response.json({ output: { audio: { data: Buffer.from(WAV).toString('base64') } } })
    const out = await adapter().run(
      { operation: 'speech', prompt: 'x', inputs: [], params: {} },
      signal(),
    )
    expect(out.files[0]).toEqual({ bytes: WAV, mime: 'audio/wav' })
  })
})
