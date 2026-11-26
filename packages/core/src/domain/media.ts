/**
 * 生成模型的协议与类别：图片生成等生成接口的请求形状，以及添加模型时的默认协议。
 *
 * 与对话协议 `PROVIDER_KINDS` 分开定义：后者的每个值都是对话协议，对话目录、协议下拉框与对话适配器
 * 都按它分派，合并后每一处都必须排除生成协议。
 */

import type { ErrorCode } from '../protocol/events.ts'
import type { MentionStyle } from './canvas.ts'
import { channelVendorOf, hostOf } from './channel-vendors.ts'
import type { MediaOperation, MediaParamSpec } from './media-params.ts'
import type { Currency, ProviderKind } from './model.ts'

/**
 * 一个值 = 一种请求形状，不是一个厂商：火山方舟的图片生成接口与 OpenAI 同形状，同属 `openai_images`。
 * 新增值时须同时新增该协议的适配器、`BUILTIN_KIND_OUTPUT` 中的一行与目录中的协议默认值。
 * 本列表之外的协议经 `registerMediaKind` 登记（`ExtensionMediaKind`）。
 */
export const BUILTIN_MEDIA_KINDS = [
  'openai_images',
  'dashscope_images',
  'gemini_images',
  'xai_images',
  'minimax_images',
  'kling_images',
  'openai_videos',
  'ark_videos',
  'dashscope_videos',
  'kling_videos',
  'gemini_videos',
  'veo_videos',
  'xai_videos',
  'minimax_videos',
  'openai_speech',
  'dashscope_speech',
  'minimax_speech',
  'mimo_speech',
  'gemini_speech',
  'qywork_images',
  'qywork_videos',
  'qywork_speech',
] as const
export type BuiltinMediaKind = (typeof BUILTIN_MEDIA_KINDS)[number]

declare const extension: unique symbol
/**
 * 经 `registerMediaKind` 登记的协议。只能由登记的返回值或 `isMediaKind` 取得：字符串字面量不能赋值给它，
 * 未登记的取值在运行时被 `isMediaKind` 拒绝。
 */
export type ExtensionMediaKind = string & { readonly [extension]: true }
export type MediaKind = BuiltinMediaKind | ExtensionMediaKind

export const isBuiltinMediaKind = (kind: unknown): kind is BuiltinMediaKind =>
  (BUILTIN_MEDIA_KINDS as readonly unknown[]).includes(kind)

/**
 * 经云端生成的三种协议，每个类别一种：电脑端把请求提交到云端的生成任务接口，云端以上游接口运行原协议的适配器。
 * 只出现在电脑端的云端接口中；云端型号表不使用它们（`isCloudMediaKind`）。
 */
export const CLOUD_MEDIA_KINDS = ['qywork_images', 'qywork_videos', 'qywork_speech'] as const
export type CloudMediaKind = (typeof CLOUD_MEDIA_KINDS)[number]
export const isCloudMediaKind = (kind: MediaKind): kind is CloudMediaKind =>
  (CLOUD_MEDIA_KINDS as readonly MediaKind[]).includes(kind)

/** 生成型号的计费单位：每张、每秒、每次、每万字符。 */
export const MEDIA_UNITS = ['image', 'second', 'request', '10k_chars'] as const
export type MediaUnit = (typeof MEDIA_UNITS)[number]
/** 单价：一个数，或按分辨率档位的「档位 → 单价」。 */
export type UnitPrice = number | Readonly<Record<string, number>>

/**
 * 第三方接口公布的价格。金额按站点充值价与分组倍率折算，币种为站点的计价币种。图像每次请求生成一张，按次即按张。
 * 各分辨率档位单价不同时 `amount` 为「档位 → 金额」。
 */
export interface ChannelPrice {
  per: 'request' | 'second'
  amount: number | Record<string, number>
  currency: Currency
}

/**
 * 扩展渠道保存的型号规格：`channel` 是登记该规格的渠道（`@qywork/ai` 的 `registerMediaChannel`），
 * 其余字段由该渠道定义与校验。电脑端的配置不保存渠道规格（`diagnoseConfig` 拒绝）。
 */
export interface ChannelSpec {
  channel: string
}

/**
 * 型号对应的生成目录条目：第三方接口的自定义名称（如 `gpt-image-2.5-sunburst-4k`）按该条目取得参数表与能力，
 * 请求中仍发送自定义名称。不继承目录单价：第三方接口的价格与官方不同。
 */
export interface MediaBaseSpec {
  base: string
}

