/**
 * 生成模型目录：每个生成模型在某条生成协议上支持的操作、参考图数量上限与参数。
 *
 * 按「模型 id × 协议」精确匹配，或使用该模型已声明的协议映射；其他组合使用协议默认规格。
 * 字段与对话目录不同：生成模型没有上下文窗口与思考档位，只有操作与参数表。
 *
 * 官方模型收录各厂商当前最新一代；渠道模型按渠道公示的可调用列表登记。
 * 未收录的型号仍可经接口调用，使用协议默认的参数表。
 *
 * 参数使用接口自身的字段名，不做跨厂商统一。生成质量 `quality` 与分辨率 `size` 分别声明；
 * 火山的尺寸可写 `size: 2K`，百炼可写 `size: 2048*2048`，各自遵守接口约束。
 * 参数原样发给接口，发送前按本表校验（`params.ts`）。
 *
 * 条目逐条与官方文档核对，核对日期写在每组上方。
 *
 * 价格按接口回报的计量计算，不在本地估算用量。单价逐条与官方价格页核对；按分辨率、清晰度等分档的，
 * 按回报的规格取档；无法取得档位或没有价目时金额记 0，界面显示 N/A。不写入未核实的单价：
 * 账本中虚构的金额与真实金额无法区分。
 */

import {
  type Currency,
  MEDIA_KIND_OUTPUT,
  type MediaKind,
  type MediaParamDefinition,
  type MentionStyle,
} from '@qywork/core'
import { BINGUO_DEFAULTS, BINGUO_MODELS } from './catalog-binguo.ts'
import { GOOGLE_XAI_DEFAULTS, GOOGLE_XAI_MODELS } from './catalog-google-xai.ts'
import { MUMUGOFE_MODELS } from './catalog-mumugofe.ts'
import type { MediaInput, MediaUsage } from './types.ts'

/**
 * 生成操作。由调用时提供的输入推定，不由大模型选择。
 *
 * 图像：`generate` 按提示词生成，`edit` 在参考图上修改。
 * 视频：`text_to_video` 文生视频，`image_to_video` 首帧生视频，`first_last_frame` 首尾帧生视频，
 * `reference_to_video` 参考素材生视频，`video_to_video` 以参考视频为输入（编辑、延长或参考由模型的原生参数或提示词决定）。
 * 语音：`speech` 文字转语音。
 */
export type MediaOperation =
  | 'generate'
  | 'edit'
  | 'text_to_video'
  | 'image_to_video'
  | 'first_last_frame'
  | 'reference_to_video'
  | 'video_to_video'
  | 'speech'

export interface MediaParamSpec extends MediaParamDefinition {
  /** 参数的含义与约束，用一句话写成，供大模型阅读。 */
  description: string
  /** 仅在这些操作下有效。省略时对全部操作有效。 */
  operations?: readonly MediaOperation[]
}

/**
 * 界面上一项「宽高比 × 分辨率」对应的尺寸取值。省略 `ratio` 表示宽高比由模型决定；省略 `tier` 表示没有档位；
 * 省略 `value` 表示不发送该参数。
 */
export interface MediaShape {
  ratio?: string
  tier?: string
  value?: string
}

/** 宽高比，顺序即界面上的显示顺序。 */
const RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] as const

/**
 * 按档位计算各宽高比的尺寸：总像素取档位边长的平方，宽、高向下取整为 16 的倍数，
 * 因此总像素不超过该档。调用方须保证每档都在接口文档的像素范围内（目录测试逐项核对）。
 *
 * `shorthand`：接口接受档位简写（「2K」）时，「自动」即简写本身，宽高比由模型决定；不接受时「自动」取值为 `auto`，
 * 未提供 `auto` 则不发送。`maxSide`：单边上限，超出时按比例缩小到上限以内。
 */
function sizeTable(opts: {
  tiers: readonly { tier: string; side: number }[]
  sep: 'x' | '*'
  shorthand: boolean
  auto?: string
  maxSide?: number
}): MediaShape[] {
  const out: MediaShape[] = opts.shorthand ? [] : [opts.auto ? { value: opts.auto } : {}]
  const down16 = (n: number) => Math.floor(n / 16) * 16
  for (const { tier, side } of opts.tiers) {
    if (opts.shorthand) out.push({ tier, value: tier })
    for (const ratio of RATIOS) {
      const [a, b] = ratio.split(':').map(Number) as [number, number]
      const w = side * Math.sqrt(a / b)
      const h = side * Math.sqrt(b / a)
      const fit = Math.min(1, (opts.maxSide ?? Number.POSITIVE_INFINITY) / Math.max(w, h))
      out.push({ ratio, tier, value: `${down16(w * fit)}${opts.sep}${down16(h * fit)}` })
    }
  }
  return out
}

const TIER_1K = { tier: '1K', side: 1024 }
const TIER_2K = { tier: '2K', side: 2048 }

export interface MediaModelSpec {
  id: string
  displayName: string
  vendor: string | null
  kind: MediaKind
  operations: readonly MediaOperation[]
  /**
   * 参考图、参考视频的数量上限与传递方式（首尾帧不计入）。传递方式由目录声明，不按模型名推测：
   * OpenAI 的修改使用 multipart `/edits`，其余均放入 JSON。
   * `types`：同一协议下各厂商的素材类型名不同时（百炼上的万相与可灵），写明各用途在请求中的类型名；省略时使用协议的类型名。
   */
  inputs: {
    maxImages: number
    maxVideos: number
    /** 参考音频的段数上限。省略表示不接受参考音频（总时长上限由各厂商另行规定，本地不校验，由接口判定）。 */
    maxAudios?: number
    transport: 'multipart' | 'json'
    types?: Partial<Record<MediaInput['role'], string>>
    /** 允许尾帧单独输入，或首尾帧与参考素材组合。省略时各组合互斥且尾帧需要首帧。 */
    lastFrameAlone?: boolean
    framesWithReferences?: boolean
    /** 音频必须同时带参考图或参考视频。 */
    audioRequiresVisual?: boolean
    /** 百炼中仅接受图像地址的模型也使用临时上传。 */
    inlineImages?: boolean
    /** 允许的素材用途组合；参数条件按目录默认值求值。 */
    combinations?: readonly {
      roles: readonly MediaInput['role'][]
      maxImages?: number
      params?: Readonly<Record<string, string>>
    }[]
  }
  params: readonly MediaParamSpec[]
  /** false 表示目录中没有该 id，使用的是协议默认。 */
  catalogued: boolean
  /**
   * 官方单价，按接口回报的计量计算金额。以下情形没有单价，金额不明：协议默认、按 id 回退到其他协议（中转站价格不同）、
   * 接口不回报计量的模型（OpenAI 语音合成）。接口直接回报扣费金额的模型（可灵官方）无需单价。
   */
  price?: MediaPrice
  /**
   * 提示词中指代第 n 个参考素材的写法（`{n}` 从 1 起，按类别分别计数），使用接口原生写法，不做统一转换。
   * 画布把 `@` 引用编译为该写法；大模型的本轮快照中也列出该写法。未登记的模型按素材名写入提示词。
   */
  mention?: MentionStyle
  /** 已核实的其他协议映射；未声明的协议不继承原生参数与能力。 */
  mappings?: Partial<Record<MediaKind, MediaMapping>>
  /** 通用视频端点中厂商扩展字段的请求结构。 */
  videoFormat?: 'dashscope' | 'ark' | 'veo' | 'kling-omni' | 'mumugofe'
}

