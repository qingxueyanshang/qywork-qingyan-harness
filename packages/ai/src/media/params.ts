/**
 * 生成参数的本地校验，以及交给大模型的参数表文字。
 *
 * 校验必须在发请求之前：生成按次计费，字段名写错或值越界的一次请求要么被拒、要么按接口默认生成出
 * 一张不是想要的图，两种都已计费。退回的消息里带合法取值，大模型下一步就能自己改对。
 */

import type { MediaModelSpec, MediaOperation, MediaParamSpec } from './catalog.ts'

const OPERATION_LABEL: Record<MediaOperation, string> = {
  generate: '生成',
  edit: '修改',
  text_to_video: '文生视频',
  image_to_video: '首帧生视频',
  first_last_frame: '首尾帧生视频',
  reference_to_video: '参考图生视频',
  video_to_video: '参考视频（编辑、延长、参考）',
  speech: '语音合成',
}

/** 一个参数的取值说明，如「low | medium | high；默认 auto」。 */
export function describeParam(p: MediaParamSpec): string {
  const parts: string[] = []
  if (p.type === 'enum' && p.values) parts.push(p.values.join(' | '))
  else if (p.type === 'boolean') parts.push('true | false')
  else if (p.min !== undefined || p.max !== undefined) {
    parts.push(`${p.type === 'integer' ? '整数' : '数值'} ${p.min ?? ''}–${p.max ?? ''}`)
  } else parts.push(p.type === 'string' ? '字符串' : '数值')
  parts.push(p.description)
  if (p.operations) parts.push(`仅${p.operations.map((o) => OPERATION_LABEL[o]).join('、')}时有效`)
  if (p.default !== undefined) parts.push(`默认 ${String(p.default)}`)
  return `${p.name}：${parts.join('；')}`
}

/** 操作的中文名，给快照与错误消息用。 */
export function operationLabel(op: MediaOperation): string {
  return OPERATION_LABEL[op]
}

/**
 * 按目录校验一次调用。返回问题清单，空数组 = 可以发。
 *
 * 不补默认值、不改写取值：参数原样发给接口，接口的默认由接口决定。
 */
export function validateMediaCall(
  spec: MediaModelSpec,
  operation: MediaOperation,
  params: Record<string, unknown>,
  counts: { images: number; videos: number },
): string[] {
  const problems: string[] = []
  if (!spec.operations.includes(operation)) {
    problems.push(
      `${spec.id} 不支持${OPERATION_LABEL[operation]}；它支持：${spec.operations.map((o) => OPERATION_LABEL[o]).join('、')}`,
    )
  }
  if (counts.images > spec.inputs.maxImages) {
    problems.push(
      `${spec.id} 最多收 ${spec.inputs.maxImages} 张参考图，这次给了 ${counts.images} 张`,
    )
  }
  if (counts.videos > spec.inputs.maxVideos) {
    problems.push(
      `${spec.id} 最多收 ${spec.inputs.maxVideos} 个参考视频，这次给了 ${counts.videos} 个`,
    )
  }
  const known = new Map(spec.params.map((p) => [p.name, p]))
  for (const [name, value] of Object.entries(params)) {
    const p = known.get(name)
    if (!p) {
      problems.push(
        `${spec.id} 没有参数 ${name}；可用：${spec.params.map((q) => q.name).join('、') || '（无）'}`,
      )
      continue
    }
    if (p.operations && !p.operations.includes(operation)) {
      problems.push(
        `参数 ${name} 只在${p.operations.map((o) => OPERATION_LABEL[o]).join('、')}时有效`,
      )
      continue
    }
    const bad = checkValue(p, value)
    if (bad) problems.push(`参数 ${name} 的值 ${JSON.stringify(value)} 不合法：${bad}`)
  }
  return problems
}

/** 值不合法时回一句合法取值，合法回 null。 */
function checkValue(p: MediaParamSpec, value: unknown): string | null {
  switch (p.type) {
    case 'enum':
      return p.values?.includes(value as string | number) ? null : `可选 ${p.values?.join(' | ')}`
    case 'boolean':
      return typeof value === 'boolean' ? null : '要 true 或 false'
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '要一个数'
      if (p.type === 'integer' && !Number.isInteger(value)) return '要整数'
      if ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max)) {
        return `范围 ${p.min ?? ''}–${p.max ?? ''}`
      }
      return null
    }
    case 'string':
      if (typeof value !== 'string') return '要字符串'
      if (p.pattern && !new RegExp(p.pattern).test(value)) return p.description
      return null
  }
}
