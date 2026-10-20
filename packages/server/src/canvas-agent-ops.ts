/**
 * 大模型提交的画布操作在应用前后的核对与补全。只用于画布端口（大模型），界面的操作不经过这里。
 *
 * - 卡片名称在同一张画布中不能重复：大模型按名称引用卡片，名称重复时无法确定所指。
 * - 同一文件只放一张整篇的文件卡，同一段摘录只放一张摘录卡：再次放置时拒绝并给出已有卡片的名称。
 *   界面复制粘贴文件卡不经过这里。摘录卡须给出名称：缺省名称是文件名，同一文件的各张摘录卡无法按名称区分。
 *   以上两条按本批进行到该条时的画布判定，同一批中先删除的卡让出名称与文件。
 * - 只给出 model 时按已配置的模型补上 provider（`providerFor`），参数按该模型的参数表核对。
 * - 参数按所用模型的参数表核对，应用后再按卡片的输入与其他参数核对是否可用：不存在、不合法或不可用的取值
 *   该条操作不成立并列出可选值（`applyAgent` 逐条判定）。大模型写入的每个参数都会发送，也都显示在参数面板上。
 * - 大模型读取的画布中，生成卡的参数为实际发送的参数（`agentView`），与参数面板的显示一致。
 * - 尚无结果的生成卡按参数中的宽高比确定形状，出图前的排列即接近出图后的排列；结果的形状不同时，出图时相邻的卡随之移动（core `keepSpacing`）。
 */