type MediaMapping = Partial<
  Pick<MediaModelSpec, 'operations' | 'inputs' | 'params' | 'videoFormat'>
>

export interface MediaPrice {
  currency: Currency
  /** 缺少计价所需的计量时返回 null。 */
  cost(u: MediaUsage): number | null
  /**
   * 按发送前已确定的参数与输入推算计量，供界面在发送前显示本次花费（`quoteMedia`）。
   * 计量须待接口回报才能确定的（按 token 计价、档位由接口决定、计费秒数含输入视频时长）不实现，或返回 null。
   * 推算的计量必须与接口成功后回报的计量口径一致，否则发送前显示的金额与账本不一致。
   */
  usageOf?(params: Record<string, unknown>, inputs: MediaInputCount): MediaUsage | null
}

/** 一次请求中参考图与参考视频的数量（首尾帧计入图）。 */
export interface MediaInputCount {
  images: number
  videos: number
}

/**
 * 发送前的花费：计量由 `usageOf` 按参数推算（未填写的参数取目录中的接口默认值），金额由同一个 `cost` 计算。
 * 无法推算或金额不明时返回 null，界面不显示。
 */
export function quoteMedia(
  spec: MediaModelSpec,
  params: Record<string, unknown>,
  inputs: MediaInputCount,
): { cost: number; currency: Currency } | null {
  const price = spec.price
  if (!price?.usageOf) return null
  const defaults: Record<string, unknown> = {}
  for (const p of spec.params) if (p.default !== undefined) defaults[p.name] = p.default
  const usage = price.usageOf({ ...defaults, ...params }, inputs)
  const cost = usage ? price.cost(usage) : null
  return cost !== null && cost > 0 ? { cost, currency: price.currency } : null
}

/**
 * 一次生成的金额。接口直接回报扣费金额时以回报为准，其次按目录单价计算；两者均无时金额记 0（金额不明）。
 */
export function mediaCost(
  spec: MediaModelSpec,
  usage: MediaUsage,
): { cost: number; currency: Currency } {
  if (usage.billed) return { cost: usage.billed.amount, currency: usage.billed.currency }
  const currency = spec.price?.currency ?? 'USD'
  const cost = spec.price?.cost(usage)
  return { cost: cost !== null && cost !== undefined && cost > 0 ? cost : 0, currency }
}

/** 按档位取单价。档位不在表中（接口回报了表外的规格）时返回 undefined，金额按不明处理。 */
function tier(rates: Record<string, number>, key: string | undefined): number | undefined {
  return key === undefined ? undefined : rates[key]
}

/** Seedance 的 480p 与 720p 同价。 */
function seedanceTier(resolution: string | undefined): string | undefined {
  return resolution === '480p' || resolution === '720p' ? '720p' : resolution
}

/**
 * 按张计价。`output` 给出每张输出图的单价（可按计量分档），`input` 是每张参考图的单价，
 * `firstInputFree` 表示首张参考图免费（火山 Seedream 5.0 Pro）。
 */
function perImage(
  currency: Currency,
  output: (u: MediaUsage) => number | undefined,
  input: { rate: number; firstInputFree?: boolean } | null = null,
): MediaPrice {
  return {
    currency,
    cost(u) {
      const rate = output(u)
      if (u.images === undefined || rate === undefined) return null
      const inputs = u.inputImages ?? 0
      const billedInputs = input?.firstInputFree ? Math.max(inputs - 1, 0) : inputs
      return u.images * rate + billedInputs * (input?.rate ?? 0)
    },
  }
}

/** 按秒计价，单价按计量分档。 */
function perSecond(currency: Currency, rate: (u: MediaUsage) => number | undefined): MediaPrice {
  return {
    currency,
    cost(u) {
      const r = rate(u)
      return u.seconds === undefined || r === undefined ? null : u.seconds * r
    },
  }
}

/** 按每百万输出 token 计价，单价按计量分档（Seedance）。 */
function perMillionOutputTokens(
  currency: Currency,
  rate: (u: MediaUsage) => number | undefined,
): MediaPrice {
  return {
    currency,
    cost(u) {
      const r = rate(u)
      return u.outputTokens === undefined || r === undefined ? null : (u.outputTokens * r) / 1e6
    },
  }
}

// ── 价格（2026-09-26 核对官方价格页，均为原价，不计限时折扣与免费额度）──
// OpenAI「Pricing」图像生成：GPT Image 2.5 文字输入 $5、图片输入 $8、图片输出 $30，每百万 token；
// Images API 不计缓存输入。
const gptImagePrice: MediaPrice = {
  currency: 'USD',
  cost: (u) =>
    u.outputTokens === undefined
      ? null
      : ((u.inputTextTokens ?? 0) * 5 + (u.inputImageTokens ?? 0) * 8 + u.outputTokens * 30) / 1e6,
}
// 火山方舟「模型价格」：Seedream 5.0 Pro 单图 ≤ 261 万像素 ¥0.30、> 261 万像素 ¥0.60，输入图首张免费、第 2 张起 ¥0.02；
// 像素按 `output_tokens`（像素总数 / 256）折算每张。Flash 每张 ¥0.12，输入图免费。
const seedreamProPrice = perImage(
  'CNY',
  (u) =>
    u.outputTokens === undefined || !u.images
      ? undefined
      : (u.outputTokens * 256) / u.images <= 2_610_000
        ? 0.3
        : 0.6,
  { rate: 0.02, firstInputFree: true },
)
const seedreamFlashPrice: MediaPrice = {
  ...perImage('CNY', () => 0.12),
  // 每次生成一张，输入图免费。
  usageOf: (_params, inputs) => ({ images: 1, inputImages: inputs.images }),
}
// 百炼「模型调用价格」：千问图像 3.0 Pro 输出 1k ¥0.25、2k ¥0.5，3.0 输出 ¥0.18，输入均 ¥0.02 每张；
// 档位取接口回报的 `output_image_type`。
const qwenImagePrice = (rates: Record<string, number>) =>
  perImage('CNY', (u) => tier(rates, u.imageTier), { rate: 0.02 })
// 万相图像 2.7 Pro ¥0.50、2.7 ¥0.20 每张，只按输出计费。
// 万相视频 3.0 Prime 480P ¥0.45、720P ¥0.9、1080P ¥1.8 每秒；3.0 ¥0.3、¥0.6、¥1.2；计费秒数含输入视频时长。
const wanVideoPrice = (rates: Record<string, number>): MediaPrice => ({
  ...perSecond('CNY', (u) => tier(rates, u.resolution)),
  // 有参考视频时计费秒数含输入视频时长，发送前无法确定，不估算；-1（由模型决定）同样不估算。
  usageOf: (p, inputs) => {
    const seconds = Number(p.duration)
    if (inputs.videos > 0 || !(seconds > 0) || typeof p.resolution !== 'string') return null
    return { seconds, resolution: p.resolution.toLowerCase() }
  },
})
// 火山方舟「模型价格」：Seedance 每百万 token，按输出分辨率与输入是否含视频分档；480p 与 720p 同价。
const seedancePrice = (rates: Record<string, [number, number]>) =>
  perMillionOutputTokens('CNY', (u) => {
    const pair = rates[seedanceTier(u.resolution) ?? '']
    return pair ? pair[u.videoInput ? 1 : 0] : undefined
  })
