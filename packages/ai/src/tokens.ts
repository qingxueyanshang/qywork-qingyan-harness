/**
 * Token 估算。**只用于面板与预算判断**，精确值一律以 provider 回报的 usage 为准。
 *
 * 文字按词法计数（`textFeatures`）：中文字、英文单词与字母、数字、标点、空白等十项，各项乘以该模型的
 * 实测系数（`TokenDensity`）后相加。系数按模型确定，由调用方传入，此处不取默认值：同一段中文，
 * deepseek 约 0.74 token/字，默认档按 1.1 计；提供默认值等于允许某个调用点改用另一套口径，
 * 而这种不一致不会产生任何报错。
 *
 * 四个易错点：
 *
 * - **不要改回「字符数 ÷ 每 token 字符数」。** 同一模型上英文正文约 5 字符/token，代码与 JSON 约 3，
 *   中文约 1.4 字/token，按字符数相除的算法无法同时适用：2026-10-27 用 31 段真实样本留一交叉验证，
 *   该算法在英文为主的思考正文上偏差 46%，词法计数的中位偏差 2%–4%。
 * - **英文单词与字母分别计数。** 只按单词计数时，一段很长的连续字母只计为一个单词，严重低估。
 * - **图片与文档按固定值计算，不按 base64 长度**：一张 1 MB 的图片约为 137 万个
 *   base64 字符，按字符估算为数十万 token，而 provider 实际只计数千。
 * - **tool call 的参数须单独计算**：`write_file` 的整份文件正文位于 arguments 中，
 *   只计算 `m.content` 时该部分为 0。
 */

import { COMMON_HANZI } from './common-hanzi.ts'
import type { ChatRequest, ContentBlock, ToolSchema, WireMessage } from './types.ts'

/**
 * 常用汉字的码元集合（GB2312 一级汉字，`common-hanzi.ts`）。
 *
 * 常用字与其余汉字须分为两档：DeepSeek 实测随机非一级字 1.87 token / 字，常用中文约 0.74，
 * 合为一档时，按常用字取值会低估生僻字，按生僻字取值会高估常用中文一倍以上。
 */
const COMMON_HANZI_CODES: ReadonlySet<number> = new Set(
  [...COMMON_HANZI].map((c) => c.charCodeAt(0)),
)

/** 词法计数的十项。顺序即 `textFeatures` 的输出顺序。 */
export const TEXT_FEATURES = [
  'cjk',
  'rareCjk',
  'word',
  'letter',
  'caseBreak',
  'digit',
  'punctRun',
  'punct',
  'space',
  'other',
] as const

export type TextFeature = (typeof TEXT_FEATURES)[number]

/**
 * 一个 tokenizer 对各类内容的系数。真源是 `ModelSpec.density`（`catalog.ts`）。
 *
 * 标定方法固定：取真实会话中的各类样本（用户消息、模型正文、思考正文、工具调用参数、工具结果、
 * 系统提示、工具定义）与生僻字、其他字符两段构造样本，逐段发送，减去基线请求得到每段的真实 token 数，
 * 按十项计数做非负最小二乘拟合。经中转站调用时同样成立。新增模型档位前先按此方法测量，
 * 不要按 tokenizer 的词表大小推断。
 */
export interface TokenDensity {
  /** 常用汉字（`COMMON_HANZI`）与中文标点、全角符号，每字。 */
  cjk: number
  /** 其余中日韩表意文字（生僻字、扩展 A 区、兼容区），每字。 */
  rareCjk: number
  /** 每个英文单词（连续的 ASCII 字母）。 */
  word: number
  /** 每个 ASCII 字母。 */
  letter: number
  /** 单词内小写字母之后的大写字母（驼峰命名的分段处），每处。 */
  caseBreak: number
  /** 每个 ASCII 数字。 */
  digit: number
  /** 每段连续的 ASCII 标点。 */
  punctRun: number
  /** 每个 ASCII 标点。 */
  punct: number
  /** 每段连续的空白（空格、制表符、换行）。 */
  space: number
  /** 其余字符（非 ASCII 且非中日韩表意文字，如制表线、箭头、表情、带重音的字母），每个码点。 */
  other: number
  /** 每条消息的固定协议开销：role、分隔符、消息骨架。 */
  message: number
}

/**
 * 未标定的模型使用此档：各项取已实测各档（`catalog.ts`）的最大值并向上取整；生僻字取字节级上界：
 * 基本平面的汉字在 UTF-8 中占 3 字节，按字节回退的 tokenizer 每字节至多一个 token。
 *
 * 每一项都不低于任何已实测的模型，因此对已实测的 tokenizer 都偏高而不偏低。
 * 代价是读数偏高：未收录的模型只能偏高，不能偏低。
 */
export const DEFAULT_DENSITY: TokenDensity = {
  cjk: 1.1,
  rareCjk: 3,
  word: 0.33,
  letter: 0.2,
  caseBreak: 3.3,
  digit: 1.4,
  punctRun: 1.7,
  punct: 0.6,
  space: 0.82,
  other: 1.3,
  message: 6.4,
}