/** 型号接受的参考素材：数量上限（首尾帧不计入）与传递方式。 */
export interface MediaInputLimits {
  maxImages: number
  maxVideos: number
  /** 参考音频的段数上限。省略表示不接受参考音频（总时长上限由各厂商另行规定，本地不校验，由接口判定）。 */
  maxAudios?: number
  audioMimeTypes?: readonly string[]
  maxAudioBytes?: number
  transport: 'multipart' | 'json'
  /** JSON 素材必须使用公网地址，不能内联文件字节。 */
  publicUrls?: boolean
  /** 同一协议下各厂商的素材类型名不同时，各用途在请求中的类型名；省略时使用协议的类型名。 */
  types?: Partial<Record<MediaInputRole, string>>
  /** 允许尾帧单独输入，或首尾帧与参考素材组合。省略时各组合互斥且尾帧需要首帧。 */
  lastFrameAlone?: boolean
  framesWithReferences?: boolean
  /** 音频必须同时带参考图或参考视频。 */
  audioRequiresVisual?: boolean
  /** 百炼中仅接受图像地址的模型也使用临时上传。 */
  inlineImages?: boolean
  /** 允许的素材用途组合；参数条件按目录默认值求值。 */
  combinations?: readonly {
    roles: readonly MediaInputRole[]
    maxImages?: number
    params?: Readonly<Record<string, string>>
  }[]
}

/** 计量取值的参数名：张数、时长与分辨率档位。参数表中没有该参数时省略。 */
export interface MediaMeterParams {
  count?: string
  seconds?: string
  resolution?: string
}

/**
 * 云端生成型号交给电脑端的规格（云端型号清单的 `cloudSpec`）：云端按型号的上游协议查表后取出电脑端需要的部分，
 * 不含上游协议、渠道、厂商与型号名。电脑端据此显示参数、校验素材与报价，请求经云端协议提交。
 */
export interface CloudModelSpec {
  operations: MediaOperation[]
  inputs: MediaInputLimits
  params: MediaParamSpec[]
  maxPromptLength?: number
  mention?: MentionStyle
  /** 各尺寸所属的分辨率档位，键为 `size` 的取值；档位由尺寸决定的型号据此计量。 */
  resolutionBySize?: Readonly<Record<string, string>>
  meter: MediaMeterParams
}

/** 云端生成型号保存的规格：云端下发的规格，以及计费单位与单价（积分）。由云端型号清单写入。 */
export interface CloudMediaSpec {
  cloud: {
    spec: CloudModelSpec
    unit: MediaUnit
    unitPrice: UnitPrice
  }
}

/** 生成型号保存的规格来源：渠道规格、对应的目录型号或云端规格。三者互斥，保存在同一字段（`spec`）中。 */
export type StoredMediaSpec = ChannelSpec | MediaBaseSpec | CloudMediaSpec

const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0

/** 生成的产物类别。顺序即模型库页签顺序。 */
export const MEDIA_OUTPUTS = ['image', 'video', 'audio'] as const
export type MediaOutput = (typeof MEDIA_OUTPUTS)[number]

/** 发送前的价格：可计算时为本次金额，Token 用量未知时只提供每百万 Token 单价。 */
export type MediaQuote =
  | { cost: number; currency: Currency }
  | { cost: null; currency: Currency; tokenRates: { input: number; output: number } }

/**
 * 使用对话模型的生成类别：`art` 写出 HTML 页面，`text` 写出文本。不属于 `MEDIA_OUTPUTS`：
 * 模型库与生成模型的配置中没有这两类，模型从对话模型中选择。
 */
export const CHAT_OUTPUTS = ['art', 'text'] as const
export type ChatOutput = (typeof CHAT_OUTPUTS)[number]

/** 生成调用与画布生成卡的类别：生成模型的三类，加上使用对话模型的两类。 */
export const GENERATE_OUTPUTS = [...MEDIA_OUTPUTS, ...CHAT_OUTPUTS] as const
export type GenerateOutput = (typeof GENERATE_OUTPUTS)[number]

/** 该类别是否使用对话模型。按模型来源分支的位置一律经由它判定，不要写成 `output === 'art'`。 */
export function isChatOutput(output: GenerateOutput): output is ChatOutput {
  return (CHAT_OUTPUTS as readonly string[]).includes(output)
}

/**
 * 生成输入的用途。生成请求（`MediaInput.role`）与画布连线使用同一组取值。
 *
 * `reference` 是参考图（生成图片时即待修改的图），`first_frame` / `last_frame` 是视频的首尾帧，
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
 * 使用对话模型的类别是输出 token。
 */
