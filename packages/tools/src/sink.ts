/**
 * 中间资源投递。
 *
 * 判据是「不可重放」，而不是体积大。这是本模块最容易写错的一点，由两张工具名表固定：
 *
 * - 本地权威（`read_file` / `grep` / `list_dir` …）：完整正文就在工作区中。
 *   历史被压缩后，模型重新读取即可。这类结果不进入 sink，
 *   即使有 10 MB：落盘只会把同一份数据存两遍。
 * - 内容权威（`web_fetch` / `web_search` / `run_command` …）：字节无法重建。
 *   网页当次抓取的内容、命令当次的输出，事后无法重建。
 *   这类结果必须先落盘，再把有界摘要发给模型。
 *
 * 按「超过 N KB 即落盘」判定会同时在两个方向出错：把可重放的源码文件存成副本，
 * 又遗漏体积不大但不可重建的输出（一次 200 行的 web_search 结果）。
 *
 * 另一条入库理由是续读：本次投递超出额度、且原工具不能按范围续读时（历史条目、记忆、技能、
 * `read_file` 的单行），正文经 `landHead`（`@qywork/agent`）保存一次，模型用 `read_resource` 继续读取。
 * 能按范围续读的（`read_file` 的多行）不入库，而是给出下一段的 `offset`。
 *
 * 模型必须知道自己看到的是截断内容。投递给模型的是摘要 + `resource_id` + 覆盖事实（已投递多少、
 * 共有多少、是否截断）。缺少覆盖事实时，模型会把 4 KB 摘要当作 2.3 MB 的全部内容，
 * 并基于不完整的信息下结论；这比不提供更糟，因为模型无从察觉信息不完整。
 */

import {
  chargeBatchBudget,
  continuationNote,
  decodeUtf8Boundary,
  deliveryCap,
  headBytesWithin,
  landHead,
  outcomeTokens,
  recordBatchSpent,
  type SinkPort,
  type ToolContext,
  type ToolOutcome,
  tokensToBytes,
} from '@qywork/agent'
import type {
  IntermediateResourceRef,
  ResourceCoverage,
  ResourceId,
  ResourceStatus,
} from '@qywork/core'

export type { SinkPort }

/**
 * 产出不可重建正文的工具。不在此表中的工具一律按「再次调用可原样取回」处理。
 *
 * 新增工具时应判断：其输出能否通过再次调用原样取回；若不能，则应纳入此表。
 * 误判的代价不对称：漏列会导致压缩后信息永久丢失（不可重建却未落盘），
 * 多列只是多存一份。因此无法确定时应予以纳入。
 *
 * `mcp__` 前缀一律按此处理：第三方 MCP 工具的可重放性本地无从判断，
 * 保守假设它不可重放。
 */
export const CONTENT_AUTHORITY_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'web_fetch',
  'web_search',
  // 子 agent 的产出无法通过再次派发取回：它运行在自己的会话中，执行时的上下文与外部 CLI
  // 进程都已结束，重新派发得到的是另一次执行的结果。
  'subagent',
  'workflow',
  // 观察结果是采集时刻的界面。再次观察得到的是另一时刻的控件表，控件编号也已更换，
  // 动作所依据的那一份无从重建。四个工具都可能返回观察结果，因此都在表中。
  'desktop_observe',
  'desktop_act',
  'desktop_act_sequence',
  'desktop_wait',
  // 页面观察同理：元素编号只属于产生它的那次观察，重新观察即重新编号。
  // 这四个工具会返回观察结果或选项页；`browser_tabs` / `browser_upload` / `browser_download`
  // 只返回简短回执，不落盘。
  'browser_observe',
  'browser_act',
  'browser_navigate',
  'browser_wait',
])

export function isContentAuthority(toolName: string): boolean {
  return CONTENT_AUTHORITY_TOOLS.has(toolName) || toolName.startsWith('mcp__')
}

