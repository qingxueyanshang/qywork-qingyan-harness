/**
 * desktop 四个出口的结果生产。
 *
 * 控件表装得下单次投递上限就整份内联，装不下就整份存盘，结果里放一部分控件加规范资源
 * 引用。六条边界：
 *
 * 1. **判定线与视图上限是同一个数**，按 `deliveredTokens` 量整条结果——控件、观察
 *    元数据、回执、message 与资源引用都算在内。只量元素数组会把回执与长 message
 *    漏在上限之外。上限是单次投递上限本身，不再按比例缩：历史里被取代的控件表由
 *    AgentLoop 收起，单份表的大小不再随步数累积。
 * 2. **动作判定与读回核验不看这里的视图**，它们用端口交回的完整控件表。
 * 3. **采集侧与投递侧分列**：`truncated` / `truncatedBy` / `filteredBy` 说的是没采到，
 *    `delivery` 说的是采到了没投。两者不能合并成一格。
 * 4. **图像字节不进这里**：它走 `data.images`，既不计入上限也不写进存盘正文。
 * 5. **按角色或文字筛选只作用于视图**：观察编号与控件表是端口交回的整份，筛出来的控件与
 *    其余控件的 `ref` 同样可以直接用。存盘正文是整份控件表。
 * 6. **投递形状只有一种**：`actions` 去重成 `actionSets`，控件上只留下标；与 `defaults`
 *    相同的格省掉。小表与大表的视图同形，字典随每个结果自带。存盘正文仍是一行一个
 *    完整原始控件，不依赖字典。
 */

import {
  type DesktopElement,
  type DesktopSnapshot,
  deliveredTokens,
  deliveryBudget,
  recordBatchSpent,
  type ToolContext,
} from '@qywork/agent'
import type { TokenDensity } from '@qywork/ai'
import type { CurrentView, IntermediateResourceRef, ResourceId } from '@qywork/core'
import { deliver, type LandedResult } from './sink.ts'

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
 * 视图里窗口标题与控件名称、值各自最多留多少字。
 *
 * 取 200，与 message 里控件值的上限同一量级。这几格由窗口与应用自报、长度无界，而上限
 * 按整条结果计量：一格长文本会把视图预算吃光，排在它后面的控件一个都投不出去。只用在
 * 大表视图上，完整原值在存盘正文里。
 */
export const MAX_TITLE_CHARS = 200

/**
 * 控件上缺席时取的值。每个结果都带一份，模型读结果时不依赖别处的约定。
 *
 * 取绝大多数控件的实际值：可用、可见、没有稳定标识。
 */
const DEFAULTS = { enabled: true, offscreen: false, automationId: '' } as const

type DesktopResultContext = Pick<ToolContext, 'sink' | 'contextWindow' | 'density' | 'state'>

type Actions = DesktopElement['actions']

/**
 * 交给模型的一个控件：`actions` 换成 `actionSets` 的下标，与 `DEFAULTS` 相同的格省掉。
 * 大表视图里超长的名称与值只留前缀，并标明省掉多少字。
 *
 * 不带 `parentRef`：`ref` 的路径段就是祖先链（`w.1.0.2` 的父控件是 `w.1.0`），再带一份
 * 父控件引用约占控件表的四分之一，且每一步都是新内容，无法命中缓存。
 */
export type CompactElement = Omit<
  DesktopElement,
  'actions' | 'enabled' | 'offscreen' | 'automationId' | 'parentRef'
> & {
  enabled?: boolean
  offscreen?: boolean
  automationId?: string
  actionSet: number
  nameOmittedChars?: number
  valueOmittedChars?: number
}

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
  /** 视图只列命中这些条件的控件及其祖先。 */
  filter?: ViewFilter
  /** message 的执行事实部分。控件内容不进 message。 */
  lead: string
  /** 上限，缺省取 `deliveryBudget(ctx.contextWindow).perCall`。 */
  limit?: number
}

/** 视图的筛选条件。`query` 看名称、稳定标识与值，不分大小写。 */
export interface ViewFilter {
  role?: string
  query?: string
}

export interface DesktopResultParts {
  message: string
  data: Record<string, unknown>
  resources?: IntermediateResourceRef[]
  /**
   * 这份结果是哪个窗口、哪个读取范围的当前控件表。AgentLoop 按它把历史里被取代的
   * 控件表收起；按条件筛过的视图标 `partial`，不取代别的结果。
   */
  currentView: CurrentView
}

/**
 * 把一份观察与本次回执合成工具结果。**四个出口只有这一个入口。**
 *
 * 存不下的部分照实说：没有 sink 或写失败时不给地址，执行事实一个字不改。
 */
