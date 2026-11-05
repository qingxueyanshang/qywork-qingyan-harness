/**
 * 按计费单位计价：云端的生成型号以「计费单位 + 单价」售卖，计量由请求参数决定，与上游的计费口径无关。
 *
 * 计量参数按协议写明（`catalog.ts` 的 `METER_PARAMS`）：协议决定请求形状，同一协议的张数、时长与分辨率参数名相同。
 * 型号的参数表中没有该参数时：张数按 1，时长与档位不明。音频的字符数按提示词的字符计。
 * 云端结算、后台上架校验与电脑端发送前的报价（云端规格的 `price`）都经 `meterFromParams`，三处口径一致。
 */

import type { MediaKind, MediaOutput, MediaUnit, StoredMediaSpec, UnitPrice } from '@qywork/core'
import { lookupMediaModel, meterFromParams, meterParamsOf } from './catalog.ts'

export { MEDIA_UNITS, type MediaUnit, type UnitPrice } from '@qywork/core'

/** 各类别可选的计费单位，第一项为默认值。 */
export const UNITS_BY_OUTPUT: Readonly<Record<MediaOutput, readonly MediaUnit[]>> = {
  image: ['image'],
  video: ['second', 'request'],
  audio: ['10k_chars', 'request'],
}

/** 一次生成的计量：计费单位的数量，以及按档位定价时的档位。 */
export interface UnitMeter {
  units: number
  resolution?: string
}

interface MeteredModel {
  id: string
  kind: MediaKind
  spec?: StoredMediaSpec
}

/** 按参数推算计量，无法确定时返回 null（见 `meterFromParams`）。 */
export function meterMedia(
  model: MeteredModel,
  unit: MediaUnit,
  price: UnitPrice,
  request: { params: Record<string, unknown>; prompt: string },
): UnitMeter | null {
  const spec = lookupMediaModel(model.id, model.kind, model.spec)
  return meterFromParams(spec, model.kind, unit, price, request.params, request.prompt)
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
  const p = meterParamsOf(lookupMediaModel(model.id, model.kind, model.spec), model.kind)
  if (unit === 'second' && !p.seconds) return '该型号没有时长参数，不能按秒计费'
  if (typeof price !== 'number') {
    if (!p.resolution) return '该型号没有分辨率参数，不能按档位定价'
    const values = p.resolution.values ?? []
    const missing = values.filter((v) => price[String(v)] === undefined)
    if (missing.length) return `缺少分辨率档位的单价：${missing.join('、')}`
  }
  return null
}
