/**
 * 生成模型的协议与类别：出图等生成接口的请求形状，以及添加模型时的默认协议。
 *
 * 与对话协议 `PROVIDER_KINDS` 分开定义：后者的每个值都是对话协议，对话目录、协议下拉框与对话适配器
 * 都按它分派，合并后每一处都必须排除生成协议。
 */

import type { Currency, ProviderKind } from './model.ts'

/**
 * 一个值 = 一种请求形状，不是一个厂商：火山方舟的出图与 OpenAI 同形状，同属 `openai_images`。
 * 新增值时须同时新增该协议的适配器、`MEDIA_KIND_OUTPUT` 中的一行与目录中的协议默认值。
 */
export const MEDIA_KINDS = [
  'openai_images',
  'dashscope_images',
  'gemini_images',
  'xai_images',
  'openai_videos',
  'ark_videos',
  'dashscope_videos',
  'kling_videos',
  'gemini_videos',
  'veo_videos',
  'xai_videos',
  'openai_speech',
  'dashscope_speech',
] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/**
 * 中转渠道的视频请求格式。请求字段、素材上传与任务查询由 `@qywork/ai` 按格式实现；
 * 型号的时长、画幅、素材上限与价格来自拉取时的渠道目录，保存在该型号的配置中（`ChannelVideoSpec`）。
 * 图像只有 mumugofe 一种格式（`ChannelImageSpec`）。
 */
export const VIDEO_CHANNELS = ['hongcheng', 'mumugofe'] as const
export type VideoChannel = (typeof VIDEO_CHANNELS)[number]

/**
 * 渠道公布的价格。金额按渠道充值价与分组倍率折算，币种为渠道的计价币种。图像每次请求生成一张，按次即按张。
 * 各分辨率档位单价不同时 `amount` 为「档位 → 金额」，键与规格的 `resolutions` 一致。
 */
export interface ChannelPrice {
  per: 'request' | 'second'
  amount: number | Record<string, number>
  currency: Currency
}

/**
 * 拉取模型时由渠道目录得到的视频型号规格，保存在该型号的配置中。
 * 只保存目录中的事实；参数名、默认值与说明由 `@qywork/ai` 按渠道格式生成。
 */
export interface ChannelVideoSpec {
  channel: VideoChannel
  /** 可选时长（秒），升序；第一项为默认值。 */
  seconds: number[]
  /** 宽高比；第一项为默认值。 */
  ratios: string[]
  /** 分辨率档位，如 `720p`。 */
  resolutions: string[]
  /** 各档位的横屏像素尺寸 `[宽, 高]`。按像素尺寸提交的格式（mumugofe）必须提供。 */
  sizes?: Record<string, [number, number]>
  maxImages: number
  maxVideos: number
  maxAudios: number
  /** 参考素材先上传到渠道，请求中只发送地址；省略时内联发送（mumugofe）。 */
  publicUrls?: true
  /** 参考图以表单文件随提交上传；省略时按 JSON 提交（mumugofe）。不能与 `publicUrls` 同时设置。 */
  multipart?: true
  /** 提交时同时发送与所选尺寸对应的分辨率档位 `resolution`：渠道按该字段出图与计价，不按尺寸推断（mumugofe）。 */
  resolutionField?: true
  /** 省略表示价格不明。 */
  price?: ChannelPrice
}

/**
 * 拉取模型时由渠道目录得到的图像型号规格，保存在该型号的配置中（mumugofe）。
 * 尺寸与分辨率档位是两个独立参数，渠道分别计价与出图；只保存目录中的事实。
 */
export interface ChannelImageSpec {
  channel: 'mumugofe'
  /** 分辨率档位，如 `1K`；第一项为默认值。 */
  resolutions: string[]
  /** 像素尺寸 `宽x高`；第一项为默认值。 */
  sizes: string[]
  maxImages: number
  /** 省略表示价格不明。 */
  price?: ChannelPrice
}

/** 生成型号保存的渠道规格。类别由该型号的协议决定：`openai_videos` 为视频，`openai_images` 为图像。 */
export type ChannelSpec = ChannelVideoSpec | ChannelImageSpec

/**
 * 型号对应的生成目录条目：中转站的自定义名称（如 `gpt-image-2.5-sunburst-4k`）按该条目取得参数表与能力，
 * 请求中仍发送自定义名称。不继承目录单价：中转站的价格与官方不同。
 */