export function desktopResult(input: DesktopResultInput): DesktopResultParts {
  const { ctx } = input
  const snapshot = viewOf(input.snapshot, input.filter)
  const receipt = input.receipt ?? {}
  const limit = input.limit ?? deliveryBudget(ctx.contextWindow).perCall
  const lead = input.filter ? `${input.lead} · ${filterNote(snapshot)}` : input.lead
  const shaped = { ...input, snapshot, lead }

  const { elements, ...meta } = snapshot
  const whole: DesktopResultParts = {
    message: lead,
    data: compose(receipt, { ...meta, ...pack(elements) }, input.place),
    currentView: viewKeyOf(input),
  }
  if (tokensOf(whole, ctx.density) <= limit) return recorded(ctx, whole)

  const total = elements.length
  const body = jsonlBody(input.snapshot)
  const skeleton = assemble(
    shaped,
    receipt,
    pack([]),
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
    elements,
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

  const delivered = view.elements.length
  if (landed.resourceId === null) {
    return recorded(
      ctx,
      assemble(shaped, receipt, view, {
        deliveredElements: delivered,
        totalElements: total,
        unsaved: landed.landError ?? '本次执行没有正文库',
      }),
    )
  }
  return recorded(
    ctx,
    assemble(
      shaped,
      receipt,
      view,
      { deliveredElements: delivered, totalElements: total, resourceId: landed.resourceId },
      [resourceRef(landed)],
    ),
  )
}

/** 这份结果对应的当前视图：窗口、读取范围，以及视图是否按条件筛过。 */
function viewKeyOf(input: DesktopResultInput): CurrentView {
  return {
    key: `desktop:${input.snapshot.windowId}`,
    ...(input.snapshot.scope !== undefined ? { scope: input.snapshot.scope } : {}),
    ...(input.filter ? { partial: true as const } : {}),
  }
}

/** 按视图条件筛过的观察。没有条件时原样返回。 */
type ShownSnapshot = DesktopSnapshot & { viewFilter?: string[]; matched?: number }

/**
 * 视图只列命中条件的控件，连同它们的祖先：祖先不留的话 `parentRef` 指向表外，
 * 同名控件分不开。`matched` 是命中数，不含祖先。
 */
function viewOf(snapshot: DesktopSnapshot, filter: ViewFilter | undefined): ShownSnapshot {
  if (!filter) return snapshot
  const byRef = new Map(snapshot.elements.map((e) => [e.ref, e]))
  const kept = new Set<string>()
  let matched = 0
  for (const element of snapshot.elements) {
    if (!matchesFilter(element, filter)) continue
    matched++
    let at: DesktopElement | undefined = element
    while (at !== undefined && !kept.has(at.ref)) {
      kept.add(at.ref)
      at = at.parentRef === undefined ? undefined : byRef.get(at.parentRef)
    }
  }
  return {
    ...snapshot,
    elements: snapshot.elements.filter((e) => kept.has(e.ref)),
    viewFilter: [
      ...(filter.role !== undefined ? [`role=${filter.role}`] : []),
      ...(filter.query !== undefined ? [`query=${filter.query}`] : []),
    ],
    matched,
  }
}

function matchesFilter(element: DesktopElement, filter: ViewFilter): boolean {
  if (filter.role !== undefined && element.role !== filter.role) return false
  if (filter.query === undefined) return true
  const needle = filter.query.toLowerCase()
  return [element.name, element.automationId, element.value].some((field) =>
    field?.toLowerCase().includes(needle),
  )
}

/** message 里的视图筛选事实：命中多少，以及其余控件仍属这份观察。 */
function filterNote(snapshot: ShownSnapshot): string {
  return `视图按 ${snapshot.viewFilter?.join(' ')} 列出命中的 ${snapshot.matched} 个控件及其祖先，其余控件仍在这份观察里`
}

/** 观察在 data 里的位置。两处的字段名与层级都由调用方那一侧的界面消费，不要挪。 */
function compose(
  receipt: Record<string, unknown>,
  observation: Record<string, unknown>,
  place: 'top' | 'observation',
): Record<string, unknown> {
  return place === 'top' ? { ...receipt, ...observation } : { ...receipt, observation }
}

/** 投递给模型的控件表：默认值、动作字典与控件。 */
interface Packed {
  defaults: typeof DEFAULTS
  actionSets: Actions[]
  elements: CompactElement[]
}

/** 动作字典。下标按第一次登记的先后编号，同一个结果里一个动作表只占一个下标。 */
class ActionSets {
  readonly list: Actions[] = []
  #index = new Map<string, number>()

  /** 这个动作表的下标，以及它是不是还没登记过。只查不登记。 */
  peek(actions: Actions): { index: number; fresh: boolean } {
    const known = this.#index.get(JSON.stringify(actions))
    return known === undefined
      ? { index: this.list.length, fresh: true }
      : { index: known, fresh: false }
  }

  add(actions: Actions): number {
    const { index, fresh } = this.peek(actions)
    if (fresh) {
      this.#index.set(JSON.stringify(actions), index)
      this.list.push(actions)
    }
    return index
  }
}

/** 整份控件表的投递形状。 */
function pack(elements: readonly DesktopElement[]): Packed {
  const sets = new ActionSets()
  const packed = elements.map((e) => compactOf(e, sets.add(e.actions)))
  return { defaults: DEFAULTS, actionSets: sets.list, elements: packed }
}

/** 一个控件的投递形状。`element` 可以是已经留了前缀的那一份，省略字数随之带上。 */
function compactOf(
  element: DesktopElement & { nameOmittedChars?: number; valueOmittedChars?: number },
  actionSet: number,
): CompactElement {
  const {
    actions: _actions,
    parentRef: _parentRef,
    enabled,
    offscreen,
    automationId,
    ...rest
  } = element
  return {
    ...rest,
    ...(enabled !== DEFAULTS.enabled ? { enabled } : {}),
    ...(offscreen !== DEFAULTS.offscreen ? { offscreen } : {}),
    ...(automationId !== DEFAULTS.automationId ? { automationId } : {}),
    actionSet,
  }
}

function assemble(
  input: DesktopResultInput,
  receipt: Record<string, unknown>,
  view: Packed,
  delivery: Delivery,
  resources: IntermediateResourceRef[] = [],
): DesktopResultParts {
  const { elements: _elements, ...meta } = boundedTitle(input.snapshot)
  const observation = { ...meta, ...view, delivery }
  return {
    message: `${input.lead} · ${noteOf(delivery)}`,
    data: compose(receipt, observation, input.place),
    ...(resources.length ? { resources } : {}),
    currentView: viewKeyOf(input),
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
 * 大表视图选谁：本次动作目标及其祖先、当前焦点控件优先，其余按原始顺序补到上限为止。
 *
 * **控件不从中间切开**：超长的名称与值先留前缀，装不下就停。优先那几个一律装入——
 * 目标不在视图里，模型就只能再观察一次。输出按原始顺序，层级关系由 `ref` 的路径与 `depth`
 * 读出。一个控件的成本含它第一次带进字典的那个动作表。
 */
function pickView(
  elements: readonly DesktopElement[],
  targetRef: string | null,
  budget: number,
  density: TokenDensity,
): Packed {
  const priority = new Set<string>()
  const queue = ordered(elements, targetRef, priority)
  const sets = new ActionSets()
  const chosen = new Map<string, CompactElement>()
  let left = budget
  for (const element of queue) {
    const shown = boundedFields(element)
    const { index, fresh } = sets.peek(element.actions)
    const item = compactOf(shown, index)
    const cost = costOf(item, density) + (fresh ? costOf(element.actions, density) : 0)
    if (cost > left && !priority.has(element.ref)) break
    sets.add(element.actions)
    chosen.set(element.ref, item)
    left -= cost
  }
  const view: CompactElement[] = []
  for (const element of elements) {
    const item = chosen.get(element.ref)
    if (item !== undefined) view.push(item)
  }
  return { defaults: DEFAULTS, actionSets: sets.list, elements: view }
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

/** 超长的名称与值只留前 `MAX_TITLE_CHARS` 字，并标明省掉多少字。短的原样。 */
function boundedFields(
  element: DesktopElement,
): DesktopElement & { nameOmittedChars?: number; valueOmittedChars?: number } {
  const longName = element.name.length > MAX_TITLE_CHARS
  const longValue = element.value !== undefined && element.value.length > MAX_TITLE_CHARS
  if (!longName && !longValue) return element
  return {
    ...element,
    ...(longName
      ? {
          name: element.name.slice(0, MAX_TITLE_CHARS),
          nameOmittedChars: element.name.length - MAX_TITLE_CHARS,
        }
      : {}),
    ...(longValue && element.value !== undefined
      ? {
          value: element.value.slice(0, MAX_TITLE_CHARS),
          valueOmittedChars: element.value.length - MAX_TITLE_CHARS,
        }
      : {}),
  }
}

/** 一项在视图里占多少，含数组分隔符。 */
function costOf(item: unknown, density: TokenDensity): number {
  return deliveredTokens(`${JSON.stringify(item)},`, density)
}

/** 整条结果交给模型的部分有多大。`currentView` 不上线，不计在内。 */
function tokensOf(parts: DesktopResultParts, density: TokenDensity): number {
  const { currentView: _view, ...delivered } = parts
  return deliveredTokens(JSON.stringify(delivered), density)
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