export const MEDIA_OUTPUT_UNIT: Record<GenerateOutput, '张' | '秒' | '字符' | 'token'> = {
  image: '张',
  video: '秒',
  audio: '字符',
  art: 'token',
  text: 'token',
}

/**
 * 一轮中的一次生成花费。保存在所属轮次的 `runs.media_usage` 中，到达时即记入账本（可晚于轮次结束）。
 *
 * `cost` 为 0 表示金额不明：模型没有价目、接口没有回报计价所需的量，或从资源包扣费（没有金额）。
 * 界面按既有约定将 0 显示为 N/A，不显示为免费。
 */
export interface MediaSpend {
  /** 请求所用的协议：生成模型为生成协议，使用对话模型的类别为对话协议。 */
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
  /**
   * 生成在远端的结果：`rejected` 接口没有受理，可以重新提交；`unknown` 无法确定是否受理；
   * `available` 远端仍保留任务或产物，可按任务号或地址取回（下载失败、任务号返回之后的失败）；
   * `failed` 远端受理后报告任务失败，为终态。
   */
  outcome: 'unknown' | 'rejected' | 'available' | 'failed'
  host: string
  elapsedMs: number
  /** 静默上限（毫秒）：连续该时长未收到数据即中止。生成请求不设上限，此项缺省。 */
  timeoutMs?: number
  status?: number
  /** 连接层的错误码（`ECONNRESET`、`ConnectionRefused` 等）。 */
  code?: string
  requestId?: string
  /**
   * 失败码，与对话请求同一套（`@qywork/ai` 的 `MediaError.code`）：重试与云端向用户显示的文字据此判断。
   * 接口答复了错误状态或在正文中报告了失败时存在；连接失败与响应无法解析时缺省。
   */
  errorCode?: ErrorCode
}

/** 内置协议决定类别。配置中不另存类别：两处各存一份可能导致不一致。 */
const BUILTIN_KIND_OUTPUT: Readonly<Record<BuiltinMediaKind, MediaOutput>> = {
  openai_images: 'image',
  dashscope_images: 'image',
  gemini_images: 'image',
  xai_images: 'image',
  minimax_images: 'image',
  kling_images: 'image',
  openai_videos: 'video',
  ark_videos: 'video',
  dashscope_videos: 'video',
  kling_videos: 'video',
  gemini_videos: 'video',
  veo_videos: 'video',
  xai_videos: 'video',
  minimax_videos: 'video',
  openai_speech: 'audio',
  dashscope_speech: 'audio',
  minimax_speech: 'audio',
  mimo_speech: 'audio',
  gemini_speech: 'audio',
  qywork_images: 'image',
  qywork_videos: 'video',
  qywork_speech: 'audio',
}

/** 登记的协议：所属类别，以及以该协议为该类别默认协议的接口地址主机名。 */
const EXTENSION_KINDS = new Map<string, { output: MediaOutput; hosts: readonly string[] }>()

/**
 * 登记内置协议之外的生成协议，返回可用作 `MediaKind` 的协议名。`hosts` 中的主机名添加该类别的型号时默认使用该协议
 * （`defaultMediaKind`）。协议名已存在时抛出：两次登记的类别或主机名可能不同。
 * 适配器、协议默认规格与计量参数名由 `@qywork/ai` 的 `registerMediaProtocol` 登记，它调用本函数。
 */
export function registerMediaKind(
  kind: string,
  output: MediaOutput,
  hosts: readonly string[] = [],
): ExtensionMediaKind {
  if (isBuiltinMediaKind(kind) || EXTENSION_KINDS.has(kind))
    throw new Error(`生成协议 ${kind} 已存在`)
  EXTENSION_KINDS.set(kind, { output, hosts: hosts.map((h) => h.toLowerCase()) })
  return kind as ExtensionMediaKind
}

/** 是否为内置或已登记的协议。读取配置与数据库中的协议名时据此校验。 */
export const isMediaKind = (kind: unknown): kind is MediaKind =>
  isBuiltinMediaKind(kind) || (typeof kind === 'string' && EXTENSION_KINDS.has(kind))

/** 内置协议与已登记的协议。 */
export function mediaKinds(): MediaKind[] {
  return [...BUILTIN_MEDIA_KINDS, ...(EXTENSION_KINDS.keys() as Iterable<ExtensionMediaKind>)]
}

/** 协议所属的类别。协议未登记时抛出：没有类别的协议无法分派。 */
export function mediaKindOutput(kind: MediaKind): MediaOutput {
  if (isBuiltinMediaKind(kind)) return BUILTIN_KIND_OUTPUT[kind]
  const registered = EXTENSION_KINDS.get(kind)
  if (!registered) throw new Error(`生成协议 ${kind} 未登记`)
  return registered.output
}

