/**
 * Token 估算。
 *
 * 覆盖范围：`tokens.ts` 全部，以及 `catalog.ts` 里每条 `ModelSpec.density` 的标定区间。
 *
 * 断言的是失败形状与标定区间，不是具体数字：具体数字随口径微调而变化，
 * 而下列低估、暴涨与口径混用都是实测出现过的形状，改动使其复现时测试必须失败。
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
import { STREAM_IDLE_TIMEOUT_MS } from './transport.ts'

const D = DEFAULT_DENSITY
/** 已标定的档位，取自目录本身；同时锁定该模型条目带有 density。 */
const DEEPSEEK = lookupModel(
  'deepseek-v4-pro',
  'openai_chat_completions',
  Date.UTC(2026, 8, 10),
).density

describe('文本口径', () => {
  test('空值一律为 0', () => {
    expect(estimateText('', D)).toBe(0)
    expect(estimateJson(undefined, D)).toBe(0)
    expect(estimateJson(null, D)).toBe(0)
    expect(estimateContent(undefined, D, D.textCharsPerToken)).toBe(0)
  })

  /**
   * 按 `length / 3.5` 计算等于每字 0.29 token，低估五倍。
   * 该估算是压缩判断的输入，低估过多时实际超限的请求会被判定为不会超限。
   */
  test('中文不按 1/3.5 个 token 计', () => {
    const cn = '这是一段纯中文的正文'
    expect(estimateText(cn, D)).toBeGreaterThan(Math.ceil(cn.length / 3.5) * 3)
  })

  test('拉丁文本按 textCharsPerToken 计', () => {
    expect(estimateText('a'.repeat(40), { ...D, textCharsPerToken: 4 })).toBe(10)
  })

  /** 稠密 JSON 中有大量单字符 token，按散文档计会低估。 */
  test('JSON 比自然语言更密', () => {
    const obj = { a: 1, b: 2, c: [3, 4, 5] }
    expect(estimateJson(obj, D)).toBeGreaterThan(estimateText(JSON.stringify(obj), D))
  })

  test('循环引用不抛出异常，返回 0', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(estimateJson(cyclic, D)).toBe(0)
  })
})

/**
 * 密度的标定区间。
 *
 * 真值由斜率法实测（2026-08-26，同一段文本按两种长度发送，两次 `prompt_tokens` 相减）。
 * 上下两侧都须锁定：
 *
 * - **下界 1.0**：低于真值即为低估，超限的请求会因此被判为可容纳，超出窗口时没有任何提示。
 * - **上界 1.5**：防止高估。对冻结前缀高估 1.87 倍时，
 *   第一次回执到达后读数即从估算值降至真值，界面上显示为「发一句话，占用先变大又变小」。
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

  test('目录中每一条都带有 density，四项均为正数', () => {
    for (const spec of builtinCatalog()) {
      expect(spec.density.cjkTokensPerChar).toBeGreaterThan(0)
      expect(spec.density.rareCjkTokensPerChar).toBeGreaterThan(0)
      expect(spec.density.textCharsPerToken).toBeGreaterThan(0)
      expect(spec.density.jsonCharsPerToken).toBeGreaterThan(0)
    }
  })
})

/**
 * 常用字与其余汉字分两档：DeepSeek V4.1 Flash 实测随机一级字 1.04 token / 字、随机非一级字 1.91。
 * 合为一档时生僻字被低估，读取一份含大量生僻字的文件后，下一次请求可能超出窗口。
 */
describe('汉字分两档', () => {
  const d: TokenDensity = {
    cjkTokensPerChar: 1,
    rareCjkTokensPerChar: 3,
    textCharsPerToken: 1_000_000,
    jsonCharsPerToken: 1_000_000,
  }

  test('一级字与中文标点按常用档，其余汉字按生僻档', () => {
    expect(estimateText('的一是了', d)).toBe(4)
    expect(estimateText('，。（）「」', d)).toBe(6)
    // 「龘」「㐀」「豈」分别是基本区非一级字、扩展 A 区、兼容区。
    expect(estimateText('龘㐀豈', d)).toBe(9)
  })

  test('上界档对生僻字不低于 Flash 实测', () => {
    const rare = '龘靐齉爩'.repeat(250)
    expect(estimateText(rare, DEFAULT_DENSITY)).toBeGreaterThanOrEqual(rare.length * 1.91)
  })
})

