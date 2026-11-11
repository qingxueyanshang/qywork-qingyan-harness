/** 千问音频 3.1，2026-10-14 核对官方 HTTP API、音色列表和北京地域价格；Plus 于 2026-11-11 核对。 */
import type { MediaModelSpec, MediaParamSpec, MediaPrice } from './catalog.ts'
import { QWEN_AUDIO_VOICES } from './catalog-qwen-voices.ts'

const price = (input: number): MediaPrice => {
  const tokenRates = { input, output: 12 }
  return {
    currency: 'CNY',
    tokenRates,
    // Next 当前文档只返回 duration；缺少任一 Token 计量时金额未知，不按时长推算。
    cost: (u) =>
      u.inputTokens === undefined || u.outputTokens === undefined
        ? null
        : (u.inputTokens * tokenRates.input + u.outputTokens * tokenRates.output) / 1e6,
  }
}
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
const volume: MediaParamSpec = {
  name: 'volume',
  label: '音量',
  type: 'integer',
  min: 0,
  max: 100,
  default: 50,
  advanced: true,
  description: '音量',
}
const rate: MediaParamSpec = {
  name: 'rate',
  label: '语速',
  type: 'number',
  min: 0.5,
  max: 2,
  default: 1,
  description: '语速倍数',
}
const watermark: MediaParamSpec = {
  name: 'enable_aigc_tag',
  label: '音频标识',
  type: 'boolean',
  default: false,
  advanced: true,
  description: '添加 AIGC 标识水印',
}
// Plus 按输入字符计价，每万字符 ¥1.4；接口未回报字符数时金额不明。
const plusPrice: MediaPrice = {
  currency: 'CNY',
  cost: (u) => (u.characters === undefined ? null : (u.characters / 10_000) * 1.4),
}
// 音色列表中 Plus 只有四个系统音色，使用列表之外的音色时接口返回 InvalidParameter。
const PLUS_VOICES = [
  'longanlingxin_v3.1',
  'xunanchuan_v3.1',
  'longanhuan_v3.1',
  'longanfengyue_v3.1',
]
const only = <T>(record: Record<string, T>) =>
  Object.fromEntries(Object.entries(record).filter(([id]) => PLUS_VOICES.includes(id)))
const plusVoice: MediaParamSpec = {
  name: 'voice',
  label: '音色',
  type: 'string',
  presets: PLUS_VOICES,
  valueLabels: only(QWEN_AUDIO_VOICES.valueLabels),
  valueDescriptions: only(QWEN_AUDIO_VOICES.valueDescriptions),
  valueSamples: only(QWEN_AUDIO_VOICES.valueSamples),
  default: 'longanhuan_v3.1',
  description: 'Plus 的系统音色，区分大小写',
}
// 系统音色区分大小写，不能沿用 Qwen3-TTS 的 Cherry 等音色。
const flashVoice: MediaParamSpec = {
  name: 'voice',
  label: '音色',
  type: 'string',
  ...QWEN_AUDIO_VOICES,
  default: 'longanhuan_v3.1',
  description:
    '3.1 系统音色，区分大小写；多语种与方言优先选 longanhuan、longanlingxin、longanfengyue 或 xunanchuan 的 v3.1 音色',
}
/** Flash 与 Plus 使用同一端点与同一组参数，只有音色列表不同。 */
const ttsParams = (voice: MediaParamSpec): MediaParamSpec[] => [
  voice,
  {
    name: 'instruction',
    label: '朗读要求',
    advanced: true,
    type: 'string',
    maxLength: 1000,
    description: '用自然语言指定情绪、方言或角色；情绪标签也可直接写入正文',
  },
  // 当前提供可直接播放的封装格式，不提供裸 PCM。
  choice('format', '输出格式', ['mp3', 'wav', 'opus'], 'mp3'),
  {
    ...choice('sample_rate', '采样率', [8000, 12000, 16000, 22050, 24000, 44100, 48000], 22050),
    advanced: true,
    rules: [
      {
        when: { params: { format: ['opus'] } },
        values: [8000, 12000, 16000, 24000, 48000],
        default: 24000,
      },
    ],
  },
  volume,
  rate,
  {
    name: 'pitch',
    label: '音调',
    type: 'number',
    min: 0.5,
    max: 2,
    default: 1,
    advanced: true,
    description: '音调倍数',
  },
  {
    name: 'bit_rate',
    label: '码率',
    type: 'integer',
    min: 6,
    max: 510,
    default: 32,
    advanced: true,
    available: false,
    rules: [{ when: { params: { format: ['opus'] } }, available: true }],
    description: 'Opus 码率，单位 kbps',
  },
  {
    name: 'seed',
    label: '随机种子',
    type: 'integer',
    min: 0,
    max: 65535,
    default: 0,
    advanced: true,
    description: '固定种子可复现相同条件下的合成结果',
  },
  watermark,
]

