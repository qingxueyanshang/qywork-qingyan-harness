/** Google 与 xAI 生成模型规格，2026-10-01 核对官方生成指南与价格页。 */
import type { MediaModelSpec, MediaParamSpec, MediaPrice } from './catalog.ts'

const ratios = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const choice = (
  name: string,
  label: string,
  values: readonly (string | number)[],
  description: string,
): MediaParamSpec => ({ name, label, type: 'enum', values, description })

const imageParams = (sizes: string[], wide = false): MediaParamSpec[] => [
  choice(
    'aspect_ratio',
    '宽高比',
    wide ? [...ratios, '1:4', '4:1', '1:8', '8:1'] : ratios,
    '输出画幅',
  ),
  choice('image_size', '分辨率', sizes, '输出分辨率档位'),
  {
    name: 'mime_type',
    label: '输出格式',
    advanced: true,
    type: 'enum',
    values: ['image/png', 'image/jpeg'],
    description: '输出图像格式',
  },
]

const omniParams: MediaParamSpec[] = [
  choice('aspect_ratio', '宽高比', ['16:9', '9:16'], '输出画幅；默认 16:9'),
  choice(
    'resolution',
    '分辨率',
    ['360p', '720p', '1080p', '4k'],
    '默认 720p；1080p 与 4k 为上采样',
  ),
]

const veoParams = (lite = false): MediaParamSpec[] => [
  { ...choice('aspectRatio', '宽高比', ['16:9', '9:16'], '输出画幅'), default: '16:9' },
  {
    ...choice(
      'resolution',
      '分辨率',
      lite ? ['720p', '1080p'] : ['720p', '1080p', '4k'],
      '1080p、4k 仅支持 8 秒',
    ),
    default: '720p',
  },
  {
    ...choice('durationSeconds', '时长', [4, 6, 8], '参考图生成与高分辨率输出须为 8 秒'),
    default: 8,
    rules: [
      { when: { operations: ['reference_to_video'] }, values: [8] },
      { when: { params: { resolution: ['1080p', '4k'] } }, values: [8] },
    ],
  },
  {
    name: 'personGeneration',
    type: 'enum',
    values: ['allow_all', 'allow_adult'],
    description: '文生视频使用 allow_all；有输入图片时使用 allow_adult；受地区限制',
  },
]

const xaiImageParams: MediaParamSpec[] = [
  choice(
    'aspect_ratio',
    '宽高比',
    [
      'auto',
      '1:1',
      '16:9',
      '9:16',
      '4:3',
      '3:4',
      '3:2',
      '2:3',
      '2:1',
      '1:2',
      '19.5:9',
      '9:19.5',
      '20:9',
      '9:20',
      '21:9',
      '5:2',
    ],
    '生成时默认 auto；修改时默认沿用第一张输入图片的宽高比',
  ),
  { ...choice('resolution', '分辨率', ['1k', '2k'], '输出分辨率'), default: '1k' },
  {
    name: 'quality',
    label: '生成质量',
    type: 'enum',
    values: ['low', 'medium', 'auto'],
    valueLabels: { low: '低', medium: '中', auto: '自动' },
    default: 'auto',
    description: '输出质量；auto 由接口决定实际计费档位',
  },
  {
    name: 'n',
    label: '张数',
    type: 'integer',
    min: 1,
    max: 10,
    default: 1,
    description: '输出图片数量',
  },
]

const xaiVideoParams: MediaParamSpec[] = [
  choice(
    'aspect_ratio',
    '宽高比',
    ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    '文生视频默认 16:9；首帧生视频默认沿用图片的宽高比',
  ),
  {
    ...choice('resolution', '分辨率', ['480p', '720p', '1080p'], '参考图与首尾帧最高 720p'),
    default: '480p',
    rules: [
      {
        when: { operations: ['reference_to_video', 'first_last_frame'] },
        values: ['480p', '720p'],
      },
    ],
  },
  {
    name: 'duration',
    label: '时长',
    type: 'integer',
    min: 1,
    max: 15,
    description: '输出视频秒数',
  },
  {
    name: 'generate_audio',
    label: '声音',
    type: 'boolean',
    default: true,
    description: '生成声音',
  },
]

/** https://ai.google.dev/gemini-api/docs/pricing；缺少模态计量时不推算金额。 */
function tokenPrice(input: number, text: number, media: number): MediaPrice {
  return {
    currency: 'USD',
    cost: (u) =>
      u.inputTokens === undefined ||
      u.outputTextTokens === undefined ||
      u.outputMediaTokens === undefined
        ? null
        : (u.inputTokens * input + u.outputTextTokens * text + u.outputMediaTokens * media) / 1e6,
  }
}

