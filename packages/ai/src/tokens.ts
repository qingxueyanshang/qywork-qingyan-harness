/**
 * Token 估算。**只用于面板与预算判断**，精确值一律以 provider 回报的 usage 为准。
 *
 * ## 为什么不是一个 `length / N`
 *
 * 原来这里是 `ceil(text.length / 3.5)`，对整个序列化请求体调用一次。三处错：
 *
 * 1. **中文被严重低估。** 中文约 1～1.5 token/字，除以 3.5 等于按 1/4 计，
 *    低估三到五倍。而这个数字是压缩判断的输入——低估到一定程度，
 *    真正超限的请求会被判成「不可能超」。
 * 2. **base64 被当成正文数。** 一张 1 MB 的图片是约 137 万个 base64 字符，
 *    按字符估就是**39 万 token**，而 provider 实际按约 2000 计。贴一张图，
 *    面板从 2% 跳到 39%。cc-haha 的 `tokenEstimation.ts:419-431` 为这件事
 *    专门写了注释：「Must NOT reach the jsonStringify catch-all」。
 * 3. **tool call 的参数一个都没数。** `write_file` 的整份文件正文就在
 *    tool call 的 arguments 里，而按 `m.content` 数的话它是 0。
 *
 * ## 口径
 *
 * - **除法基底，不按词计数。** 按词在压缩 JSON、长标识符、base64 残片上会
 *   空白坍缩：一段 10 KB 的压缩 JSON 真值约 5000 token，按词只有几十——
 *   低两个数量级。魔盒的「中文 ×1.5 + 英文词 ×1.3」是它 tiktoken 缺失时的
 *   **应急回退**（`token_counter.py:63-64` 原话），不是主口径，不要拿来当主口径。
 * - 中文按 1.5/字，其余按 4 字符/token；**JSON 上下文按 2 字符/token**——
 *   稠密 JSON 里 `{`/`}`/`:`/`,`/`"` 大量是单字符 token（cc-haha `:216-225`）。
 * - 图片与文档按固定值，**不看 base64 长度**。
 */

import type { ChatRequest, ContentBlock, ToolSchema, WireMessage } from './types.ts'

/** 中日韩统一表意文字与常用中文标点。 */
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/g

/**
 * 一张图片 / 一份文档按多少算。
 *
 * 取 cc-haha 的 2000（`tokenEstimation.ts:430`）而不是魔盒的 1000：
 * 前者覆盖 PDF（一份 1 MB 的 PDF 实际约 2000），后者只按图片估。
 * 宁可高估——这个数进的是压缩判断，低估的代价是该压不压然后撞墙。
 */
export const MEDIA_TOKENS = 2000

/**
 * 每条消息的固定协议开销：role、分隔符、消息骨架。
 *
 * 不算它的话，一段几十条短消息的历史会被系统性低估。魔盒同口径
 * （`context/manager.py:93` 的 `+ 4`）。
 */
const PER_MESSAGE_OVERHEAD = 4

function count(text: string, bytesPerToken: number): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  const rest = text.length - cjk
  return Math.ceil(cjk * 1.5 + rest / bytesPerToken)
}

/** 自然语言正文。 */
export function estimateText(text: string): number {
  return count(text, 4)
}

/** 结构化数据（工具 schema、tool call 参数、工具结果 JSON）。 */
export function estimateJson(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    return count(typeof value === 'string' ? value : JSON.stringify(value), 2)
  } catch {
    // 循环引用等。返回 0 而不是抛——估算失败不该让整轮请求起不来。
    return 0
  }
}

/**
 * 一条消息的内容块。
 *
 * 图片/文档走固定值，**绝不落到 JSON 序列化那条路**——那正是 base64 暴涨的来源。
 */
export function estimateContent(content: string | ContentBlock[] | undefined): number {
  if (!content) return 0
  if (typeof content === 'string') return estimateText(content)
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += estimateText(block.text)
    else total += MEDIA_TOKENS
  }
  return total
}

/**
 * 一条 wire 消息的全部占用。
 *
 * 三部分缺一不可：正文、**工具调用参数**、**思考正文**。后两者原来一个都没数。
 */
export function estimateMessage(m: WireMessage): number {
  let total = PER_MESSAGE_OVERHEAD + estimateContent(m.content)
  if (m.reasoningContent) total += estimateText(m.reasoningContent)
  for (const call of m.toolCalls ?? []) {
    total += estimateText(call.name) + estimateJson(call.arguments)
  }
  return total
}

export function estimateMessages(messages: readonly WireMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessage(m)
  return total
}

/** 工具 schema。按 JSON 口径——它就是一坨稠密 JSON。 */
export function estimateSchemas(tools: readonly ToolSchema[]): number {
  return tools.length ? estimateJson(tools) : 0
}

/** 整个请求：冻结前缀 + 工具 schema + 全部消息。 */
export function estimateRequest(req: ChatRequest): number {
  const system = req.system.reduce((n, b) => n + estimateText(b.text), 0)
  return system + estimateSchemas(req.tools) + estimateMessages(req.messages)
}