/**
 * 一张图片或一份文档计为多少 token。
 *
 * 按 PDF 取值（一份 1 MB 的 PDF 实际约 2000），只按图片估算会偏小一半。
 * 取值偏高：该值用于压缩判断，低估会导致应压缩时未压缩，随后超出窗口。
 */
export const MEDIA_TOKENS = 2000

const NONE = 0
const LETTER = 1
const DIGIT = 2
const PUNCT = 3
const SPACE = 4

/**
 * 按码元计数十项特征（`TEXT_FEATURES`）。
 *
 * 字母、数字、标点、空白只按 ASCII 判定；中文标点与全角符号（U+3000–303F、U+FF00–FFEF）与常用字计入
 * `cjk`，基本区的其余汉字、扩展 A 区（U+3400–4DBF）、兼容区（U+F900–FAFF）计入 `rareCjk`；代理对按一个码点
 * 计入 `other`。标定脚本使用同一个函数，改动计数规则后必须重新标定全部档位。
 */
export function textFeatures(text: string): Record<TextFeature, number> {
  const f: Record<TextFeature, number> = {
    cjk: 0,
    rareCjk: 0,
    word: 0,
    letter: 0,
    caseBreak: 0,
    digit: 0,
    punctRun: 0,
    punct: 0,
    space: 0,
    other: 0,
  }
  let prev = NONE
  let prevLower = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) {
      if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
        const upper = c <= 0x5a
        f.letter++
        if (prev !== LETTER) f.word++
        else if (upper && prevLower) f.caseBreak++
        prevLower = !upper
        prev = LETTER
      } else if (c >= 0x30 && c <= 0x39) {
        f.digit++
        prev = DIGIT
      } else if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) {
        if (prev !== SPACE) f.space++
        prev = SPACE
      } else if (c > 0x20 && c < 0x7f) {
        f.punct++
        if (prev !== PUNCT) f.punctRun++
        prev = PUNCT
      } else {
        f.other++
        prev = NONE
      }
      continue
    }
    // 代理对的后半：前半已按一个码点计入。
    if (c >= 0xdc00 && c <= 0xdfff) continue
    if ((c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) || COMMON_HANZI_CODES.has(c))
      f.cjk++
    else if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0xf900 && c <= 0xfaff)
    )
      f.rareCjk++
    else f.other++
    prev = NONE
  }
  return f
}

function count(text: string, d: TokenDensity): number {
  if (!text) return 0
  const f = textFeatures(text)
  let total = 0
  for (const k of TEXT_FEATURES) total += f[k] * d[k]
  return Math.ceil(total)
}

/** 自然语言正文与代码。 */
export function estimateText(text: string, d: TokenDensity): number {
  return count(text, d)
}

/** 结构化数据（工具 schema、tool call 参数、工具结果 JSON），按序列化后的文本计数。 */
export function estimateJson(value: unknown, d: TokenDensity): number {
  if (value === undefined || value === null) return 0
  try {
    return count(typeof value === 'string' ? value : JSON.stringify(value), d)
  } catch {
    // 循环引用等。返回 0 而不是抛错：估算失败不应导致整轮请求无法发起。
    return 0
  }
}

/**
 * 一条消息的内容块。
 *
 * 图片与文档按固定值计算，不得经由 JSON 序列化估算：按 base64 长度估算正是暴涨的来源。
 * 视频计为 0：其占用随时长与抽帧规则变化，本地没有可用的算法，只有接口回报的真值可信，
 * 读数一侧据 `videoBlocksOf` 标注「未计」（`agent` 的 `contextEvent`）。
 */
export function estimateContent(
  content: string | ContentBlock[] | undefined,
  d: TokenDensity,
): number {
  if (!content) return 0
  if (typeof content === 'string') return count(content, d)
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += count(block.text, d)
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
 * 四部分缺一不可：协议开销、正文、工具调用参数、思考正文。
 */
export function estimateMessage(m: WireMessage, d: TokenDensity): number {
  let total = d.message + estimateContent(m.content, d)
  // 原生推理条目按 provider 回报的 token 数计：签名与密文按字节估算会高出数倍。
  // 存在该条目时思考正文不发送（`reasoningReplay`），两者只计一份。
  if (m.responseReasoning) total += m.responseReasoning.tokens
  else if (m.reasoningContent) total += estimateText(m.reasoningContent, d)
  for (const call of m.toolCalls ?? []) {
    total += estimateText(call.name, d) + estimateJson(call.arguments, d)
  }
  return Math.ceil(total)
}

export function estimateMessages(messages: readonly WireMessage[], d: TokenDensity): number {
  let total = 0
  for (const m of messages) total += estimateMessage(m, d)
  return total
}

/** 工具 schema：按序列化后的 JSON 计数。 */
export function estimateSchemas(tools: readonly ToolSchema[], d: TokenDensity): number {
  return tools.length ? estimateJson(tools, d) : 0
}

/** 整个请求：冻结前缀 + 工具 schema + 全部消息。 */
export function estimateRequest(req: ChatRequest, d: TokenDensity): number {
  const system = req.system.reduce((n, b) => n + estimateText(b.text, d), 0)
  return system + estimateSchemas(req.tools, d) + estimateMessages(req.messages, d)
}
