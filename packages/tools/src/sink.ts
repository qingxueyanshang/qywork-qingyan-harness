/**
 * 中间资源投递闸。
 *
 * **判据不是「大」，是「不可重放」。** 这是整个模块最容易写错的一点，两张工具名表把它钉死：
 *
 * - **本地权威**（`read_file` / `grep` / `list_dir` …）：完整正文就在工作区里。
 *   历史被压缩掉之后，模型再读一遍就是了。**这类结果不进 sink**，
 *   哪怕它有 10 MB —— 落一份盘只是把同一份数据存两遍。
 * - **内容权威**（`web_fetch` / `web_search` / `run_command` …）：字节**无法重建**。
 *   该网页当次抓取的内容、该命令当次的输出，事后无法重建。
 *   这类**必须**先落盘再把有界摘要发给模型。
 *
 * 按「超过 N KB 就落盘」来判会同时犯两个方向的错：把可重放的源码文件存成副本，
 * 又漏掉那些不大但不可重建的输出（一次 200 行的 web_search 结果）。
 *
 * 另一条入库理由是**续读**：本次投递装不下、而原工具又不能按范围续读时（历史条目、记忆、技能、
 * `read_file` 的单行），正文经 `landHead`（`@qywork/agent`）存一次，模型用 `read_resource` 接着读。
 * 能按范围续读的（`read_file` 的多行）不入库，给下一段的 `offset`。
 *
 * **为什么模型必须知道自己看到的是截断的。** 投递给模型的是摘要 + `resource_id` + **覆盖事实**（投
 * 了多少 / 一共多少 / 截没截）。少了覆盖事实，模型会把 4 KB 摘要当成 2.3 MB 的全部，然后基于不完整
 * 信息下结论——那比不给它更糟，因为它不知道自己不知道。
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
 * 产出不可重建正文的工具。不在这张表里的一律按「再调一次能原样拿回来」处理。
 *
 * 新增工具时应判断：其输出能否通过再次调用原样取回；若不能，则应纳入此表。
 * 判错的方向是不对称的——漏列会导致压缩后信息永久丢失（不可重建却没落盘），
 * 多列只是多存一份。因此无法确定时应予以纳入。
 *
 * `mcp__` 前缀一律按此处理：第三方 MCP 工具的可重放性本地无从判断，
 * 保守假设它不可重放。
 */
export const CONTENT_AUTHORITY_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'web_fetch',
  'web_search',
  // 子 agent 的产出再派一次拿不回来：它跑在自己的会话里，那一轮的上下文与外部 CLI
  // 的那个进程都已经结束，重派得到的是另一次执行的结果。
  'subagent',
  'workflow',
  // 观察是采集那一刻的界面。再观察一次得到的是另一个时刻的控件表，控件编号也换了一批，
  // 动作所依据的那一份无从重建。四个出口都可能带回观察，因此四个都在表里。
  'desktop_observe',
  'desktop_act',
  'desktop_act_sequence',
  'desktop_wait',
  // 页面观察同理：元素编号只属于产生它的那一次观察，重新观察即换号。
  // 这四个工具会带回观察或选项页，`browser_tabs` / `browser_upload` / `browser_download`
  // 只回短回执，不落盘。
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
 * **它是「摘录多长」，不是「容量闸」。** 容量由本次决策的投递额度管
 * （`@qywork/agent` 的 `batchRemaining`），实际摘录取两者较小的那个。
 *
 * **不要把它改成窗口比例**：摘录长度是可读性问题（头尾各留一半，
 * 错误信息通常在尾部），不是容量问题。8 KB 的依据是实测——
 * 常见构建/测试输出在 2–6 KB，这个长度能容下绝大多数命令的完整输出。
 * 真正超长的那些走 sink 落盘，模型拿 `resource_id` 按需回读。
 */
export const INLINE_BUDGET_BYTES = 8 * 1024

/**
 * 观察视图与子任务摘录的单份尺寸（token）：窗口 1/8，封顶 30K。
 *
 * 这是可读性尺寸，不是容量闸：实际投递还受本次决策的剩余额度约束（`batchRemaining`）。
 * 压缩的尾部保留量取它的两倍（`runtime/compaction.ts` 的 `tailRetain`），一份整视图必然落在保留尾部之内。
 */
export function observationBudget(contextWindow: number): number {
  return Math.min(Math.floor(contextWindow / 8), 30_000)
}

/**
 * browser 观察结果上限占单份视图尺寸的比例。
 *
 * 它同时决定「多大算大」与「视图装多少」。写成比例是为了让小窗口跟着缩。desktop 的
 * 控件表不用它，单份按 `observationBudget` 给：按这个比例缩，多数整窗控件表要分页，排在尾部的
 * 动作目标首读不在视图里，分页的结果也当不了差异基底。控件表在历史里的累积由精简投递、
 * 差异投递与压缩承担。
 */
export const OBSERVATION_RESULT_BUDGET_RATIO = 1 / 4

/** 这一轮 browser 观察结果的上限（token）。 */
export function observationResultBudget(contextWindow: number): number {
  return Math.max(1, Math.floor(observationBudget(contextWindow) * OBSERVATION_RESULT_BUDGET_RATIO))
}

