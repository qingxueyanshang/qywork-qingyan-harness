/**
 * desktop 四个出口的结果生产。
 *
 * 控件表小的整份内联，格式不变；大的整份存盘，结果里放一部分控件加规范资源引用。
 * 四条边界：
 *
 * 1. **判定线与视图上限是同一个数**，按 `deliveredTokens` 量整条结果——控件、观察
 *    元数据、回执、message 与资源引用都算在内。只量元素数组会把回执与长 message
 *    漏在上限之外。
 * 2. **动作判定与读回核验不看这里的视图**，它们用端口交回的完整控件表。
 * 3. **采集侧与投递侧分列**：`truncated` / `truncatedBy` / `filteredBy` 说的是没采到，
 *    `delivery` 说的是采到了没投。两者不能合并成一格。
 * 4. **图像字节不进这里**：它走 `data.images`，既不计入上限也不写进存盘正文。
 */

import {
  type DesktopElement,
  type DesktopSnapshot,
  deliveredTokens,
  recordBatchSpent,
  type ToolContext,
} from '@qywork/agent'
import type { TokenDensity } from '@qywork/ai'
import type { IntermediateResourceRef, ResourceId } from '@qywork/core'
import { deliver, type LandedResult, observationResultBudget } from './sink.ts'

/** 存盘正文：一行一个 JSON 值。 */
const JSONL_MIME = 'application/x-ndjson'
const SOURCE_TYPE = 'desktop:observation'
/**
 * 骨架估算时给 resource id 留的位置。
 *
 * 真 id 在存盘之后才有，而视图要在存盘之前选好。取 32 字符是上界：高估只让视图
 * 少装一个控件，低估会让结果越过上限。
 */
const ID_ESTIMATE = 'r'.repeat(32)
/**
 * 视图里窗口标题最多留多少字。
 *
 * 取 200，与 message 里控件值的上限同一量级。标题由窗口自报、长度无界，而上限按整条
 * 结果计量：一段长标题会把视图预算吃光，控件一个都投不出去。
 */
export const MAX_TITLE_CHARS = 200

type DesktopResultContext = Pick<ToolContext, 'sink' | 'contextWindow' | 'density' | 'state'>

/** 视图里值被留在存盘正文里的控件。身份、状态与能力照旧。 */
export interface ValueOmittedElement extends Omit<DesktopElement, 'value'> {
  /** 这个控件的值有多少字。完整值在存盘正文里。 */
  valueOmittedChars: number
}

export type ViewElement = DesktopElement | ValueOmittedElement

/** 投递事实。与采集侧的 `truncated` / `filteredBy` 是两回事。 */
interface Delivery {
  deliveredElements: number
  totalElements: number
  /** 存盘成功才有：完整控件表按它读。 */
  resourceId?: string
  /** 存盘没成功才有：原因。未返回的控件此后读不回来。 */
  unsaved?: string
}

export interface DesktopResultInput {
  ctx: DesktopResultContext
  toolName: string
  snapshot: DesktopSnapshot
  /** 观察放在 `data` 顶层（observe），还是 `data.observation` 下（act / wait / sequence）。 */
  place: 'top' | 'observation'
  /** 结果里除观察以外的字段：回执、步骤表、found。 */
  receipt?: Record<string, unknown>
  /** 本次动作的目标控件，它与它的祖先优先进视图。没有目标给 null。 */
  targetRef?: string | null
  /** message 的执行事实部分。控件内容不进 message。 */
  lead: string
  /** 上限，缺省取 `observationResultBudget(ctx.contextWindow)`。 */
  limit?: number
}

export interface DesktopResultParts {
  message: string
  data: Record<string, unknown>
  resources?: IntermediateResourceRef[]
}

/**
 * 把一份观察与本次回执合成工具结果。**四个出口只有这一个入口。**
 *
 * 存不下的部分照实说：没有 sink 或写失败时不给地址，执行事实一个字不改。
 */
