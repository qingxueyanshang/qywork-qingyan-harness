/**
 * 大模型提交的画布操作在应用前的核对与补全。只用于画布端口（大模型），界面的操作不经过这里。
 *
 * - 卡片名称在同一张画布中不能重复：大模型按名称引用卡片，名称重复时无法确定所指。
 * - 参数按所用模型的参数表核对：不存在的参数、不合法的取值整批拒绝并列出可选值，不在运行时静默丢弃。
 * - 尚无结果的生成卡按参数中的宽高比确定形状，排位时不必为横竖两种结果预留空间。
 */

import {
  blankBox,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasOp,
  displayNameOf,
  fitBox,
  type GenerateOutput,
  type MediaParamDefinition,
  mediaParamProblem,
  ratioOf,
} from '@qywork/core'

export type ParamSpecsOf = (
  output: GenerateOutput,
  pick: { provider: string; model: string } | undefined,
) => readonly MediaParamDefinition[] | undefined

/** 核对并返回补全后的操作；不成立时抛出 `Error`，消息原样交给大模型。 */
export function prepareAgentOps(
  doc: CanvasDoc,
  ops: readonly CanvasOp[],
  specsOf: ParamSpecsOf | undefined,
): CanvasOp[] {
  const taken = new Set(doc.nodes.map(displayNameOf))
  const out: CanvasOp[] = []
  for (const op of ops) {
    if (op.op === 'add_file' || op.op === 'add_generate' || op.op === 'add_timeline') {
      if (op.name !== undefined) {
        if (taken.has(op.name)) {
          throw new Error(`名称「${op.name}」已被另一张卡使用：同一张画布中的卡片名称不能重复`)
        }
        taken.add(op.name)
      }
    }
    if (op.op === 'add_generate') {
      const pick = op.provider && op.model ? { provider: op.provider, model: op.model } : undefined
      const specs = specsOf?.(op.output, pick)
      const label = op.name ?? '新卡'
      if (op.params && specs) checkParams(label, op.params, specs)
      const shape =
        op.w === undefined && op.h === undefined && specs
          ? shapeOf(op.output, op.params ?? {}, specs)
          : null
      out.push(shape ? { ...op, ...shape } : op)
      continue
    }
    if (op.op === 'update') {
      const node = doc.nodes.find((n) => n.id === op.id || displayNameOf(n) === op.id)
      if (op.name && node && displayNameOf(node) !== op.name && taken.has(op.name)) {
        throw new Error(`名称「${op.name}」已被另一张卡使用：同一张画布中的卡片名称不能重复`)
      }
      if (op.params && node?.type === 'generate') {
        out.push(updateWithShape(op, node, specsOf))
        continue
      }
    }
    out.push(op)
  }
  return out
}

/** 修改参数时核对取值；卡片尚无结果且未给出框时，按新参数的宽高比改变形状。 */
function updateWithShape(
  op: Extract<CanvasOp, { op: 'update' }>,
  node: CanvasGenerateNode,
  specsOf: ParamSpecsOf | undefined,
): CanvasOp {
  const provider = op.provider === undefined ? node.provider : (op.provider ?? undefined)
  const model = op.model === undefined ? node.model : (op.model ?? undefined)
  const specs = specsOf?.(node.output, provider && model ? { provider, model } : undefined)
  if (!specs || !op.params) return op
  checkParams(node.name, op.params, specs)
  if (node.versions.length > 0 || op.w !== undefined || op.h !== undefined) return op
  const shape = shapeOf(node.output, op.params, specs)
  return shape ? { ...op, ...fitBox(node, shape) } : op
}

function checkParams(
  label: string,
  params: Record<string, unknown>,
  specs: readonly MediaParamDefinition[],
): void {
  for (const [name, value] of Object.entries(params)) {
    const spec = specs.find((p) => p.name === name)
    if (!spec) {
      throw new Error(
        `「${label}」的参数 ${name} 不存在。可用参数：${specs.map((p) => p.name).join('、')}`,
      )
    }
    const problem = mediaParamProblem(spec, value)
    if (problem) {
      throw new Error(`「${label}」的参数 ${name} 取值 ${JSON.stringify(value)} 不合法：${problem}`)
    }
  }
}

/**
 * 参数决定的卡片形状：取值能确定宽高比时按该比例，自动或无关时返回 `null`，保持缺省形状。
 * 带对照表的尺寸参数取值不在表中时（如 1024x1536），按取值中的像素宽高计算：大模型常填写表外的常用尺寸。
 */
function shapeOf(
  output: GenerateOutput,
  params: Record<string, unknown>,
  specs: readonly MediaParamDefinition[],
): { w: number; h: number } | null {
  for (const spec of specs) {
    const value = params[spec.name] ?? spec.default
    const pixels = spec.shapes && typeof value === 'string' ? /^(\d+)[x*](\d+)$/.exec(value) : null
    const ratio = ratioOf(spec, value) ?? (pixels ? `${pixels[1]}:${pixels[2]}` : null)
    if (!ratio || ratio === 'auto') continue
    const [w, h] = ratio.split(':').map(Number) as [number, number]
    const blank = blankBox(output)
    return fitBox({ w: Math.min(blank.w, blank.h), h: Math.min(blank.w, blank.h) }, { w, h })
  }
  return null
}
