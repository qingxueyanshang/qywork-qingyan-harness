/**
 * MiniMax 视频生成 H3 系列，2026-10-27 核对官方「视频生成 V2」创建与查询接口及价格页。
 *
 * 分辨率与时长为必填字段，画布省略默认值时由适配器按当前操作补齐（`resolveMediaParam` 的缺省值）。
 * 首尾帧与参考素材互斥；只有尾帧时按尾帧生成。
 */
import type { MentionStyle } from '@qywork/core'
import type { MediaModelSpec, MediaParamSpec, MediaPrice } from './catalog.ts'

const OPERATIONS: MediaModelSpec['operations'] = [
  'text_to_video',
  'image_to_video',
  'first_last_frame',
  'reference_to_video',
  'video_to_video',
]
const FRAMES = ['image_to_video', 'first_last_frame']
const REFERENCES = ['reference_to_video', 'video_to_video']
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

// 官方示例「人物参考视频1的动作，表演街舞，人物参考图1 图2」「音色参考音频1」：按类别分别计数。
const MENTION: MentionStyle = { image: '图{n}', video: '视频{n}', audio: '音频{n}' }

/**
 * 价格页「视频」：输出与参考视频按秒、按输出分辨率计价，参考图超出免费张数后按张计价，参考音频免费。
 * `rates` 的值为 [输出每秒, 参考视频每秒]。有参考视频时计费秒数取决于素材时长，发送前不估算。
 */
function price(
  rates: Record<string, readonly [number, number]>,
  image: { rate: number; free: number },
): MediaPrice {
  return {
    currency: 'CNY',
    cost(u) {
      const r = u.resolution === undefined ? undefined : rates[u.resolution]
      if (u.seconds === undefined || !r) return null
      const images = Math.max((u.inputImages ?? 0) - image.free, 0)
      return u.seconds * r[0] + (u.inputSeconds ?? 0) * r[1] + images * image.rate
    },
    usageOf(p, inputs) {
      const seconds = Number(p.duration)
      if (inputs.videos > 0 || !(seconds > 0) || typeof p.resolution !== 'string') return null
      return { seconds, resolution: p.resolution.toLowerCase(), inputImages: inputs.images }
    },
  }
}

/** `minSeconds`：Max 不支持 4 秒。`ratioRequired`：Lite 的参考生视频不接受 adaptive。 */
function params(opts: {
  resolutions: readonly string[]
  minSeconds: number
  ratioRequired: boolean
  max: boolean
}): MediaParamSpec[] {
  return [
    {
      name: 'resolution',
      label: '分辨率',
      type: 'enum',
      values: opts.resolutions,
      default: '768P',
      description: '输出分辨率',
    },
    {
      name: 'duration',
      label: '时长',
      type: 'integer',
      min: opts.minSeconds,
      max: 15,
      default: 5,
      description: `时长（秒），${opts.minSeconds} 到 15`,
    },
    {
      name: 'ratio',
      label: '宽高比',
      type: 'enum',
      values: ['adaptive', ...RATIOS],
      default: 'adaptive',
      description: '画幅；文生视频不能取 adaptive，首帧与首尾帧只能取 adaptive',
      rules: [
        { when: { operations: ['text_to_video'] }, values: RATIOS, default: '16:9' },
        { when: { operations: FRAMES }, values: ['adaptive'] },
        ...(opts.ratioRequired
          ? [{ when: { operations: REFERENCES }, values: RATIOS, default: '16:9' }]
          : []),
      ],
    },
    ...(opts.max
      ? [
          {
            name: 'prompt_expansion_mode',
            label: '提示词扩写',
            type: 'enum',
            values: ['disabled', 'balanced', 'quality'],
            valueLabels: { disabled: '关闭', balanced: '均衡', quality: '质量优先' },
            default: 'balanced',
            description: '提示词扩写模式',
          } satisfies MediaParamSpec,
        ]
      : []),
    {
      name: 'aigc_watermark',
      label: '水印',
      advanced: true,
      type: 'boolean',
      default: false,
      description: '在视频中添加 AIGC 标识水印',
    },
  ]
}

/** 协议默认与目录条目共用。参考图 ≤ 9、参考视频与参考音频各 ≤ 3；请求体总大小 ≤ 64 MB。 */
export const MINIMAX_VIDEO_DEFAULT: Omit<MediaModelSpec, 'id' | 'displayName'> = {
  vendor: null,
  kind: 'minimax_videos',
  operations: OPERATIONS,
  maxPromptLength: 7000,
  inputs: {
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    audioMimeTypes: ['audio/wav', 'audio/mpeg'],
    maxAudioBytes: 15 * 1024 * 1024,
    transport: 'json',
    lastFrameAlone: true,
  },
  params: params({ resolutions: ['768P'], minSeconds: 5, ratioRequired: true, max: false }),
  catalogued: false,
}

const model = (
  id: string,
  displayName: string,
  opts: Parameters<typeof params>[0],
  videoPrice: MediaPrice,
): MediaModelSpec => ({
  ...MINIMAX_VIDEO_DEFAULT,
  id,
  displayName,
  vendor: 'MiniMax',
  params: params(opts),
  price: videoPrice,
  mention: MENTION,
  catalogued: true,
})

const FLAGSHIP_IMAGES = { rate: 0.2, free: 5 }

export const MINIMAX_VIDEO_MODELS: readonly MediaModelSpec[] = [
  model(
    'MiniMax-H3',
    'MiniMax H3',
    { resolutions: ['768P', '2K'], minSeconds: 4, ratioRequired: false, max: false },
    price({ '768p': [0.5, 0.5], '2k': [0.8, 0.8] }, FLAGSHIP_IMAGES),
  ),
  model(
    'MiniMax-H3-Highspeed',
    'MiniMax H3 Highspeed',
    { resolutions: ['768P'], minSeconds: 4, ratioRequired: false, max: false },
    price({ '768p': [0.4, 0.4] }, FLAGSHIP_IMAGES),
  ),
  model(
    'MiniMax-H3-Lite',
    'MiniMax H3 Lite',
    { resolutions: ['480P', '768P'], minSeconds: 4, ratioRequired: true, max: false },
    price({ '480p': [0.16, 0.16], '768p': [0.26, 0.26] }, { rate: 0.13, free: 5 }),
  ),
  model(
    'MiniMax-H3-Max',
    'MiniMax H3 Max',
    { resolutions: ['480P', '768P'], minSeconds: 5, ratioRequired: false, max: true },
    price({ '480p': [0.33, 0.37], '768p': [0.5, 0.97] }, { rate: 0.5, free: 2 }),
  ),
]