// 百炼「模型调用价格」：千问语音合成 3 按输入字符 ¥0.8 每万字符（一个汉字计 2 个字符，接口回报值已按此计算），输出不计费。
const qwenSpeechPrice: MediaPrice = {
  currency: 'CNY',
  cost: (u) => (u.characters === undefined ? null : (u.characters / 10_000) * 0.8),
}
// 百炼「模型调用价格」：可灵 3.0 按秒，按清晰度（std 720P / pro 1080P / 4k）、有无声音、有无参考视频分档。
// 无声 ¥0.6 / ¥0.8 / ¥3.0，有声 ¥0.9 / ¥1.2 / ¥3.0；Omni 有参考视频（仅支持无声）时与有声同价；Turbo 固定有声 ¥0.8 / ¥1.0。
const KLING_SILENT = { '720p': 0.6, '1080p': 0.8, '4k': 3.0 }
const KLING_SOUND = { '720p': 0.9, '1080p': 1.2, '4k': 3.0 }
/** 百炼上可灵的清晰度档位与接口回报的 `SR` 的对应关系（`videoUsage` 将 `SR` 规整为 `720p` / `1080p` / `4k`）。 */
const KLING_MODE_RESOLUTION: Record<string, string> = { std: '720p', pro: '1080p', '4k': '4k' }
const klingBailianPrice = (
  rates: (u: MediaUsage) => Record<string, number> | undefined,
): MediaPrice => ({
  ...perSecond('CNY', (u) => {
    const table = rates(u)
    return table ? tier(table, u.resolution) : undefined
  }),
  // 有参考视频时时长由输入视频决定（编辑）或另有上限，不估算。
  usageOf: (p, inputs) => {
    const seconds = Number(p.duration)
    const resolution = KLING_MODE_RESOLUTION[String(p.mode)]
    if (inputs.videos > 0 || !(seconds > 0) || !resolution) return null
    return { seconds, resolution, ...(typeof p.audio === 'boolean' ? { audio: p.audio } : {}) }
  },
})