export interface MediaBaseSpec {
  base: string
}

/** 生成型号保存的规格来源：渠道规格，或对应的目录型号。两者互斥，保存在同一字段（`spec`）中。 */
export type StoredMediaSpec = ChannelSpec | MediaBaseSpec

/** 保存的规格是渠道规格时返回它；对应型号或未保存时返回 undefined。 */
export function channelSpecOf(spec: StoredMediaSpec | undefined): ChannelSpec | undefined {
  return spec && 'channel' in spec ? spec : undefined
}

const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0
const isTextList = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '')

function channelPriceProblem(p: unknown, resolutions: string[]): string | null {
  if (p === undefined) return null
  const price = p as Partial<ChannelPrice> | null
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0
  const amount = price?.amount
  return price &&
    ['request', 'second'].includes(price.per as string) &&
    (positive(amount) ||
      (amount &&
        typeof amount === 'object' &&
        Object.keys(amount).length === resolutions.length &&
        resolutions.every((r) => positive(amount[r])))) &&
    ['USD', 'CNY'].includes(price.currency as string)
    ? null
    : 'price 必须包含 per（request 或 second）、amount（正数，或每个分辨率档位各一个正数）与 currency'
}

/** 配置中保存的渠道规格不合法时返回原因。配置写入前校验，不合法的规格不落盘。 */
export function channelVideoSpecProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return '不是对象'
  const s = value as Partial<ChannelVideoSpec>
  if (!VIDEO_CHANNELS.includes(s.channel as VideoChannel))
    return `channel 必须是 ${VIDEO_CHANNELS.join('、')} 之一`
  if (
    !Array.isArray(s.seconds) ||
    !s.seconds.length ||
    !s.seconds.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n > s.seconds![i - 1]!))
  )
    return 'seconds 必须是升序的正整数数组'
  if (!isTextList(s.ratios)) return 'ratios 必须是非空字符串数组'
  if (!isTextList(s.resolutions)) return 'resolutions 必须是非空字符串数组'
  if (
    s.sizes !== undefined &&
    (!s.sizes ||
      typeof s.sizes !== 'object' ||
      !Object.values(s.sizes).every(
        (d) => Array.isArray(d) && d.length === 2 && d.every((n) => Number.isInteger(n) && n > 0),
      ))
  )
    return 'sizes 必须是「档位 → [宽, 高]」'
  if (s.channel === 'mumugofe' && !(s.resolutions as string[]).every((r) => s.sizes?.[r]))
    return 'mumugofe 的每个分辨率档位都必须提供 sizes'
  if (!isCount(s.maxImages) || !isCount(s.maxVideos) || !isCount(s.maxAudios))
    return 'maxImages、maxVideos、maxAudios 必须是非负整数'
  if (s.publicUrls !== undefined && s.publicUrls !== true) return 'publicUrls 只能为 true'
  if (s.multipart !== undefined && s.multipart !== true) return 'multipart 只能为 true'
  if (s.multipart && s.publicUrls) return 'multipart 与 publicUrls 不能同时设置'
  if (s.resolutionField !== undefined && s.resolutionField !== true)
    return 'resolutionField 只能为 true'
  return channelPriceProblem(s.price, s.resolutions as string[])
}

/** 配置中保存的图像渠道规格不合法时返回原因。 */
export function channelImageSpecProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return '不是对象'
  const s = value as Partial<ChannelImageSpec>
  if (s.channel !== 'mumugofe') return 'channel 必须是 mumugofe'
  if (!isTextList(s.resolutions)) return 'resolutions 必须是非空字符串数组'
  if (!isTextList(s.sizes) || !(s.sizes as string[]).every((v) => /^\d+x\d+$/.test(v)))
    return 'sizes 必须是「宽x高」的非空数组'
  if (!isCount(s.maxImages)) return 'maxImages 必须是非负整数'
  if (s.price?.per === 'second') return '图像的 price 只能按次'
  return channelPriceProblem(s.price, s.resolutions as string[])
}

/** 生成的产物类别。顺序即模型库页签顺序。 */
export const MEDIA_OUTPUTS = ['image', 'video', 'audio'] as const
export type MediaOutput = (typeof MEDIA_OUTPUTS)[number]