/**
 * 投递给模型的正文上限（字节）。
 *
 * 它决定摘录长度，不是容量限制。容量由本次决策的投递额度控制
 * （`@qywork/agent` 的 `batchRemaining`），实际摘录取两者中的较小值。
 *
 * 不要把它改成窗口比例：摘录长度是可读性问题（头尾各保留一部分，
 * 错误信息通常在尾部），不是容量问题。8 KB 依据实测：
 * 常见构建与测试输出为 2–6 KB，此长度能容纳绝大多数命令的完整输出。
 * 更长的输出经 sink 落盘，模型凭 `resource_id` 按需读取。
 */
export const INLINE_BUDGET_BYTES = 8 * 1024

/**
 * 观察视图与子任务摘录的单份尺寸（token）：窗口的 1/8，上限 30K。
 *
 * 这是可读性尺寸，不是容量限制：实际投递还受本次决策的剩余额度约束（`batchRemaining`）。
 * 压缩的尾部保留量取它的两倍（`runtime/compaction.ts` 的 `tailRetain`），一份整视图必然落在保留尾部之内。
 */
export function observationBudget(contextWindow: number): number {
  return Math.min(Math.floor(contextWindow / 8), 30_000)
}

/**
 * browser 观察结果上限占单份视图尺寸的比例。
 *
 * 它同时决定结果多大算超长与视图容纳多少。写成比例是为了使小窗口按比例缩小。desktop 的
 * 控件表不使用它，单份按 `observationBudget` 计算：按此比例缩小时，多数整窗控件表需要分页，
 * 排在末尾的动作目标在首次读取时不在视图中，分页结果也无法作为差异基准。
 * 控件表在历史中的累积由精简投递、差异投递与压缩承担。
 */
export const OBSERVATION_RESULT_BUDGET_RATIO = 1 / 4

/** 本轮 browser 观察结果的上限（token）。 */
export function observationResultBudget(contextWindow: number): number {
  return Math.max(1, Math.floor(observationBudget(contextWindow) * OBSERVATION_RESULT_BUDGET_RATIO))
}

/** 本次投递的实际上限：展示尺寸与单次投递上限（`deliveryCap`）中的较小值，至少为 1。 */
export function viewLimit(ctx: Pick<ToolContext, 'state' | 'contextWindow'>, size: number): number {
  return Math.max(1, Math.min(size, deliveryCap(ctx)))
}

/** 摘录字节上限：展示尺寸（字节）与单次投递上限换算的字节数中的较小值。 */
export function excerptBytes(
  ctx: Pick<ToolContext, 'state' | 'density' | 'contextWindow'>,
  sizeBytes = INLINE_BUDGET_BYTES,
): number {
  return Math.min(sizeBytes, tokensToBytes(deliveryCap(ctx), ctx.density))
}

/** 头尾各保留一部分：错误信息通常在尾部（stack trace、exit code），只保留头部会丢失它。 */
const HEAD_RATIO = 0.6

export interface LandedResult {
  /** 投递给模型的正文。 */
  text: string
  /** 落盘后才有；未落盘时为 null。 */
  resourceId: string | null
  coverage: ResourceCoverage
  status: ResourceStatus
  /** 仅在落盘抛错时存在：自带摘录的调用方据此组织自己的说明。 */
  landError?: string
}

/**
 * 按预算裁剪正文，并给出覆盖事实。
 *
 * 裁剪按字节而不是字符计算，但切点必须落在 UTF-8 字符边界上：
 * 从中间切开多字节字符会产生 U+FFFD 替换符，模型读到乱码，
 * 且乱码恰好位于最需要辨认的截断处。
 */
export function clampBody(
  body: Uint8Array,
  budget = INLINE_BUDGET_BYTES,
): {
  text: string
  truncated: boolean
  deliveredBytes: number
} {
  const decoder = new TextDecoder('utf-8')
  if (body.byteLength <= budget) {
    return { text: decoder.decode(body), truncated: false, deliveredBytes: body.byteLength }
  }

  const headBytes = Math.floor(budget * HEAD_RATIO)
  const tailBytes = budget - headBytes
  const head = decodeUtf8Boundary(body.subarray(0, headBytes), 'head')
  const tail = decodeUtf8Boundary(body.subarray(body.byteLength - tailBytes), 'tail')
  const omitted = body.byteLength - headBytes - tailBytes

  return {
    text: `${head}\n\n… 中间省略 ${omitted.toLocaleString()} 字节 …\n\n${tail}`,
    truncated: true,
    deliveredBytes: headBytes + tailBytes,
  }
}

