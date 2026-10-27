/**
 * 渠道商表：接口地址的主机名 → 渠道商。按渠道商处理的兼容差异（协议默认值、请求头、素材上传方式、
 * 拉取时读取的渠道目录与提交格式）一律经 `channelVendorOf` 判定，不在各处另写主机名判断：
 * 分散的判断在渠道商更换域名时只会被改到其中一处。
 *
 * 只按接口地址判定，不按接口返回的字段或模型名推断：中转站可能返回与某渠道同名的字段，
 * 经中转调用的模型名也与官方相同，按它们推断会套用不适用的格式。
 * 表中只收录有兼容处理的渠道商；未收录的地址按通用协议处理。
 * 渠道商 id 与 `@qywork/ai` 的 `VENDORS` 中同一厂商的 id 一致。
 */

export const CHANNEL_VENDORS = [
  'alibaba',
  'volcengine',
  'kling',
  'minimax',
  'xiaomi',
  'google',
  'xai',
  'opencode',
  'hongcheng',
  'mumugofe',
] as const
export type ChannelVendor = (typeof CHANNEL_VENDORS)[number]

/** 每个渠道商的主机名：字符串为完整主机名，正则匹配整个主机名。 */
const HOSTS: Readonly<Record<ChannelVendor, readonly (string | RegExp)[]>> = {
  // 百炼：旧的公共域名与按业务空间分配的 `*.maas.aliyuncs.com`。对话大媒体经 `oss://` 上传；生成协议默认值。
  alibaba: [
    'dashscope.aliyuncs.com',
    'dashscope-intl.aliyuncs.com',
    'dashscope-us.aliyuncs.com',
    /\.maas\.aliyuncs\.com$/,
  ],
  // 火山方舟：国内 `ark.<区域>.volces.com`，海外 `ark.<区域>.bytepluses.com`。视频协议默认值。
  volcengine: [/^ark\.[a-z0-9-]+\.(volces|bytepluses)\.com$/],
  // 可灵开放平台：国内 `api-beijing`，海外 `api-singapore`。视频协议默认值。
  kling: [/^api-(beijing|singapore)\.klingai\.com$/],
  // MiniMax：国内 `api.minimax.cn`（华北 `api-bj.minimaxi.com`），海外 `api.minimax.io`（美西 `api-uw.minimax.io`）。
  minimax: ['api.minimax.cn', 'api-bj.minimaxi.com', 'api.minimax.io', 'api-uw.minimax.io'],
  // 小米 MiMo 开放平台。语音协议默认值。
  xiaomi: ['api.xiaomimimo.com'],
  // Gemini API。图像、视频协议默认值；对话兼容地址转为原生地址。
  google: ['generativelanguage.googleapis.com'],
  // xAI。图像、视频协议默认值。
  xai: ['api.x.ai'],
  // OpenCode Zen。请求附带会话标识。
  opencode: ['opencode.ai'],
  // 中转站 hongcheng。拉取时读取带凭证型号列表的 `parameters`，视频按 hongcheng 格式提交。
  hongcheng: ['hongcheng.lol'],
  // 中转站木木。拉取时读取 `/docs/typetale-models.json`，视频、图像按木木格式提交。
  mumugofe: ['api.mumugofe.com'],
}

/** 接口地址所属的渠道商；地址无效或不在表中时返回 null。 */
export function channelVendorOf(baseUrl: string | undefined): ChannelVendor | null {
  let host: string
  try {
    host = new URL(baseUrl ?? '').hostname.toLowerCase()
  } catch {
    return null
  }
  for (const vendor of CHANNEL_VENDORS) {
    if (HOSTS[vendor].some((h) => (typeof h === 'string' ? h === host : h.test(host))))
      return vendor
  }
  return null
}