/** 各类别的云端生成协议。 */
export const CLOUD_MEDIA_KIND: Record<MediaOutput, CloudMediaKind> = {
  image: 'qywork_images',
  video: 'qywork_videos',
  audio: 'qywork_speech',
}

/** 各生成操作所属的类别。 */
const OPERATION_OUTPUT: Record<MediaOperation, MediaOutput> = {
  generate: 'image',
  edit: 'image',
  text_to_video: 'video',
  image_to_video: 'video',
  first_last_frame: 'video',
  reference_to_video: 'video',
  video_to_video: 'video',
  speech: 'audio',
}

const PARAM_TYPES: Record<MediaParamSpec['type'], true> = {
  enum: true,
  integer: true,
  number: true,
  string: true,
  boolean: true,
}

const isText = (v: unknown) => typeof v === 'string' && v !== ''
const isTextRecord = (v: unknown) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isText)

/**
 * 云端下发的规格不合法时返回原因。只校验电脑端读取的字段：操作须属于该型号的类别，素材上限为非负整数，
 * 参数须有名称、类型与说明，计量参数名为字符串。其余字段不校验：云端新增字段时，已安装的版本仍能写入清单。
 */
function cloudModelSpecProblem(value: unknown, output: MediaOutput): string | null {
  if (!value || typeof value !== 'object') return '缺少 spec'
  const s = value as Partial<Record<keyof CloudModelSpec, unknown>>
  if (
    !Array.isArray(s.operations) ||
    !s.operations.length ||
    !s.operations.every((op) => OPERATION_OUTPUT[op as MediaOperation] === output)
  )
    return 'operations 必须是该类别的生成操作'
  const inputs = s.inputs as Partial<MediaInputLimits> | undefined
  if (
    !inputs ||
    !isCount(inputs.maxImages) ||
    !isCount(inputs.maxVideos) ||
    (inputs.maxAudios !== undefined && !isCount(inputs.maxAudios)) ||
    !['multipart', 'json'].includes(inputs.transport as string)
  )
    return 'inputs 必须包含非负整数 maxImages、maxVideos 与 transport（multipart 或 json）'
  const names = new Set<string>()
  for (const p of Array.isArray(s.params) ? (s.params as Partial<MediaParamSpec>[]) : [null]) {
    if (
      !p ||
      !isText(p.name) ||
      names.has(p.name as string) ||
      !Object.hasOwn(PARAM_TYPES, p.type as string) ||
      typeof p.description !== 'string'
    )
      return 'params 中的每个参数必须有不重复的 name、有效的 type 与 description'
    names.add(p.name as string)
  }
  if (
    s.maxPromptLength !== undefined &&
    !(Number.isInteger(s.maxPromptLength) && (s.maxPromptLength as number) > 0)
  )
    return 'maxPromptLength 必须是正整数'
  if (s.mention !== undefined && !isTextRecord(s.mention)) return 'mention 必须是「类别 → 写法」'
  if (s.resolutionBySize !== undefined && !isTextRecord(s.resolutionBySize))
    return 'resolutionBySize 必须是「尺寸 → 档位」'
  if (!s.meter || !isTextRecord(s.meter)) return 'meter 必须是「计量项 → 参数名」'
  return null
}

/** 配置中保存的云端规格不合法时返回原因。`kind` 是该型号的云端协议，规格中的操作须属于其类别。 */
export function cloudMediaSpecProblem(value: unknown, kind: MediaKind): string | null {
  const c = (value as Partial<CloudMediaSpec> | null)?.cloud
  if (!c || typeof c !== 'object') return '缺少 cloud'
  const spec = cloudModelSpecProblem(c.spec, mediaKindOutput(kind))
  if (spec) return spec
  if (!MEDIA_UNITS.includes(c.unit as MediaUnit)) return '计费单位不是有效值'
  const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0
  const price = c.unitPrice
  if (
    !positive(price) &&
    !(
      price &&
      typeof price === 'object' &&
      Object.values(price).length > 0 &&
      Object.values(price).every(positive)
    )
  )
    return '单价须为正数，或按档位分别填写的正数'
  return null
}

/**
 * 已收录模型默认使用目录协议；未收录时按类别与接口地址给出默认值：登记了该主机名的协议（`registerMediaKind`）优先，
 * 其次按官方地址所属的厂商。
 * 仅在添加时使用。请求以保存的 `media[id].kind` 为准，修改地址不改变协议。
 */
