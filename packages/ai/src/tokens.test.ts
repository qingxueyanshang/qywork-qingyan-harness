/**
 * Token 估算。
 *
 * 覆盖范围：`tokens.ts` 全部。
 *
 * 断言的是**失败形状**，不是具体数字——具体数字随口径微调会变，
 * 而下面这三种低估/暴涨都是实测形状，改动只要复发它们就必须红。
 */

import { describe, expect, test } from 'bun:test'
import {
  estimateContent,
  estimateJson,
  estimateMessage,
  estimateMessages,
  estimateRequest,
  estimateSchemas,
  estimateText,
  MEDIA_TOKENS,
} from './tokens.ts'

describe('文本口径', () => {
  test('空值一律 0', () => {
    expect(estimateText('')).toBe(0)
    expect(estimateJson(undefined)).toBe(0)
    expect(estimateJson(null)).toBe(0)
    expect(estimateContent(undefined)).toBe(0)
  })

  /**
   * 中文按 1.5/字。旧口径是 `length / 3.5`，等于按 0.29/字——**低估五倍**。
   * 这个数是压缩判断的输入，低估到一定程度真正超限的请求会被判成「不可能超」。
   */
  test('中文不再被当成 1/3.5 个 token', () => {
    const cn = '这是一段纯中文的正文'
    expect(estimateText(cn)).toBe(Math.ceil(cn.length * 1.5))
    // 与旧口径对比：新口径必须明显更高。
    expect(estimateText(cn)).toBeGreaterThan(Math.ceil(cn.length / 3.5) * 3)
  })

  test('英文按 4 字符/token', () => {
    expect(estimateText('a'.repeat(40))).toBe(10)
  })

  /** 稠密 JSON 里大量单字符 token，按 4 会低估一倍。 */
  test('JSON 比自然语言更密', () => {
    const obj = { a: 1, b: 2, c: [3, 4, 5] }
    expect(estimateJson(obj)).toBeGreaterThan(estimateText(JSON.stringify(obj)))
  })

  test('循环引用不抛，返回 0', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(estimateJson(cyclic)).toBe(0)
  })
})

describe('内容块', () => {
  /**
   * **实测的暴涨形状**：1 MB 图片 ≈ 137 万 base64 字符，按字符估是约 39 万 token，
   * provider 实际按约 2000 计。贴一张图，面板从 2% 跳到 39%。
   */
  test('图片按固定值，不数 base64', () => {
    const huge = 'A'.repeat(1_370_000)
    const n = estimateContent([
      { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: huge } },
    ])
    expect(n).toBe(MEDIA_TOKENS)
    // 关键是量级：绝不能和 base64 长度同阶。
    expect(n).toBeLessThan(huge.length / 100)
  })

  test('图文混排各算各的', () => {
    const n = estimateContent([
      { type: 'text', text: 'x'.repeat(40) },
      { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'zz' } },
    ])
    expect(n).toBe(10 + MEDIA_TOKENS)
  })
})

describe('消息', () => {
  /**
   * **实测的漏数形状**：`write_file` 的整份文件正文在 tool call 的 arguments 里，
   * 而旧口径只数 `m.content`——面板上它是 0。
   */
  test('tool call 参数必须计入', () => {
    const body = 'x'.repeat(4000)
    const withCall = estimateMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a.ts', content: body } }],
    })
    const withoutCall = estimateMessage({ role: 'assistant', content: '' })
    expect(withCall - withoutCall).toBeGreaterThan(1000)
  })

  /** 思考正文会随 tool_calls 一起发给兼容端点，不数它就是系统性少一块。 */
  test('reasoningContent 计入', () => {
    const a = estimateMessage({ role: 'assistant', content: '', reasoningContent: 'y'.repeat(400) })
    const b = estimateMessage({ role: 'assistant', content: '' })
    expect(a - b).toBe(100)
  })

  test('每条有固定协议开销——几十条短消息不会被系统性低估', () => {
    const many = Array.from({ length: 50 }, () => ({ role: 'user' as const, content: '' }))
    expect(estimateMessages(many)).toBe(50 * 4)
  })
})

describe('整个请求', () => {
  test('system + tools + messages 三段都算', () => {
    const req = {
      model: 'm',
      system: [{ text: 'a'.repeat(40) }],
      messages: [{ role: 'user' as const, content: 'b'.repeat(40) }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    }
    const total = estimateRequest(req)
    expect(total).toBeGreaterThan(10 + 10)
    expect(total).toBe(10 + estimateSchemas(req.tools) + estimateMessages(req.messages))
  })
})
