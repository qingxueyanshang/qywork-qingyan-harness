/**
 * 生成模型的协议与类别：出图等生成接口的请求形状，以及添加模型时按接口地址给出的默认协议。
 *
 * 与对话协议 `PROVIDER_KINDS` 分列：那一组的每个值都是对话协议，对话目录、协议下拉与对话适配器
 * 都按它分派，混进来就得在每一处排除生成协议。
 */

/**
 * 一个值 = 一种请求形状，不是一个厂商：火山方舟的出图与 OpenAI 同形状，同属 `openai_images`。
 * 加值要同时加该协议的适配器、`MEDIA_KIND_OUTPUT` 一行与目录里的协议默认。
 */
export const MEDIA_KINDS = [
  'openai_images',
  'dashscope_images',
  'openai_videos',
  'ark_videos',
  'dashscope_videos',
  'openai_speech',
  'dashscope_speech',
] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]

/** 生成的产物类别。顺序即模型库页签顺序。 */
export const MEDIA_OUTPUTS = ['image', 'video', 'audio'] as const
export type MediaOutput = (typeof MEDIA_OUTPUTS)[number]

/** 协议决定类别。配置里不另存类别：两处各存一份就可能对不上。 */
export const MEDIA_KIND_OUTPUT: Record<MediaKind, MediaOutput> = {
  openai_images: 'image',
  dashscope_images: 'image',
  openai_videos: 'video',
  ark_videos: 'video',
  dashscope_videos: 'video',
  openai_speech: 'audio',
  dashscope_speech: 'audio',
}

/**
 * 百炼官方端点：旧的公共域名与按业务空间分配的 `*.maas.aliyuncs.com`。
 *
 * 对话适配器据此决定大媒体走不走 `oss://` 上传，添加生成模型时据此选百炼原生协议。
 * 两处必须共用这一个判断：各写一份时，百炼换域名只会改到其中一处。
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

/**
 * 添加生成模型时的默认协议，按「类别 × 接口地址」查。
 *
 * **只在添加的那一刻用一次。** 落盘的 `media[id].kind` 才是权威，之后不再按地址重算：
 * 重算会把用户在 `config.json` 里手改的协议改回默认值。
 */
export function defaultMediaKind(output: MediaOutput, baseUrl: string | undefined): MediaKind {
  const dashScope = baseUrl !== undefined && isDashScopeEndpoint(baseUrl)
  switch (output) {
    case 'image':
      // 火山的出图本来就是 OpenAI 形状，与中转站同一协议。
      return dashScope ? 'dashscope_images' : 'openai_images'
    case 'video':
      if (dashScope) return 'dashscope_videos'
      return baseUrl !== undefined && isArkEndpoint(baseUrl) ? 'ark_videos' : 'openai_videos'
    case 'audio':
      return dashScope ? 'dashscope_speech' : 'openai_speech'
  }
}
