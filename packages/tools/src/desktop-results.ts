/**
 * desktop 四个出口的结果生产。
 *
 * 控件表装得下单次投递上限就整份内联，装不下就整份存盘，结果里放一部分控件加规范资源
 * 引用；动作与等待之后的重读在条件成立时只投与上一份整份相比的变化。七条边界：
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
 * 6. **投递形状只有一种**：`actions` 按投递方式分组、去重成 `actionSets`，控件上只留下标；与 `defaults`
 *    相同的格省掉；`rect` 只在调用方要时给；无名结构容器不列，`depth` 按列出的祖先计。
 *    小表与大表的视图同形，字典随每个结果自带。存盘正文仍是一行一个完整原始控件，
 *    不依赖字典。
 * 7. **差异只相对一份仍然可见的整份投递**：本 run、同窗口、同读取范围、未筛选、未分页、
 *    不带 `rect` 的那一份；逐字未变的控件过半；这份基底与之后各次差异累计不超过单次上限，
 *    压缩保留的尾部（两倍单次上限）因此装得下它们。任一条不成立即整份投递并成为新基底。
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
/** 结构容器的角色。这几种控件没有名称与状态时只承载层级。 */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['pane', 'group', 'custom'])
/** `ctx.state` 里记差异基底的键。`ctx.state` 是 run 级的：新 run 的第一次投递一定整份。 */
const BASES_KEY = 'desktop:bases'
/**
 * 差异投递要求与基底逐字相同的控件至少占多少，分母取基底与这一份里较多的那个。
 *
 * 低于它说明界面已经大改（页面跳转、换了对话框），整份投递读起来更直接，且成为新基底。
 */
const MIN_UNCHANGED_SHARE = 0.5

type DesktopResultContext = Pick<ToolContext, 'sink' | 'contextWindow' | 'density' | 'state'>

type Actions = DesktopElement['actions']