/**
 * 工具产出的统一投递入口。
 *
 * 三条分支：
 * 1. 本地权威工具：原样返回，不落盘。正文可重新读取，保存副本没有意义。
 * 2. 内容权威且未超预算：原样返回，也不落盘。完整正文已在上下文中，
 *    另存一份只在将来被压缩时才有用，届时由压缩层决定是否固化。
 * 3. 内容权威且超预算：落盘，返回头尾摘要 + resource_id + 覆盖事实。
 *
 * 分支 2 容易被误改为「内容权威一律落盘」。那样每条 `ls` 都会
 * 在正文库中留下一行，GC 压力与写放大都得不偿失。
 *
 * `excerpt` 是调用方自带的摘录。结构化正文（控件表、元素表）按字节截取头尾得不到
 * 可用的结果，这类调用方自行选定投递的部分，`deliver` 只负责落盘、地址、覆盖事实
 * 与失败降级，`text` 原样返回、不追加保存说明：说明由调用方按自己的结果结构编写。
 */
export function deliver(
  sink: SinkPort | null,
  input: {
    toolName: string
    sourceType: string
    body: Uint8Array
    mimeType?: string | null
    query?: string
    budget?: number
    excerpt?: { text: string; truncated: boolean; deliveredBytes: number }
  },
): LandedResult {
  const budget = input.budget ?? INLINE_BUDGET_BYTES
  const clamped = input.excerpt ?? clampBody(input.body, budget)

  const baseCoverage: ResourceCoverage = {
    deliveredBytes: clamped.deliveredBytes,
    totalBytes: input.body.byteLength,
    truncated: clamped.truncated,
    ...(input.query ? { query: input.query } : {}),
  }

  if (!clamped.truncated || !isContentAuthority(input.toolName) || !sink) {
    // 未截断时不存在不可见的部分，不需要 resource；
    // 本地权威工具即使截断也不落盘：模型可以重新读取。
    return {
      text: clamped.text,
      resourceId: null,
      coverage: baseCoverage,
      status: 'complete',
    }
  }

  try {
    const landed = sink.land({
      toolName: input.toolName,
      sourceType: input.sourceType,
      body: input.body,
      mimeType: input.mimeType ?? null,
      coverage: baseCoverage,
    })
    return {
      text: input.excerpt
        ? clamped.text
        : `${clamped.text}\n\n[完整输出已保存：${landed.resourceId}，共 ${input.body.byteLength.toLocaleString()} 字节。用 read_resource 读取。]`,
      resourceId: landed.resourceId,
      coverage: baseCoverage,
      status: 'complete',
    }
  } catch (err) {
    // 落盘失败不应使整个工具调用判为失败：正文的头尾摘要仍然有效，
    // 模型可以据此继续。但必须告知模型完整正文已无法取得，
    // 否则它会调用 read_resource，并遇到一个不存在的 id。
    const why = err instanceof Error ? err.message : String(err)
    return {
      text: input.excerpt
        ? clamped.text
        : `${clamped.text}\n\n[完整输出保存失败：${why}。仅上方这段内容可用。]`,
      resourceId: null,
      coverage: { ...baseCoverage, landFailed: true },
      status: 'partial',
      landError: why,
    }
  }
}

