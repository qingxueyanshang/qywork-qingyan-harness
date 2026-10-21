/**
 * 中转渠道的视频型号：渠道目录条目 → 配置中保存的规格（`ChannelVideoSpec`）→ 生成规格。
 *
 * 渠道格式（参数名、素材上传、提示词引用写法）在此处；型号名称、时长、画幅、素材上限与价格只来自拉取时的渠道目录，
 * 代码中不登记具体型号。目录字段缺失或取值不合法时返回 null，不补默认值：补出的上限会使画布开放渠道不接受的素材。
 */

import type { ChannelPrice, ChannelVideoSpec } from '@qywork/core'
import type { MediaModelSpec, MediaParamSpec, MediaPrice } from './catalog.ts'

const RANGE = /^(\d+)\s*-\s*(\d+)$/

function count(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : null
}

function range(min: number, max: number): number[] {
  return min > 0 && max >= min ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : []
}

/**
 * hongcheng 工作台目录（`/api/workbench-models` 的 `data[]`）中的一条。
 * 时长写为「最小-最大」，画幅为逗号分隔，三类素材上限为数字字符串。
 */
export function hongchengVideoSpec(entry: Record<string, unknown>): ChannelVideoSpec | null {
  const duration = typeof entry.duration === 'string' ? RANGE.exec(entry.duration.trim()) : null
  const seconds = duration ? range(Number(duration[1]), Number(duration[2])) : []
  const ratios =
    typeof entry.aspect_ratios === 'string'
      ? entry.aspect_ratios
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : []
  const resolution = typeof entry.resolution === 'string' ? entry.resolution.trim() : ''
  const maxImages = count(entry.max_image_refs)
  const maxVideos = count(entry.max_video_refs)
  const maxAudios = count(entry.max_audio_refs)
  if (
    !seconds.length ||
    !ratios.length ||
    !resolution ||
    maxImages === null ||
    maxVideos === null ||
    maxAudios === null
  )
    return null
  return {
    channel: 'hongcheng',
    seconds,
    ratios,
    resolutions: [resolution],
    maxImages,
    maxVideos,
    maxAudios,
  }
}

/** 木木目录不支持的素材传递方式。`multipart` 需要另一种请求结构，当前格式未实现。 */
export type MumugofeUnsupported = { unsupported: string }

/**
 * 木木目录（`/docs/typetale-models.json` 的 `models[]`）中的一条视频型号。
 * 目录只给出参考图数量，参考视频与参考音频按 0 处理；`transport` 为 `public_urls` 时素材先上传到渠道。
 */
export function mumugofeVideoSpec(
  entry: Record<string, unknown>,
): ChannelVideoSpec | MumugofeUnsupported | null {
  if (entry.kind !== 'video' || entry.protocol !== 'video_v1') return null
  if (entry.transport === 'multipart') return { unsupported: '该型号按表单上传素材，当前未接入' }
  if (entry.transport !== 'json' && entry.transport !== 'public_urls') return null
  if (entry.duration_field !== 'seconds' || entry.duration_type !== 'string') return null
  if (entry.size_format !== 'pixels') return null
  const seconds = Array.isArray(entry.seconds)
    ? entry.seconds.filter((n): n is number => Number.isInteger(n) && n > 0)
    : range(count(entry.min) ?? 0, count(entry.max) ?? 0)
  const ratios = Array.isArray(entry.ratios)
    ? entry.ratios.filter((r): r is string => typeof r === 'string' && /^\d+:\d+$/.test(r))
    : []
  const resolutions = Array.isArray(entry.res)
    ? entry.res.filter((r): r is string => typeof r === 'string' && r !== '')
    : []
  const sizes: Record<string, [number, number]> = {}
  const dimensions = entry.dimensions as Record<string, unknown> | undefined
  for (const r of resolutions) {
    const d = dimensions?.[r]
    if (Array.isArray(d) && d.length === 2 && d.every((n) => Number.isInteger(n) && n > 0))
      sizes[r] = [d[0] as number, d[1] as number]
  }
  const maxImages = count(entry.refs)
  if (
    !seconds.length ||
    !ratios.length ||
    !resolutions.length ||
    Object.keys(sizes).length !== resolutions.length ||
    maxImages === null
  )
    return null
  return {
    channel: 'mumugofe',
    seconds: [...new Set(seconds)].sort((a, b) => a - b),
    ratios,
    resolutions,
    sizes,
    maxImages,
    maxVideos: 0,
    maxAudios: 0,
    ...(entry.transport === 'public_urls' ? { publicUrls: true as const } : {}),
  }
}

