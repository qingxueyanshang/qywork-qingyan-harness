/**
 * 按计费单位计价：云端的生成型号以「计费单位 + 单价」售卖，计量由请求参数决定，与上游的计费口径无关。
 *
 * 计量参数按协议写明（`METER_PARAMS`）：协议决定请求形状，同一协议的张数、时长与分辨率参数名相同。
 * 型号的参数表中没有该参数时：张数按 1，时长与档位不明。音频的字符数按提示词的字符计。
 * 云端结算、后台上架校验与电脑端发送前的报价都调用本文件，三处口径一致。
 */

import type { MediaKind, MediaOutput, StoredMediaSpec } from '@qywork/core'
import { lookupMediaModel } from './catalog.ts'

export const MEDIA_UNITS = ['image', 'second', 'request', '10k_chars'] as const
export type MediaUnit = (typeof MEDIA_UNITS)[number]

/** 各类别可选的计费单位，第一项为默认值。 */
export const UNITS_BY_OUTPUT: Readonly<Record<MediaOutput, readonly MediaUnit[]>> = {
  image: ['image'],
  video: ['second', 'request'],
  audio: ['10k_chars', 'request'],
}

/** 单价：一个数，或按分辨率档位的「档位 → 单价」。 */
export type UnitPrice = number | Readonly<Record<string, number>>

/** 一次生成的计量：计费单位的数量，以及按档位定价时的档位。 */
export interface UnitMeter {
  units: number
  resolution?: string
}

/** 各协议中表示张数、时长（秒）与分辨率档位的参数名。 */
const METER_PARAMS: Readonly<
  Record<MediaKind, { count?: string; seconds?: string; resolution?: string }>
> = {
  openai_images: { count: 'n', resolution: 'resolution' },
  dashscope_images: { count: 'n' },
  gemini_images: { resolution: 'image_size' },
  xai_images: { count: 'n', resolution: 'resolution' },
  minimax_images: { count: 'n' },
  openai_videos: { seconds: 'seconds', resolution: 'resolution' },
  ark_videos: { seconds: 'duration', resolution: 'resolution' },
  dashscope_videos: { seconds: 'duration', resolution: 'resolution' },
  kling_videos: { seconds: 'duration', resolution: 'resolution' },
  gemini_videos: { resolution: 'resolution' },
  veo_videos: { seconds: 'durationSeconds', resolution: 'resolution' },
  xai_videos: { seconds: 'duration', resolution: 'resolution' },
  minimax_videos: { seconds: 'duration', resolution: 'resolution' },
  openai_speech: {},
  dashscope_speech: {},
  minimax_speech: {},
  mimo_speech: {},
}

interface MeteredModel {
  id: string
  kind: MediaKind
  spec?: StoredMediaSpec
}

/** 该型号作为计量参数的参数表：参数名与默认值。型号没有的参数不出现。 */
function meterParams(model: MeteredModel) {
  const spec = lookupMediaModel(model.id, model.kind, model.spec)
  const names = METER_PARAMS[model.kind]
  const param = (name: string | undefined) =>
    name === undefined ? undefined : spec.params.find((p) => p.name === name)
  return {
    count: param(names.count),
    seconds: param(names.seconds),
    resolution: param(names.resolution),
  }
}

/**
 * 按参数推算计量。无法确定时返回 null：按秒计费而型号没有时长参数、按档位定价而没有档位参数或档位不在单价表中。
 * 参数未填写时取型号的默认值。`prompt` 只用于按字符计费。
 */
export function meterMedia(
  model: MeteredModel,
  unit: MediaUnit,
  price: UnitPrice,
  request: { params: Record<string, unknown>; prompt: string },
): UnitMeter | null {
  const p = meterParams(model)
  const value = (param: { name: string; default?: unknown } | undefined) =>
    param === undefined ? undefined : (request.params[param.name] ?? param.default)
  let resolution: string | undefined
  if (typeof price !== 'number') {
    const v = value(p.resolution)
    if (v === undefined || price[String(v)] === undefined) return null
    resolution = String(v)
  }
  let units: number
  if (unit === 'request') units = 1
  else if (unit === 'image') units = p.count ? Number(value(p.count) ?? 1) : 1
  else if (unit === 'second') units = Number(value(p.seconds))
  else units = Array.from(request.prompt).length / 10_000
  if (!Number.isFinite(units) || units <= 0) return null
  return { units, ...(resolution !== undefined ? { resolution } : {}) }
}

/** 计量对应的金额，单位与单价相同。 */
export function unitAmount(price: UnitPrice, meter: UnitMeter): number {
  const rate = typeof price === 'number' ? price : price[meter.resolution ?? '']
  return rate === undefined ? 0 : rate * meter.units
}

/**
 * 型号能否按该计费单位与单价上架。不能时返回原因：计费单位与类别不符、按秒计费而型号没有时长参数、
 * 按档位定价而型号没有分辨率参数，或单价表缺少型号可选的档位（缺少的档位在请求时无法计价）。
 */
export function unitProblem(
  model: MeteredModel,
  output: MediaOutput,
  unit: MediaUnit,
  price: UnitPrice,
): string | null {
  if (!UNITS_BY_OUTPUT[output].includes(unit)) return '计费单位与类别不符'
  const p = meterParams(model)
  if (unit === 'second' && !p.seconds) return '该型号没有时长参数，不能按秒计费'
  if (typeof price !== 'number') {
    if (!p.resolution) return '该型号没有分辨率参数，不能按档位定价'
    const values = p.resolution.values ?? []
    const missing = values.filter((v) => price[String(v)] === undefined)
    if (missing.length) return `缺少分辨率档位的单价：${missing.join('、')}`
  }
  return null
}
