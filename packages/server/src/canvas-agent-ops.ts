/**
 * 大模型提交的画布操作在应用前后的核对与补全。只用于画布端口（大模型），界面的操作不经过这里。
 *
 * - 卡片名称在同一张画布中不能重复：大模型按名称引用卡片，名称重复时无法确定所指。
 * - 参数按所用模型的参数表核对，应用后再按卡片的输入与其他参数核对是否可用：不存在、不合法或不可用的取值
 *   整批拒绝并列出可选值。大模型写入的每个参数都会发送，也都显示在参数面板上。
 * - 尚无结果的生成卡按参数中的宽高比确定形状，排位时不必为横竖两种结果预留空间。
 */

import {
  activeMediaParams,
  blankBox,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasOp,
  displayNameOf,
  fitBox,
  type GenerateOutput,
  type MediaParamDefinition,
  mediaOperationFor,
  mediaParamProblem,
  mediaParamValues,
  ratioOf,
  resolveMediaParam,
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

/**
 * 应用之后核对本批写入的生成模型与参数。
 *
 * - 写入了服务商与模型的卡片，须是已配置的生成模型：未配置时查不到参数表，参数核对被跳过，
 *   参数面板也无法显示该模型与其参数。
 * - 参数在卡片实际的生成模式下可用。模式由批后的连线决定，取值还受其他参数约束
 *   （如 PNG 时没有压缩质量、有参考图时没有 4K）。画布只发送可用的参数，参数面板也只显示这些参数。
 *
 * 不成立时整批拒绝并说明原因。参数表本身的核对在 `prepareAgentOps` 中，那里尚无批后的连线。
 */
export function checkActiveParams(
  before: CanvasDoc,
  after: CanvasDoc,
  specsOf: ParamSpecsOf | undefined,
): void {
  if (!specsOf) return
  for (const node of after.nodes) {
    if (node.type !== 'generate') continue
    const old = before.nodes.find((n) => n.id === node.id)
    const prior = old?.type === 'generate' ? old : undefined
    const prev = prior?.params ?? {}
    const written = Object.keys(node.params).filter((k) => node.params[k] !== prev[k])
    const repicked = node.provider !== prior?.provider || node.model !== prior?.model
    if (!written.length && !repicked) continue
    const pick =
      node.provider && node.model ? { provider: node.provider, model: node.model } : undefined
    const specs = specsOf(node.output, pick)
    if (!specs) {
      throw new Error(
        pick
          ? `「${displayNameOf(node)}」的生成模型 ${pick.provider} / ${pick.model} 未配置：provider 与 model 取自本轮「可用的生成模型」中的同一行`
          : `「${displayNameOf(node)}」未指定生成模型，且没有默认的生成模型：provider 与 model 取自本轮「可用的生成模型」`,
      )
    }
    const roles = after.edges.filter((e) => e.to === node.id).map((e) => e.role)
    const operation = mediaOperationFor(node.output, roles)
    const refs = roles.filter((r) => r === 'reference').length
    const active = activeMediaParams(specs, operation, node.params, refs)
    for (const name of written) {
      if (name in active) continue
      const spec = specs.find((p) => p.name === name)
      if (!spec) continue
      const resolved = resolveMediaParam(spec, operation, mediaParamValues(specs, active), refs)
      const problem = mediaParamProblem(resolved, node.params[name]) ?? '与其他参数的取值冲突'
      throw new Error(
        `「${displayNameOf(node)}」的参数 ${name} 取值 ${JSON.stringify(node.params[name])} 在当前的输入与参数下不可用：${problem}`,
      )
    }
  }
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

/** 参数决定的卡片形状：取值能确定宽高比时按该比例，自动或无关时返回 `null`，保持缺省形状。 */
function shapeOf(
  output: GenerateOutput,
  params: Record<string, unknown>,
  specs: readonly MediaParamDefinition[],
): { w: number; h: number } | null {
  for (const spec of specs) {
    const ratio = ratioOf(spec, params[spec.name] ?? spec.default)
    if (!ratio || ratio === 'auto') continue
    const [w, h] = ratio.split(':').map(Number) as [number, number]
    const blank = blankBox(output)
    return fitBox({ w: Math.min(blank.w, blank.h), h: Math.min(blank.w, blank.h) }, { w, h })
  }
  return null
}
