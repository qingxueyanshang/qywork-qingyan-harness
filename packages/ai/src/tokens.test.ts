/**
 * Token 估算。
 *
 * 覆盖范围：`tokens.ts` 全部，以及 `catalog.ts` 里每条 `ModelSpec.density` 的标定区间。
 *
 * 断言的是**失败形状与标定区间**，不是具体数字——具体数字随口径微调会变，
 * 而下面这几种低估/暴涨/换尺都是实测形状，改动只要复发它们就必须红。
 */

import { describe, expect, test } from 'bun:test'
import { builtinCatalog, lookupModel } from './catalog.ts'
import {
  DEFAULT_DENSITY,
  estimateContent,
  estimateJson,
  estimateMessage,
  estimateMessages,
  estimateRequest,
  estimateSchemas,
  estimateText,
  MEDIA_TOKENS,
  type TokenDensity,
} from './tokens.ts'

const D = DEFAULT_DENSITY
/** 已标定那一档，取自目录本身——这一并锁住那条模型确实带着 density。 */
const DEEPSEEK = lookupModel('deepseek-v4-flash', 'openai_chat_completions').density

describe('文本口径', () => {
  test('空值一律 0', () => {
    expect(estimateText('', D)).toBe(0)
    expect(estimateJson(undefined, D)).toBe(0)
    expect(estimateJson(null, D)).toBe(0)
    expect(estimateContent(undefined, D, D.textCharsPerToken)).toBe(0)
  })

  /**
   * 旧口径是 `length / 3.5`，等于按 0.29/字——**低估五倍**。
   * 这个数是压缩判断的输入，低估到一定程度真正超限的请求会被判成「不可能超」。
   */
  test('中文不按 1/3.5 个 token 计', () => {
    const cn = '这是一段纯中文的正文'
    expect(estimateText(cn, D)).toBeGreaterThan(Math.ceil(cn.length / 3.5) * 3)
  })

  test('拉丁文本按 textCharsPerToken 走', () => {
    expect(estimateText('a'.repeat(40), { ...D, textCharsPerToken: 4 })).toBe(10)
  })

  /** 稠密 JSON 里大量单字符 token，按散文档会低估。 */
  test('JSON 比自然语言更密', () => {
    const obj = { a: 1, b: 2, c: [3, 4, 5] }
    expect(estimateJson(obj, D)).toBeGreaterThan(estimateText(JSON.stringify(obj), D))
  })

  test('循环引用不抛，返回 0', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(estimateJson(cyclic, D)).toBe(0)
  })
})

/**
 * 密度的标定区间。
 *
 * 真值是斜率法实测（2026-08-26，同一段文本发两种长度、两次 `prompt_tokens` 相减）。
 * 两侧都要锁：
 *
 * - **下界 1.0**：低于真值就是低估，而超限的请求会因此被判成装得下，撞窗无声。
 * - **上界 1.5**：这正是这次要治的病。旧口径对冻结前缀高 1.87 倍，
 *   第一次回执一到读数就从估算尺跌到真值尺，界面上是「发一句话，占用先变大又变小」。
 */
describe('密度标定', () => {
  /** deepseek 实测 0.569 token/字。 */
  const CN_TOKENS_PER_CHAR = 0.569
  const CN = '这个函数负责把工作区里的文件读出来并按行截断，遇到二进制内容直接拒绝。'

  test('deepseek 档对中文既不低估也不高出五成', () => {
    const real = CN.length * CN_TOKENS_PER_CHAR
    const est = estimateText(CN, DEEPSEEK)
    expect(est).toBeGreaterThanOrEqual(real)
    expect(est).toBeLessThan(real * 1.5)
  })

  test('上界档对每一条已标定的模型都是上界', () => {
    for (const spec of builtinCatalog()) {
      expect(estimateText(CN, D)).toBeGreaterThanOrEqual(estimateText(CN, spec.density))
      expect(estimateJson(CN, D)).toBeGreaterThanOrEqual(estimateJson(CN, spec.density))
    }
  })

  test('目录里每一条都带 density，三项都是正数', () => {
    for (const spec of builtinCatalog()) {
      expect(spec.density.cjkTokensPerChar).toBeGreaterThan(0)
      expect(spec.density.textCharsPerToken).toBeGreaterThan(0)
      expect(spec.density.jsonCharsPerToken).toBeGreaterThan(0)
    }
  })
})

describe('内容块', () => {
  /**
   * **实测的暴涨形状**：1 MB 图片 ≈ 137 万 base64 字符，按字符估是约 39 万 token，
   * provider 实际按约 2000 计。贴一张图，面板从 2% 跳到 39%。
   */
  test('图片按固定值，不数 base64', () => {
    const huge = 'A'.repeat(1_370_000)
    const n = estimateContent(
      [{ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: huge } }],
      D,
      D.textCharsPerToken,
    )
    expect(n).toBe(MEDIA_TOKENS)
    // 关键是量级：绝不能和 base64 长度同阶。
    expect(n).toBeLessThan(huge.length / 100)
  })

  test('图文混排各算各的', () => {
    const n = estimateContent(
      [
        { type: 'text', text: 'x'.repeat(40) },
        { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'zz' } },
      ],
      D,
      4,
    )
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
    const withCall = estimateMessage(
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a.ts', content: body } }],
      },
      D,
    )
    const withoutCall = estimateMessage({ role: 'assistant', content: '' }, D)
    expect(withCall - withoutCall).toBeGreaterThan(1000)
  })

  /** 思考正文会随 tool_calls 一起发给兼容端点，不数它就是系统性少一块。 */
  test('reasoningContent 计入', () => {
    const a = estimateMessage(
      { role: 'assistant', content: '', reasoningContent: 'y'.repeat(400) },
      { ...D, textCharsPerToken: 4 },
    )
    const b = estimateMessage({ role: 'assistant', content: '' }, { ...D, textCharsPerToken: 4 })
    expect(a - b).toBe(100)
  })

  test('每条有固定协议开销——几十条短消息不会被系统性低估', () => {
    const many = Array.from({ length: 50 }, () => ({ role: 'user' as const, content: '' }))
    expect(estimateMessages(many, D)).toBe(50 * 4)
  })

  /**
   * 工具结果是 `{call_id, tool, status, executed, summary, result}` 的稠密 JSON，
   * 实测 2.4–2.5 字符/token。按散文档计会把编码 agent 里长得最快的那个桶低估三分之一，
   * 而它恰好在会话最满的时候占比最大。
   */
  test('tool 角色走 JSON 档，不走散文档', () => {
    const payload = JSON.stringify({ call_id: 'c1', tool: 'read_file', result: 'x'.repeat(2000) })
    const d: TokenDensity = { cjkTokensPerChar: 1, textCharsPerToken: 4, jsonCharsPerToken: 2 }
    const asTool = estimateMessage({ role: 'tool', toolCallId: 'c1', content: payload }, d)
    const asUser = estimateMessage({ role: 'user', content: payload }, d)
    expect(asTool).toBeGreaterThan(asUser)
    expect(asTool - 4).toBe(Math.ceil(payload.length / 2))
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
    const d: TokenDensity = { ...D, textCharsPerToken: 4 }
    const total = estimateRequest(req, d)
    expect(total).toBeGreaterThan(10 + 10)
    expect(total).toBe(10 + estimateSchemas(req.tools, d) + estimateMessages(req.messages, d))
  })
})