function veoPrice(rates: Record<string, number>): MediaPrice {
  return {
    currency: 'USD',
    cost(u) {
      const rate = rates[u.resolution ?? '']
      return rate === undefined || u.seconds === undefined ? null : rate * u.seconds
    },
    usageOf: (p) =>
      typeof p.durationSeconds === 'number' && typeof p.resolution === 'string'
        ? { seconds: p.durationSeconds, resolution: p.resolution }
        : null,
  }
}

/** xAI 成功响应的实际扣费由适配器读取；目录只提供已明确规格的发送前报价。 */
const xaiImagePrice: MediaPrice = {
  currency: 'USD',
  cost(u) {
    const rate = (
      { '1k:low': 0.04, '2k:low': 0.06, '1k:medium': 0.06, '2k:medium': 0.08 } as Record<
        string,
        number
      >
    )[u.imageTier ?? '']
    return rate === undefined || u.images === undefined || u.inputImages === undefined
      ? null
      : rate * u.images + 0.01 * u.inputImages
  },
  usageOf: (p, inputs) =>
    typeof p.n === 'number' && (p.quality === 'low' || p.quality === 'medium')
      ? { images: p.n, inputImages: inputs.images, imageTier: `${p.resolution}:${p.quality}` }
      : null,
}
const xaiVideoUsage: NonNullable<MediaPrice['usageOf']> = (p, inputs) =>
  typeof p.duration === 'number' && typeof p.resolution === 'string'
    ? { seconds: p.duration, resolution: p.resolution, inputImages: inputs.images }
    : null
const xaiVideoPrice: MediaPrice = {
  currency: 'USD',
  cost(u) {
    const rate = ({ '480p': 0.08, '720p': 0.14, '1080p': 0.25 } as Record<string, number>)[
      u.resolution ?? ''
    ]
    return rate === undefined || u.seconds === undefined || u.inputImages === undefined
      ? null
      : rate * u.seconds + u.inputImages * 0.01
  },
  usageOf: xaiVideoUsage,
}
// 2026-11-11 核对价目页：Lite 只列 $0.020 每秒，未列 720p、1080p 与输入图片的价格。
// 只对默认的 480p 且没有输入图片的请求报价，其余金额不明。
const xaiVideoLitePrice: MediaPrice = {
  currency: 'USD',
  cost: (u) =>
    u.resolution === '480p' && u.seconds !== undefined && u.inputImages === 0
      ? 0.02 * u.seconds
      : null,
  usageOf: xaiVideoUsage,
}

// 2026-11-11 核对语音生成指南的预置音色表。
const GEMINI_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
]
const speechParams: MediaParamSpec[] = [
  {
    name: 'voice',
    label: '音色',
    type: 'string',
    presets: GEMINI_VOICES,
    default: 'Kore',
    description: '预置音色名称',
  },
  {
    name: 'style',
    type: 'string',
    description: '语气、情绪、语速等朗读要求，用英文短语描述；不出现在合成语音中',
  },
]

/**
 * 价目页（2026-11-11 核对）：文字输入与音频输出按每百万 token 计价，促销价截至 2026-12-31，之后两项均为 2 倍。
 * 按计费时刻取值，不硬编码，否则自 1 月 1 日起金额偏低一半。
 */
const GEMINI_TTS_PROMO_ENDS = Date.UTC(2027, 0, 1)
function speechPrice(input: number, audio: number): MediaPrice {
  return {
    currency: 'USD',
    cost(u) {
      if (u.inputTokens === undefined || u.outputMediaTokens === undefined) return null
      const scale = Date.now() < GEMINI_TTS_PROMO_ENDS ? 1 : 2
      return ((u.inputTokens * input + u.outputMediaTokens * audio) * scale) / 1e6
    },
  }
}

type NativeKind =
  | 'gemini_images'
  | 'gemini_videos'
  | 'veo_videos'
  | 'xai_images'
  | 'xai_videos'
  | 'gemini_speech'