export function desktopResult(input: DesktopResultInput): DesktopResultParts {
  const { ctx, snapshot } = input
  const receipt = input.receipt ?? {}
  const limit = input.limit ?? observationResultBudget(ctx.contextWindow)

  const whole: DesktopResultParts = {
    message: input.lead,
    data: compose(receipt, { ...snapshot }, input.place),
  }
  if (tokensOf(whole, ctx.density) <= limit) return recorded(ctx, whole)

  const total = snapshot.elements.length
  const body = jsonlBody(snapshot)
  const skeleton = assemble(
    input,
    receipt,
    [],
    { deliveredElements: total, totalElements: total, resourceId: ID_ESTIMATE },
    [
      {
        resourceId: ID_ESTIMATE as ResourceId,
        status: 'complete',
        contentHash: null,
        sizeBytes: body.byteLength,
        mimeType: JSONL_MIME,
        coverage: { deliveredBytes: body.byteLength, totalBytes: body.byteLength, truncated: true },
      },
    ],
  )
  const view = pickView(
    snapshot.elements,
    input.targetRef ?? null,
    limit - tokensOf(skeleton, ctx.density),
    ctx.density,
  )

  const excerpt = JSON.stringify(view)
  const landed = deliver(ctx.sink, {
    toolName: input.toolName,
    sourceType: SOURCE_TYPE,
    body,
    mimeType: JSONL_MIME,
    excerpt: {
      text: excerpt,
      truncated: true,
      deliveredBytes: new TextEncoder().encode(excerpt).byteLength,
    },
  })

  if (landed.resourceId === null) {
    return recorded(
      ctx,
      assemble(input, receipt, view, {
        deliveredElements: view.length,
        totalElements: total,
        unsaved: landed.landError ?? '本次执行没有正文库',
      }),
    )
  }
  return recorded(
    ctx,
    assemble(
      input,
      receipt,
      view,
      { deliveredElements: view.length, totalElements: total, resourceId: landed.resourceId },
      [resourceRef(landed)],
    ),
  )
}

/** 观察在 data 里的位置。两处的字段名与层级都由调用方那一侧的界面消费，不要挪。 */
function compose(
  receipt: Record<string, unknown>,
  observation: Record<string, unknown>,
  place: 'top' | 'observation',
): Record<string, unknown> {
  return place === 'top' ? { ...receipt, ...observation } : { ...receipt, observation }
}

function assemble(
  input: DesktopResultInput,
  receipt: Record<string, unknown>,
  view: ViewElement[],
  delivery: Delivery,
  resources: IntermediateResourceRef[] = [],
): DesktopResultParts {
  const observation = { ...boundedTitle(input.snapshot), elements: view, delivery }
  return {
    message: `${input.lead} · ${noteOf(delivery)}`,
    data: compose(receipt, observation, input.place),
    ...(resources.length ? { resources } : {}),
  }
}

/**
 * 视图里的窗口标题：超过 `MAX_TITLE_CHARS` 只留前缀，并标明省掉多少字。
 *
 * 只用在大观察路径上。完整原值在存盘正文的第一行，按 `delivery.resourceId` 读得回来；
 * 留前缀而不是整格去掉，是因为动作行上的窗口名取的就是这一格。
 */
function boundedTitle(snapshot: DesktopSnapshot): Record<string, unknown> {
  if (snapshot.title.length <= MAX_TITLE_CHARS) return { ...snapshot }
  return {
    ...snapshot,
    title: snapshot.title.slice(0, MAX_TITLE_CHARS),
    titleOmittedChars: snapshot.title.length - MAX_TITLE_CHARS,
  }
}

/** message 里的投递事实：给了多少、其余在哪读，或者为什么读不回来。 */
function noteOf(delivery: Delivery): string {
  const head = `已投 ${delivery.deliveredElements}/${delivery.totalElements} 个控件`
  if (delivery.resourceId !== undefined) {
    return `${head} · 完整控件表 ${delivery.resourceId}，用 read_resource 读`
  }
  return `${head} · 完整控件表未保存 · ${delivery.unsaved} · 未返回的部分无法回读`
}