// ── OpenAI GPT Image（2026-09-25 核对 developers.openai.com 图像生成指南与 edits 参考）──
const gptImageParams: readonly MediaParamSpec[] = [
  {
    name: 'size',
    label: '尺寸',
    type: 'string',
    pattern: '^(auto|\\d+x\\d+)$',
    default: 'auto',
    sizeLimits: { minPixels: 655360, maxPixels: 8294400, maxRatio: 3, maxSide: 3840, multiple: 16 },
    // 4K 档按总像素上限（3840x2160）取边长 2880；21:9 等宽幅另受单边 3840 限制。
    shapes: sizeTable({
      tiers: [TIER_1K, TIER_2K, { tier: '4K', side: 2880 }],
      sep: 'x',
      shorthand: false,
      auto: 'auto',
      maxSide: 3840,
    }),
    description: '输出尺寸；auto 由模型决定',
  },
  {
    name: 'quality',
    label: '生成质量',
    type: 'enum',
    values: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
    valueLabels: { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', auto: '自动' },
    default: 'auto',
    description: '生成质量档位，影响细节、耗时与费用，不改变输出分辨率',
  },
  {
    name: 'n',
    label: '张数',
    type: 'integer',
    min: 1,
    max: 10,
    default: 1,
    description: '一次生成的张数',
  },
  {
    name: 'output_format',
    label: '输出格式',
    advanced: true,
    type: 'enum',
    values: ['png', 'jpeg', 'webp'],
    default: 'png',
    rules: [{ when: { params: { background: ['transparent'] } }, values: ['png', 'webp'] }],
    description: '输出格式',
  },
  {
    name: 'output_compression',
    label: '压缩质量',
    advanced: true,
    type: 'integer',
    min: 0,
    max: 100,
    rules: [{ when: { params: { output_format: ['png'] } }, available: false }],
    description: 'jpeg / webp 的压缩质量',
  },
  {
    name: 'background',
    label: '背景',
    advanced: true,
    type: 'enum',
    values: ['transparent', 'opaque', 'auto'],
    valueLabels: { transparent: '透明', opaque: '不透明', auto: '自动' },
    default: 'auto',
    rules: [{ when: { params: { output_format: ['jpeg'] } }, values: ['opaque', 'auto'] }],
    description: '背景；transparent 须搭配 png 或 webp',
  },
]

// ── 火山方舟 Seedream 5.0（2026-09-25 核对方舟「图片生成 API」与模型列表）──
const seedreamParams: readonly MediaParamSpec[] = [
  {
    name: 'size',
    label: '尺寸',
    type: 'string',
    pattern: '^(1K|1\\.5K|2K|\\d+x\\d+)$',
    default: '2K',
    sizeLimits: {
      minPixels: 921600,
      maxPixels: 4624220,
      maxRatio: 16,
      tiers: { '1K': 1024 ** 2, '1.5K': 1536 ** 2, '2K': 2048 ** 2 },
    },
    shapes: sizeTable({
      tiers: [TIER_1K, { tier: '1.5K', side: 1536 }, TIER_2K],
      sep: 'x',
      shorthand: true,
    }),
    description: '输出尺寸；只写档位时宽高比写在提示词中，由模型决定',
  },
  {
    name: 'output_format',
    label: '输出格式',
    advanced: true,
    type: 'enum',
    values: ['png', 'jpeg'],
    default: 'jpeg',
    rules: [{ when: { params: { background: ['transparent'] } }, values: ['png'], default: 'png' }],
    description: '输出格式',
  },
  {
    name: 'background',
    label: '背景',
    advanced: true,
    type: 'enum',
    values: ['transparent', 'opaque'],
    valueLabels: { transparent: '透明', opaque: '不透明' },
    default: 'opaque',
    operations: ['edit'],
    description: '透明背景，仅在输入一张带透明通道的图片时可用，输出为 png',
    available: false,
    rules: [{ when: { imageCount: 1 }, available: true }],
  },
  {
    name: 'watermark',
    label: '水印',
    advanced: true,
    type: 'boolean',
    default: true,
    description: '在右下角添加「AI 生成」水印',
  },
]

// ── 百炼千问图像 3.0（2026-09-25 核对「千问图像生成与编辑 API」）──
const qwenImageParams: readonly MediaParamSpec[] = [
  {
    name: 'size',
    label: '尺寸',
    type: 'string',
    pattern: '^\\d+\\*\\d+$',
    sizeLimits: { minPixels: 512 ** 2, maxPixels: 2048 ** 2, maxRatio: 8 },
    shapes: sizeTable({ tiers: [TIER_1K, TIER_2K], sep: '*', shorthand: false }),
    description: '输出尺寸，宽与高以星号分隔；不填写时由模型决定',
  },
  {
    name: 'n',
    label: '张数',
    type: 'integer',
    min: 1,
    max: 6,
    default: 1,
    description: '一次生成的张数',
  },
  {
    name: 'negative_prompt',
    label: '排除内容',
    advanced: true,
    type: 'string',
    maxLength: 500,
    description: '不希望出现的内容，最多 500 字',
  },
  {
    name: 'seed',
    label: '随机种子',
    advanced: true,
    type: 'integer',
    min: 0,
    max: 2147483647,
    description: '随机种子；同一种子与提示词得到相近结果',
  },
  {
    name: 'prompt_extend',
    label: '提示词扩写',
    advanced: true,
    type: 'boolean',
    default: true,
    description: '由模型扩写提示词',
  },
  {
    name: 'prompt_extend_mode',
    label: '扩写方式',
    advanced: true,
    type: 'enum',
    values: ['direct', 'agent'],
    valueLabels: { direct: '直接扩写', agent: '智能扩写' },
    default: 'direct',
    rules: [
      { when: { operations: ['edit'] }, values: ['direct'] },
      { when: { params: { prompt_extend: [false] } }, available: false },
    ],
    description: '扩写方式',
  },
  {
    name: 'enable_thinking',
    label: '思考',
    advanced: true,
    type: 'boolean',
    default: true,
    rules: [{ when: { params: { prompt_extend: [false] } }, available: false }],
    description: '生成前先推理；仅开启提示词扩写时生效',
  },
  {
    name: 'watermark',
    label: '水印',
    advanced: true,
    type: 'boolean',
    default: false,
    description: '添加「Qwen-Image」水印',
  },
]

/**
 * 百炼万相 2.7 图像（2026-09-30 核对「万相-图像生成与编辑 2.7 API 参考」）。
 * Pro 支持 1K / 2K / 4K（4K 仅限文生图），普通版仅支持 1K / 2K，可用档位由调用方通过 `pro` 指定。
 */
function wanImageParams(pro: boolean): readonly MediaParamSpec[] {
  return [
    {
      name: 'size',
      label: '尺寸',
      type: 'string',
      pattern: pro ? '^(1K|2K|4K|\\d+\\*\\d+)$' : '^(1K|2K|\\d+\\*\\d+)$',
      default: '2K',
      sizeLimits: {
        minPixels: 768 ** 2,
        maxPixels: (pro ? 4096 : 2048) ** 2,
        maxRatio: 8,
        tiers: { '1K': 1024 ** 2, '2K': 2048 ** 2, ...(pro ? { '4K': 4096 ** 2 } : {}) },
      },
      rules: [
        {
          when: { operations: ['edit'] },
          sizeLimits: {
            minPixels: 768 ** 2,
            maxPixels: 2048 ** 2,
            maxRatio: 8,
            tiers: { '1K': 1024 ** 2, '2K': 2048 ** 2, '4K': 4096 ** 2 },
          },
        },
      ],
      shapes: sizeTable({
        tiers: pro ? [TIER_1K, TIER_2K, { tier: '4K', side: 4096 }] : [TIER_1K, TIER_2K],
        sep: '*',
        shorthand: true,
      }),
      description:
        '输出尺寸，宽与高以星号分隔；只写档位时文生图输出正方形，有输入图时沿用最后一张输入图的宽高比' +
        (pro ? '；有输入图时最大 2K，4K 仅限文生图' : ''),
    },
    ...wanImageRest,
  ]
}

const wanImageRest: readonly MediaParamSpec[] = [
  {
    name: 'n',
    label: '张数',
    type: 'integer',
    min: 1,
    max: 4,
    default: 1,
    description: '一次生成的张数',
  },
  {
    name: 'thinking_mode',
    label: '思考',
    advanced: true,
    type: 'boolean',
    default: true,
    operations: ['generate'],
    description: '生成前先推理，仅对文生图生效',
  },
  {
    name: 'seed',
    label: '随机种子',
    advanced: true,
    type: 'integer',
    min: 0,
    max: 2147483647,
    description: '随机种子；同一种子与提示词得到相近结果',
  },
  {
    name: 'watermark',
    label: '水印',
    advanced: true,
    type: 'boolean',
    default: false,
    description: '添加水印',
  },
]

// ── 百炼万相 3.0 视频（2026-09-25 核对「万相 3.0 视频生成 API」）──
const wanVideoParams: readonly MediaParamSpec[] = [
  {
    name: 'ratio',
    label: '宽高比',
    type: 'enum',
    values: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    default: 'adaptive',
    description: '画幅；adaptive 按输入自动适配，竖版使用 9:16',
  },
  {
    name: 'resolution',
    label: '分辨率',
    type: 'enum',
    values: ['1080P', '720P', '480P'],
    default: '1080P',
    description: '分辨率',
  },
  {
    name: 'duration',
    label: '时长',
    type: 'integer',
    min: 2,
    max: 30,
    auto: -1,
    default: 5,
    description: '时长（秒），2 到 30；-1 表示由模型决定；有参考视频时上限由输入决定',
  },
  { name: 'audio', label: '声音', type: 'boolean', default: true, description: '是否生成声音' },
  {
    name: 'seed',
    label: '随机种子',
    advanced: true,
    type: 'integer',
    min: -1,
    max: 2147483647,
    description: '随机种子；同一种子得到相近结果',
  },
  {
    name: 'prompt_extend',
    label: '提示词扩写',
    advanced: true,
    type: 'boolean',
    default: true,
    description: '由模型扩写提示词',
  },
  {
    name: 'watermark',
    label: '水印',
    advanced: true,
    type: 'boolean',
    default: false,
    description: '添加水印',
  },
]

// ── 火山方舟 Seedance 2.5（2026-09-25 核对方舟「创建视频生成任务 API」与模型列表）──
const seedanceParams: readonly MediaParamSpec[] = [
  {
    name: 'ratio',
    label: '宽高比',
    type: 'enum',
    values: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    default: 'adaptive',
    description: '画幅；首帧、首尾帧、编辑、延长时只能取 adaptive',
    rules: [
      { when: { operations: ['image_to_video', 'first_last_frame'] }, values: ['adaptive'] },
      { when: { params: { omni_reference_task_type: ['edit', 'extend'] } }, values: ['adaptive'] },
    ],
  },
  {
    name: 'resolution',
    label: '分辨率',
    type: 'enum',
    values: ['480p', '720p', '1080p'],
    default: '720p',
    description: '分辨率',
  },
  {
    name: 'duration',
    label: '时长',
    type: 'integer',
    min: 4,
    max: 30,
    auto: -1,
    default: -1,
    description: '时长（秒），4 到 30；-1 表示由模型决定；编辑时只能取 -1',
    rules: [{ when: { params: { omni_reference_task_type: ['edit'] } }, values: [-1] }],
  },
  {
    name: 'omni_reference_task_type',
    label: '任务类型',
    type: 'enum',
    values: ['auto', 'reference', 'edit', 'extend'],
    valueLabels: { auto: '自动', reference: '参考生成', edit: '编辑', extend: '延长' },
    default: 'auto',
    operations: ['reference_to_video', 'video_to_video'],
    rules: [{ when: { operations: ['reference_to_video'] }, values: ['auto', 'reference'] }],
    description:
      '有参考素材时的任务类型：reference 参考生成、edit 编辑参考视频、extend 延长参考视频；显式指定时，参数不合规会在提交时报错，不扣费',
  },
  {
    name: 'generate_audio',
    label: '声音',
    type: 'boolean',
    default: true,
    description: '是否生成同步声音',
  },
  {
    name: 'return_last_frame',
    label: '返回尾帧',
    type: 'boolean',
    default: false,
    description: '同时返回尾帧图（jpeg，与视频同尺寸、无水印），可用作下一段视频的首帧',
  },
  {
    name: 'output_format',
    type: 'enum',
    label: '输出格式',
    advanced: true,
    values: ['mp4', 'mov'],
    default: 'mp4',
    description: '输出格式；mov 色彩精度高、播放兼容性差',
  },
  {
    name: 'watermark',
    label: '水印',
    advanced: true,
    type: 'boolean',
    default: false,
    description: '在右下角添加「AI 生成」水印',
  },
]

/**
 * 火山方舟 Seedance 2.0 系列（2026-09-25 核对方舟「创建视频生成任务 API」逐参数的「模型支持」与模型列表）。
 * 与 2.5 的差别：时长上限 15，画幅不受输入限制，没有 `omni_reference_task_type` 与 `output_format`；
 * 可用清晰度因型号而异，由调用方传入。
 */
function seedance20Params(resolutions: readonly string[]): readonly MediaParamSpec[] {
  return [
    {
      name: 'ratio',
      label: '宽高比',
      type: 'enum',
      values: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
      default: 'adaptive',
      description: '画幅；adaptive 按输入或提示词自动选择',
    },
    {
      name: 'resolution',
      label: '分辨率',
      type: 'enum',
      values: resolutions,
      default: '720p',
      description: '分辨率',
    },
    {
      name: 'duration',
      label: '时长',
      type: 'integer',
      min: 4,
      max: 15,
      auto: -1,
      description: '时长（秒），4 到 15；-1 表示由模型决定',
    },
    {
      name: 'generate_audio',
      label: '声音',
      type: 'boolean',
      default: true,
      description: '是否生成同步声音',
    },
    {
      name: 'return_last_frame',
      label: '返回尾帧',
      type: 'boolean',
      default: false,
      description: '同时返回尾帧图（jpeg，与视频同尺寸、无水印），可用作下一段视频的首帧',
    },
    {
      name: 'watermark',
      label: '水印',
      advanced: true,
      type: 'boolean',
      default: false,
      description: '在右下角添加「AI 生成」水印',
    },
  ]
}

/**
 * 百炼上的可灵 3.0（2026-09-25 核对百炼「可灵视频生成 API 参考」）。仅在北京地域开放。
 * 与万相使用同一端点，但 `media[].type` 的取值不同（参考图为 `refer`，视频分为 `feature` 与 `base`），见目录的 `types`。
 * 不支持 `input` 中的多镜头、主体与负向提示词字段：多镜头可写入提示词，官方允许将负向描述写入提示词。
 */
function klingBailianParams(opts: { modes: readonly string[]; audio: boolean }): MediaParamSpec[] {
  return [
    {
      name: 'mode',
      label: '清晰度',
      type: 'enum',
      values: opts.modes,
      valueLabels: { std: '720P', pro: '1080P', '4k': '4K' },
      default: 'pro',
      description: '清晰度档位：std 为 720P，pro 为 1080P，4k 为 4K',
    },
    {
      name: 'aspect_ratio',
      label: '宽高比',
      type: 'enum',
      values: ['16:9', '9:16', '1:1'],
      default: '16:9',
      operations: ['text_to_video', 'reference_to_video', 'video_to_video'],
      description: '画幅；编辑视频时沿用输入视频的宽高比，此参数无效',
    },
    {
      name: 'duration',
      label: '时长',
      type: 'integer',
      min: 3,
      max: 15,
      default: 5,
      description: '时长（秒）；有参考视频时 3 到 10，编辑视频时沿用输入视频时长，此参数无效',
      rules: [
        { when: { operations: ['video_to_video'] }, max: 10 },
        {
          when: { operations: ['video_to_video'], params: { video_type: ['base'] } },
          available: false,
        },
      ],
    },
    ...(opts.audio
      ? [
          {
            name: 'audio',
            label: '声音',
            type: 'boolean',
            default: false,
            description: '是否生成声音；输入中有视频时只能取 false',
            rules: [{ when: { operations: ['video_to_video'] }, values: [false] }],
          } as const,
        ]
      : []),
  ]
}

/**
 * 百炼上可灵的参考视频以 `media[].type` 区分用途，接口没有单独的参数字段。此处以该参数交由大模型选择，
 * 百炼适配器将其写入视频项的类型，不作为参数发送。取值为接口原值。
 */
const klingBailianVideoType: MediaParamSpec = {
  name: 'video_type',
  label: '视频用途',
  type: 'enum',
  values: ['feature', 'base'],
  valueLabels: { feature: '参考生成', base: '编辑视频' },
  default: 'feature',
  operations: ['video_to_video'],
  description:
    '参考视频的用途：feature 用作特征参考（参考镜头、风格，或生成上一 / 下一镜头），base 用作待编辑视频',
}

/**
 * 可灵开放平台官方接口的 3.0（2026-09-25 核对 kling.ai/document-api 的 3.0、3.0 Omni、3.0 Turbo 各页）。
 * 参数均在 `settings` 中；画幅仅在文生视频时可设，首帧、首尾帧沿用首帧的宽高比。
 */
function klingParams(opts: {
  resolutions: readonly string[]
  audio: readonly string[] | null
  multiShot: boolean
}): MediaParamSpec[] {
  return [
    {
      name: 'aspect_ratio',
      label: '宽高比',
      type: 'enum',
      values: ['16:9', '9:16', '1:1'],
      default: '16:9',
      operations: ['text_to_video', 'reference_to_video'],
      description: '画幅',
    },
    {
      name: 'resolution',
      label: '分辨率',
      type: 'enum',
      values: opts.resolutions,
      default: '720p',
      description: '分辨率',
    },
    {
      name: 'duration',
      label: '时长',
      type: 'integer',
      min: 3,
      max: 15,
      default: 5,
      description: '时长（秒）',
    },
    ...(opts.audio
      ? [
          {
            name: 'audio',
            label: '声音',
            type: 'enum',
            values: opts.audio,
            valueLabels: { native: '有声', off: '无声' },
            default: 'off',
            description: 'native 生成匹配画面的声音，off 无声',
          } as const,
        ]
      : []),
    ...(opts.multiShot
      ? [
          {
            name: 'multi_shot',
            label: '多镜头',
            advanced: true,
            type: 'boolean',
            default: true,
            description:
              '多镜头；提示词按「shot 序号, 秒数, 描述;」写分镜，各镜头秒数之和等于总时长',
          } as const,
        ]
      : []),
  ]
}

// ── OpenAI 语音（2026-09-25 核对 developers.openai.com 语音合成指南与 speech 参考）──
const openaiSpeechParams: readonly MediaParamSpec[] = [
  {
    name: 'voice',
    label: '音色',
    type: 'string',
    default: 'alloy',
    presets: [
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
      'marin',
      'cedar',
    ],
    description: '音色',
  },
  {
    name: 'instructions',
    type: 'string',
    description: '语气、情绪、语速等朗读要求，用自然语言描述',
  },
  {
    name: 'response_format',
    type: 'enum',
    values: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
    default: 'mp3',
    description: '音频格式',
  },
  { name: 'speed', type: 'number', min: 0.25, max: 4, default: 1, description: '语速倍数' },
]

// ── 百炼千问语音合成 3（2026-09-25 核对「千问语音合成 API」与「支持的系统音色」）──
const qwenSpeechParams: readonly MediaParamSpec[] = [
  {
    name: 'voice',
    label: '音色',
    type: 'string',
    default: 'Cherry',
    presets: [
      'Cherry',
      'Serena',
      'Ethan',
      'Moon',
      'Kai',
      'Neil',
      'Maia',
      'Momo',
      'Vivian',
      'Chelsie',
      'Bella',
      'Ryan',
      'Katerina',
      'Eldric Sage',
      'Mia',
      'Mochi',
      'Bellona',
      'Vincent',
      'Bunny',
      'Elias',
      'Arthur',
      'Nini',
      'Seren',
      'Pip',
      'Stella',
      'Nofish',
      'Jennifer',
      'Aiden',
    ],
    description:
      '系统音色；Cherry 明快女声、Serena 温柔女声、Ethan 北方口音男声、Moon 随性男声、Kai 舒缓男声、Neil 新闻播音男声',
  },
  {
    name: 'language_type',
    type: 'enum',
    values: [
      'Auto',
      'Chinese',
      'English',
      'German',
      'Italian',
      'Portuguese',
      'Spanish',
      'Japanese',
      'Korean',
      'French',
      'Russian',
    ],
    default: 'Auto',
    description: '朗读语种',
  },
]

const IMAGE_OPERATIONS: readonly MediaOperation[] = ['generate', 'edit']
const SPEECH_OPERATIONS: readonly MediaOperation[] = ['speech']
const NO_INPUTS: MediaModelSpec['inputs'] = { maxImages: 0, maxVideos: 0, transport: 'json' }
/** 百炼上可灵的素材类型名；视频的类型由参数 `video_type` 决定，此处为未填写时的取值。 */
const KLING_BAILIAN_TYPES: MediaModelSpec['inputs']['types'] = {
  reference: 'refer',
  video: 'feature',
}
const VIDEO_OPERATIONS: readonly MediaOperation[] = [
  'text_to_video',
  'image_to_video',
  'first_last_frame',
  'reference_to_video',
  'video_to_video',
]

const spec = (
  id: string,
  displayName: string,
  vendor: string,
  kind: MediaKind,
  operations: readonly MediaOperation[],
  inputs: MediaModelSpec['inputs'],
  params: readonly MediaParamSpec[],
  price?: MediaPrice,
  mention?: MentionStyle,
  mappings?: MediaModelSpec['mappings'],
): MediaModelSpec => ({
  id,
  displayName,
  vendor,
  kind,
  operations,
  inputs,
  params,
  catalogued: true,
  ...(price ? { price } : {}),
  ...(mention ? { mention } : {}),
  ...(mappings ? { mappings } : {}),
})

/** 万相视频的中转只接受内联图像；本机视频、音频需要百炼原生的临时上传。 */
const WAN_VIDEO_MAPPING: MediaModelSpec['mappings'] = {
  openai_videos: {
    videoFormat: 'dashscope',
    operations: ['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video'],
    inputs: { maxImages: 10, maxVideos: 0, maxAudios: 0, transport: 'json' },
  },
}
const ARK_VIDEO_MAPPING: MediaModelSpec['mappings'] = {
  openai_videos: { videoFormat: 'ark' },
}

/** 图片兼容接口接受宽x高；原生接口使用宽*高，目录中的尺寸与界面选项一起转换。 */
function compatibleImageParams(params: readonly MediaParamSpec[]): MediaParamSpec[] {
  return params.map((p) => {
    if (p.name !== 'size') return p
    const next = { ...p, description: p.description.replaceAll('*', 'x') }
    if (next.pattern) next.pattern = next.pattern.replace('\\*', 'x')
    if (typeof next.default === 'string') next.default = next.default.replace('*', 'x')
    if (next.shapes)
      next.shapes = next.shapes.map((s) => ({
        ...s,
        ...(s.value ? { value: s.value.replace('*', 'x') } : {}),
      }))
    return next
  })
}

// ── 提示词中指代素材的写法（2026-09-29 核对官方文档原文）──
// 方舟 Seedance 2.0 系列：「提示词中必须使用"素材类型+序号"格式引用素材，序号为请求体中该素材在同类素材中的排序」。
const SEEDANCE_20_MENTION: MentionStyle = { image: '图片{n}', video: '视频{n}', audio: '音频{n}' }
// 方舟 Seedance 2.5：「使用 @图片1、@视频1、@音频1 指代参考素材」。
const SEEDANCE_25_MENTION: MentionStyle = {
  image: '@图片{n}',
  video: '@视频{n}',
  audio: '@音频{n}',
}
// 百炼万相 3.0：「prompt中可以用"图1""视频1""音频1"等指代 media 数组中对应顺序的媒体素材」，「图和视频分别计数」。
// 百炼上的可灵使用 `<<<>>>` 写法，文档未写明是否按类别分别计数，因此未登记。
const WAN_MENTION: MentionStyle = { image: '图{n}', video: '视频{n}', audio: '音频{n}' }

const SEEDS: readonly MediaModelSpec[] = [
  ...MUMUGOFE_MODELS,
  ...BINGUO_MODELS,
  ...GOOGLE_XAI_MODELS,
  spec(
    'gpt-image-2.5-flare',
    'GPT Image 2.5 Flare',
    'OpenAI',
    'openai_images',
    IMAGE_OPERATIONS,
    { maxImages: 16, maxVideos: 0, transport: 'multipart' },
    gptImageParams,
    gptImagePrice,
  ),
  spec(
    'gpt-image-2.5-sunburst',
    'GPT Image 2.5 Sunburst',
    'OpenAI',
    'openai_images',
    IMAGE_OPERATIONS,
    { maxImages: 16, maxVideos: 0, transport: 'multipart' },
    gptImageParams,
    gptImagePrice,
  ),
  spec(
    'doubao-seedream-5-0-pro-260628',
    'Seedream 5.0 Pro',
    '火山引擎',
    'openai_images',
    IMAGE_OPERATIONS,
    { maxImages: 10, maxVideos: 0, transport: 'json' },
    seedreamParams,
    seedreamProPrice,
  ),
  spec(
    'doubao-seedream-5-0-flash-260915',
    'Seedream 5.0 Flash',
    '火山引擎',
    'openai_images',
    IMAGE_OPERATIONS,
    { maxImages: 10, maxVideos: 0, transport: 'json' },
    seedreamParams,
    seedreamFlashPrice,
  ),
  spec(
    'qwen-image-3.0-pro',
    '千问图像 3.0 Pro',
    '阿里云',
    'dashscope_images',
    IMAGE_OPERATIONS,
    { maxImages: 3, maxVideos: 0, transport: 'json' },
    qwenImageParams,
    qwenImagePrice({ qima_output_1k: 0.25, qima_output_2k: 0.5 }),
    undefined,
    { openai_images: { params: compatibleImageParams(qwenImageParams) } },
  ),
  spec(
    'qwen-image-3.0',
    '千问图像 3.0',
    '阿里云',
    'dashscope_images',
    IMAGE_OPERATIONS,
    { maxImages: 3, maxVideos: 0, transport: 'json' },
    qwenImageParams,
    qwenImagePrice({ qima_output_1k: 0.18, qima_output_2k: 0.18 }),
    undefined,
    { openai_images: { params: compatibleImageParams(qwenImageParams) } },
  ),
  spec(
    'wan2.7-image-pro',
    '万相 2.7 图像 Pro',
    '阿里云',
    'dashscope_images',
    IMAGE_OPERATIONS,
    { maxImages: 9, maxVideos: 0, transport: 'json' },
    wanImageParams(true),
    perImage('CNY', () => 0.5),
    undefined,
    { openai_images: { params: compatibleImageParams(wanImageParams(true)) } },
  ),
  spec(
    'wan2.7-image',
    '万相 2.7 图像',
    '阿里云',
    'dashscope_images',
    IMAGE_OPERATIONS,
    { maxImages: 9, maxVideos: 0, transport: 'json' },
    wanImageParams(false),
    perImage('CNY', () => 0.2),
    undefined,
    { openai_images: { params: compatibleImageParams(wanImageParams(false)) } },
  ),
  spec(
    'wan3.0-video',
    '万相 3.0 视频',
    '阿里云',
    'dashscope_videos',
    VIDEO_OPERATIONS,
    { maxImages: 10, maxVideos: 5, maxAudios: 5, transport: 'json' },
    wanVideoParams,
    wanVideoPrice({ '480p': 0.3, '720p': 0.6, '1080p': 1.2 }),
    WAN_MENTION,
    WAN_VIDEO_MAPPING,
  ),
  spec(
    'wan3.0-video-prime',
    '万相 3.0 视频 Prime',
    '阿里云',
    'dashscope_videos',
    VIDEO_OPERATIONS,
    { maxImages: 10, maxVideos: 5, maxAudios: 5, transport: 'json' },
    wanVideoParams,
    wanVideoPrice({ '480p': 0.45, '720p': 0.9, '1080p': 1.8 }),
    WAN_MENTION,
    WAN_VIDEO_MAPPING,
  ),
  spec(
    'doubao-seedance-2-5-260628',
    'Seedance 2.5',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 30, maxVideos: 10, maxAudios: 10, transport: 'json' },
    seedanceParams,
    seedancePrice({ '720p': [70, 42], '1080p': [77, 46] }),
    SEEDANCE_25_MENTION,
    ARK_VIDEO_MAPPING,
  ),
  spec(
    'doubao-seedance-2-0-260128',
    'Seedance 2.0',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 9, maxVideos: 3, maxAudios: 3, transport: 'json', audioRequiresVisual: true },
    seedance20Params(['480p', '720p', '1080p', '4k']),
    seedancePrice({ '720p': [46, 28], '1080p': [51, 31], '4k': [26, 16] }),
    SEEDANCE_20_MENTION,
    ARK_VIDEO_MAPPING,
  ),
  spec(
    'doubao-seedance-2-0-fast-260128',
    'Seedance 2.0 Fast',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 9, maxVideos: 3, maxAudios: 3, transport: 'json', audioRequiresVisual: true },
    seedance20Params(['480p', '720p']),
    seedancePrice({ '720p': [37, 22] }),
    SEEDANCE_20_MENTION,
    ARK_VIDEO_MAPPING,
  ),
  spec(
    'doubao-seedance-2-0-mini-260615',
    'Seedance 2.0 Mini',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 9, maxVideos: 3, maxAudios: 3, transport: 'json', audioRequiresVisual: true },
    seedance20Params(['480p', '720p']),
    seedancePrice({ '720p': [23, 14] }),
    SEEDANCE_20_MENTION,
    ARK_VIDEO_MAPPING,
  ),
  spec(
    'kling/kling-v3-omni-video-generation',
    '可灵 3.0 Omni',
    '快手',
    'dashscope_videos',
    VIDEO_OPERATIONS,
    {
      maxImages: 7,
      maxVideos: 1,
      transport: 'json',
      types: KLING_BAILIAN_TYPES,
      inlineImages: false,
      combinations: [
        { roles: [] },
        { roles: ['first_frame'] },
        { roles: ['first_frame', 'last_frame'] },
        { roles: ['reference'] },
        { roles: ['video'] },
        { roles: ['video', 'reference'], maxImages: 4 },
        { roles: ['video', 'first_frame'], params: { video_type: 'feature' } },
      ],
    },
    [...klingBailianParams({ modes: ['std', 'pro', '4k'], audio: true }), klingBailianVideoType],
    klingBailianPrice((u) =>
      u.videoInput || u.audio ? KLING_SOUND : u.audio === false ? KLING_SILENT : undefined,
    ),
  ),
  spec(
    'kling/kling-v3-video-generation',
    '可灵 3.0',
    '快手',
    'dashscope_videos',
    ['text_to_video', 'image_to_video', 'first_last_frame'],
    { ...NO_INPUTS, inlineImages: false },
    klingBailianParams({ modes: ['std', 'pro', '4k'], audio: true }),
    klingBailianPrice((u) =>
      u.audio ? KLING_SOUND : u.audio === false ? KLING_SILENT : undefined,
    ),
  ),
  spec(
    'kling/kling-v3-turbo-video-generation',
    '可灵 3.0 Turbo',
    '快手',
    'dashscope_videos',
    ['text_to_video', 'image_to_video'],
    { ...NO_INPUTS, inlineImages: false },
    klingBailianParams({ modes: ['std', 'pro'], audio: false }),
    klingBailianPrice(() => ({ '720p': 0.8, '1080p': 1.0 })),
  ),
  // Omni 的文生、首尾帧与参考图均使用同一端点；视频仍要求公网地址。
  {
    ...spec(
      'kling-3.0-omni',
      '可灵 3.0 Omni',
      '快手',
      'kling_videos',
      ['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video'],
      { maxImages: 7, maxVideos: 0, transport: 'json', framesWithReferences: true },
      klingParams({
        resolutions: ['720p', '1080p', '4k'],
        audio: ['native', 'off'],
        multiShot: true,
      }),
    ),
    videoFormat: 'kling-omni',
  },
  spec(
    'kling-3.0',
    '可灵 3.0',
    '快手',
    'kling_videos',
    ['text_to_video', 'image_to_video', 'first_last_frame'],
    NO_INPUTS,
    klingParams({
      resolutions: ['720p', '1080p', '4k'],
      audio: ['native', 'off'],
      multiShot: true,
    }),
  ),
  spec(
    'kling-3.0-turbo',
    '可灵 3.0 Turbo',
    '快手',
    'kling_videos',
    ['text_to_video', 'image_to_video'],
    NO_INPUTS,
    klingParams({ resolutions: ['720p', '1080p'], audio: null, multiShot: false }),
  ),
  spec(
    'gpt-4o-mini-tts',
    'GPT-4o mini TTS',
    'OpenAI',
    'openai_speech',
    SPEECH_OPERATIONS,
    NO_INPUTS,
    openaiSpeechParams,
  ),
  spec(
    'qwen3-tts-flash',
    '千问语音合成 3 Flash',
    '阿里云',
    'dashscope_speech',
    SPEECH_OPERATIONS,
    NO_INPUTS,
    qwenSpeechParams,
    qwenSpeechPrice,
  ),
  spec(
    'qwen3-tts-instruct-flash',
    '千问语音合成 3 指令版',
    '阿里云',
    'dashscope_speech',
    SPEECH_OPERATIONS,
    NO_INPUTS,
    [
      ...qwenSpeechParams,
      {
        name: 'instructions',
        type: 'string',
        description: '语气、情绪、语速等朗读要求，使用中文或英文描述',
      },
      {
        name: 'optimize_instructions',
        type: 'boolean',
        description: '由模型改写朗读要求，使其更容易被遵循',
      },
    ],
    qwenSpeechPrice,
  ),
]

