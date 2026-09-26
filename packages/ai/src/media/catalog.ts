/**
 * 生成模型目录：每个生成模型在某条生成协议上支持哪些操作、收几张参考图、有哪些参数。
 *
 * 与对话目录（`../catalog.ts`）同一套查法：按「模型 id × 协议」精确匹配，没有就按 id 兜底，
 * 再没有就回该协议的保守默认。字段完全不同：生成模型没有上下文窗口与思考档，有的是操作与参数表。
 *
 * **只收各家当前最新一代。** 旧型号挂在接口下照样能用，走协议默认的参数表。
 *
 * **参数用接口自己的字段名，不做跨厂商统一。** 同一个「清晰度」，OpenAI 写 `quality`，火山写 `size: 2K`，
 * 百炼写 `size: 2048*2048`；统一后再逐家翻译就多出一份对照表，厂商改字段时大模型填得对、发出去的却是错的。
 * 参数原样发给接口，发之前按这里的表校验（`params.ts`）。
 *
 * 种子逐条对过官方文档，核对日期写在每组上方。
 *
 * **价格按接口回报的计量算，不在本地估算用量。** 单价逐条对官方价格页，按分辨率、清晰度等分档的
 * 按回报的规格取档；取不到档位或没有价目时金额记 0，界面显示 N/A。不写没核实的单价：
 * 账本上一个编出来的金额看起来和真的一样。
 */

import { type Currency, MEDIA_KIND_OUTPUT, type MediaKind } from '@qywork/core'
import type { MediaInput, MediaUsage } from './types.ts'

/**
 * 生成操作。由调用时给了哪些输入推出来，不让大模型选。
 *
 * 出图：`generate` 按提示词生成，`edit` 在参考图上修改。
 * 视频：`text_to_video` 文生，`image_to_video` 首帧，`first_last_frame` 首尾帧，`reference_to_video` 参考图，
 * `video_to_video` 以参考视频为输入（编辑、延长还是参考，由模型的原生参数或提示词决定）。
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

export interface MediaParamSpec {
  /** 接口字段名，原样发出。 */
  name: string
  type: 'enum' | 'integer' | 'number' | 'string' | 'boolean'
  /** enum 的可选值。 */
  values?: readonly (string | number)[]
  min?: number
  max?: number
  /** string 的格式，正则源码。 */
  pattern?: string
  /** 接口在不填时用的值。只用于告诉大模型，本地不补值。 */
  default?: string | number | boolean
  /** 一句话含义与约束，给大模型看。 */
  description: string
  /** 只在这些操作下有效。不写 = 全部。 */
  operations?: readonly MediaOperation[]
}

export interface MediaModelSpec {
  id: string
  displayName: string
  vendor: string | null
  kind: MediaKind
  operations: readonly MediaOperation[]
  /**
   * 参考图、参考视频的数量上限与传法（首尾帧不计入）。传法由目录声明，不按模型名猜：
   * OpenAI 的修改走 multipart `/edits`，其余都放进 JSON。
   * `types`：同一协议下各家的素材类型名不同时（百炼上的万相与可灵），写明各用途在请求里的类型名；不写用协议的。
   */
  inputs: {
    maxImages: number
    maxVideos: number
    transport: 'multipart' | 'json'
    types?: Partial<Record<MediaInput['role'], string>>
  }
  params: readonly MediaParamSpec[]
  /** false = 目录里没有这个 id，用的是协议默认。 */
  catalogued: boolean
  /**
   * 官方单价，按接口回报的计量算金额。没有时金额不明：协议默认、按 id 兜底到别的协议（中转站价格不同）、
   * 接口不回报计量的模型（OpenAI 语音合成）。接口直接回报扣费金额的（可灵官方）不需要单价。
   */
  price?: MediaPrice
}

export interface MediaPrice {
  currency: Currency
  /** 缺计价所需的量时返回 null。 */
  cost(u: MediaUsage): number | null
}