function resourceRef(landed: LandedResult): IntermediateResourceRef {
  return {
    resourceId: landed.resourceId as ResourceId,
    status: landed.status,
    contentHash: null,
    sizeBytes: landed.coverage.totalBytes ?? 0,
    mimeType: JSONL_MIME,
    coverage: landed.coverage,
  }
}

/**
 * 存盘正文：第一行是观察的全部非元素元数据，之后每行一个完整控件，顺序不变。
 *
 * 字段缺席、null、false、0、空串原样保留——回读要按字段和值与原观察核对。
 */
function jsonlBody(snapshot: DesktopSnapshot): Uint8Array {
  const { elements, ...meta } = snapshot
  const lines = [JSON.stringify(meta), ...elements.map((e) => JSON.stringify(e))]
  return new TextEncoder().encode(lines.join('\n'))
}

/**
 * 视图选谁：本次动作目标及其祖先、当前焦点控件优先，其余按原始顺序补到上限为止。
 *
 * **控件不从中间切开**：装不下时先去掉长值再试，仍装不下就停。优先那几个一律装入——
 * 目标不在视图里，模型就只能再观察一次，减量的意义随之消失。输出按原始顺序，
 * `parentRef` 表达的层级关系因此仍然读得出来。
 */
function pickView(
  elements: readonly DesktopElement[],
  targetRef: string | null,
  budget: number,
  density: TokenDensity,
): ViewElement[] {
  const priority = new Set<string>()
  const queue = ordered(elements, targetRef, priority)
  const chosen = new Map<string, ViewElement>()
  let left = budget
  for (const element of queue) {
    let item: ViewElement = element
    let cost = costOf(item, density)
    if (cost > left) {
      item = withoutValue(element)
      cost = costOf(item, density)
    }
    if (cost > left && !priority.has(element.ref)) break
    chosen.set(element.ref, item)
    left -= cost
  }
  const view: ViewElement[] = []
  for (const element of elements) {
    const item = chosen.get(element.ref)
    if (item !== undefined) view.push(item)
  }
  return view
}

/** 优先那几个排在前面，其余保持原始顺序。`priority` 由本函数填好交回。 */
function ordered(
  elements: readonly DesktopElement[],
  targetRef: string | null,
  priority: Set<string>,
): DesktopElement[] {
  const byRef = new Map(elements.map((e) => [e.ref, e]))
  const head: DesktopElement[] = []
  const take = (element: DesktopElement): void => {
    if (priority.has(element.ref)) return
    priority.add(element.ref)
    head.push(element)
  }
  let at = targetRef === null ? undefined : byRef.get(targetRef)
  while (at !== undefined && !priority.has(at.ref)) {
    take(at)
    at = at.parentRef === undefined ? undefined : byRef.get(at.parentRef)
  }
  for (const element of elements) {
    if (element.focused === true) take(element)
  }
  return [...head, ...elements.filter((e) => !priority.has(e.ref))]
}

/** 长值留在存盘正文里，视图里留身份、状态与能力，并标明值有多少字。 */
function withoutValue(element: DesktopElement): ViewElement {
  if (element.value === undefined) return element
  const { value, ...rest } = element
  return { ...rest, valueOmittedChars: value.length }
}

/** 一个控件在视图里占多少，含数组分隔符。 */
function costOf(item: ViewElement, density: TokenDensity): number {
  return deliveredTokens(`${JSON.stringify(item)},`, density)
}

function tokensOf(parts: DesktopResultParts, density: TokenDensity): number {
  return deliveredTokens(JSON.stringify(parts), density)
}

/**
 * 结果定稿后记一次已投递用量。
 *
 * 记的是实际投了多少，允许越过本波预算：动作已经执行，按预算改报失败等于骗模型。
 */
function recorded(ctx: DesktopResultContext, parts: DesktopResultParts): DesktopResultParts {
  recordBatchSpent(ctx, tokensOf(parts, ctx.density))
  return parts
}