/** 发送前的价格：可计算时为本次金额，Token 用量未知时只提供每百万 Token 单价。 */
export type MediaQuote =
  | { cost: number; currency: Currency }
  | { cost: null; currency: Currency; tokenRates: { input: number; output: number } }

/**
 * 生成调用与画布生成卡的类别：生成模型的三类，加上 `art`（由对话模型写出的 HTML 页面）。
 * `art` 不属于 `MEDIA_OUTPUTS`：它使用对话模型，模型库与生成模型的配置中没有这一类。
 */
export const GENERATE_OUTPUTS = [...MEDIA_OUTPUTS, 'art'] as const
export type GenerateOutput = (typeof GENERATE_OUTPUTS)[number]

/**
 * 生成输入的用途。生成请求（`MediaInput.role`）与画布连线使用同一组取值。
 *
 * `reference` 是参考图（出图时即待修改的图），`first_frame` / `last_frame` 是视频的首尾帧，
 * `video` 是参考视频（编辑、延长或参考生成，具体是哪一种由模型的原生参数或提示词决定），
 * `audio` 是视频生成的参考音频（wav / mp3），须与参考图或参考视频同时提供，不能与首尾帧同时提供。
 */
export const MEDIA_INPUT_ROLES = [
  'reference',
  'first_frame',
  'last_frame',
  'video',
  'audio',
] as const
export type MediaInputRole = (typeof MEDIA_INPUT_ROLES)[number]

/**
 * 生成花费中数量字段的单位：图片按张、视频按秒、语音按字符，与各厂商的计费口径一致；
 * `art` 是对话模型的输出 token。
 */
export const MEDIA_OUTPUT_UNIT: Record<GenerateOutput, '张' | '秒' | '字符' | 'token'> = {
  image: '张',
  video: '秒',
  audio: '字符',
  art: 'token',
}

/**
 * 一轮中的一次生成花费。保存在所属轮次的 `runs.media_usage` 中，轮次收尾时逐条记入账本。
 *
 * `cost` 为 0 表示金额不明：模型没有价目、接口没有回报计价所需的量，或从资源包扣费（没有金额）。
 * 界面按既有约定将 0 显示为 N/A，不显示为免费。
 */
export interface MediaSpend {
  /** 请求所用的协议：生成模型为生成协议，`art` 为对话协议。 */
  kind: MediaKind | ProviderKind
  /** 接口名。 */
  provider: string
  model: string
  output: GenerateOutput
  /** 接口回报的数量，单位见 `MEDIA_OUTPUT_UNIT`；接口未回报时为 null。 */
  quantity: number | null
  cost: number
  currency: Currency
  at: number
}

/** 单次媒体请求的失败事实；连接中断与本地超时不能证明远端生成失败。 */
export interface MediaDiagnostic {
  stage: 'upload' | 'generate' | 'query' | 'download'
  kind: 'timeout' | 'connection' | 'http' | 'response'
  outcome: 'unknown' | 'rejected' | 'available'
  host: string
  elapsedMs: number
  /** 静默上限（毫秒）：连续这么久未收到数据即中止。生成请求不设上限，此项缺省。 */
  timeoutMs?: number
  status?: number
  code?: string
  requestId?: string
}

/** 协议决定类别。配置中不另存类别：两处各存一份可能导致不一致。 */
export const MEDIA_KIND_OUTPUT: Record<MediaKind, MediaOutput> = {
  openai_images: 'image',
  dashscope_images: 'image',
  gemini_images: 'image',
  xai_images: 'image',
  openai_videos: 'video',
  ark_videos: 'video',
  dashscope_videos: 'video',
  kling_videos: 'video',
  gemini_videos: 'video',
  veo_videos: 'video',
  xai_videos: 'video',
  openai_speech: 'audio',
  dashscope_speech: 'audio',
}

/**
 * 百炼官方端点：旧的公共域名与按业务空间分配的 `*.maas.aliyuncs.com`。
 *
 * 对话适配器据此决定大媒体是否使用 `oss://` 上传；未收录的生成模型据此选择协议默认值。
 * 两处必须共用此判断：各写一份时，百炼更换域名后可能只修改其中一处。
 */
