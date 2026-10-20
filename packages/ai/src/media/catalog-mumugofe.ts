/**
 * Mumugofe 渠道使用 /v1/videos 提交，素材通过 JSON 字段传递。
 * seedance2.5-V 参考图通过本渠道上传；007 按次型号直接发送 base64 图片与 MP3 音频。
 * 保留渠道原始编号，不继承官方 Seedance 的素材格式或价格。
 */
import type { MediaModelSpec, MediaParamSpec } from './catalog.ts'

const SIZE: MediaParamSpec = {
  name: 'size',
  label: '尺寸',
  type: 'string',
  shapes: [
    { ratio: '16:9', tier: '720P', value: '1280x720' },
    { ratio: '9:16', tier: '720P', value: '720x1280' },
  ],
  default: '1280x720',
  description: '720P 横屏 1280x720 或竖屏 720x1280',
}

const SECONDS: MediaParamSpec = {
  name: 'seconds',
  label: '时长',
  type: 'enum',
  values: Array.from({ length: 27 }, (_, i) => String(i + 4)),
  valueLabels: Object.fromEntries(Array.from({ length: 27 }, (_, i) => [i + 4, `${i + 4}秒`])),
  default: '5',
  description: '4–30 秒整数，使用字符串',
}

const FIXED_SECONDS: MediaParamSpec = {
  name: 'seconds',
  label: '时长',
  type: 'enum',
  values: ['30'],
  valueLabels: { '30': '30秒' },
  default: '30',
  description: '固定 30 秒，使用字符串 "30"',
}

export const MUMUGOFE_MODELS: readonly MediaModelSpec[] = [
  {
    id: 'seedance2.5-V',
    displayName: 'seedance2.5-V',
    vendor: 'Mumugofe',
    kind: 'openai_videos',
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video'],
    inputs: { maxImages: 30, maxVideos: 0, maxAudios: 0, transport: 'json', publicUrls: true },
    params: [
      {
        ...SECONDS,
        values: Array.from({ length: 26 }, (_, i) => String(i + 5)),
        valueLabels: Object.fromEntries(
          Array.from({ length: 26 }, (_, i) => [i + 5, `${i + 5}秒`]),
        ),
        description: '5–30 秒整数，使用字符串',
      },
      SIZE,
    ],
    price: { currency: 'CNY', cost: () => 7.5, usageOf: () => ({}) },
    catalogued: true,
  },
  {
    id: '007系列/sd2.5(30图10音/4-30秒/720P)',
    displayName: '007系列/sd2.5(30图10音/4-30秒/720P)',
    vendor: 'Mumugofe',
    kind: 'openai_videos',
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video'],
    inputs: { maxImages: 30, maxVideos: 0, maxAudios: 10, transport: 'json' },
    params: [SECONDS, SIZE],
    price: { currency: 'CNY', cost: () => 6, usageOf: () => ({}) },
    catalogued: true,
  },
]

/** 已从内置模型库下架；旧配置和已提交任务仍按原协议解析，避免取回改走通用端点。 */
export const MUMUGOFE_RETIRED_MODELS: readonly MediaModelSpec[] = [
  {
    id: '专享sd2.5(30图10音/4-30秒/720p)',
    displayName: '专享 SD2.5 · 720P · 4–30秒',
    vendor: 'Mumugofe',
    kind: 'openai_videos',
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video'],
    inputs: { maxImages: 30, maxVideos: 0, maxAudios: 10, transport: 'json' },
    params: [SECONDS, SIZE],
    catalogued: false,
  },
  {
    id: '高质量sd2.5(满血全参/720P/按次)',
    displayName: '高质量 SD2.5 · 满血全参 · 720P',
    vendor: 'Mumugofe',
    kind: 'openai_videos',
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video', 'video_to_video'],
    inputs: { maxImages: 30, maxVideos: 10, maxAudios: 10, transport: 'json' },
    // 2026-10-12 实际接口以 HTTP 400 拒绝 15 秒并要求固定 30 秒，覆盖公开目录的 4–30 秒声明。
    params: [FIXED_SECONDS, SIZE],
    catalogued: false,
  },
]