type Defaults = Omit<MediaModelSpec, 'id' | 'displayName'>
export const GOOGLE_XAI_DEFAULTS: Record<NativeKind, Defaults> = {
  gemini_images: {
    vendor: null,
    kind: 'gemini_images',
    operations: ['generate', 'edit'],
    inputs: { maxImages: 14, maxVideos: 0, transport: 'json' },
    params: imageParams(['1K']),
    catalogued: false,
  },
  gemini_videos: {
    vendor: null,
    kind: 'gemini_videos',
    operations: [
      'text_to_video',
      'image_to_video',
      'first_last_frame',
      'reference_to_video',
      'video_to_video',
    ],
    inputs: { maxImages: 6, maxVideos: 1, transport: 'json', framesWithReferences: true },
    params: omniParams,
    catalogued: false,
  },
  veo_videos: {
    vendor: null,
    kind: 'veo_videos',
    operations: ['text_to_video', 'image_to_video', 'first_last_frame'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: veoParams(true),
    catalogued: false,
  },
  xai_images: {
    vendor: null,
    kind: 'xai_images',
    operations: ['generate', 'edit'],
    inputs: { maxImages: 5, maxVideos: 0, transport: 'json' },
    params: xaiImageParams,
    catalogued: false,
  },
  gemini_speech: {
    vendor: null,
    kind: 'gemini_speech',
    operations: ['speech'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: speechParams,
    catalogued: false,
  },
  xai_videos: {
    vendor: null,
    kind: 'xai_videos',
    operations: ['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video'],
    inputs: {
      maxImages: 7,
      maxVideos: 0,
      transport: 'json',
      lastFrameAlone: true,
      framesWithReferences: true,
    },
    params: xaiVideoParams,
    catalogued: false,
  },
}

function model(
  id: string,
  displayName: string,
  kind: NativeKind,
  price: MediaPrice,
  overrides: Partial<MediaModelSpec> = {},
): MediaModelSpec {
  return {
    ...GOOGLE_XAI_DEFAULTS[kind],
    id,
    displayName,
    vendor: kind.startsWith('xai_') ? 'xAI' : 'Google',
    catalogued: true,
    price,
    ...overrides,
  }
}

export const GOOGLE_XAI_MODELS: readonly MediaModelSpec[] = [
  model(
    'gemini-3.1-flash-lite-image',
    'Nano Banana 2 Lite',
    'gemini_images',
    tokenPrice(0.25, 1.5, 30),
  ),
  model('gemini-3.1-flash-image', 'Nano Banana 2', 'gemini_images', tokenPrice(0.5, 3, 60), {
    params: imageParams(['512', '1K', '2K', '4K'], true),
  }),
  // 2026-11-11 核对型号页与图像生成指南：1K / 2K / 4K，不支持 512；参考图上限与宽幅画幅同 Nano Banana 2。
  model('gemini-nano-banana-2.1', 'Nano Banana 2.1', 'gemini_images', tokenPrice(1.5, 7.5, 30), {
    params: imageParams(['1K', '2K', '4K'], true),
  }),
  model('gemini-3-pro-image', 'Nano Banana Pro', 'gemini_images', tokenPrice(2, 12, 120), {
    params: imageParams(['1K', '2K', '4K']),
  }),
  // 2026-11-11 核对：1.2 的视频输出为每百万 token $12；1.1 自 2026-12-03 起由 1.2 提供服务并按 1.2 计价。
  model('gemini-omni-1.2-flash', 'Gemini Omni 1.2 Flash', 'gemini_videos', tokenPrice(1.5, 9, 12)),
  model('gemini-omni-1.1-flash', 'Gemini Omni Flash', 'gemini_videos', tokenPrice(1.5, 9, 17.5)),
  ...(
    [
      ['veo-3.1-generate-preview', 'Veo 3.1', { '720p': 0.4, '1080p': 0.4, '4k': 0.6 }],
      ['veo-3.1-fast-generate-preview', 'Veo 3.1 Fast', { '720p': 0.1, '1080p': 0.12, '4k': 0.3 }],
      ['veo-3.1-lite-generate-preview', 'Veo 3.1 Lite', { '720p': 0.05, '1080p': 0.08 }],
    ] as const
  ).map(([id, name, rates]) =>
    model(id, name, 'veo_videos', veoPrice(rates), {
      params: veoParams(!('4k' in rates)),
      mappings: {
        openai_videos: {
          videoFormat: 'veo',
          operations: ['text_to_video', 'image_to_video'],
          inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
        },
      },
      ...('4k' in rates
        ? ({
            operations: [
              'text_to_video',
              'image_to_video',
              'first_last_frame',
              'reference_to_video',
            ],
            inputs: { maxImages: 3, maxVideos: 0, transport: 'json' },
          } as const)
        : {}),
    }),
  ),
  model('gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS', 'gemini_speech', speechPrice(0.5, 9)),
  model(
    'gemini-3.8-flash-lite-tts',
    'Gemini 3.8 Flash Lite TTS',
    'gemini_speech',
    speechPrice(0.5, 6),
  ),
  model('grok-imagine-image-2.0', 'Grok Imagine Image 2.0', 'xai_images', xaiImagePrice),
  model('grok-imagine-video-1.5', 'Grok Imagine Video 1.5', 'xai_videos', xaiVideoPrice),
  // 2026-11-11 核对视频生成指南：Lite 只写明文生视频与首帧生视频，未写明首尾帧与参考图。
  model(
    'grok-imagine-video-1.5-lite',
    'Grok Imagine Video 1.5 Lite',
    'xai_videos',
    xaiVideoLitePrice,
    {
      operations: ['text_to_video', 'image_to_video'],
      inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    },
  ),
]
