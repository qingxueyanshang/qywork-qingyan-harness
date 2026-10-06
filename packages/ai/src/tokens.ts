/**
 * Token 估算。**只用于面板与预算判断**，精确值一律以 provider 回报的 usage 为准。
 *
 * 四个系数（`TokenDensity`）按模型确定，由调用方传入，此处不取默认值：
 * 各厂商 tokenizer 对中文的密度相差 1.8 倍（实测 deepseek 0.57、claude 1.03 token/字），
 * 一组全局常数无法同时适用于两者。参数必填也出于此原因：提供默认值等于允许某个
 * 调用点改用另一套口径，而这种不一致不会产生任何报错。
 *
 * 四个易错点：
 *
 * - **按字符数相除，不按词计数。** 按词计数在压缩 JSON、长标识符、base64 片段上严重偏低：
 *   一段 10 KB 的压缩 JSON 真值约 5000 token，按词计数只有几十，低两个数量级。
 * - **稠密结构比自然语言消耗更多 token**，因此 JSON 与散文分为两档：工具 schema、
 *   tool call 参数、工具结果均按 JSON 档计算。
 * - **图片与文档按固定值计算，不按 base64 长度**：一张 1 MB 的图片约为 137 万个
 *   base64 字符，按字符估算为 39 万 token，而 provider 实际按约 2000 计。
 * - **tool call 的参数须单独计算**：`write_file` 的整份文件正文位于 arguments 中，
 *   只计算 `m.content` 时该部分为 0。
 */

import { COMMON_HANZI } from './common-hanzi.ts'
import type { ChatRequest, ContentBlock, ToolSchema, WireMessage } from './types.ts'

/**
 * 常用汉字的码元集合（GB2312 一级汉字，`common-hanzi.ts`）。
 *
 * 常用字与其余汉字须分为两档：DeepSeek V4.1 Flash 实测随机一级字 1.04 token / 字，随机非一级字 1.91，
 * 相差近一倍；合为一档时，按常用字取值会低估生僻字，按生僻字取值会高估常用中文近三倍。
 */
const COMMON_HANZI_CODES: ReadonlySet<number> = new Set(
  [...COMMON_HANZI].map((c) => c.charCodeAt(0)),
)

/**
 * 一个 tokenizer 对四类内容的密度。真源是 `ModelSpec.density`（`catalog.ts`）。
 *
 * 标定方法固定：同一段文本按两种长度发送，两次 `prompt_tokens` 相减取斜率；
 * 相减可消去端点的固定开销，经中转站调用时同样成立。新增模型档位前先按此方法测量，
 * 不要按 tokenizer 的词表大小推断。
 *
 * **每一档都必须是上界。** 低估时实际超限的请求会被判定为不会超限，
 * 超出窗口时没有任何提示。
 */
export interface TokenDensity {
  /** 常用汉字（`COMMON_HANZI`）与中文标点、全角符号：每字计为多少 token。 */
  cjkTokensPerChar: number
  /** 其余中日韩表意文字（生僻字、扩展 A 区、兼容区）：每字计为多少 token。 */
  rareCjkTokensPerChar: number
  /** 自然语言正文与代码：每个 token 对应的字符数。 */
  textCharsPerToken: number
  /** 稠密结构（工具 schema、tool call 参数、工具结果）：每个 token 对应的字符数。 */
  jsonCharsPerToken: number
}

/**
 * 未标定的模型使用此档。
 *
 * 常用字、文本与 JSON 取实测中 token 消耗最高的一端并留有余量（中文以 claude 的 1.03 为基础，
 * 文本与 JSON 以稠密代码的 2.4 为基础）；其余汉字取字节级上界：基本平面的汉字在 UTF-8 中占
 * 3 字节，按字节回退的 tokenizer 每字节至多一个 token，因此对任何已知 tokenizer 都是上界。
 * 代价是读数偏高：未收录的模型只能偏高，不能偏低。
 */
export const DEFAULT_DENSITY: TokenDensity = {
  cjkTokensPerChar: 1.1,
  rareCjkTokensPerChar: 3,
  textCharsPerToken: 2.5,
  jsonCharsPerToken: 2,
}

/**
 * 一张图片或一份文档计为多少 token。
 *
 * 按 PDF 取值（一份 1 MB 的 PDF 实际约 2000），只按图片估算会偏小一半。
 * 取值偏高：该值用于压缩判断，低估会导致应压缩时未压缩，随后超出窗口。
 */
export const MEDIA_TOKENS = 2000