/**
 * 一次生成的金额。接口直接回报扣费的以回报为准，其次按目录单价算；都没有时金额记 0（金额不明）。
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

/** 按档位取单价。档位不在表里（接口回报了表外的规格）时返回 undefined，金额按不明处理。 */
function tier(rates: Record<string, number>, key: string | undefined): number | undefined {
  return key === undefined ? undefined : rates[key]
}

/** Seedance 的 480p 与 720p 同价。 */
function seedanceTier(resolution: string | undefined): string | undefined {
  return resolution === '480p' || resolution === '720p' ? '720p' : resolution
}

/**
 * 按张计价。`output` 给出每张输出图的单价（可按计量分档），`input` 是每张参考图的单价，
 * `firstInputFree` 为首张参考图免费（火山 Seedream 5.0 Pro）。
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

// ── 价格（2026-09-26 对官方价格页，均为原价，不计限时折扣与免费额度）──
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
const seedreamFlashPrice = perImage('CNY', () => 0.12)
// 百炼「模型调用价格」：千问图像 3.0 Pro 输出 1k ¥0.25、2k ¥0.5，3.0 输出 ¥0.18，输入均 ¥0.02 每张；
// 档位取接口回报的 `output_image_type`。
const qwenImagePrice = (rates: Record<string, number>) =>
  perImage('CNY', (u) => tier(rates, u.imageTier), { rate: 0.02 })
// 万相图像 2.7 Pro ¥0.50、2.7 ¥0.20 每张，只按输出计费。
// 万相视频 3.0 Prime 480P ¥0.45、720P ¥0.9、1080P ¥1.8 每秒；3.0 ¥0.3、¥0.6、¥1.2；计费秒数含输入视频时长。
const wanVideoPrice = (rates: Record<string, number>) =>
  perSecond('CNY', (u) => tier(rates, u.resolution))
// 火山方舟「模型价格」：Seedance 每百万 token，按输出分辨率与输入是否含视频分档；480p 与 720p 同价。
const seedancePrice = (rates: Record<string, [number, number]>) =>
  perMillionOutputTokens('CNY', (u) => {
    const pair = rates[seedanceTier(u.resolution) ?? '']
    return pair ? pair[u.videoInput ? 1 : 0] : undefined
  })
// 百炼「模型调用价格」：千问语音合成 3 按输入字符 ¥0.8 每万字符（一个汉字计 2 个字符，接口回报的已按此计），输出不计费。
const qwenSpeechPrice: MediaPrice = {
  currency: 'CNY',
  cost: (u) => (u.characters === undefined ? null : (u.characters / 10_000) * 0.8),
}
// 百炼「模型调用价格」：可灵 3.0 按秒，按清晰度（std 720P / pro 1080P / 4k）、有无声音、有无参考视频分档。
// 无声 ¥0.6 / ¥0.8 / ¥3.0，有声 ¥0.9 / ¥1.2 / ¥3.0；Omni 有参考视频（只能无声）与有声同价；Turbo 固定有声 ¥0.8 / ¥1.0。
const KLING_SILENT = { '720p': 0.6, '1080p': 0.8, '4k': 3.0 }
const KLING_SOUND = { '720p': 0.9, '1080p': 1.2, '4k': 3.0 }
const klingBailianPrice = (rates: (u: MediaUsage) => Record<string, number> | undefined) =>
  perSecond('CNY', (u) => {
    const table = rates(u)
    return table ? tier(table, u.resolution) : undefined
  })

// ── OpenAI GPT Image（2026-09-25 对 developers.openai.com 图像生成指南与 edits 参考）──
const gptImageParams: readonly MediaParamSpec[] = [
  {
    name: 'size',
    type: 'string',
    pattern: '^(auto|\\d+x\\d+)$',
    default: 'auto',
    description:
      '宽x高，边长须为 16 的倍数，宽高比 1:3 到 3:1，单边不超过 3840；常用 1024x1024、1536x1024（横）、1024x1536（竖）',
  },
  {
    name: 'quality',
    type: 'enum',
    values: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
    default: 'auto',
    description: '画质档位，越高越慢越贵',
  },
  { name: 'n', type: 'integer', min: 1, max: 10, default: 1, description: '一次生成几张' },
  {
    name: 'output_format',
    type: 'enum',
    values: ['png', 'jpeg', 'webp'],
    default: 'png',
    description: '输出格式',
  },
  {
    name: 'output_compression',
    type: 'integer',
    min: 0,
    max: 100,
    description: 'jpeg / webp 的压缩质量',
  },
  {
    name: 'background',
    type: 'enum',
    values: ['transparent', 'opaque', 'auto'],
    default: 'auto',
    description: '背景；transparent 需配 png 或 webp',
  },
]

// ── 火山方舟 Seedream 5.0（2026-09-25 对方舟「图片生成 API」与模型列表）──
const seedreamParams: readonly MediaParamSpec[] = [
  {
    name: 'size',
    type: 'string',
    pattern: '^(1K|1\\.5K|2K|\\d+x\\d+)$',
    default: '2K',
    description:
      '分辨率档位 1K / 1.5K / 2K（宽高比写在提示词里，由模型定），或宽x高：总像素 921600 到 4624220、宽高比 1/16 到 16',
  },
  {
    name: 'output_format',
    type: 'enum',
    values: ['png', 'jpeg'],
    default: 'jpeg',
    description: '输出格式',
  },
  {
    name: 'background',
    type: 'enum',
    values: ['transparent', 'opaque'],
    default: 'opaque',
    operations: ['edit'],
    description: '透明背景，只在输入一张带透明通道的图时可用，输出为 png',
  },
  { name: 'watermark', type: 'boolean', default: true, description: '右下角加「AI 生成」水印' },
]

// ── 百炼千问图像 3.0（2026-09-25 对「千问图像生成与编辑 API」）──
const qwenImageParams: readonly MediaParamSpec[] = [
  {
    name: 'size',
    type: 'string',
    pattern: '^\\d+\\*\\d+$',
    description: '宽*高，用星号分隔，512*512 到 2048*2048；不填由模型定',
  },
  { name: 'n', type: 'integer', min: 1, max: 6, default: 1, description: '一次生成几张' },
  { name: 'negative_prompt', type: 'string', description: '不希望出现的内容，最多 500 字' },
  {
    name: 'seed',
    type: 'integer',
    min: 0,
    max: 2147483647,
    description: '随机种子；同一种子与提示词得到相近结果',
  },
  { name: 'prompt_extend', type: 'boolean', default: true, description: '由模型扩写提示词' },
  {
    name: 'prompt_extend_mode',
    type: 'enum',
    values: ['direct', 'agent'],
    default: 'direct',
    description: '扩写方式',
  },
  { name: 'enable_thinking', type: 'boolean', default: true, description: '生成前先推理' },
  { name: 'watermark', type: 'boolean', default: false, description: '加「Qwen-Image」水印' },
]

// ── 百炼万相 2.7 图像（2026-09-25 对「万相图像生成与编辑 API」）──
const wanImageParams: readonly MediaParamSpec[] = [
  {
    name: 'size',
    type: 'string',
    pattern: '^(1K|2K|4K|\\d+x\\d+)$',
    description:
      '1K / 2K / 4K 或宽x高；文生图 768x768 到 4096x4096，修改时最大 2K（2048x2048），4K 仅 wan2.7-image-pro 文生图',
  },
  { name: 'n', type: 'integer', min: 1, max: 4, default: 1, description: '一次生成几张' },
  {
    name: 'thinking_mode',
    type: 'boolean',
    default: true,
    operations: ['generate'],
    description: '生成前先推理，只对文生图生效',
  },
  {
    name: 'seed',
    type: 'integer',
    min: 0,
    max: 2147483647,
    description: '随机种子；同一种子与提示词得到相近结果',
  },
  { name: 'watermark', type: 'boolean', default: false, description: '加水印' },
]

// ── 百炼万相 3.0 视频（2026-09-25 对「万相 3.0 视频生成 API」）──
const wanVideoParams: readonly MediaParamSpec[] = [
  {
    name: 'resolution',
    type: 'enum',
    values: ['1080P', '720P', '480P'],
    default: '1080P',
    description: '分辨率',
  },
  {
    name: 'ratio',
    type: 'enum',
    values: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    default: 'adaptive',
    description: '画幅；adaptive 按输入自动适配，竖版用 9:16',
  },
  {
    name: 'duration',
    type: 'integer',
    min: -1,
    max: 30,
    default: 5,
    description: '时长（秒），2 到 30；-1 由模型定；有参考视频时由输入决定上限',
  },
  { name: 'audio', type: 'boolean', default: true, description: '是否带声音' },
  {
    name: 'seed',
    type: 'integer',
    min: -1,
    max: 2147483647,
    description: '随机种子；同一种子得到相近结果',
  },
  { name: 'prompt_extend', type: 'boolean', default: true, description: '由模型扩写提示词' },
  { name: 'watermark', type: 'boolean', default: false, description: '加水印' },
]

// ── 火山方舟 Seedance 2.5（2026-09-25 对方舟「创建视频生成任务 API」与模型列表）──
const seedanceParams: readonly MediaParamSpec[] = [
  {
    name: 'resolution',
    type: 'enum',
    values: ['480p', '720p', '1080p'],
    default: '720p',
    description: '分辨率',
  },
  {
    name: 'ratio',
    type: 'enum',
    values: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
    default: 'adaptive',
    description: '画幅；首帧、首尾帧、编辑、延长时只能 adaptive',
  },
  {
    name: 'duration',
    type: 'integer',
    min: -1,
    max: 30,
    default: -1,
    description: '时长（秒），4 到 30；-1 由模型定；编辑时只能 -1',
  },
  {
    name: 'omni_reference_task_type',
    type: 'enum',
    values: ['auto', 'reference', 'edit', 'extend'],
    default: 'auto',
    operations: ['reference_to_video', 'video_to_video'],
    description:
      '有参考素材时的任务类型：reference 参考生成、edit 编辑参考视频、extend 延长参考视频；显式指定时参数不合规会在提交时直接报错、不扣费',
  },
  { name: 'generate_audio', type: 'boolean', default: true, description: '是否带同步声音' },
  {
    name: 'output_format',
    type: 'enum',
    values: ['mp4', 'mov'],
    default: 'mp4',
    description: '输出格式；mov 色彩精度高、播放兼容性差',
  },
  { name: 'watermark', type: 'boolean', default: false, description: '右下角加「AI 生成」水印' },
]

/**
 * 火山方舟 Seedance 2.0 系列（2026-09-25 对方舟「创建视频生成任务 API」逐参数的「模型支持」与模型列表）。
 * 与 2.5 的差别：时长上限 15，画幅不受输入限制，没有 `omni_reference_task_type` 与 `output_format`；
 * 清晰度按型号不同，由调用方给出。
 */
