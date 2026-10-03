/**
 * 生成参数的本地校验，以及交给大模型的参数表文字。
 *
 * 校验必须在发请求之前：生成按次计费，字段名写错或值越界的一次请求要么被拒、要么按接口默认生成出
 * 一张不是想要的图，两种都已计费。退回的消息里带合法取值，大模型下一步就能自己改对。
 */

import { mediaParamProblem, mediaParamValues, resolveMediaParam } from '@qywork/core'
import type { MediaModelSpec, MediaOperation, MediaParamSpec } from './catalog.ts'

const OPERATION_LABEL: Record<MediaOperation, string> = {
  generate: '生成',
  edit: '修改',
  text_to_video: '文生视频',
  image_to_video: '首帧生视频',
  first_last_frame: '首尾帧生视频',
  reference_to_video: '参考素材生视频',
  video_to_video: '参考视频（编辑、延长、参考）',
  speech: '语音合成',
}

/** 一个参数的取值说明，如「low | medium | high；默认 auto」。 */
export function describeParam(p: MediaParamSpec): string {
  const parts: string[] = []
  if (p.type === 'enum' && p.values) parts.push(p.values.join(' | '))
  else if (p.type === 'boolean') parts.push('true | false')
  else if (p.min !== undefined || p.max !== undefined) {
    const auto = p.auto === undefined ? '' : ` 或 ${p.auto}`
    parts.push(`${p.type === 'integer' ? '整数' : '数值'} ${p.min ?? ''}–${p.max ?? ''}${auto}`)
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
  counts: {
    images: number
    videos: number
    audios?: number
    firstFrames?: number
    lastFrames?: number
  },
): string[] {
  const problems: string[] = []
  const first = counts.firstFrames ?? 0
  const last = counts.lastFrames ?? 0
  const audios = counts.audios ?? 0
  const values = mediaParamValues(spec.params, params)
  if (last && !first && !spec.inputs.lastFrameAlone) {
    problems.push('提供尾帧时必须同时提供首帧')
  }
  if (
    (first || last) &&
    (counts.images || counts.videos || audios) &&
    !spec.inputs.framesWithReferences &&
    !spec.inputs.combinations
  ) {
    problems.push('首尾帧不能与参考图、参考视频、参考音频同时提供')
  }
  if (audios && !counts.images && !counts.videos && spec.inputs.audioRequiresVisual) {
    problems.push('参考音频必须与参考图或参考视频同时提供')
  }
  if (spec.inputs.combinations) {
    const present = {
      first_frame: first,
      last_frame: last,
      reference: counts.images,
      video: counts.videos,
      audio: audios,
    }
    const allowed = spec.inputs.combinations.some(
      (combination) =>
        Object.entries(present).every(
          ([role, n]) => Boolean(n) === combination.roles.some((r) => r === role),
        ) &&
        (combination.maxImages === undefined || counts.images <= combination.maxImages) &&
        Object.entries(combination.params ?? {}).every(([key, value]) => values[key] === value),
    )
    if (!allowed) problems.push(`${spec.id} 不支持当前素材组合或数量`)
  }
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
  if ((counts.audios ?? 0) > (spec.inputs.maxAudios ?? 0)) {
    problems.push(
      spec.inputs.maxAudios
        ? `${spec.id} 最多收 ${spec.inputs.maxAudios} 段参考音频，这次给了 ${counts.audios} 段`
        : `${spec.id} 不收参考音频`,
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
    const bad = mediaParamProblem(resolveMediaParam(p, operation, values, counts.images), value)
    if (bad)
      problems.push(`参数 ${name} 的值 ${JSON.stringify(value)} 不合法：${bad}；${p.description}`)
  }
  return problems
}
