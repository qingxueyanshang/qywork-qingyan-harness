/**
 * 覆盖范围：`text.ts` 的 `generateText`（经 `media.ts` 的 `makeMediaPort` 分派）与 `run.ts` 中两类共用的请求、计费与失败。
 * 重发与重发日志由 `art.test.ts` 覆盖，两类经同一个 `runChatGeneration`。
 *
 * 对端是本机模拟的对话接口（OpenAI 兼容协议），按脚本返回 SSE 正文，并记录收到的请求体。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { MediaSpend } from '@qywork/core'
import type { QyConfig } from '../config.ts'
import { makeMediaPort } from '../media.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

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
