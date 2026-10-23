/**
 * MiniMax 语音合成 Speech 2.8，2026-10-22 核对官方「同步语音合成」HTTP 接口、系统音色列表与定价页。
 *
 * 参数平铺，名称与接口字段相同；适配器按接口结构放入 `voice_setting` 与 `audio_setting`。
 */
import type { MediaModelSpec, MediaParamSpec, MediaPrice } from './catalog.ts'
import { MINIMAX_VOICES } from './catalog-minimax-voices.ts'

/** 音色必填，协议默认与目录条目共用。粤语音色只在 `language_boost` 为 `Chinese,Yue` 时生效。 */
export const MINIMAX_VOICE: MediaParamSpec = {
  name: 'voice_id',
  label: '音色',
  type: 'string',
  ...MINIMAX_VOICES,
  default: 'male-qn-qingse',
  description: '系统音色 ID；粤语音色须同时将 language_boost 设为 Chinese,Yue',
}

// 定价页「语音合成（TTS）」：按输入字符计费，1 个汉字计 2 个字符，接口回报的 usage_characters 已按此计算。
const price = (perTenThousand: number): MediaPrice => ({
  currency: 'CNY',
  cost: (u) => (u.characters === undefined ? null : (u.characters / 10_000) * perTenThousand),
})

const choice = (
  name: string,
  label: string,
  values: (string | number)[],
  defaultValue: string | number,
): MediaParamSpec => ({
  name,
  label,
  type: 'enum',
  values,
  default: defaultValue,
  description: label,
})

// 情绪 fluent 与 whisper 只对 Speech 2.6 生效。
const params: MediaParamSpec[] = [
  MINIMAX_VOICE,
  {
    name: 'speed',
    label: '语速',
    type: 'number',
    min: 0.5,
    max: 2,
    default: 1,
    description: '语速倍数',
  },
  {
    name: 'vol',
    label: '音量',
    type: 'number',
    max: 10,
    default: 1,
    advanced: true,
    description: '音量，大于 0、不超过 10',
  },
  {
    name: 'pitch',
    label: '音调',
    type: 'integer',
    min: -12,
    max: 12,
    default: 0,
    advanced: true,
    description: '音调，0 为音色原调',
  },
  {
    name: 'emotion',
    label: '情绪',
    type: 'enum',
    values: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'],
    valueLabels: {
      happy: '高兴',
      sad: '悲伤',
      angry: '愤怒',
      fearful: '害怕',
      disgusted: '厌恶',
      surprised: '惊讶',
      calm: '中性',
    },
    advanced: true,
    description: '情绪；不填写时由模型按文本自动选择',
  },
  // 只提供带文件头、可直接播放的格式。
  choice('format', '输出格式', ['mp3', 'wav', 'flac'], 'mp3'),
  {
    ...choice('sample_rate', '采样率', [8000, 16000, 22050, 24000, 32000, 44100], 32000),
    advanced: true,
  },
  {
    ...choice('bitrate', '码率', [32000, 64000, 128000, 256000], 128000),
    advanced: true,
    available: false,
    rules: [{ when: { params: { format: ['mp3'] } }, available: true }],
    description: 'MP3 码率，单位 bps',
  },
  {
    ...choice('channel', '声道', [1, 2], 1),
    valueLabels: { 1: '单声道', 2: '双声道' },
    advanced: true,
  },
  {
    name: 'language_boost',
    type: 'enum',
    values: [
      'auto',
      'Chinese',
      'Chinese,Yue',
      'English',
      'Japanese',
      'Korean',
      'Spanish',
      'Portuguese',
      'French',
      'German',
      'Russian',
      'Italian',
      'Arabic',
      'Turkish',
      'Dutch',
      'Ukrainian',
      'Vietnamese',
      'Indonesian',
      'Thai',
      'Polish',
      'Romanian',
      'Greek',
      'Czech',
      'Finnish',
      'Hindi',
      'Bulgarian',
      'Danish',
      'Hebrew',
      'Malay',
      'Persian',
      'Slovak',
      'Swedish',
      'Croatian',
      'Filipino',
      'Hungarian',
      'Norwegian',
      'Slovenian',
      'Catalan',
      'Nynorsk',
      'Tamil',
      'Afrikaans',
    ],
    description: '增强指定语种与方言的朗读；auto 由模型判断，粤语填 Chinese,Yue',
  },
]

const model = (id: string, displayName: string, rate: number): MediaModelSpec => ({
  id,
  displayName,
  vendor: 'MiniMax',
  kind: 'minimax_speech',
  operations: ['speech'],
  maxPromptLength: 10_000,
  inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
  params,
  price: price(rate),
  catalogued: true,
})

// 同步语音合成：HD 每万字符 ¥3.5，Turbo ¥2.0。
export const MINIMAX_AUDIO_MODELS: readonly MediaModelSpec[] = [
  model('speech-2.8-hd', 'MiniMax Speech 2.8 HD', 3.5),
  model('speech-2.8-turbo', 'MiniMax Speech 2.8 Turbo', 2),
]
