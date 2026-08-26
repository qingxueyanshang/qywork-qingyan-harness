/**
 * Token 估算。**只用于面板与预算判断**，精确值一律以 provider 回报的 usage 为准。
 *
 * 三个系数（`TokenDensity`）**按模型走，由调用方传进来**，不在这里取默认值：
 * 各家 tokenizer 对中文的密度差 1.8 倍（实测 deepseek 0.57、claude 1.03 token/字），
 * 一组全局常数对两档不可能同时成立。参数必填也是为此——给默认值就等于允许某个
 * 调用点用回另一把尺，而这种漂移不会产生任何报错。
 *
 * 四个坑：
 *
 * - **除法基底，不按词计数。** 按词在压缩 JSON、长标识符、base64 残片上会空白坍缩：
 *   一段 10 KB 的压缩 JSON 真值约 5000 token，按词只有几十，低两个数量级。
 * - **稠密结构比自然语言费 token**，所以 JSON 与散文两档分开：工具 schema、
 *   tool call 参数、**工具结果**都走 JSON 那一档。
 * - **图片与文档按固定值，绝不看 base64 长度**：一张 1 MB 的图片是约 137 万个
 *   base64 字符，按字符估就是 39 万 token，而 provider 实际按约 2000 计。
 * - **tool call 的参数要单独数**：`write_file` 的整份文件正文在 arguments 里，
 *   只数 `m.content` 的话它是 0。
 */

import type { ChatRequest, ContentBlock, ToolSchema, WireMessage } from './types.ts'

/** 中日韩统一表意文字与常用中文标点。 */
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g

/**
 * 一个 tokenizer 对三类内容的密度。真源是 `ModelSpec.density`（`catalog.ts`）。
 *
 * 标定方法固定：同一段文本发两种长度，两次 `prompt_tokens` 相减取斜率——
 * 相减消掉端点的固定开销，中转站上也成立。加一档新模型前先按这个方法量一次，
 * 不要按 tokenizer 的词表大小推断。
 *
 * **每一档都必须是上界。** 低估的代价是真正超限的请求被判成不可能超，
 * 而那一次撞窗是无声的。
 */
export interface TokenDensity {
  /** 中文一个字算几个 token。 */
  cjkTokensPerChar: number
  /** 自然语言正文与代码，几个字符算一个 token。 */
  textCharsPerToken: number
  /** 稠密结构（工具 schema、tool call 参数、工具结果），几个字符算一个 token。 */
  jsonCharsPerToken: number
}

/**
 * 没有标定过的模型用这一档。
 *
 * 三项都取实测里最费 token 的那一端（中文按 claude 的 1.03 再留一点、
 * 文本与 JSON 按稠密代码的 2.4 再留一点），因此对任何已知 tokenizer 都是上界。
 * 代价是读数偏高——**未收录的模型宁可偏高，不能偏低**。
 */
export const DEFAULT_DENSITY: TokenDensity = {
  cjkTokensPerChar: 1.1,
  textCharsPerToken: 2.5,
  jsonCharsPerToken: 2,
}

/**
 * 一张图片 / 一份文档按多少算。
 *
 * 按 PDF 取值（一份 1 MB 的 PDF 实际约 2000），只按图片估会偏小一半。
 * 宁可高估——这个数进的是压缩判断，低估的代价是该压不压然后撞墙。
 */
export const MEDIA_TOKENS = 2000

/**
 * 每条消息的固定协议开销：role、分隔符、消息骨架。
 *
 * 不算它的话，一段几十条短消息的历史会被系统性低估。
 *
 * 边界：Responses 协议把一条带 N 个 tool call 的 assistant 消息拆成
 * `reasoning` + `message` + N 个 `function_call` 条目，各自带骨架，
 * 而这里只收一次。多调用轮次因此仍偏低，量级是每轮几十 token。
 */
const PER_MESSAGE_OVERHEAD = 4

function count(text: string, cjkPerChar: number, charsPerToken: number): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  const rest = text.length - cjk
  return Math.ceil(cjk * cjkPerChar + rest / charsPerToken)
}

/** 自然语言正文。 */
export function estimateText(text: string, d: TokenDensity): number {
  return count(text, d.cjkTokensPerChar, d.textCharsPerToken)
}

/** 结构化数据（工具 schema、tool call 参数、工具结果 JSON）。 */
export function estimateJson(value: unknown, d: TokenDensity): number {
  if (value === undefined || value === null) return 0
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return count(text, d.cjkTokensPerChar, d.jsonCharsPerToken)
  } catch {
    // 循环引用等。返回 0 而不是抛——估算失败不该让整轮请求起不来。
    return 0
  }
}

/**
 * 一条消息的内容块。
 *
 * `charsPerToken` 由调用方按消息角色选（tool 走 JSON 档，其余走文本档），
 * 不在这里判——`estimateContent` 拿不到角色。
 *
 * 图片/文档走固定值，**绝不落到 JSON 序列化那条路**——那正是 base64 暴涨的来源。
 */
export function estimateContent(
  content: string | ContentBlock[] | undefined,
  d: TokenDensity,
  charsPerToken: number,
): number {
  if (!content) return 0
  if (typeof content === 'string') return count(content, d.cjkTokensPerChar, charsPerToken)
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += count(block.text, d.cjkTokensPerChar, charsPerToken)
    else total += MEDIA_TOKENS
  }
  return total
}

/**
 * 一条 wire 消息的全部占用。
 *
 * 三部分缺一不可：正文、**工具调用参数**、**思考正文**。
 *
 * **tool 角色的正文走 JSON 档。** 它是一段 `{call_id, tool, status, executed,
 * summary, result}` 的稠密 JSON，实测密度 2.4–2.5 字符/token，与散文差近一倍；
 * 按散文档计会把编码 agent 里长得最快的那个桶系统性低估三分之一。
 */
export function estimateMessage(m: WireMessage, d: TokenDensity): number {
  const charsPerToken = m.role === 'tool' ? d.jsonCharsPerToken : d.textCharsPerToken
  let total = PER_MESSAGE_OVERHEAD + estimateContent(m.content, d, charsPerToken)
  if (m.reasoningContent) total += estimateText(m.reasoningContent, d)
  for (const call of m.toolCalls ?? []) {
    total += estimateText(call.name, d) + estimateJson(call.arguments, d)
  }
  return total
}

export function estimateMessages(messages: readonly WireMessage[], d: TokenDensity): number {
  let total = 0
  for (const m of messages) total += estimateMessage(m, d)
  return total
}

/** 工具 schema。按 JSON 口径——它就是一段稠密 JSON。 */
export function estimateSchemas(tools: readonly ToolSchema[], d: TokenDensity): number {
  return tools.length ? estimateJson(tools, d) : 0
}

/** 整个请求：冻结前缀 + 工具 schema + 全部消息。 */
export function estimateRequest(req: ChatRequest, d: TokenDensity): number {
  const system = req.system.reduce((n, b) => n + estimateText(b.text, d), 0)
  return system + estimateSchemas(req.tools, d) + estimateMessages(req.messages, d)
}