const nextParams: MediaParamSpec[] = [
  // 产品统一默认 MP3；接口本身默认 WAV，适配器须显式发送此值。
  choice('format', '输出格式', ['mp3', 'wav'], 'mp3'),
  { ...choice('sample_rate', '采样率', [8000, 16000, 24000, 44100, 48000], 48000), advanced: true },
  { ...choice('channels', '声道', [1, 2], 2), valueLabels: { 1: '单声道', 2: '双声道' } },
  volume,
  rate,
  {
    name: 'enable_cbr',
    label: '恒定码率',
    type: 'boolean',
    default: false,
    advanced: true,
    available: false,
    rules: [{ when: { params: { format: ['mp3'] } }, available: true }],
    description: '仅 MP3 可用；关闭时为可变码率',
  },
  {
    name: 'bit_rate',
    label: '码率',
    type: 'integer',
    min: 8,
    max: 320,
    default: 128,
    advanced: true,
    available: false,
    rules: [
      { when: { params: { format: ['mp3'], enable_cbr: [true] } }, available: true },
      { when: { params: { sample_rate: [8000] } }, min: 8, max: 64, default: 64 },
      { when: { params: { sample_rate: [16000, 24000] } }, min: 8, max: 160 },
      { when: { params: { sample_rate: [44100, 48000] } }, min: 32, max: 320 },
    ],
    description: 'MP3 恒定码率，单位 kbps；实际输出受编码档位约束',
  },
  {
    name: 'quality',
    label: '编码质量',
    type: 'integer',
    min: 0,
    max: 9,
    default: 5,
    advanced: true,
    available: false,
    rules: [{ when: { params: { format: ['mp3'], enable_cbr: [false] } }, available: true }],
    description: '仅 MP3 可变码率可用，0 为最高质量',
  },
  {
    name: 'seed',
    label: '随机种子',
    type: 'integer',
    default: 42,
    advanced: true,
    description: '请求级别随机种子',
  },
  watermark,
]

export const QWEN_AUDIO_MODELS: readonly MediaModelSpec[] = [
  {
    id: 'qwen-audio-3.1-tts-flash',
    displayName: 'Qwen Audio 3.1 TTS Flash',
    vendor: '阿里云',
    kind: 'dashscope_speech',
    operations: ['speech'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: ttsParams(flashVoice),
    speechFormat: 'qwen-audio-tts',
    price: price(1.5),
    catalogued: true,
  },
  {
    id: 'qwen-audio-3.1-tts-plus',
    displayName: 'Qwen Audio 3.1 TTS Plus',
    vendor: '阿里云',
    kind: 'dashscope_speech',
    operations: ['speech'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: ttsParams(plusVoice),
    speechFormat: 'qwen-audio-tts',
    price: plusPrice,
    catalogued: true,
  },
  {
    id: 'qwen-audio-3.1-tts-next',
    displayName: 'Qwen Audio 3.1 TTS Next',
    vendor: '阿里云',
    kind: 'dashscope_speech',
    operations: ['speech'],
    maxPromptLength: 3000,
    inputs: {
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 3,
      audioMimeTypes: ['audio/wav', 'audio/mpeg', 'audio/ogg'],
      maxAudioBytes: 10 * 1024 * 1024,
      transport: 'json',
    },
    params: nextParams,
    speechFormat: 'qwen-audio-next',
    mention: { audio: '@voice{n}' },
    price: price(6),
    catalogued: true,
  },
]