/** 本次投递的实际上限：展示尺寸与单次投递上限（`deliveryCap`）取小，至少 1。 */
export function viewLimit(ctx: Pick<ToolContext, 'state' | 'contextWindow'>, size: number): number {
  return Math.max(1, Math.min(size, deliveryCap(ctx)))
}

/** 摘录字节上限：展示尺寸（字节）与单次投递上限折成的字节数取小。 */
export function excerptBytes(
  ctx: Pick<ToolContext, 'state' | 'density' | 'contextWindow'>,
  sizeBytes = INLINE_BUDGET_BYTES,
): number {
  return Math.min(sizeBytes, tokensToBytes(deliveryCap(ctx), ctx.density))
}

/** 头尾各留一半：错误信息通常在尾部（stack trace、exit code），只留头部会把它切掉。 */
const HEAD_RATIO = 0.6

export interface LandedResult {
  /** 投递给模型的正文。 */
  text: string
  /** 落盘了才有；未落盘时为 null。 */
  resourceId: string | null
  coverage: ResourceCoverage
  status: ResourceStatus
  /** 只有落盘抛错时有：自带摘录的调用方据它组织自己的说明。 */
  landError?: string
}

/**
 * 按预算裁剪正文，并给出覆盖事实。
 *
 * 裁剪的是**字节**不是字符，但切点必须落在 UTF-8 字符边界上——
 * 从中间切开一个多字节字符会产生 U+FFFD 替换符，模型读到的是乱码，
 * 而且乱码位置恰好在最需要看清的地方（截断处）。
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
 * 1. **本地权威工具** —— 原样返回，不落盘。正文可重读，存副本没意义。
 * 2. **内容权威 + 未超预算** —— 原样返回，也不落盘。完整正文已经在上下文里，
 *    再存一份只在「将来被压缩掉」时才有用，而那时压缩层会自己决定要不要固化。
 * 3. **内容权威 + 超预算** —— 落盘，返回头尾摘要 + resource_id + 覆盖事实。
 *
 * 分支 2 容易被误改成「内容权威一律落盘」。那样每条 `ls` 都会
 * 在正文库里留一行，GC 压力和写放大都不划算。
 *
 * **`excerpt` 是调用方自带的摘录。** 结构化正文（控件表、元素表）按字节头尾裁出来的
 * 不是可用的结果，这类调用方自己选好投递哪一部分，`deliver` 只管落盘、地址、覆盖事实
 * 与失败降级，`text` 原样回、不再追加保存说明——说明由调用方按自己的结果形状写。
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
    // 没截断就没有「看不到的部分」，不需要 resource；
    // 本地权威工具即使截断了也不落盘——模型可以自己再读一次。
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
    // 落盘失败不能把工具调用整体判失败——正文的头尾摘要仍然有效，
    // 模型拿着它照样能继续。但**必须**告诉模型完整正文拿不到了，
    // 否则它会去调 read_resource 然后撞一个不存在的 id。
    const why = err instanceof Error ? err.message : String(err)
    return {
      text: input.excerpt
        ? clamped.text
        : `${clamped.text}\n\n[完整输出保存失败：${why}。只有上面这段可用。]`,
      resourceId: null,
      coverage: { ...baseCoverage, landFailed: true },
      status: 'partial',
      landError: why,
    }
  }
}

/**
 * 子 agent 与 workflow 的产出过闸。
 *
 * 与 `run_command` 的两条流同形，差别只在尺寸：命令输出用 8 KB 默认摘录，
 * 子 agent 的产出是它整件事的交付物，摘录取单份视图尺寸（`observationBudget`）折成的字节数。
 * **不要改回 8 KB 默认值**：一份三千余字的中文审查就是 10 KB，会被从中间切开。
 *
 * **不走投递额度。** 回执在任何一次 provider 决策之外产生，作为一条消息进入父会话的下一轮，
 * 那一轮的容量由发送前压缩负责；这里没有可扣的决策账。
 *
 * **`share` 是分母：一次回执只有一份视图尺寸。** 一次返回 n 条产出时每条拿
 * 1/n，不是每条各拿一份：后者会让内联总量随回执数线性增长。
 *
 * `coverage` 只在截断时给：没截断就没有「看不到的部分」，调用方不必往结果里放。
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
 * 余量放不下任何内容时，读取仍投递的最小一份（字节）：与命令输出摘录同一个尺寸。
 *
 * 不要改回报失败：那一回合不产出正文，模型原样重试；超出软阈值的这一小份由下一次发送前的压缩收回，
 * 软阈值到窗口之间还有两成。
 */
export const MIN_DELIVERY_BYTES = INLINE_BUDGET_BYTES

/**
 * 只读工具交付一段不能按范围续读的正文：历史条目、记忆、技能、`read_file` 的单行。
 *
 * `whole` 整份装得下就原样投递并记账。装不下时投递头部，完整正文经 `landHead` 存一次，
 * `partial` 按头部与续读说明组出结果。余量连头部都放不下时仍投递 `MIN_DELIVERY_BYTES`。
 *
 * 续读说明几十 token，不从头部里扣，按实际投递量记账。
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
