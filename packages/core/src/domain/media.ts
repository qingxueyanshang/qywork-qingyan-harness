/**
 * 生成模型的协议与类别：出图等生成接口的请求形状，以及添加模型时的默认协议。
 *
 * 与对话协议 `PROVIDER_KINDS` 分开定义：后者的每个值都是对话协议，对话目录、协议下拉框与对话适配器
 * 都按它分派，合并后每一处都必须排除生成协议。
 */

import type { Currency } from './model.ts'

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

/** 生成的产物类别。顺序即模型库页签顺序。 */
export const MEDIA_OUTPUTS = ['image', 'video', 'audio'] as const
export type MediaOutput = (typeof MEDIA_OUTPUTS)[number]

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

/** 生成花费中数量字段的单位：图片按张、视频按秒、语音按字符，与各厂商的计费口径一致。 */
export const MEDIA_OUTPUT_UNIT: Record<MediaOutput, '张' | '秒' | '字符'> = {
  image: '张',
  video: '秒',
  audio: '字符',
}

/**
 * 一轮中的一次生成花费。保存在所属轮次的 `runs.media_usage` 中，轮次收尾时逐条记入账本。
 *
 * `cost` 为 0 表示金额不明：模型没有价目、接口没有回报计价所需的量，或从资源包扣费（没有金额）。
 * 界面按既有约定将 0 显示为 N/A，不显示为免费。
 */
export interface MediaSpend {
  kind: MediaKind
  /** 接口名。 */
  provider: string
  model: string
  output: MediaOutput
  /** 接口回报的数量，单位见 `MEDIA_OUTPUT_UNIT`；接口未回报时为 null。 */
  quantity: number | null
  cost: number
  currency: Currency
  at: number
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