function seedance20Params(resolutions: readonly string[]): readonly MediaParamSpec[] {
  return [
    {
      name: 'resolution',
      type: 'enum',
      values: resolutions,
      default: '720p',
      description: '分辨率',
    },
    {
      name: 'ratio',
      type: 'enum',
      values: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
      default: 'adaptive',
      description: '画幅；adaptive 按输入或提示词自动选',
    },
    {
      name: 'duration',
      type: 'integer',
      min: -1,
      max: 15,
      description: '时长（秒），4 到 15；-1 由模型定',
    },
    { name: 'generate_audio', type: 'boolean', default: true, description: '是否带同步声音' },
    { name: 'watermark', type: 'boolean', default: false, description: '右下角加「AI 生成」水印' },
  ]
}

/**
 * 百炼上的可灵 3.0（2026-09-25 对百炼「可灵视频生成 API 参考」）。只开在北京地域。
 * 与万相同一个端点，但 `media[].type` 的取值不同（参考图是 `refer`，视频分 `feature` 与 `base`），见目录的 `types`。
 * `input` 里的多镜头、主体、负向提示词不收：多镜头可写进提示词，负向描述官方允许写进提示词。
 */
function klingBailianParams(opts: { modes: readonly string[]; audio: boolean }): MediaParamSpec[] {
  return [
    {
      name: 'mode',
      type: 'enum',
      values: opts.modes,
      default: 'pro',
      description: '清晰度档位：std 为 720P，pro 为 1080P，4k 为 4K',
    },
    {
      name: 'aspect_ratio',
      type: 'enum',
      values: ['16:9', '9:16', '1:1'],
      default: '16:9',
      operations: ['text_to_video', 'reference_to_video', 'video_to_video'],
      description: '画幅；编辑视频时按输入视频的宽高比，这个值无效',
    },
    {
      name: 'duration',
      type: 'integer',
      min: 3,
      max: 15,
      default: 5,
      description: '时长（秒）；有参考视频时 3 到 10，编辑视频时按输入视频时长、这个值无效',
    },
    ...(opts.audio
      ? [
          {
            name: 'audio',
            type: 'boolean',
            default: false,
            description: '是否生成声音；输入里有视频时只能 false',
          } as const,
        ]
      : []),
  ]
}

