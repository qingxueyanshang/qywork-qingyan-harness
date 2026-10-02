/** 生成参数的声明与条件约束；目录、服务端校验和画布控件共用。 */
import type { MediaInputRole, MediaOutput } from './media.ts'

/** 从输入用途推导生成模式；素材组合是否合法仍由生成入口校验。 */
export function mediaOperationFor(output: MediaOutput, roles: readonly MediaInputRole[]) {
  if (output === 'image') return roles.length ? 'edit' : 'generate'
  if (output === 'audio') return 'speech'
  if (roles.includes('video')) return 'video_to_video'
  if (roles.includes('last_frame')) return 'first_last_frame'
  if (roles.includes('first_frame')) return 'image_to_video'
  return roles.includes('reference') ? 'reference_to_video' : 'text_to_video'
}

export type MediaParamValue = string | number | boolean

export interface MediaSizeLimits {
  minPixels: number
  maxPixels: number
  maxRatio: number
  maxSide?: number
  multiple?: number
  /** 接口支持的尺寸简写及其像素面积。 */
  tiers?: Readonly<Record<string, number>>
}

export interface MediaParamLimits {
  default?: MediaParamValue
  values?: readonly MediaParamValue[]
  min?: number
  max?: number
  sizeLimits?: MediaSizeLimits
  available?: boolean
}

export interface MediaParamDefinition extends MediaParamLimits {
  name: string
  label?: string
  type: 'enum' | 'integer' | 'number' | 'string' | 'boolean'
  auto?: number
  pattern?: string
  presets?: readonly string[]
  shapes?: readonly { ratio?: string; tier?: string; value?: string }[]
  default?: MediaParamValue
  operations?: readonly string[]
  advanced?: boolean
  maxLength?: number
  /** 所有条件同时满足才收紧限制；未填参数按目录缺省值判断。 */
  rules?: readonly (MediaParamLimits & {
    when: {
      operations?: readonly string[]
      params?: Readonly<Record<string, readonly MediaParamValue[]>>
      imageCount?: number
    }
  })[]
}

export function mediaParamValues(
  specs: readonly MediaParamDefinition[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      specs.filter((p) => p.default !== undefined).map((p) => [p.name, p.default]),
    ),
    ...params,
  }
}

/** 只解析控件和约束，不改调用者的参数、不向请求补默认值。 */
export function resolveMediaParam<T extends MediaParamDefinition>(
  spec: T,
  operation: string,
  values: Record<string, unknown>,
  imageCount = 0,
): T {
  let result = spec
  for (const { when, ...limits } of spec.rules ?? []) {
    if (when.imageCount !== undefined && when.imageCount !== imageCount) continue
    if (when.operations && !when.operations.includes(operation)) continue
    if (
      when.params &&
      !Object.entries(when.params).every(([key, allowed]) =>
        allowed.includes(values[key] as MediaParamValue),
      )
    )
      continue
    result = { ...result, ...limits }
  }
  if (spec.operations && !spec.operations.includes(operation))
    result = { ...result, available: false }
  if (result.shapes && result.sizeLimits) {
    result = {
      ...result,
      shapes: result.shapes.filter(
        (s) => s.value === undefined || mediaSizeProblem(s.value, result.sizeLimits!) === null,
      ),
    }
  }
  return result
}

export function mediaSizeProblem(value: string, limits: MediaSizeLimits): string | null {
  if (value === 'auto') return null
  const tier = limits.tiers?.[value]
  if (tier !== undefined)
    return tier <= limits.maxPixels && tier >= limits.minPixels
      ? null
      : '当前生成模式不支持这个分辨率档位'
  const match = /^(\d+)[x*](\d+)$/.exec(value)
  if (!match) return '尺寸格式不合法'
  const w = Number(match[1])
  const h = Number(match[2])
  if (!(w > 0 && h > 0) || w * h < limits.minPixels || w * h > limits.maxPixels)
    return `总像素须在 ${limits.minPixels}–${limits.maxPixels} 之间`
  if (Math.max(w / h, h / w) > limits.maxRatio) return `长宽比不能超过 ${limits.maxRatio}:1`
  if (limits.maxSide && Math.max(w, h) > limits.maxSide) return `单边不能超过 ${limits.maxSide}`
  if (limits.multiple && (w % limits.multiple || h % limits.multiple))
    return `宽高须为 ${limits.multiple} 的倍数`
  return null
}

/** 返回用户能直接修正的错误；空值通过删除参数来表达，不把空串或 NaN 发给接口。 */
export function mediaParamProblem(p: MediaParamDefinition, value: unknown): string | null {
  if (p.available === false) return '当前生成模式或参数组合不支持此参数'
  if (p.values && !p.values.includes(value as MediaParamValue))
    return `可选 ${p.values.join(' | ')}`
  if (p.type === 'boolean') return typeof value === 'boolean' ? null : '要 true 或 false'
  if (p.type === 'enum') return p.values ? null : '缺少可选值'
  if (p.type === 'integer' || p.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '要一个数'
    if (p.type === 'integer' && !Number.isInteger(value)) return '要整数'
    if (value === p.auto) return null
    if ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max))
      return `范围 ${p.min ?? ''}–${p.max ?? ''}${p.auto === undefined ? '' : `，或 ${p.auto}`}`
    return null
  }
  if (typeof value !== 'string') return '要字符串'
  if (p.maxLength !== undefined && Array.from(value).length > p.maxLength)
    return `最多 ${p.maxLength} 字`
  if (p.pattern && !new RegExp(p.pattern).test(value)) return '格式不合法'
  return p.sizeLimits ? mediaSizeProblem(value, p.sizeLimits) : null
}

/** 画布保存选择偏好，只发送当前模式允许的值；直接生成工具仍逐项报错。 */
export function activeMediaParams(
  specs: readonly MediaParamDefinition[],
  operation: string,
  params: Record<string, unknown>,
  imageCount = 0,
): Record<string, unknown> {
  let active = params
  // 每轮只会删键；某个偏好被隐藏后，其余参数再按实际缺省值校验。
  for (;;) {
    const values = mediaParamValues(specs, active)
    const next = Object.fromEntries(
      specs.flatMap((p) => {
        const value = active[p.name]
        return value !== undefined &&
          !mediaParamProblem(resolveMediaParam(p, operation, values, imageCount), value)
          ? [[p.name, value]]
          : []
      }),
    )
    if (Object.keys(next).length === Object.keys(active).length) return next
    active = next
  }
}
