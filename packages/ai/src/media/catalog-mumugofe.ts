/**
 * Mumugofe 渠道：2026-10-10 实测 /v1/videos 提交、查询、下载与视频解码。
 * 渠道插件目录声明 30 张参考图、横竖屏；已完成单图参考与竖屏成片验证。
 * 独立请求已验证视频参考的动作生效；内置适配器尚未接通音视频输入，音色参考效果仍未确认。
 * 保留渠道原始编号，不继承官方 Seedance 的素材格式或价格。
 */
import type { MediaModelSpec } from './catalog.ts'

export const MUMUGOFE_MODELS: readonly MediaModelSpec[] = [
  {
    id: '满血sd2.5(30-10-10原生过人脸/720P)',
    displayName: '满血 SD2.5 · 720P · 30秒',
    vendor: 'Mumugofe',
    kind: 'openai_videos',
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video'],
    inputs: { maxImages: 30, maxVideos: 0, maxAudios: 0, transport: 'json' },
    params: [
      {
        name: 'seconds',
        label: '时长',
        type: 'enum',
        values: ['30'],
        valueLabels: { '30': '30秒' },
        default: '30',
        description: '固定 30 秒，使用字符串 "30"',
      },
      {
        name: 'size',
        label: '尺寸',
        type: 'string',
        shapes: [
          { ratio: '16:9', tier: '720P', value: '1280x720' },
          { ratio: '9:16', tier: '720P', value: '720x1280' },
        ],
        default: '1280x720',
        description: '720P 横屏 1280x720 或竖屏 720x1280',
      },
    ],
    catalogued: true,
  },
]