/**
 * 子 agent 与 workflow 产出的投递。
 *
 * 与 `run_command` 两条输出流的处理方式相同，区别只在尺寸：命令输出使用 8 KB 默认摘录，
 * 子 agent 的产出是其整个任务的交付物，摘录取单份视图尺寸（`observationBudget`）换算的字节数。
 * 不要改为 8 KB 默认值：一份三千余字的中文审查约 10 KB，会被从中间截断。
 *
 * 不计入投递额度。回执在任何一次 provider 决策之外产生，作为一条消息进入父会话的下一轮，
 * 该轮的容量由发送前压缩负责；此处没有可扣减的决策额度。
 *
 * `share` 是分母：一次回执只有一份视图尺寸。一次返回 n 条产出时每条取 1/n，
 * 而不是每条各取一份：后者会使内联总量随回执数线性增长。
 *
 * `coverage` 只在截断时提供：未截断时不存在不可见的部分，调用方无需将其写入结果。
 */
export function deliverAgentOutput(
  ctx: Pick<ToolContext, 'sink' | 'contextWindow' | 'density'>,
  input: { toolName: string; sourceType: string; body: string; share?: number },
): { text: string; coverage: ResourceCoverage | null; resource: IntermediateResourceRef | null } {
  const share = Math.max(1, input.share ?? 1)
  const landed = deliver(ctx.sink, {
    toolName: input.toolName,
    sourceType: input.sourceType,
    body: new TextEncoder().encode(input.body),
    mimeType: 'text/plain',
    budget: tokensToBytes(Math.floor(observationBudget(ctx.contextWindow) / share), ctx.density),
  })
  return {
    text: landed.text,
    coverage: landed.coverage.truncated ? landed.coverage : null,
    resource: landed.resourceId
      ? {
          resourceId: landed.resourceId as ResourceId,
          status: landed.status,
          contentHash: null,
          sizeBytes: landed.coverage.totalBytes ?? 0,
          mimeType: 'text/plain',
          coverage: landed.coverage,
        }
      : null,
  }
}

/**
 * 余量无法容纳任何内容时，读取仍投递的最小份额（字节）：与命令输出摘录的尺寸相同。
 *
 * 不要改为返回失败：那样该回合不产出正文，模型会原样重试；超出软阈值的这一小份由下一次发送前的压缩收回，
 * 软阈值与窗口之间还有两成余量。
 */
export const MIN_DELIVERY_BYTES = INLINE_BUDGET_BYTES

/**
 * 只读工具交付一段不能按范围续读的正文：历史条目、记忆、技能、`read_file` 的单行。
 *
 * `whole` 可整份容纳时原样投递并记账。超出额度时投递头部，完整正文经 `landHead` 保存一次，
 * `partial` 由头部与续读说明组成结果。余量连头部都无法容纳时仍投递 `MIN_DELIVERY_BYTES`。
 *
 * 续读说明约几十 token，不从头部中扣除，按实际投递量记账。
 */
export function deliverReadable(
  ctx: Pick<ToolContext, 'state' | 'sink' | 'density' | 'contextWindow'>,
  input: {
    toolName: string
    sourceType: string
    whole: { message: string; data?: Record<string, unknown> }
    body: string
    partial: (head: string, note: string) => { message: string; data?: Record<string, unknown> }
  },
): ToolOutcome {
  const charged = chargeBatchBudget(ctx, outcomeTokens(input.whole, ctx.density))
  if (charged.ok) return { status: 'success', ...input.whole }

  const frame = outcomeTokens(input.partial('', ''), ctx.density)
  const body = new TextEncoder().encode(input.body)
  const budgetBytes = Math.max(
    headBytesWithin(body, Math.max(0, charged.cap - frame), ctx.density),
    MIN_DELIVERY_BYTES,
  )
  if (budgetBytes >= body.byteLength) {
    recordBatchSpent(ctx, outcomeTokens(input.whole, ctx.density))
    return { status: 'success', ...input.whole }
  }
  const head = landHead(ctx.sink, {
    toolName: input.toolName,
    sourceType: input.sourceType,
    body,
    mimeType: 'text/plain',
    budgetBytes,
  })
  const outcome: ToolOutcome = {
    status: 'success',
    ...input.partial(head.text, continuationNote(head)),
    ...(head.resource ? { resources: [head.resource] } : {}),
  }
  recordBatchSpent(ctx, outcomeTokens(outcome, ctx.density))
  return outcome
}
