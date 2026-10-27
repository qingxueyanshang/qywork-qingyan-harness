/**
 * 小米 MiMo 语音合成 MiMo-V2.5-TTS 系列，2026-10-27 核对官方「语音合成」接口与使用指南。
 *
 * 经对话接口合成：朗读文本为 assistant 消息，`instructions` 为 user 消息，其余参数放入 `audio`。
 * 三个型号限时免费，官方未公布单价，目录不记单价。
 */
import type { MediaModelSpec, MediaParamSpec } from './catalog.ts'

const FORMAT: MediaParamSpec = {
  name: 'format',
  label: '格式',
  type: 'enum',
  values: ['wav', 'mp3'],
  default: 'wav',
  description: '输出音频格式',
}

const INSTRUCTIONS: MediaParamSpec = {
  name: 'instructions',
  type: 'string',
  description: '语气、情绪、语速等朗读要求，使用中文或英文描述；不出现在合成语音中',
}

/** 协议默认与目录条目共用。 */
export const MIMO_SPEECH_DEFAULT: Omit<MediaModelSpec, 'id' | 'displayName'> = {
  vendor: null,
  kind: 'mimo_speech',
  operations: ['speech'],
  inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
  params: [INSTRUCTIONS, FORMAT],
  catalogued: false,
}

const model = (
  id: string,
  displayName: string,
  params: MediaParamSpec[],
  inputs: MediaModelSpec['inputs'] = MIMO_SPEECH_DEFAULT.inputs,
): MediaModelSpec => ({
  ...MIMO_SPEECH_DEFAULT,
  id,
  displayName,
  vendor: '小米',
  inputs,
  params,
  catalogued: true,
})

export const MIMO_AUDIO_MODELS: readonly MediaModelSpec[] = [
  model('mimo-v2.5-tts', 'MiMo V2.5 TTS', [
    {
      name: 'voice',
      label: '音色',
      type: 'enum',
      values: ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
      valueLabels: { mimo_default: 'MiMo-默认' },
      default: 'mimo_default',
      description: '内置音色；mimo_default 在国内集群为冰糖，其他集群为 Mia',
    },
    INSTRUCTIONS,
    FORMAT,
  ]),
  model('mimo-v2.5-tts-voicedesign', 'MiMo V2.5 TTS VoiceDesign', [
    {
      ...INSTRUCTIONS,
      description: '音色描述（必填），1 到 4 句，说明性别、年龄、音色与语气',
    },
    {
      name: 'optimize_text_preview',
      label: '文本润色',
      type: 'boolean',
      default: false,
      description: '由接口润色朗读文本',
    },
    FORMAT,
  ]),
  // 参考音频为复刻的声音样本，Base64 编码后不超过 10 MB。
  model('mimo-v2.5-tts-voiceclone', 'MiMo V2.5 TTS VoiceClone', [INSTRUCTIONS, FORMAT], {
    maxImages: 0,
    maxVideos: 0,
    maxAudios: 1,
    audioMimeTypes: ['audio/mpeg', 'audio/wav'],
    maxAudioBytes: Math.floor((10 * 1024 * 1024 * 3) / 4),
    transport: 'json',
  }),
]