/**
 * 百炼上可灵的参考视频不靠参数区分用途，靠 `media[].type`：接口没有单独的字段，这里用这个参数交给大模型选，
 * 百炼适配器把它写进视频那一项的类型，不作为参数发出。取值是接口原词。
 */
const klingBailianVideoType: MediaParamSpec = {
  name: 'video_type',
  type: 'enum',
  values: ['feature', 'base'],
  default: 'feature',
  operations: ['video_to_video'],
  description:
    '参考视频的用途：feature 作特征参考（参考镜头、风格，或生成上一 / 下一镜头），base 作待编辑视频',
}

/**
 * 可灵开放平台官方接口的 3.0（2026-09-25 对 kling.ai/document-api 的 3.0、3.0 Omni、3.0 Turbo 各页）。
 * 参数全在 `settings` 里；画幅只在文生时有，首帧、首尾帧按首帧的宽高比。
 */
function klingParams(opts: {
  resolutions: readonly string[]
  audio: readonly string[] | null
  multiShot: boolean
}): MediaParamSpec[] {
  return [
    {
      name: 'resolution',
      type: 'enum',
      values: opts.resolutions,
      default: '720p',
      description: '分辨率',
    },
    {
      name: 'aspect_ratio',
      type: 'enum',
      values: ['16:9', '9:16', '1:1'],
      default: '16:9',
      operations: ['text_to_video', 'reference_to_video'],
      description: '画幅',
    },
    {
      name: 'duration',
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
            type: 'enum',
            values: opts.audio,
            default: 'off',
            description: 'native 生成匹配画面的声音，off 无声',
          } as const,
        ]
      : []),
    ...(opts.multiShot
      ? [
          {
            name: 'multi_shot',
            type: 'boolean',
            default: true,
            description:
              '多镜头；提示词按「shot 序号, 秒数, 描述;」写分镜，各镜头秒数之和等于总时长',
          } as const,
        ]
      : []),
  ]
}