export function defaultMediaKind(
  output: MediaOutput,
  baseUrl: string | undefined,
  catalogKind?: MediaKind,
): MediaKind {
  if (catalogKind && mediaKindOutput(catalogKind) === output) return catalogKind
  const host = hostOf(baseUrl)
  for (const [kind, registered] of EXTENSION_KINDS) {
    if (registered.output === output && host && registered.hosts.includes(host))
      return kind as ExtensionMediaKind
  }
  const vendor = channelVendorOf(baseUrl)
  switch (output) {
    case 'image':
      if (vendor === 'google') return 'gemini_images'
      if (vendor === 'xai') return 'xai_images'
      if (vendor === 'minimax') return 'minimax_images'
      if (vendor === 'kling') return 'kling_images'
      // 火山方舟的图片生成接口与 OpenAI 形状相同，与第三方接口使用同一协议。
      return vendor === 'alibaba' ? 'dashscope_images' : 'openai_images'
    case 'video':
      if (vendor === 'google') return catalogKind === 'veo_videos' ? 'veo_videos' : 'gemini_videos'
      if (vendor === 'xai') return 'xai_videos'
      if (vendor === 'alibaba') return 'dashscope_videos'
      if (vendor === 'minimax') return 'minimax_videos'
      if (vendor === 'volcengine') return 'ark_videos'
      return vendor === 'kling' ? 'kling_videos' : 'openai_videos'
    case 'audio':
      if (vendor === 'alibaba') return 'dashscope_speech'
      if (vendor === 'xiaomi') return 'mimo_speech'
      if (vendor === 'google') return 'gemini_speech'
      return vendor === 'minimax' ? 'minimax_speech' : 'openai_speech'
  }
}

/** 目录 id 作为名称前缀时其后允许的分隔符：第三方接口在官方名称后追加的分辨率、思考档位、版本或日期以此开头。 */
const PREFIX_SEPARATORS = ['-', '.', '_']

/**
 * 按前缀识别名称对应的目录 id：`ids` 中是 `id` 的前缀且其后紧接分隔符的条目，多个成立时取最长的一个；
 * 都不成立时返回 undefined。生成模型（`identifyMediaModel`）与拉取时的对话型号共用此规则，
 * 例如 `gpt-image-2.5-sunburst-4k` 对应 `gpt-image-2.5-sunburst`，`gemini-4-argon-high` 对应 `gemini-4-argon`。
 */
export function catalogPrefixOf(id: string, ids: Iterable<string>): string | undefined {
  let base: string | undefined
  for (const c of ids) {
    if (!id.startsWith(c) || !PREFIX_SEPARATORS.includes(id.charAt(c.length))) continue
    if (!base || c.length > base.length) base = c
  }
  return base
}

/**
 * 按名称识别生成模型。与目录 id 完全一致时使用目录协议；接口地址的默认协议是通用协议（第三方接口）且该条目登记了
 * 通用协议的兼容映射（`kinds`）时改用通用协议：第三方接口以自身的接口格式提供该名称，不提供厂商的原生路径
 * （New API 对百炼原生路径返回 404）。没有兼容映射的条目（如 Gemini 图像）与未填写接口地址时沿用目录协议。
 * 名称以目录 id 为前缀时（`catalogPrefixOf`，第三方接口的自定义名称），`base` 为该目录 id，协议按接口地址取默认值；
 * 不成立时返回 undefined。
 *
 * 拉取模型与手动添加共用此函数：两处各写一份时，同一个名称在两处可能识别为不同类别。
 */
export function identifyMediaModel(
  id: string,
  catalog: readonly { id: string; kind: MediaKind; kinds?: readonly MediaKind[] }[],
  baseUrl: string | undefined,
): { output: MediaOutput; kind: MediaKind; base?: string } | undefined {
  const exact = catalog.find((m) => m.id === id)
  if (exact) {
    const output = mediaKindOutput(exact.kind)
    const generic = defaultMediaKind(output, undefined)
    const relay = !!baseUrl?.trim() && defaultMediaKind(output, baseUrl) === generic
    if (relay && exact.kinds?.includes(generic)) return { output, kind: generic }
    return { output, kind: defaultMediaKind(output, baseUrl, exact.kind) }
  }
  const prefix = catalogPrefixOf(
    id,
    catalog.map((m) => m.id),
  )
  const base = catalog.find((m) => m.id === prefix)
  if (!base) return undefined
  const output = mediaKindOutput(base.kind)
  return { output, kind: defaultMediaKind(output, baseUrl), base: base.id }
}