export function isDashScopeEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return (
      host === 'dashscope.aliyuncs.com' ||
      host === 'dashscope-intl.aliyuncs.com' ||
      host === 'dashscope-us.aliyuncs.com' ||
      host.endsWith('.maas.aliyuncs.com')
    )
  } catch {
    return false
  }
}

/** 火山方舟官方端点（国内 `ark.<区域>.volces.com`，海外 `ark.<区域>.bytepluses.com`）。 */
export function isArkEndpoint(baseUrl: string): boolean {
  try {
    return /^ark\.[a-z0-9-]+\.(volces|bytepluses)\.com$/.test(
      new URL(baseUrl).hostname.toLowerCase(),
    )
  } catch {
    return false
  }
}

/** 可灵开放平台官方端点（国内 `api-beijing`，海外 `api-singapore`）。 */
export function isKlingEndpoint(baseUrl: string): boolean {
  try {
    return /^api-(beijing|singapore)\.klingai\.com$/.test(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 已收录模型默认使用目录协议；未收录时按类别与官方地址给出默认值。
 * 仅在添加时使用。请求以保存的 `media[id].kind` 为准，修改地址不改变协议。
 */
export function defaultMediaKind(
  output: MediaOutput,
  baseUrl: string | undefined,
  catalogKind?: MediaKind,
): MediaKind {
  if (catalogKind && MEDIA_KIND_OUTPUT[catalogKind] === output) return catalogKind
  let host = ''
  try {
    host = new URL(baseUrl ?? '').hostname.toLowerCase()
  } catch {}
  if (host === 'generativelanguage.googleapis.com') {
    if (output === 'image') return 'gemini_images'
    if (output === 'video') return catalogKind === 'veo_videos' ? 'veo_videos' : 'gemini_videos'
  }
  if (host === 'api.x.ai') {
    if (output === 'image') return 'xai_images'
    if (output === 'video') return 'xai_videos'
  }
  const dashScope = baseUrl !== undefined && isDashScopeEndpoint(baseUrl)
  switch (output) {
    case 'image':
      // 火山方舟的出图接口与 OpenAI 形状相同，与中转站使用同一协议。
      return dashScope ? 'dashscope_images' : 'openai_images'
    case 'video':
      if (dashScope) return 'dashscope_videos'
      if (baseUrl !== undefined && isArkEndpoint(baseUrl)) return 'ark_videos'
      return baseUrl !== undefined && isKlingEndpoint(baseUrl) ? 'kling_videos' : 'openai_videos'
    case 'audio':
      return dashScope ? 'dashscope_speech' : 'openai_speech'
  }
}

/** 名称与目录 id 之间允许的分隔符：中转站在官方名称后追加的分辨率、版本或日期后缀以此开头。 */
const SUFFIX_SEPARATORS = ['-', '.', '_']

/**
 * 按名称识别生成模型。与目录 id 完全一致时使用目录协议；目录 id 之后带分隔符与后缀时（中转站的自定义名称，
 * 如 `gpt-image-2.5-sunburst-4k`），`base` 为该目录 id，协议按接口地址取默认值：中转站以自身的接口格式提供该名称，
 * 不一定提供目录协议（如 Gemini 原生接口）。多个目录 id 都是前缀时取最长的一个；都不成立时返回 undefined。
 *
 * 拉取模型与手动添加共用此函数：两处各写一份时，同一个名称在两处可能识别为不同类别。
 */
export function identifyMediaModel(
  id: string,
  catalog: readonly { id: string; kind: MediaKind }[],
  baseUrl: string | undefined,
): { output: MediaOutput; kind: MediaKind; base?: string } | undefined {
  const exact = catalog.find((m) => m.id === id)
  if (exact) {
    const output = MEDIA_KIND_OUTPUT[exact.kind]
    return { output, kind: defaultMediaKind(output, baseUrl, exact.kind) }
  }
  let base: { id: string; kind: MediaKind } | undefined
  for (const m of catalog) {
    if (!id.startsWith(m.id) || !SUFFIX_SEPARATORS.includes(id.charAt(m.id.length))) continue
    if (!base || m.id.length > base.id.length) base = m
  }
  if (!base) return undefined
  const output = MEDIA_KIND_OUTPUT[base.kind]
  return { output, kind: defaultMediaKind(output, baseUrl), base: base.id }
}