/**
 * 每条消息的固定协议开销：role、分隔符、消息骨架。
 *
 * 不计入该开销时，几十条短消息组成的历史会被系统性低估。
 *
 * 边界：Responses 协议将一条带 N 个 tool call 的 assistant 消息拆分为
 * `reasoning` + `message` + N 个 `function_call` 条目，各自带有骨架，
 * 而此处只计一次。多调用轮次因此仍然偏低，量级为每轮几十 token。
 */
const PER_MESSAGE_OVERHEAD = 4

/**
 * 按码元分四类计数：中文标点与全角符号（U+3000–303F、U+FF00–FFEF）与常用字按常用档，
 * 基本区的其余汉字、扩展 A 区（U+3400–4DBF）、兼容区（U+F900–FAFF）按生僻档，其余按 `charsPerToken`。
 */
function count(text: string, d: TokenDensity, charsPerToken: number): number {
  if (!text) return 0
  let common = 0
  let rare = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x3000) continue
    if (c <= 0x303f || (c >= 0xff00 && c <= 0xffef)) common++
    else if (c >= 0x4e00 && c <= 0x9fff) {
      if (COMMON_HANZI_CODES.has(c)) common++
      else rare++
    } else if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) rare++
  }
  const rest = text.length - common - rare
  return Math.ceil(
    common * d.cjkTokensPerChar + rare * d.rareCjkTokensPerChar + rest / charsPerToken,
  )
}

/** 自然语言正文。 */
export function estimateText(text: string, d: TokenDensity): number {
  return count(text, d, d.textCharsPerToken)
}

/** 结构化数据（工具 schema、tool call 参数、工具结果 JSON）。 */
export function estimateJson(value: unknown, d: TokenDensity): number {
  if (value === undefined || value === null) return 0
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return count(text, d, d.jsonCharsPerToken)
  } catch {
    // 循环引用等。返回 0 而不是抛错：估算失败不应导致整轮请求无法发起。
    return 0
  }
}

/**
 * 一条消息的内容块。
 *
 * `charsPerToken` 由调用方按消息角色选择（tool 使用 JSON 档，其余使用文本档），
 * 此处不判定：`estimateContent` 无法取得角色。
 *
 * 图片与文档按固定值计算，不得经由 JSON 序列化估算：按 base64 长度估算正是暴涨的来源。
 * 视频计为 0：其占用随时长与抽帧规则变化，本地没有可用的算法，只有接口回报的真值可信，
 * 读数一侧据 `videoBlocksOf` 标注「未计」（`agent` 的 `contextEvent`）。
 */
export function estimateContent(
  content: string | ContentBlock[] | undefined,
  d: TokenDensity,
  charsPerToken: number,
): number {
  if (!content) return 0
  if (typeof content === 'string') return count(content, d, charsPerToken)
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += count(block.text, d, charsPerToken)
    else if (block.type === 'image') total += MEDIA_TOKENS
  }
  return total
}

/** 一组消息里的视频块数。估算不含它们（见 `estimateContent`）。 */
export function videoBlocksOf(messages: readonly WireMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (typeof m.content !== 'string') n += m.content.filter((b) => b.type === 'video').length
  }
  return n
}

/**
 * 一条 wire 消息的全部占用。
 *
 * 三部分缺一不可：正文、工具调用参数、思考正文。
 *
 * **tool 角色的正文按 JSON 档计算。** 它是 `{call_id, tool, status, executed,
 * summary, result}` 形式的稠密 JSON，实测密度 2.4–2.5 字符/token，与散文相差近一倍；
 * 按散文档计算会将编码 agent 中增长最快的部分系统性低估三分之一。
 */
export function estimateMessage(m: WireMessage, d: TokenDensity): number {
  const charsPerToken = m.role === 'tool' ? d.jsonCharsPerToken : d.textCharsPerToken
  let total = PER_MESSAGE_OVERHEAD + estimateContent(m.content, d, charsPerToken)
  // 原生推理条目按 provider 回报的 token 数计：签名与密文按字节估算会高出数倍。
  // 存在该条目时思考正文不发送（`reasoningReplay`），两者只计一份。
  if (m.responseReasoning) total += m.responseReasoning.tokens
  else if (m.reasoningContent) total += estimateText(m.reasoningContent, d)
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

/** 工具 schema。按 JSON 口径计算：它本身是稠密 JSON。 */
export function estimateSchemas(tools: readonly ToolSchema[], d: TokenDensity): number {
  return tools.length ? estimateJson(tools, d) : 0
}

/** 整个请求：冻结前缀 + 工具 schema + 全部消息。 */
export function estimateRequest(req: ChatRequest, d: TokenDensity): number {
  const system = req.system.reduce((n, b) => n + estimateText(b.text, d), 0)
  return system + estimateSchemas(req.tools, d) + estimateMessages(req.messages, d)
}