describe('内容块', () => {
  /**
   * 实测的暴涨形状：1 MB 图片约为 137 万个 base64 字符，按字符估算约 39 万 token，
   * provider 实际按约 2000 计。附加一张图片后，面板读数从 2% 升至 39%。
   */
  test('图片按固定值计，不按 base64 长度计', () => {
    const huge = 'A'.repeat(1_370_000)
    const n = estimateContent(
      [{ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: huge } }],
      D,
      D.textCharsPerToken,
    )
    expect(n).toBe(MEDIA_TOKENS)
    // 断言的是量级：不得与 base64 长度同阶。
    expect(n).toBeLessThan(huge.length / 100)
  })

  test('图文混排时分别计算', () => {
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
   * 实测的漏计形状：`write_file` 的整份文件正文位于 tool call 的 arguments 中，
   * 只计算 `m.content` 时，面板上该部分为 0。
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

  /** 思考正文随 tool_calls 一起发送给兼容端点，不计入时估算系统性偏低。 */
  test('reasoningContent 计入', () => {
    const a = estimateMessage(
      { role: 'assistant', content: '', reasoningContent: 'y'.repeat(400) },
      { ...D, textCharsPerToken: 4 },
    )
    const b = estimateMessage({ role: 'assistant', content: '' }, { ...D, textCharsPerToken: 4 })
    expect(a - b).toBe(100)
  })

  /**
   * 原生推理条目按回报的 token 数计。签名中是加密的完整推理，按字节估算会高出数倍；
   * 存在该条目时思考正文不发送，两者只计一份。
   */
  test('原生推理按回报 token 计，不按签名字节，也不与正文重复计', () => {
    const d = { ...D, textCharsPerToken: 4 }
    const bare = estimateMessage({ role: 'assistant', content: '' }, d)
    const native = estimateMessage(
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'y'.repeat(400),
        responseReasoning: {
          items: [{ type: 'thinking', thinking: 'y'.repeat(400), signature: 's'.repeat(40_000) }],
          tokens: 700,
        },
      },
      d,
    )
    expect(native - bare).toBe(700)
  })

  test('每条消息计入固定协议开销：几十条短消息不会被系统性低估', () => {
    const many = Array.from({ length: 50 }, () => ({ role: 'user' as const, content: '' }))
    expect(estimateMessages(many, D)).toBe(50 * 4)
  })

  /**
   * 工具结果是 `{call_id, tool, status, executed, summary, result}` 的稠密 JSON，
   * 实测 2.4–2.5 字符/token。按散文档计算会将编码 agent 中增长最快的部分低估三分之一，
   * 而该部分在会话接近上限时占比最大。
   */
  test('tool 角色按 JSON 档计，不按散文档计', () => {
    const payload = JSON.stringify({ call_id: 'c1', tool: 'read_file', result: 'x'.repeat(2000) })
    const d: TokenDensity = {
      cjkTokensPerChar: 1,
      rareCjkTokensPerChar: 3,
      textCharsPerToken: 4,
      jsonCharsPerToken: 2,
    }
    const asTool = estimateMessage({ role: 'tool', toolCallId: 'c1', content: payload }, d)
    const asUser = estimateMessage({ role: 'user', content: payload }, d)
    expect(asTool).toBeGreaterThan(asUser)
    expect(asTool - 4).toBe(Math.ceil(payload.length / 2))
  })
})

describe('整个请求', () => {
  test('system + tools + messages 三部分均计入', () => {
    const req = {
      model: 'm',
      system: [{ text: 'a'.repeat(40) }],
      messages: [{ role: 'user' as const, content: 'b'.repeat(40) }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      maxOutputTokens: 100,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal: new AbortController().signal,
    }
    const d: TokenDensity = { ...D, textCharsPerToken: 4 }
    const total = estimateRequest(req, d)
    expect(total).toBeGreaterThan(10 + 10)
    expect(total).toBe(10 + estimateSchemas(req.tools, d) + estimateMessages(req.messages, d))
  })
})