/**
 * 目录未收录的模型使用的协议默认：只包含协议文档中的通用字段。
 *
 * 参数表取保守写法：多写一个接口不接受的字段会导致请求被拒绝；少写只使大模型少一个可调参数。
 */
const PROTOCOL_DEFAULTS: Record<MediaKind, Omit<MediaModelSpec, 'id' | 'displayName'>> = {
  ...BINGUO_DEFAULTS,
  ...GOOGLE_XAI_DEFAULTS,
  openai_images: {
    vendor: null,
    kind: 'openai_images',
    operations: IMAGE_OPERATIONS,
    inputs: { maxImages: 16, maxVideos: 0, transport: 'multipart' },
    params: [
      {
        name: 'size',
        type: 'string',
        pattern: '^(auto|\\d+x\\d+)$',
        description: '宽x高，如 1024x1024',
      },
      {
        name: 'n',
        label: '张数',
        type: 'integer',
        min: 1,
        max: 10,
        default: 1,
        description: '一次生成的张数',
      },
    ],
    catalogued: false,
  },
  dashscope_images: {
    vendor: null,
    kind: 'dashscope_images',
    operations: IMAGE_OPERATIONS,
    inputs: { maxImages: 3, maxVideos: 0, transport: 'json' },
    params: [
      { name: 'size', type: 'string', description: '尺寸，写法以该模型文档为准' },
      {
        name: 'n',
        label: '张数',
        type: 'integer',
        min: 1,
        max: 4,
        default: 1,
        description: '一次生成的张数',
      },
    ],
    catalogued: false,
  },
  /*
   * 中转站的 `/v1/videos`：各家共用的只有提交、查询、获取内容三条路径与 `seconds` / `size` 两个字段。
   * 未登记型号只提供通用文生字段；已核实型号使用目录中声明的映射。
   */
  openai_videos: {
    vendor: null,
    kind: 'openai_videos',
    operations: ['text_to_video'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: [
      {
        name: 'seconds',
        type: 'string',
        description: '时长（秒），以字符串表示，如 "5"',
      },
      {
        name: 'size',
        label: '尺寸',
        type: 'string',
        shapes: [{}, { ratio: '16:9', value: '1280x720' }, { ratio: '9:16', value: '720x1280' }],
        description: '宽x高，如 1280x720、720x1280',
      },
    ],
    catalogued: false,
  },
  ark_videos: {
    vendor: null,
    kind: 'ark_videos',
    operations: VIDEO_OPERATIONS,
    inputs: { maxImages: 9, maxVideos: 3, transport: 'json' },
    params: seedanceParams.filter((p) =>
      ['resolution', 'ratio', 'duration', 'watermark'].includes(p.name),
    ),
    catalogued: false,
  },
  kling_videos: {
    vendor: null,
    kind: 'kling_videos',
    operations: ['text_to_video', 'image_to_video'],
    inputs: NO_INPUTS,
    params: klingParams({ resolutions: ['720p', '1080p'], audio: null, multiShot: false }),
    catalogued: false,
  },
  openai_speech: {
    vendor: null,
    kind: 'openai_speech',
    operations: SPEECH_OPERATIONS,
    inputs: NO_INPUTS,
    params: openaiSpeechParams.filter((p) => ['voice', 'response_format'].includes(p.name)),
    catalogued: false,
  },
  dashscope_speech: {
    vendor: null,
    kind: 'dashscope_speech',
    operations: SPEECH_OPERATIONS,
    inputs: NO_INPUTS,
    params: qwenSpeechParams.filter((p) => p.name === 'voice'),
    catalogued: false,
  },
  dashscope_videos: {
    vendor: null,
    kind: 'dashscope_videos',
    operations: VIDEO_OPERATIONS,
    inputs: { maxImages: 10, maxVideos: 5, transport: 'json' },
    params: wanVideoParams.filter((p) =>
      ['resolution', 'ratio', 'duration', 'watermark'].includes(p.name),
    ),
    catalogued: false,
  },
}

/** 内置的全部生成模型，供模型库页使用。 */
export function mediaCatalog(): readonly MediaModelSpec[] {
  return SEEDS
}

/** 按 id 查找条目，不区分协议。添加模型时据此判断该模型是否为生成模型及其类别。 */
export function findMediaModel(id: string): MediaModelSpec | undefined {
  return SEEDS.find((m) => m.id === id)
}

/** 条目已核实的协议：目录协议加已登记的兼容映射。设置页的接入方式与加载配置时的协议校正共用。 */
export function mediaKindsOf(spec: MediaModelSpec): MediaKind[] {
  return [spec.kind, ...(Object.keys(spec.mappings ?? {}) as MediaKind[])]
}

/**
 * 模型在指定协议上的规格。
 *
 * 精确匹配未命中时只使用已登记的协议映射。没有映射的组合使用协议默认，
 * 不继承无法正确序列化的原生参数、输入能力或官方单价。
 */
export function lookupMediaModel(id: string, kind: MediaKind): MediaModelSpec {
  const exact = SEEDS.find((m) => m.id === id && m.kind === kind)
  if (exact) return exact
  const base = PROTOCOL_DEFAULTS[kind]
  const byId = SEEDS.find(
    (m) => m.id === id && MEDIA_KIND_OUTPUT[m.kind] === MEDIA_KIND_OUTPUT[kind],
  )
  const mapping = byId?.mappings?.[kind]
  if (byId && mapping) {
    const { price: _price, mappings: _mappings, ...rest } = byId
    return {
      ...rest,
      ...mapping,
      kind,
    }
  }
  return { ...base, id, displayName: id }
}