function secondsParam(seconds: readonly number[]): MediaParamSpec {
  const values = seconds.map(String)
  const first = seconds[0]!
  const last = seconds[seconds.length - 1]!
  const contiguous = last - first + 1 === seconds.length
  return {
    name: 'seconds',
    label: '时长',
    type: 'enum',
    values,
    valueLabels: Object.fromEntries(seconds.map((s) => [s, `${s}秒`])),
    default: values[0]!,
    description:
      seconds.length === 1
        ? `固定 ${first} 秒，使用字符串 "${first}"`
        : contiguous
          ? `${first}–${last} 秒整数，使用字符串`
          : `可选 ${values.join('、')} 秒，使用字符串`,
  }
}

function priceOf(price: ChannelPrice | undefined): MediaPrice | undefined {
  if (!price) return undefined
  const { amount, currency } = price
  return price.per === 'request'
    ? { currency, cost: () => amount, usageOf: () => ({}) }
    : {
        currency,
        cost: (u) => (u.seconds === undefined ? null : u.seconds * amount),
        usageOf: (params) => ({ seconds: Number(params.seconds) }),
      }
}

/**
 * 按横屏尺寸生成该宽高比的像素尺寸；与横屏、竖屏都不一致的比例返回 undefined。
 * 比较允许 1% 误差：480p 的 854x480 不是精确的 16:9。
 */
function sizeFor(ratio: string, [w, h]: [number, number]): string | undefined {
  const [a, b] = ratio.split(':').map(Number) as [number, number]
  const near = (x: number, y: number) => Math.abs(x / y - 1) < 0.01
  if (near(a / b, w / h)) return `${w}x${h}`
  if (near(a / b, h / w)) return `${h}x${w}`
  return undefined
}

function hongchengParams(spec: ChannelVideoSpec): MediaParamSpec[] {
  return [
    secondsParam(spec.seconds),
    {
      name: 'aspect_ratio',
      label: '画幅',
      type: 'string',
      shapes: spec.ratios.map((ratio) => ({ ratio, value: ratio })),
      default: spec.ratios[0]!,
      description: `支持 ${spec.ratios.join('、')}`,
    },
    {
      name: 'resolution',
      label: '分辨率',
      type: 'enum',
      values: spec.resolutions,
      default: spec.resolutions[0]!,
      description:
        spec.resolutions.length === 1
          ? `固定 ${spec.resolutions[0]}`
          : `可选 ${spec.resolutions.join('、')}`,
    },
  ]
}

function mumugofeParams(spec: ChannelVideoSpec): MediaParamSpec[] {
  const shapes = spec.resolutions.flatMap((r) =>
    spec.ratios.flatMap((ratio) => {
      const value = sizeFor(ratio, spec.sizes![r]!)
      return value ? [{ ratio, tier: r.toUpperCase(), value }] : []
    }),
  )
  return [
    secondsParam(spec.seconds),
    {
      name: 'size',
      label: '尺寸',
      type: 'string',
      shapes,
      default: shapes[0]!.value,
      description: `宽x高，可选 ${shapes.map((s) => s.value).join('、')}`,
    },
  ]
}

/** 保存的渠道规格对应的生成规格。只用于 `openai_videos` 协议：两个渠道都按该协议的任务接口提交与查询。 */
export function channelMediaSpec(id: string, spec: ChannelVideoSpec): MediaModelSpec {
  const hongcheng = spec.channel === 'hongcheng'
  const price = priceOf(spec.price)
  return {
    id,
    displayName: id,
    vendor: hongcheng ? 'hongcheng' : 'Mumugofe',
    kind: 'openai_videos',
    videoFormat: spec.channel,
    operations: [
      'text_to_video',
      ...(spec.maxImages || spec.maxAudios ? ['reference_to_video' as const] : []),
      ...(spec.maxVideos ? ['video_to_video' as const] : []),
    ],
    inputs: {
      maxImages: spec.maxImages,
      maxVideos: spec.maxVideos,
      maxAudios: spec.maxAudios,
      transport: 'json',
      ...(spec.publicUrls ? { publicUrls: true } : {}),
    },
    params: hongcheng ? hongchengParams(spec) : mumugofeParams(spec),
    ...(hongcheng
      ? { mention: { image: '@Image{n}', video: '@Video{n}', audio: '@Audio{n}' } }
      : {}),
    ...(price ? { price } : {}),
    catalogued: true,
  }
}
