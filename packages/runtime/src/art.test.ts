/**
 * 覆盖范围：`art.ts` 的 `generateArt`（经 `media.ts` 的 `makeMediaPort` 分派）与 `extractHtml`。
 *
 * 对端是本机模拟的对话接口（OpenAI 兼容协议），按脚本返回 SSE 正文，并记录收到的请求体。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { MediaSpend } from '@qywork/core'
import { artViewportOf } from '@qywork/core'
import { extractHtml } from './art.ts'
import type { QyConfig } from './config.ts'
import { makeMediaPort } from './media.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const PAGE = '<!doctype html><html><head><title>旧</title></head><body>旧页面</body></html>'

let server: ReturnType<typeof Bun.serve>
let bodies: Record<string, unknown>[] = []
let answer = ''

const sse = (text: string) => {
  const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
  return (
    chunk({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    chunk({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 3456 },
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
})

const config = (): QyConfig => ({
  active: { provider: 'relay', model: 'chat-model' },
  providers: {
    relay: {
      kind: 'openai_chat_completions',
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: { 'chat-model': {}, 'other-model': {} },
    },
  },
})

const generate = (over: Record<string, unknown>, onSpend?: (s: MediaSpend) => void) =>
  makeMediaPort(config(), onSpend).generate(
    { type: 'art', prompt: '把镜头降低', inputs: [], params: {}, ...over },
    new AbortController().signal,
  )

describe('Art 生成', () => {
  test('请求依次带当前页面、编号的参考图与要求；产物是写入 viewport 的完整文档，花费按输出 token 记账', async () => {
    answer = `好的，修改如下：\n\`\`\`html\n<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>新页面</body></html>\n\`\`\`\n以上。`
    const spends: MediaSpend[] = []
    const result = await generate(
      {
        params: { size: '720x1280' },
        inputs: [
          {
            role: 'reference',
            bytes: new TextEncoder().encode(PAGE),
            mime: 'text/html',
            path: '/w/a.html',
          },
          { role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' },
        ],
      },
      (s) => spends.push(s),
    )
    if (!result.ok) throw new Error(result.message)
    expect(result.provider).toBe('relay')
    expect(result.model).toBe('chat-model')
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.mime).toBe('text/html')
    const html = new TextDecoder().decode(result.files[0]!.bytes)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.endsWith('</html>')).toBe(true)
    expect(artViewportOf(html)).toEqual({ w: 720, h: 1280 })

    const body = bodies[0]!
    const messages = body.messages as { role: string; content: unknown }[]
    expect(JSON.stringify(messages[0])).toContain('720×1280')
    const user = JSON.stringify(messages.find((m) => m.role === 'user'))
    const order = ['当前页面', '旧页面', '图1：', 'data:image/png;base64,', '要求：把镜头降低']
    const at = order.map((s) => user.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(body.tools).toBeUndefined()

    expect(spends).toHaveLength(1)
    expect(spends[0]).toMatchObject({
      kind: 'openai_chat_completions',
      provider: 'relay',
      model: 'chat-model',
      output: 'art',
      quantity: 3456,
    })
  })

  test('指定模型时使用该模型；回复中没有完整文档时失败，花费照常记账', async () => {
    answer = '我无法完成。'
    const spends: MediaSpend[] = []
    const result = await generate({ provider: 'relay', model: 'other-model' }, (s) =>
      spends.push(s),
    )
    expect(result).toEqual({
      ok: false,
      message: 'relay / other-model：回复中没有完整的 HTML 文档',
    })
    expect((bodies[0] as { model: string }).model).toBe('other-model')
    expect(spends).toHaveLength(1)
  })

  test('接口不存在时不发出请求，消息列出可选的对话模型', async () => {
    const result = await generate({ provider: 'nope', model: 'chat-model' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('relay / chat-model、relay / other-model')
    expect(bodies).toHaveLength(0)
  })
})

describe('extractHtml', () => {
  test('取第一个 doctype 或 html 起始到最后一个 </html>；不完整时为 null', () => {
    expect(extractHtml('前言 <html lang="zh"><body>a</body></html> 后记')).toBe(
      '<html lang="zh"><body>a</body></html>',
    )
    expect(extractHtml('<!DOCTYPE HTML><html><body>a</body></HTML>')).toBe(
      '<!DOCTYPE HTML><html><body>a</body></HTML>',
    )
    expect(extractHtml('<!doctype html><html><body>写到一半')).toBeNull()
    expect(extractHtml('<htmlx></html>')).toBeNull()
  })
})