/**
 * 交给模型的一个控件：`actions` 换成 `actionSets` 的下标，与 `DEFAULTS` 相同的格省掉。
 * 大表视图里超长的名称与值只留前缀，并标明省掉多少字。
 *
 * 不带 `parentRef`：控件按前序排列，父控件是前面最近的、`depth` 小一层的那一个。再带一份
 * 父控件引用约占控件表的四分之一，且每一步都是新内容，无法命中缓存。`rect` 只在
 * `includeRect` 为真时带：它约占控件表的五分之一，按控件动作与取景都不读投递里的这一格。
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
  /** 控件带不带 `rect`。缺席不带。 */
  includeRect?: boolean
  /**
   * 动作与等待之后的重读传 true：条件成立时只投与上一份整份投递相比的变化。
   * `desktop_observe` 不传，一律整份：模型主动要看的是整张表。
   */
  incremental?: boolean
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
  const { shown: snapshot, hits } = viewOf(input.snapshot, input.filter)
  const receipt = input.receipt ?? {}
  const limit = input.limit ?? deliveryBudget(ctx.contextWindow).perCall
  const lead = input.filter ? `${input.lead} · ${filterNote(snapshot)}` : input.lead
  const shaped = { ...input, snapshot, lead }
  const includeRect = input.includeRect === true

  const { elements: read, ...meta } = snapshot
  const targetRef = input.targetRef ?? null
  const elements = listable(read, new Set([...keptAnyway(read, targetRef), ...hits]))
  const view = viewKeyOf(input)
  // 筛过的视图标 partial，不取代别的结果，也不碰基底。
  const bases = input.filter ? null : basesOf(ctx)
  const rows = bases ? new Map(elements.map((e) => [e.ref, rowKey(e)])) : null

  if (input.incremental === true && bases && rows) {
    const base = bases.get(view.key)?.get(view.scope ?? '')
    const diff = base ? diffOf(base, elements, rows) : null
    if (base && diff) {
      const parts = diffParts(input, receipt, meta, diff, view)
      const spent = tokensOf(parts, ctx.density)
      if (base.spent + spent <= limit) {
        base.spent += spent
        return recorded(ctx, parts)
      }
    }
  }

  const whole: DesktopResultParts = {
    message: lead,
    data: compose(receipt, { ...meta, ...pack(elements, includeRect) }, input.place),
    currentView: view,
  }
  const wholeTokens = tokensOf(whole, ctx.density)
  if (wholeTokens <= limit) {
    if (bases && rows) {
      // 带 rect 的整份不当基底：之后的差异不带 rect，未列出的控件在基底里的 rect 可能已经过时。
      const next = includeRect
        ? null
        : { observationId: snapshot.observationId, rows, spent: wholeTokens }
      supersede(bases, view, next)
    }
    return recorded(ctx, whole)
  }
  if (bases) supersede(bases, view, null)

  const total = elements.length
  const body = jsonlBody(input.snapshot)
  const skeleton = assemble(
    shaped,
    receipt,
    pack([], includeRect),
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
  const picked = pickView(
    elements,
    priorityOf(read, targetRef),
    limit - tokensOf(skeleton, ctx.density),
    ctx.density,
    includeRect,
  )

  const excerpt = JSON.stringify(picked)
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

  const delivered = picked.elements.length
  if (landed.resourceId === null) {
    return recorded(
      ctx,
      assemble(shaped, receipt, picked, {
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
      picked,
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

/**
 * 模型手上的一份整份控件表：本 run 里某个窗口、某个读取范围最近一次整份、未筛选、未分页的
 * 投递。差异投递按它比较。
 *
 * 它只记投递出去了什么，不参与动作判定：动作仍按协调器交回的完整表核对。
 */
interface Base {
  observationId: string
  /** 编号 → 这一行投递内容的比较串，见 `rowKey`。 */
  rows: Map<string, string>
  /** 这份基底与之后各次差异一共投了多少 token。不超过单次上限，基底才仍在压缩保留的尾部里。 */
  spent: number
}

/** 视图 key → 读取范围（整窗记空串）→ 基底。 */
type Bases = Map<string, Map<string, Base>>

function basesOf(ctx: DesktopResultContext): Bases {
  const known = ctx.state.get(BASES_KEY) as Bases | undefined
  if (known) return known
  const bases: Bases = new Map()
  ctx.state.set(BASES_KEY, bases)
  return bases
}

/**
 * 一份不筛选的结果进了历史之后，基底随之更新。取代范围与 `collapseSuperseded` 同一套：
 * 整窗的结果取代这个窗口的全部视图，局部读取的结果只取代同一个读取范围。
 *
 * 取代范围不要比那边窄：历史里已经收起的表留在这里当基底，之后的差异指向一份模型看不到的表。
 */
function supersede(bases: Bases, view: CurrentView, next: Base | null): void {
  if (view.scope === undefined) bases.delete(view.key)
  else bases.get(view.key)?.delete(view.scope)
  if (next === null) return
  const scopes = bases.get(view.key) ?? new Map<string, Base>()
  scopes.set(view.scope ?? '', next)
  bases.set(view.key, scopes)
}

/**
 * 一行投递内容的比较串：投递形状（不含 `rect`）、它的动作字典项与列出的父控件。
 *
 * 父控件要算进来：差异里的行不在原位置上，换了父控件而其余字段不变的控件，只比投递字段
 * 会被判成未变。
 */
function rowKey(e: DesktopElement): string {
  const { actionSet: _index, ...row } = compactOf(e, 0, false)
  return JSON.stringify({ ...row, parentRef: e.parentRef ?? null, actions: groupsOf(e.actions) })
}

/** 与基底相比的变化。三类都按这一份里的顺序排，`removed` 按基底里的顺序。 */
interface Diff {
  since: string
  unchanged: number
  added: DesktopElement[]
  changed: DesktopElement[]
  removed: string[]
}

/** 与基底相比的变化；逐字未变的控件不到 `MIN_UNCHANGED_SHARE` 时交回 `null`，整份投递。 */
function diffOf(
  base: Base,
  elements: readonly DesktopElement[],
  rows: ReadonlyMap<string, string>,
): Diff | null {
  let unchanged = 0
  const added: DesktopElement[] = []
  const changed: DesktopElement[] = []
  for (const e of elements) {
    const before = base.rows.get(e.ref)
    if (before === undefined) added.push(e)
    else if (before === rows.get(e.ref)) unchanged++
    else changed.push(e)
  }
  const most = Math.max(base.rows.size, elements.length)
  if (most === 0 || unchanged < MIN_UNCHANGED_SHARE * most) return null
  const removed = [...base.rows.keys()].filter((ref) => !rows.has(ref))
  return { since: base.observationId, unchanged, added, changed, removed }
}

/**
 * 差异结果。观察元数据与整份投递相同，控件表换成 `since` / `unchanged` 与三类变化。
 *
 * 行不在原位置上，所以 `added` 与 `changed` 的每一行都带 `parentRef`（列出的父控件）；
 * 字典只含这两类行用到的项。标 `partial`：它不取代基底，下一份整份投递同时取代两者。
 */
function diffParts(
  input: DesktopResultInput,
  receipt: Record<string, unknown>,
  meta: Omit<DesktopSnapshot, 'elements'>,
  diff: Diff,
  view: CurrentView,
): DesktopResultParts {
  const sets = new ActionSets()
  const rowOf = (e: DesktopElement): CompactElement & { parentRef?: string } => ({
    ...compactOf(e, sets.add(e.actions), false),
    ...(e.parentRef !== undefined ? { parentRef: e.parentRef } : {}),
  })
  const added = diff.added.map(rowOf)
  const changed = diff.changed.map(rowOf)
  const observation = {
    ...meta,
    since: diff.since,
    unchanged: diff.unchanged,
    defaults: DEFAULTS,
    actionSets: sets.list,
    added,
    changed,
    removed: diff.removed,
  }
  const counts = `新增 ${added.length}、改变 ${changed.length}、消失 ${diff.removed.length}`
  return {
    message: `${input.lead} · 与 ${diff.since} 相比：${counts}`,
    data: compose(receipt, observation, input.place),
    currentView: { ...view, partial: true },
  }
}

/** 按视图条件筛过的观察。没有条件时原样返回。 */
type ShownSnapshot = DesktopSnapshot & { viewFilter?: string[]; matched?: number }

/**
 * 视图只列命中条件的控件，连同它们的祖先：祖先不留的话层级读不出来，同名控件分不开。
 * `matched` 是命中数，不含祖先；`hits` 是命中的那几个，结构容器命中了同样列出。
 */
function viewOf(
  snapshot: DesktopSnapshot,
  filter: ViewFilter | undefined,
): { shown: ShownSnapshot; hits: ReadonlySet<string> } {
  const hits = new Set<string>()
  if (!filter) return { shown: snapshot, hits }
  const byRef = new Map(snapshot.elements.map((e) => [e.ref, e]))
  const kept = new Set<string>()
  for (const element of snapshot.elements) {
    if (!matchesFilter(element, filter)) continue
    hits.add(element.ref)
    let at: DesktopElement | undefined = element
    while (at !== undefined && !kept.has(at.ref)) {
      kept.add(at.ref)
      at = at.parentRef === undefined ? undefined : byRef.get(at.parentRef)
    }
  }
  return {
    shown: {
      ...snapshot,
      elements: snapshot.elements.filter((e) => kept.has(e.ref)),
      viewFilter: [
        ...(filter.role !== undefined ? [`role=${filter.role}`] : []),
        ...(filter.query !== undefined ? [`query=${filter.query}`] : []),
      ],
      matched: hits.size,
    },
    hits,
  }
}

/**
 * 无名结构容器：pane / group / custom，没有名称、值与文本，也没有任何非默认状态。
 *
 * 它们只承载层级。可用动作不参与判定：浏览器里几乎每个节点都挂着 scroll_into_view 与
 * 指针动作，按它判等于一个都不省。
 */
function structural(e: DesktopElement): boolean {
  return (
    CONTAINER_ROLES.has(e.role) &&
    e.name === '' &&
    e.value === undefined &&
    e.text !== true &&
    e.enabled &&
    !e.offscreen &&
    e.focused !== true &&
    e.weakIdentity !== true &&
    e.windowRoot !== true &&
    e.expand === undefined &&
    e.toggle === undefined &&
    e.selected === undefined &&
    e.selection === undefined &&
    e.scroll === undefined &&
    e.range === undefined
  )
}

/**
 * 投给模型的控件：无名结构容器不列，`keep` 里的照列；`depth` 改成列出的祖先个数，
 * `parentRef` 改成最近一个列出的祖先。
 *
 * 不要保留原 `depth`：容器省掉之后层数跳级，它的子控件读起来挂在前一个兄弟下面。按列出的
 * 祖先计数，「父控件是前面最近的、depth 小一层的那一个」对投递出去的表仍然成立；一个都
 * 没省时它与原值相同。父控件不在表里的控件两格都沿用原值。
 */
function listable(
  elements: readonly DesktopElement[],
  keep: ReadonlySet<string>,
): DesktopElement[] {
  const levels = new Map<string, number>()
  /** 编号 → 它自己（列出时）或它最近一个列出的祖先。 */
  const anchors = new Map<string, string | undefined>()
  const listed = new Set<string>()
  const out: DesktopElement[] = []
  for (const e of elements) {
    const parent = e.parentRef
    const parentLevel = parent === undefined ? undefined : levels.get(parent)
    const inTable = parent !== undefined && parentLevel !== undefined
    const level = inTable ? parentLevel + (listed.has(parent) ? 1 : 0) : e.depth
    const up = inTable ? anchors.get(parent) : parent
    levels.set(e.ref, level)
    if (structural(e) && !keep.has(e.ref)) {
      anchors.set(e.ref, up)
      continue
    }
    anchors.set(e.ref, e.ref)
    listed.add(e.ref)
    const { parentRef: _parentRef, ...rest } = e
    out.push({ ...rest, ...(up !== undefined ? { parentRef: up } : {}), depth: level })
  }
  return out
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
  actionSets: ActionGroups[]
  elements: CompactElement[]
}

/**
 * 字典里的一项：一个控件的动作表按投递方式分组。
 *
 * 键是 `delivery` 的取值，一个动作有多种投递方式时按字母序用 `+` 连起来；值是这一组的
 * 动作名，顺序同端口交回的动作表。`delivery` 为空的动作放进 `unavailable`，值是原因。
 * 组与组之间不保留原顺序：按投递方式列同一组动作名只写一次，动作名的相对顺序对调用方
 * 不构成约定。
 */
type ActionGroups = Record<string, string[] | Record<string, string>>

/** 一个动作表的字典形状。组的键按字母序，`unavailable` 在最后，同一张表只有一种写法。 */
function groupsOf(actions: Actions): ActionGroups {
  const groups = new Map<string, string[]>()
  const unavailable: Record<string, string> = {}
  let blocked = false
  for (const a of actions) {
    if (a.delivery.length === 0) {
      unavailable[a.action] = a.unavailable ?? ''
      blocked = true
      continue
    }
    const key = [...a.delivery].sort().join('+')
    groups.set(key, [...(groups.get(key) ?? []), a.action])
  }
  const out: ActionGroups = {}
  for (const key of [...groups.keys()].sort()) out[key] = groups.get(key) ?? []
  if (blocked) out.unavailable = unavailable
  return out
}

/** 动作字典。下标按第一次登记的先后编号，同一个结果里一种分组只占一个下标。 */
class ActionSets {
  readonly list: ActionGroups[] = []
  #index = new Map<string, number>()

  /** 这个动作表的下标、字典形状，以及它是不是还没登记过。只查不登记。 */
  peek(actions: Actions): { index: number; fresh: boolean; groups: ActionGroups } {
    const groups = groupsOf(actions)
    const known = this.#index.get(JSON.stringify(groups))
    return known === undefined
      ? { index: this.list.length, fresh: true, groups }
      : { index: known, fresh: false, groups }
  }

  add(actions: Actions): number {
    const { index, fresh, groups } = this.peek(actions)
    if (fresh) {
      this.#index.set(JSON.stringify(groups), index)
      this.list.push(groups)
    }
    return index
  }
}

/** 整份控件表的投递形状。 */
function pack(elements: readonly DesktopElement[], includeRect: boolean): Packed {
  const sets = new ActionSets()
  const packed = elements.map((e) => compactOf(e, sets.add(e.actions), includeRect))
  return { defaults: DEFAULTS, actionSets: sets.list, elements: packed }
}

/** 一个控件的投递形状。`element` 可以是已经留了前缀的那一份，省略字数随之带上。 */
function compactOf(
  element: DesktopElement & { nameOmittedChars?: number; valueOmittedChars?: number },
  actionSet: number,
  includeRect: boolean,
): CompactElement {
  const {
    actions: _actions,
    parentRef: _parentRef,
    rect,
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
    ...(includeRect && rect !== undefined ? { rect } : {}),
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
 * 大表视图选谁：本次动作目标、当前焦点控件及它们的祖先优先，其余按原始顺序补到上限为止。
 *
 * **控件不从中间切开**：超长的名称与值先留前缀，装不下就停。优先那几个一律装入——
 * 目标不在视图里，模型就只能再观察一次。输出按原始顺序；其余部分是原始顺序的前缀，
 * 优先那几个连同祖先一起装入，视图里每个控件列出的祖先因此都在视图里，层级按 `depth`
 * 读得出。一个控件的成本含它第一次带进字典的那个动作表。
 */
function pickView(
  elements: readonly DesktopElement[],
  priority: ReadonlySet<string>,
  budget: number,
  density: TokenDensity,
  includeRect: boolean,
): Packed {
  const queue = [
    ...elements.filter((e) => priority.has(e.ref)),
    ...elements.filter((e) => !priority.has(e.ref)),
  ]
  const sets = new ActionSets()
  const chosen = new Map<string, CompactElement>()
  let left = budget
  for (const element of queue) {
    const shown = boundedFields(element)
    const { index, fresh, groups } = sets.peek(element.actions)
    const item = compactOf(shown, index, includeRect)
    const cost = costOf(item, density) + (fresh ? costOf(groups, density) : 0)
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

/**
 * 是结构容器也照列的那几个：本次动作目标与当前焦点控件本身。
 *
 * 它们的无名祖先照常省掉：`depth` 按列出的祖先计，省掉之后层级仍然读得出。
 */
function keptAnyway(elements: readonly DesktopElement[], targetRef: string | null): string[] {
  return elements.filter((e) => e.ref === targetRef || e.focused === true).map((e) => e.ref)
}

/**
 * 大表视图里不受上限约束的那几个：本次动作目标、当前焦点控件，以及它们的祖先。
 *
 * 按端口交回的整份表走 `parentRef`，在省掉结构容器之前算。其中被省掉的容器不在视图里，
 * 其余的连同祖先一起装入。
 */
function priorityOf(elements: readonly DesktopElement[], targetRef: string | null): Set<string> {
  const byRef = new Map(elements.map((e) => [e.ref, e]))
  const priority = new Set<string>()
  const takeWithAncestors = (element: DesktopElement | undefined): void => {
    let at = element
    while (at !== undefined && !priority.has(at.ref)) {
      priority.add(at.ref)
      at = at.parentRef === undefined ? undefined : byRef.get(at.parentRef)
    }
  }
  takeWithAncestors(targetRef === null ? undefined : byRef.get(targetRef))
  for (const element of elements) {
    if (element.focused === true) takeWithAncestors(element)
  }
  return priority
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
