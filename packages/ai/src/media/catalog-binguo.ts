/** 集梦仅收录 Seedance 2.5 720p，渠道编号不映射为官方型号。 */
import type { MediaModelSpec, MediaParamSpec } from './catalog.ts'

const videoParams = (min: number, max: number): MediaParamSpec[] => [
  {
    name: 'duration',
    label: '时长',
    type: 'integer',
    min,
    max,
    default: 5,
    description: '生成时长（秒）',
  },
  {
    name: 'aspect_ratio',
    label: '宽高比',
    type: 'enum',
    values: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    default: '16:9',
    description: '输出视频的宽高比',
  },
]

export const BINGUO_DEFAULTS: Record<
  'binguo_videos',
  Omit<MediaModelSpec, 'id' | 'displayName'>
> = {
  binguo_videos: {
    vendor: '集梦',
    kind: 'binguo_videos',
    operations: ['text_to_video'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: videoParams(5, 5),
    catalogued: false,
    price: { currency: 'BINGUO_CREDIT', cost: () => null },
  },
}

// 金额只读取终态任务的 cost，不用静态价目推算实扣。
export const BINGUO_MODELS: readonly MediaModelSpec[] = [
  {
    ...BINGUO_DEFAULTS.binguo_videos,
    id: 'Seedance 2.5 720p',
    displayName: 'Seedance 2.5 720p',
    catalogued: true,
    operations: ['text_to_video', 'reference_to_video', 'video_to_video'],
    inputs: { maxImages: 30, maxVideos: 10, maxAudios: 10, transport: 'json' },
    params: videoParams(5, 30),
  },
]
