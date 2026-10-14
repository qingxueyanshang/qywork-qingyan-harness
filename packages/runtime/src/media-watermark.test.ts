import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mediaCatalog } from '@qywork/ai'
import type { QyConfig } from './config.ts'
import { makeMediaPort } from './media.ts'

let server: ReturnType<typeof Bun.serve>
let received: Record<string, unknown>

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      received = (await req.json()) as Record<string, unknown>
      // 只检查提交正文；明确拒绝后不得继续轮询或下载。
      return Response.json({ error: { message: 'test rejection' } }, { status: 400 })
    },
  })
})
afterAll(() => server.stop(true))

describe('生成水印默认值', () => {
  test('内置模型的可选水印统一默认关闭', () => {
    const params = mediaCatalog().flatMap((m) => m.params.filter((p) => p.name === 'watermark'))
    expect(params.length).toBeGreaterThan(0)
    for (const p of params) expect(p.default).toBe(false)
  })

  test.each([
    ['doubao-seedream-5-0-pro-260628', 'openai_images', 'image', []],
    ['doubao-seedream-5-0-flash-260915', 'openai_images', 'image', []],
    ['qwen-image-3.0', 'dashscope_images', 'image', ['parameters']],
    ['qwen-image-3.0', 'openai_images', 'image', []],
    ['doubao-seedance-2-5-260628', 'ark_videos', 'video', []],
    ['doubao-seedance-2-5-260628', 'openai_videos', 'video', ['metadata']],
    ['wan3.0-video', 'dashscope_videos', 'video', ['parameters']],
    ['wan3.0-video', 'openai_videos', 'video', ['metadata', 'parameters']],
    ['gpt-image-2.5-flare', 'openai_images', 'image', null],
    ['custom-image', 'openai_images', 'image', null],
  ] as const)('%s / %s 显式发送默认关闭并保留用户选择', async (model, kind, type, path) => {
    const config: QyConfig = {
      providers: {
        test: {
          kind: 'openai_chat_completions',
          apiKey: 'test-key',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          models: {},
          media: { [model]: { kind } },
        },
      },
      mediaDefaults: { [type]: { provider: 'test', model } },
    }
    const choices = path === null ? [undefined] : [undefined, false, true]
    for (const watermark of choices) {
      received = {}
      const params = watermark === undefined ? {} : { watermark }
      const original = { ...params }
      const result = await makeMediaPort(config).generate(
        { type, prompt: '一只猫', inputs: [], params },
        new AbortController().signal,
      )
      expect(result.ok).toBe(false)
      expect(received.model).toBe(model)
      const payload = (path ?? []).reduce(
        (value, key) => value[key] as Record<string, unknown>,
        received,
      )
      if (path === null) expect(payload).not.toHaveProperty('watermark')
      else expect(payload.watermark).toBe(watermark ?? false)
      expect(params).toEqual(original)
    }
  })
})