// ── OpenAI 语音（2026-09-25 对 developers.openai.com 语音合成指南与 speech 参考）──
const openaiSpeechParams: readonly MediaParamSpec[] = [
  {
    name: 'voice',
    type: 'string',
    default: 'alloy',
    description:
      '音色：alloy、ash、ballad、coral、echo、fable、nova、onyx、sage、shimmer、verse、marin、cedar',
  },
  {
    name: 'instructions',
    type: 'string',
    description: '语气、情绪、语速等朗读要求，自然语言写',
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

// ── 百炼千问语音合成 3（2026-09-25 对「千问语音合成 API」与「支持的系统音色」）──
const qwenSpeechParams: readonly MediaParamSpec[] = [
  {
    name: 'voice',
    type: 'string',
    default: 'Cherry',
    description:
      '系统音色：Cherry（明快女声）、Serena（温柔女声）、Ethan（北方口音男声）、Moon（随性男声）、Kai（舒缓男声）、' +
      'Neil（新闻播音男声）、Maia、Momo、Vivian、Chelsie、Bella、Ryan、Katerina、Eldric Sage、Mia、Mochi、Bellona、' +
      'Vincent、Bunny、Elias、Arthur、Nini、Seren、Pip、Stella、Nofish、Jennifer、Aiden',
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
/** 百炼上可灵的素材类型名；视频的类型由参数 `video_type` 定，这里是不填时的值。 */
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
})

const SEEDS: readonly MediaModelSpec[] = [
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
  ),
  spec(
    'wan2.7-image-pro',
    '万相 2.7 图像 Pro',
    '阿里云',
    'dashscope_images',
    IMAGE_OPERATIONS,
    { maxImages: 9, maxVideos: 0, transport: 'json' },
    wanImageParams,
    perImage('CNY', () => 0.5),
  ),
  spec(
    'wan2.7-image',
    '万相 2.7 图像',
    '阿里云',
    'dashscope_images',
    IMAGE_OPERATIONS,
    { maxImages: 9, maxVideos: 0, transport: 'json' },
    wanImageParams,
    perImage('CNY', () => 0.2),
  ),
  spec(
    'wan3.0-video',
    '万相 3.0 视频',
    '阿里云',
    'dashscope_videos',
    VIDEO_OPERATIONS,
    { maxImages: 10, maxVideos: 5, transport: 'json' },
    wanVideoParams,
    wanVideoPrice({ '480p': 0.3, '720p': 0.6, '1080p': 1.2 }),
  ),
  spec(
    'wan3.0-video-prime',
    '万相 3.0 视频 Prime',
    '阿里云',
    'dashscope_videos',
    VIDEO_OPERATIONS,
    { maxImages: 10, maxVideos: 5, transport: 'json' },
    wanVideoParams,
    wanVideoPrice({ '480p': 0.45, '720p': 0.9, '1080p': 1.8 }),
  ),
  spec(
    'doubao-seedance-2-5-260628',
    'Seedance 2.5',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 30, maxVideos: 10, transport: 'json' },
    seedanceParams,
    seedancePrice({ '720p': [70, 42], '1080p': [77, 46] }),
  ),
  spec(
    'doubao-seedance-2-0-260128',
    'Seedance 2.0',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 9, maxVideos: 3, transport: 'json' },
    seedance20Params(['480p', '720p', '1080p', '4k']),
    seedancePrice({ '720p': [46, 28], '1080p': [51, 31], '4k': [26, 16] }),
  ),
  spec(
    'doubao-seedance-2-0-fast-260128',
    'Seedance 2.0 Fast',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 9, maxVideos: 3, transport: 'json' },
    seedance20Params(['480p', '720p']),
    seedancePrice({ '720p': [37, 22] }),
  ),
  spec(
    'doubao-seedance-2-0-mini-260615',
    'Seedance 2.0 Mini',
    '火山引擎',
    'ark_videos',
    VIDEO_OPERATIONS,
    { maxImages: 9, maxVideos: 3, transport: 'json' },
    seedance20Params(['480p', '720p']),
    seedancePrice({ '720p': [23, 14] }),
  ),
  spec(
    'kling/kling-v3-omni-video-generation',
    '可灵 3.0 Omni',
    '快手',
    'dashscope_videos',
    VIDEO_OPERATIONS,
    { maxImages: 7, maxVideos: 1, transport: 'json', types: KLING_BAILIAN_TYPES },
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
    NO_INPUTS,
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
    NO_INPUTS,
    klingBailianParams({ modes: ['std', 'pro'], audio: false }),
    klingBailianPrice(() => ({ '720p': 0.8, '1080p': 1.0 })),
  ),
  // 官方接口的视频素材只收 URL，本机文件没有可传的地方，所以 Omni 在这条协议上只做参考图。
  spec(
    'kling-3.0-omni',
    '可灵 3.0 Omni',
    '快手',
    'kling_videos',
    ['reference_to_video'],
    { maxImages: 7, maxVideos: 0, transport: 'json' },
    klingParams({
      resolutions: ['720p', '1080p', '4k'],
      audio: ['native', 'off'],
      multiShot: true,
    }),
  ),
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
        description: '语气、情绪、语速等朗读要求，中文或英文写',
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
 * 目录里没有的模型用的协议默认：只含协议文档里通用的字段。
 *
 * 参数表保守：多写一个接口不认的字段，请求就被拒；少写只是大模型少了一个可调项。
 */
