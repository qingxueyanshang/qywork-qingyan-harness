/**
 * 大模型提交的画布操作在应用前后的核对与补全。只用于画布端口（大模型），界面的操作不经过这里。
 *
 * - 卡片名称在同一张画布中不能重复：大模型按名称引用卡片，名称重复时无法确定所指。
 * - 参数按所用模型的参数表核对，应用后再按卡片的输入与其他参数核对是否可用：不存在、不合法或不可用的取值
 *   整批拒绝并列出可选值。大模型写入的每个参数都会发送，也都显示在参数面板上。
 * - 大模型读取的画布中，生成卡的参数为实际发送的参数（`agentView`），与参数面板的显示一致。
 * - 尚无结果的生成卡按参数中的宽高比确定形状，排位时不必为横竖两种结果预留空间。
 */

import {
  activeMediaParams,
  blankBox,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasOp,
  type CanvasView,
  cardIdOf,
  displayNameOf,
  fitBox,
  type GenerateOutput,
  inputsOf,
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
 * 应用之后核对本批涉及的生成模型与参数。
 *
 * - 新建或改换了服务商与模型的卡片，须是已配置的生成模型：未配置时查不到参数表，参数核对被跳过，
 *   参数面板也无法显示该模型与其参数。
 * - 本批写入的参数，以及本批之前已发送的参数，在批后须仍可发送。模式由批后的连线决定，取值还受其他参数约束
 *   （如 PNG 时没有压缩质量、有参考图时没有 4K）。画布只发送可用的参数，参数面板也只显示这些参数；
 *   连线或其他参数的改动使已发送的参数不可用时，同样拒绝。
 *
 * 不成立时整批拒绝并说明原因。参数表本身的核对在 `prepareAgentOps` 中，那里尚无批后的连线。
 */
export function checkActiveParams(
  before: CanvasDoc,
  after: CanvasDoc,
  ops: readonly CanvasOp[],
  specsOf: ParamSpecsOf | undefined,
): void {
  if (!specsOf) return
  // update 整体替换参数：取值与原值相同的键同样是本批写入，按值比较无法识别，须按操作记录。
  const rewritten = new Map<string, readonly string[]>()
  for (const op of ops) {
    if (op.op !== 'update' || !op.params) continue
    const target = cardIdOf(before, op.id)
    if (target.ok) rewritten.set(target.id, Object.keys(op.params))
  }
  for (const node of after.nodes) {
    if (node.type !== 'generate') continue
    const old = before.nodes.find((n) => n.id === node.id)
    const prior = old?.type === 'generate' ? old : undefined
    // 新建或改换模型时，卡片上的参数（含切换后恢复的该模型参数）都由本批生效。
    const repicked = !prior || node.provider !== prior.provider || node.model !== prior.model
    const written = Object.keys(node.params).filter(
      (k) => repicked || node.params[k] !== prior?.params[k] || rewritten.get(node.id)?.includes(k),
    )
    const pick = pickOf(node)
    const specs = specsOf(node.output, pick)
    if (!specs) {
      if (!written.length && !repicked) continue
      throw new Error(
        pick
          ? `「${displayNameOf(node)}」的生成模型 ${pick.provider} / ${pick.model} 未配置：provider 与 model 取自本轮「可用的生成模型」中的同一行`
          : `「${displayNameOf(node)}」未指定生成模型，且没有默认的生成模型：provider 与 model 取自本轮「可用的生成模型」`,
      )
    }
    const kept =
      prior && !repicked
        ? Object.keys(sentParams(before, prior, specs)).filter(
            (k) => node.params[k] === prior.params[k],
          )
        : []
    const roles = inputsOf(after, node.id).map((e) => e.role)
    const operation = mediaOperationFor(node.output, roles)
    const refs = roles.filter((r) => r === 'reference').length
    const active = activeMediaParams(specs, operation, node.params, refs)
    for (const name of new Set([...written, ...kept])) {
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

/**
 * 大模型读取的画布：生成卡的参数换成实际发送的参数，与参数面板的显示一致。
 * 卡片上保存而当前不发送的取值（输入改变后不可用的偏好、对照表外的取值）不列出。
 * 模型未配置时查不到参数表，画布运行原样发送卡片参数，此处也原样列出。
 */
export function agentView(view: CanvasView, specsOf: ParamSpecsOf | undefined): CanvasView {
  if (!specsOf) return view
  const nodes = view.doc.nodes.map((n) => {
    if (n.type !== 'generate') return n
    const specs = specsOf(n.output, pickOf(n))
    return specs ? { ...n, params: sentParams(view.doc, n, specs) } : n
  })
  return { ...view, doc: { ...view.doc, nodes } }
}

/** 卡片实际发送的参数：生成模式由连向卡片的连线决定，与画布运行、参数面板取值的规则相同。 */
function sentParams(
  doc: CanvasDoc,
  node: CanvasGenerateNode,
  specs: readonly MediaParamDefinition[],
): Record<string, unknown> {
  const roles = inputsOf(doc, node.id).map((e) => e.role)
  return activeMediaParams(
    specs,
    mediaOperationFor(node.output, roles),
    node.params,
    roles.filter((r) => r === 'reference').length,
  )
}

function pickOf(node: CanvasGenerateNode): { provider: string; model: string } | undefined {
  return node.provider && node.model ? { provider: node.provider, model: node.model } : undefined
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