import {
  activeMediaParams,
  blankBox,
  type CanvasDoc,
  type CanvasExcerpt,
  type CanvasGenerateNode,
  type CanvasNode,
  type CanvasOp,
  type CanvasView,
  cardIdOf,
  displayNameOf,
  fitBox,
  type GenerateOutput,
  type MediaParamDefinition,
  mediaInputsOf,
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

/** 已配置模型 `model` 的接口名：生成卡为配置了该生成模型的接口，art 卡为提供该对话模型的接口。 */
export type ProvidersOf = (output: GenerateOutput, model: string) => readonly string[]

/** 本批进行中的一张卡：名称，文件卡另有路径与摘录。名称未定（新卡的缺省名称在应用时才分配）时为 undefined。 */
interface Held {
  name: string | undefined
  path?: string
  excerpt?: CanvasExcerpt
}

/**
 * 核对并返回补全后的操作；不成立时抛出 `Error`，消息原样交给大模型。
 *
 * 名称与文件卡的唯一性按本批进行到该条时的画布判定，而不是按本批之前的画布：本批先删除或改名的卡让出原名称，
 * 先删除的文件卡让出原文件或摘录；同一批中先放置的卡同样占用名称、文件与摘录。
 */
export function prepareAgentOps(
  doc: CanvasDoc,
  ops: readonly CanvasOp[],
  specsOf: ParamSpecsOf | undefined,
  providersOf: ProvidersOf | undefined,
): CanvasOp[] {
  // 键为节点 id；本批新增的卡为其批内名称，没有批内名称时为条目序号（无法被引用）。
  const cards = new Map<string, Held>(doc.nodes.map((n) => [n.id, heldOf(n)]))
  // 引用的解析与 core `resolveRef` 相同：先按 id 或批内名称，再按唯一的名称。
  const holderOf = (ref: string): string | undefined => {
    if (cards.has(ref)) return ref
    const named = [...cards].filter(([, c]) => c.name === ref)
    return named.length === 1 ? named[0]![0] : undefined
  }
  const checkName = (name: string, self?: string) => {
    if ([...cards].some(([h, c]) => h !== self && c.name === name)) {
      throw new Error(`名称「${name}」已被另一张卡使用：同一张画布中的卡片名称不能重复`)
    }
  }
  // 画布只接受规范的相对路径（core `isRelativePath`），同一文件的路径写法唯一，直接比较即可。
  const checkFile = (path: string, excerpt: CanvasExcerpt | undefined, self?: string) => {
    const key = placedKey(path, excerpt)
    const held = [...cards].find(
      ([h, c]) => h !== self && c.path !== undefined && placedKey(c.path, c.excerpt) === key,
    )?.[1]
    if (!held) return
    throw new Error(
      excerpt
        ? `${path} 中的这一段已有摘录卡「${held.name}」：同一段只放一张卡`
        : `${path} 已在画布上，卡片名称为「${held.name}」：同一文件只放一张整篇的卡`,
    )
  }
  const out: CanvasOp[] = []
  for (const [at, raw] of ops.entries()) {
    let op = raw
    if (op.op === 'add_file' && op.excerpt && !op.name) {
      throw new Error('摘录卡须给出 name：同一文件的各张摘录卡按名称区分')
    }
    if (op.op === 'add_file' || op.op === 'add_generate' || op.op === 'add_timeline') {
      if (op.name !== undefined) checkName(op.name)
      if (op.op === 'add_file') checkFile(op.path, op.excerpt)
      cards.set(
        op.ref ?? `#${at}`,
        op.op === 'add_file'
          ? heldOf({
              id: '',
              type: 'file',
              path: op.path,
              x: 0,
              y: 0,
              w: 0,
              h: 0,
              ...(op.name ? { name: op.name } : {}),
              ...(op.excerpt ? { excerpt: op.excerpt } : {}),
            })
          : { name: op.name },
      )
    }
    if (op.op === 'add_generate') {
      const label = op.name ?? '新卡'
      if (op.model !== undefined && op.provider === undefined) {
        op = { ...op, provider: providerFor(label, op.output, op.model, providersOf) }
      }
      const pick = op.provider && op.model ? { provider: op.provider, model: op.model } : undefined
      const specs = specsOf?.(op.output, pick)
      if (op.params && specs) checkParams(label, op.params, specs, pick)
      const shape =
        op.w === undefined && op.h === undefined && specs
          ? shapeOf(op.output, op.params ?? {}, specs)
          : null
      out.push(shape ? { ...op, ...shape } : op)
      continue
    }
    if (op.op === 'update') {
      const self = holderOf(op.id)
      const held = self === undefined ? undefined : cards.get(self)
      if (op.name && held && held.name !== op.name) {
        checkName(op.name, self)
        held.name = op.name
      }
      if (held?.path !== undefined && (op.path !== undefined || op.excerpt !== undefined)) {
        const path = op.path ?? held.path
        const excerpt = op.excerpt === null ? undefined : (op.excerpt ?? held.excerpt)
        checkFile(path, excerpt, self)
        held.path = path
        if (excerpt) held.excerpt = excerpt
        else delete held.excerpt
      }
      const node = doc.nodes.find((n) => n.id === self)
      if (node?.type === 'generate') {
        if (typeof op.model === 'string' && op.provider === undefined && !node.provider) {
          op = { ...op, provider: providerFor(node.name, node.output, op.model, providersOf) }
        }
        if (op.params) {
          out.push(updateWithShape(op, node, specsOf))
          continue
        }
      }
    }
    if (op.op === 'remove' && op.version === undefined) {
      const self = holderOf(op.id)
      if (self !== undefined) cards.delete(self)
    }
    out.push(op)
  }
  return out
}

function heldOf(n: CanvasNode): Held {
  if (n.type !== 'file') return { name: displayNameOf(n) }
  return { name: displayNameOf(n), path: n.path, ...(n.excerpt ? { excerpt: n.excerpt } : {}) }
}

/** 文件卡的唯一性键：整篇卡为路径，摘录卡为路径加摘录。 */
function placedKey(path: string, excerpt: CanvasExcerpt | undefined): string {
  return excerpt ? JSON.stringify([path, excerpt.after ?? null, excerpt.start, excerpt.end]) : path
}

/**
 * 只给出 model 时确定 provider：已配置该模型的接口恰有一个时使用它，没有或有多个时不成立。
 * 不要改为不填：卡片没有 provider 时参数按默认模型的参数表核对，报错列出的是另一个模型的参数。
 */
function providerFor(
  label: string,
  output: GenerateOutput,
  model: string,
  providersOf: ProvidersOf | undefined,
): string {
  const owners = providersOf?.(output, model) ?? []
  if (owners.length === 1) return owners[0]!
  throw new Error(
    owners.length
      ? `「${label}」只给出 model ${model}，缺少 provider：${owners.join('、')} 都提供该模型，provider 写明其中一个`
      : `「${label}」只给出 model ${model}，缺少 provider，且本轮「可用的生成模型」中没有该模型：provider 与 model 取自其中的同一行`,
  )
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
 * 不成立时抛出并说明原因，由 `applyAgent` 记为该条跳过。参数表本身的核对在 `prepareAgentOps` 中，那里尚无批后的连线。
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
    const roles = mediaInputsOf(after, node.id).map((e) => e.role)
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
  const roles = mediaInputsOf(doc, node.id).map((e) => e.role)
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
  const pick = provider && model ? { provider, model } : undefined
  const specs = specsOf?.(node.output, pick)
  if (!specs || !op.params) return op
  checkParams(node.name, op.params, specs, pick)
  if (node.versions.length > 0 || op.w !== undefined || op.h !== undefined) return op
  const shape = shapeOf(node.output, op.params, specs)
  return shape ? { ...op, ...fitBox(node, shape) } : op
}

/** 按 `pick` 的参数表核对参数；`pick` 缺省时为默认模型的参数表。报错写明核对所用的模型。 */
function checkParams(
  label: string,
  params: Record<string, unknown>,
  specs: readonly MediaParamDefinition[],
  pick: { provider: string; model: string } | undefined,
): void {
  for (const [name, value] of Object.entries(params)) {
    const spec = specs.find((p) => p.name === name)
    if (!spec) {
      const source = pick ? `${pick.provider} / ${pick.model} ` : '默认模型'
      throw new Error(
        `「${label}」的参数 ${name} 不存在。${source}的可用参数：${specs.map((p) => p.name).join('、')}`,
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
