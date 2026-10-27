/**
 * 中转渠道的视频与图像型号：渠道目录条目 → 配置中保存的规格（`ChannelVideoSpec`、`ChannelImageSpec`）→ 生成规格。
 *
 * 渠道格式（参数名、素材上传、提示词引用写法）在此处；型号名称、时长、画幅、素材上限与价格只来自拉取时的渠道目录，
 * 代码中不登记具体型号。目录字段缺失或取值不合法时返回 null，不补默认值：补出的上限会使画布开放渠道不接受的素材。
 */

import type { ChannelImageSpec, ChannelPrice, ChannelVideoSpec } from '@qywork/core'
import type { MediaModelSpec, MediaParamSpec, MediaPrice } from './catalog.ts'
import type { MediaUsage } from './types.ts'

const DURATION = /^(\d+)(?:\s*-\s*(\d+))?$/

function count(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isInteger(n) && (n as number) >= 0 ? (n as number) : null
}

function range(min: number, max: number): number[] {
  return min > 0 && max >= min ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : []
}

/**
 * hongcheng 工作台目录（`/api/workbench-models` 的 `data[]`）中的一条。
 * 时长写为「最小-最大」，固定时长只写一个数（如 `"30"`）；画幅为逗号分隔，三类素材上限为数字字符串。
 */
export function hongchengVideoSpec(entry: Record<string, unknown>): ChannelVideoSpec | null {
  const duration = typeof entry.duration === 'string' ? DURATION.exec(entry.duration.trim()) : null
  const seconds = duration ? range(Number(duration[1]), Number(duration[2] ?? duration[1])) : []
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

/**
 * 木木目录（`/docs/typetale-models.json` 的 `models[]`）中的一条视频型号。
 * 目录只给出参考图数量，参考视频与参考音频按 0 处理；`transport` 为 `public_urls` 时素材先上传到渠道，
 * 为 `multipart` 时参考图以表单文件随提交上传。
 */
export function mumugofeVideoSpec(entry: Record<string, unknown>): ChannelVideoSpec | null {
  if (entry.kind !== 'video' || entry.protocol !== 'video_v1') return null
  if (!['json', 'public_urls', 'multipart'].includes(entry.transport as string)) return null
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
    ...(entry.transport === 'multipart' ? { multipart: true as const } : {}),
  }
}

/**
 * 木木目录中的一条图像型号（`image_json_v1`）。目录给出最长边下限（`min_long_edge`）时去掉达不到下限的尺寸：
 * 渠道拒绝这些尺寸。
 */
export function mumugofeImageSpec(entry: Record<string, unknown>): ChannelImageSpec | null {
  if (entry.kind !== 'image' || entry.protocol !== 'image_json_v1' || entry.transport !== 'json')
    return null
  const resolutions = Array.isArray(entry.res)
    ? entry.res.filter((r): r is string => typeof r === 'string' && r !== '')
    : []
  const minEdge = count(entry.min_long_edge) ?? 0
  const sizes = Array.isArray(entry.sizes)
    ? entry.sizes.filter(
        (v): v is string =>
          typeof v === 'string' &&
          /^\d+x\d+$/.test(v) &&
          Math.max(...v.split('x').map(Number)) >= minEdge,
      )
    : []
  const maxImages = count(entry.refs)
  if (!resolutions.length || !sizes.length || maxImages === null) return null
  return { channel: 'mumugofe', resolutions, sizes, maxImages }
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

/**
 * `resolutionOf` 按请求参数取分辨率档位。按档位定价时计量须带档位：任务查询未取得档位时，
 * 账本中该次金额不明；发送前的报价按所选参数计算。
 */
function priceOf(
  price: ChannelPrice | undefined,
  resolutionOf: (params: Record<string, unknown>) => string | undefined,
): MediaPrice | undefined {
  if (!price) return undefined
  const { amount, currency } = price
  const rate = (u: MediaUsage) =>
    typeof amount === 'number'
      ? amount
      : u.resolution === undefined
        ? undefined
        : amount[u.resolution]
  const tier = (params: Record<string, unknown>): MediaUsage => {
    const resolution = resolutionOf(params)
    return resolution === undefined ? {} : { resolution }
  }
  return price.per === 'request'
    ? { currency, cost: (u) => rate(u) ?? null, usageOf: tier }
    : {
        currency,
        cost: (u) => {
          const r = rate(u)
          return u.seconds === undefined || r === undefined ? null : u.seconds * r
        },
        usageOf: (params) => ({ ...tier(params), seconds: Number(params.seconds) }),
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

/** 木木各分辨率档位、各画幅的像素尺寸，档位在前。 */
function mumugofeSizes(spec: ChannelVideoSpec) {
  return spec.resolutions.flatMap((resolution) =>
    spec.ratios.flatMap((ratio) => {
      const value = sizeFor(ratio, spec.sizes![resolution]!)
      return value ? [{ ratio, resolution, value }] : []
    }),
  )
}

function mumugofeParams(
  spec: ChannelVideoSpec,
  sizes: ReturnType<typeof mumugofeSizes>,
): MediaParamSpec[] {
  const shapes = sizes.map(({ ratio, resolution, value }) => ({
    ratio,
    tier: resolution.toUpperCase(),
    value,
  }))
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
  const sizes = hongcheng ? [] : mumugofeSizes(spec)
  const price = priceOf(spec.price, (params) =>
    hongcheng
      ? typeof params.resolution === 'string'
        ? params.resolution
        : undefined
      : sizes.find((s) => s.value === params.size)?.resolution,
  )
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
      transport: spec.multipart ? 'multipart' : 'json',
      ...(spec.publicUrls ? { publicUrls: true } : {}),
    },
    params: hongcheng ? hongchengParams(spec) : mumugofeParams(spec, sizes),
    ...(spec.resolutionField
      ? { resolutionBySize: Object.fromEntries(sizes.map((s) => [s.value, s.resolution])) }
      : {}),
    ...(hongcheng
      ? { mention: { image: '@Image{n}', video: '@Video{n}', audio: '@Audio{n}' } }
      : {}),
    ...(price ? { price } : {}),
    catalogued: true,
  }
}

/** 约分后的宽高比，如 `1536x1024` 为 `3:2`。 */
function ratioOf(size: string): string {
  const [w, h] = size.split('x').map(Number) as [number, number]
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(w, h)
  return `${w / g}:${h / g}`
}

/**
 * 保存的图像渠道规格对应的生成规格。只用于 `openai_images` 协议，请求结构为 mumugofe（`imageFormat`）：
 * 尺寸与分辨率档位分别发送，渠道按分辨率档位计价，每次生成一张。
 */
export function channelImageMediaSpec(id: string, spec: ChannelImageSpec): MediaModelSpec {
  const price = priceOf(spec.price, (params) =>
    typeof params.resolution === 'string' ? params.resolution : undefined,
  )
  return {
    id,
    displayName: id,
    vendor: 'Mumugofe',
    kind: 'openai_images',
    imageFormat: 'mumugofe',
    operations: spec.maxImages ? ['generate', 'edit'] : ['generate'],
    inputs: { maxImages: spec.maxImages, maxVideos: 0, transport: 'json' },
    params: [
      {
        name: 'size',
        label: '尺寸',
        type: 'string',
        shapes: spec.sizes.map((value) => ({ ratio: ratioOf(value), value })),
        default: spec.sizes[0]!,
        description: `宽x高，可选 ${spec.sizes.join('、')}`,
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
    ],
    ...(price ? { price } : {}),
    catalogued: true,
  }
}