const PROTOCOL_DEFAULTS: Record<MediaKind, Omit<MediaModelSpec, 'id' | 'displayName'>> = {
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
      { name: 'n', type: 'integer', min: 1, max: 10, default: 1, description: '一次生成几张' },
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
      { name: 'n', type: 'integer', min: 1, max: 4, default: 1, description: '一次生成几张' },
    ],
    catalogued: false,
  },
  /*
   * 中转站的 `/v1/videos`：共用的只有提交、查询、取内容三条路径与 `seconds` / `size` 两个字段，
   * 参考图与首尾帧各家插件要的形状不同（火山插件只收 metadata 里的地址），没有核实过的形状不发，
   * 所以只做文生。
   */
  openai_videos: {
    vendor: null,
    kind: 'openai_videos',
    operations: ['text_to_video'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: [
      { name: 'seconds', type: 'string', description: '时长（秒），写成字符串，如 "5"' },
      { name: 'size', type: 'string', description: '宽x高，如 1280x720、720x1280' },
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

/** 内置的全部生成模型，给模型库页。 */
export function mediaCatalog(): readonly MediaModelSpec[] {
  return SEEDS
}

/** 按 id 找一条，不管协议。添加模型时据此判断它是不是生成模型、属于哪一类。 */
export function findMediaModel(id: string): MediaModelSpec | undefined {
  return SEEDS.find((m) => m.id === id)
}

/**
 * 这个模型在这条协议上的规格。
 *
 * 精确匹配没有时**按 id 兜底**：保留参数表，协议换成调用方的；操作与输入上限取两者都支持的部分，
 * 传法取该协议的默认。中转站转发的生成模型参数名不变（New API 原样透传厂商字段），
 * 不兜底的话参数表整张丢失；不取交集的话会让大模型传这条协议发不出去的输入。
 */
export function lookupMediaModel(id: string, kind: MediaKind): MediaModelSpec {
  const exact = SEEDS.find((m) => m.id === id && m.kind === kind)
  if (exact) return exact
  const base = PROTOCOL_DEFAULTS[kind]
  const byId = SEEDS.find(
    (m) => m.id === id && MEDIA_KIND_OUTPUT[m.kind] === MEDIA_KIND_OUTPUT[kind],
  )
  if (byId) {
    // 单价不跟过去：同一个模型经中转站或别的协议调用，价格以那一方为准，目录里没有。
    const { price: _price, ...rest } = byId
    return {
      ...rest,
      kind,
      operations: byId.operations.filter((o) => base.operations.includes(o)),
      inputs: {
        maxImages: Math.min(byId.inputs.maxImages, base.inputs.maxImages),
        maxVideos: Math.min(byId.inputs.maxVideos, base.inputs.maxVideos),
        transport: base.inputs.transport,
      },
    }
  }
  return { ...base, id, displayName: id }
}
