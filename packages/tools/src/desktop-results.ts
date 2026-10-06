/**
 * desktop 四个出口的结果生成。
 *
 * 控件表未超出单次投递上限时整份内联，超出时整份存盘，结果中放入部分控件与规范资源
 * 引用；动作与等待之后的重读在条件成立时只投递与上一份整份投递相比的变化。七条边界：
 *
 * 1. **判定阈值与视图上限是同一个数**，按 `deliveredTokens` 计量整条结果：控件、观察
 *    元数据、回执、message 与资源引用都计算在内。只计量元素数组会把回执与长 message
 *    遗漏在上限之外。上限取单次投递上限本身，不要改成 browser 那样按比例缩小：多数整窗控件表
 *    会因此分页，位于尾部的动作目标在首次读取时不在视图中，分页的结果也无法作为差异基底。
 *    历史中的控件表只追加，累积量由精简投递、差异投递与压缩承担。
 * 2. **动作判定与回读核验不使用此处的视图**，它们使用端口返回的完整控件表。
 * 3. **采集侧与投递侧分别列出**：`truncated` / `truncatedBy` / `filteredBy` 表示未采集到，
 *    `delivery` 表示已采集但未投递。两者不能合并为一个字段。
 * 4. **图像字节不经过此处**：它经由 `data.images`，既不计入上限，也不写入存盘正文。
 * 5. **按角色或文字筛选只作用于视图**：观察编号与控件表是端口返回的整份，筛选出的控件与
 *    其余控件的 `ref` 同样可以直接使用。存盘正文是整份控件表。
 * 6. **投递形状只有一种**：`actions` 按投递方式分组、去重为 `actionSets`，控件上只保留下标；
 *    省略与 `defaults` 相同的字段；`rect` 只在调用方要求时提供；无名结构容器不列出，
 *    `depth` 按列出的祖先计算。小表与大表的视图形状相同，字典随每个结果附带。
 *    存盘正文仍是每行一个完整原始控件，不依赖字典。
 * 7. **差异只相对于一份仍在上下文中的整份投递**：本 run、同窗口、同读取范围、未筛选、未分页、
 *    不带 `rect` 的那一份；逐字未变的控件过半；该基底与之后各次差异累计不超过单次上限，
 *    因此压缩保留的尾部（两倍单次上限）能够容纳它们；基底之后本 run 没有完成过压缩（尾部按
 *    全部消息计算，其他工具的大结果可能使基底移出保留范围）。任一条不成立即整份投递并成为新基底。
 */

import {
  compactionEpoch,
  type DesktopElement,
  type DesktopSnapshot,
  deliveredTokens,
  recordBatchSpent,
  type ToolContext,
} from '@qywork/agent'
import type { TokenDensity } from '@qywork/ai'
import type { IntermediateResourceRef, ResourceId } from '@qywork/core'
import { deliver, type LandedResult, observationBudget, viewLimit } from './sink.ts'

/** 存盘正文：一行一个 JSON 值。 */
const JSONL_MIME = 'application/x-ndjson'
const SOURCE_TYPE = 'desktop:observation'
/**
 * 骨架估算时为 resource id 预留的长度。
 *
 * 实际 id 在存盘之后才生成，而视图必须在存盘之前选定。取 32 字符作为上界：高估只使视图
 * 少容纳一个控件，低估会使结果超出上限。
 */
const ID_ESTIMATE = 'r'.repeat(32)
/**
 * 视图中窗口标题与控件名称、值各自最多保留的字数。
 *
 * 取 200，与 message 中控件值的上限同一量级。这些字段由窗口与应用自行报告，长度无上限，而上限
 * 按整条结果计量：一个长文本字段会耗尽视图预算，位于其后的控件均无法投递。只用于
 * 大表视图，完整原值在存盘正文中。
 */
export const MAX_TITLE_CHARS = 200

/**
 * 控件上缺失字段时取的值。每个结果都附带一份，模型读取结果时不依赖其他位置的约定。
 *
 * 取绝大多数控件的实际值：可用、可见、没有稳定标识。
 */
const DEFAULTS = { enabled: true, offscreen: false, automationId: '' } as const
/** 结构容器的角色。这几种控件没有名称与状态时只承载层级。 */
const CONTAINER_ROLES: ReadonlySet<string> = new Set(['pane', 'group', 'custom'])
/** `ctx.state` 中记录差异基底的键。`ctx.state` 是 run 级的：新 run 的第一次投递必然是整份投递。 */
const BASES_KEY = 'desktop:bases'
/**
 * 差异投递要求与基底逐字相同的控件所占的最低比例，分母取基底与本份中控件数较多者。
 *
 * 低于该比例说明界面已大幅变化（页面跳转、更换对话框），整份投递更易读，且成为新基底。
 */
const MIN_UNCHANGED_SHARE = 0.5

type DesktopResultContext = Pick<
  ToolContext,
  'sink' | 'contextWindow' | 'density' | 'state' | 'desktop'
>

type Actions = DesktopElement['actions']

/**
 * 交给模型的控件：`actions` 替换为 `actionSets` 的下标，省略与 `DEFAULTS` 相同的字段。
 * 大表视图中超长的名称与值只保留前缀，并标明省略的字数。
 *
 * 不含 `parentRef`：控件按前序排列，父控件是前面最近的、`depth` 小一层的控件。额外附带
 * 父控件引用约占控件表的四分之一，且每一步都是新内容，无法命中缓存。`rect` 只在
 * `includeRect` 为真时提供：它约占控件表的五分之一，按控件执行动作与确定采集区域都不读取投递中的该字段。
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

/** 投递事实。与采集侧的 `truncated` / `filteredBy` 含义不同。 */
interface Delivery {
  deliveredElements: number
  totalElements: number
  /** 仅在存盘成功时存在：按它读取完整控件表。 */
  resourceId?: string
  /** 仅在存盘失败时存在：失败原因。未返回的控件此后无法读取。 */
  unsaved?: string
}

export interface DesktopResultInput {
  ctx: DesktopResultContext
  toolName: string
  snapshot: DesktopSnapshot
  /** 观察放在 `data` 顶层（observe），还是 `data.observation` 下（act / wait / sequence）。 */
  place: 'top' | 'observation'
  /** 结果中除观察以外的字段：回执、步骤表、found。 */
  receipt?: Record<string, unknown>
  /** 本次动作的目标控件，它及其祖先优先进入视图。没有目标时为 null。 */
  targetRef?: string | null
  /** 视图只列命中这些条件的控件及其祖先。 */
  filter?: ViewFilter
  /** 控件是否包含 `rect`。缺失时不包含。 */
  includeRect?: boolean
  /**
   * 动作与等待之后的重读传 true：条件成立时只投递与上一份整份投递相比的变化。
   * `desktop_observe` 不传，一律整份投递：模型主动观察时需要整张表。
   */
  incremental?: boolean
  /** message 的执行事实部分。控件内容不进入 message。 */
  lead: string
  /** 上限，缺省取单份视图尺寸（`observationBudget`）与剩余额度的较小者。 */
  limit?: number
}

/** 视图的筛选条件。`query` 匹配名称、稳定标识与值，不区分大小写。 */
export interface ViewFilter {
  role?: string
  query?: string
}

export interface DesktopResultParts {
  message: string
  data: Record<string, unknown>
  resources?: IntermediateResourceRef[]
}

/**
 * 把一份观察与本次回执合成为工具结果。四个出口都只经由此入口。
 *
 * 无法保存的部分如实说明：没有 sink 或写入失败时不提供地址，执行事实保持不变。
 */
export function desktopResult(input: DesktopResultInput): DesktopResultParts {
  const { ctx } = input
  const { shown: snapshot, hits } = viewOf(input.snapshot, input.filter)
  const receipt = {
    ...input.receipt,
    ...(ctx.desktop ? { foregroundEnabled: ctx.desktop.foregroundEnabled() } : {}),
  }
  const limit = input.limit ?? viewLimit(ctx, observationBudget(ctx.contextWindow))
  const lead = input.filter ? `${input.lead} · ${filterNote(snapshot)}` : input.lead
  const shaped = { ...input, snapshot, lead }
  const includeRect = input.includeRect === true

  const { elements: read, ...meta } = snapshot
  const targetRef = input.targetRef ?? null
  const elements = listable(read, new Set([...keptAnyway(read, targetRef), ...hits]))
  // 筛选后的视图不修改基底。
  const bases = input.filter ? null : basesOf(ctx)
  const key = baseKeyOf(snapshot)
  const rows = bases ? new Map(elements.map((e) => [e.ref, rowKey(e)])) : null

  if (input.incremental === true && bases && rows) {
    const known = bases.get(key)
    const base = known?.epoch === compactionEpoch(ctx.state) ? known : undefined
    const diff = base ? diffOf(base, elements, rows) : null
    if (base && diff) {
      const parts = diffParts(input, receipt, meta, diff)
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
  }
  const wholeTokens = tokensOf(whole, ctx.density)
  if (wholeTokens <= limit) {
    // 带 rect 的整份投递不作为基底：之后的差异不含 rect，未列出的控件在基底中的 rect 可能已经过时。
    if (bases && rows && !includeRect) {
      bases.set(key, {
        observationId: snapshot.observationId,
        rows,
        spent: wholeTokens,
        epoch: compactionEpoch(ctx.state),
      })
    } else bases?.delete(key)
    return recorded(ctx, whole)
  }
  bases?.delete(key)

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

/**
 * 模型已持有的一份整份控件表：本 run 中某个窗口、某个读取范围最近一次整份、未筛选、未分页的
 * 投递。差异投递以它为比较对象。
 *
 * 它只记录已投递的内容，不参与动作判定：动作仍按协调器返回的完整表核对。
 */
interface Base {
  observationId: string
  /** 编号 → 该行投递内容的比较串，见 `rowKey`。 */
  rows: Map<string, string>
  /** 该基底与之后各次差异共投递的 token 数。不超过单次上限时，基底才仍在压缩保留的尾部中。 */
  spent: number
  /** 基底投递时的压缩次数（`compactionEpoch`）。之后完成过压缩时，基底可能已被替换为信封，不再使用。 */
  epoch: number
}

/** 基底键（`baseKeyOf`）→ 基底。 */
type Bases = Map<string, Base>

function basesOf(ctx: DesktopResultContext): Bases {
  const known = ctx.state.get(BASES_KEY) as Bases | undefined
  if (known) return known
  const bases: Bases = new Map()
  ctx.state.set(BASES_KEY, bases)
  return bases
}

/**
 * 基底按窗口与读取范围分别记录，整窗读取没有读取范围。
 *
 * 一份未筛选的结果只更新对应的键：历史只追加，其他键的基底仍逐字保留在上下文中。
 */
function baseKeyOf(snapshot: DesktopSnapshot): string {
  return JSON.stringify([snapshot.windowId, snapshot.scope ?? null])
}

/**
 * 一行投递内容的比较串：投递形状（不含 `rect`）、其动作字典项与列出的父控件。
 *
 * 父控件必须计入：差异中的行不在原位置，更换父控件而其余字段不变的控件，只比较投递字段
 * 会被判定为未变化。
 */
function rowKey(e: DesktopElement): string {
  const { actionSet: _index, ...row } = compactOf(e, 0, false)
  return JSON.stringify({ ...row, parentRef: e.parentRef ?? null, actions: groupsOf(e.actions) })
}

/** 与基底相比的变化。`added` 与 `changed` 按本份中的顺序排列，`removed` 按基底中的顺序排列。 */
interface Diff {
  since: string
  unchanged: number
  added: DesktopElement[]
  changed: DesktopElement[]
  removed: string[]
}

/** 与基底相比的变化；逐字未变的控件不足 `MIN_UNCHANGED_SHARE` 时返回 `null`，改为整份投递。 */
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
 * 差异结果。观察元数据与整份投递相同，控件表替换为 `since` / `unchanged` 与三类变化。
 *
 * 行不在原位置，因此 `added` 与 `changed` 的每一行都附带 `parentRef`（列出的父控件）；
 * 字典只包含这两类行用到的项。
 */
function diffParts(
  input: DesktopResultInput,
  receipt: Record<string, unknown>,
  meta: Omit<DesktopSnapshot, 'elements'>,
  diff: Diff,
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
  }
}

/** 按视图条件筛选后的观察。没有条件时原样返回。 */
type ShownSnapshot = DesktopSnapshot & { viewFilter?: string[]; matched?: number }

/**
 * 视图只列出命中条件的控件及其祖先：不保留祖先时无法读出层级，也无法区分同名控件。
 * `matched` 是命中数，不含祖先；`hits` 是命中的控件，结构容器命中时同样列出。
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
 * 它们只承载层级。可用动作不参与判定：浏览器中几乎每个节点都带有 scroll_into_view 与
 * 指针动作，按动作判定则没有任何容器能被省略。
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
 * 投递给模型的控件：无名结构容器不列出，`keep` 中的照常列出；`depth` 改为列出的祖先个数，
 * `parentRef` 改为最近一个列出的祖先。
 *
 * 不要保留原 `depth`：省略容器后层数出现跳跃，其子控件会被解读为前一个兄弟控件的子控件。
 * 按列出的祖先计数，「父控件是前面最近的、depth 小一层的控件」对投递出的表仍然成立；
 * 未省略任何容器时它与原值相同。父控件不在表中的控件，这两个字段都沿用原值。
 */
function listable(
  elements: readonly DesktopElement[],
  keep: ReadonlySet<string>,
): DesktopElement[] {
  const levels = new Map<string, number>()
  /** 编号 → 控件自身（列出时）或其最近一个列出的祖先。 */
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

/** message 中的视图筛选事实：命中数，以及其余控件仍属于本次观察。 */
function filterNote(snapshot: ShownSnapshot): string {
  return `视图按 ${snapshot.viewFilter?.join(' ')} 列出命中的 ${snapshot.matched} 个控件及其祖先，其余控件仍在本次观察中`
}

/** 观察在 data 中的位置。两处的字段名与层级都由调用方的界面读取，不要移动。 */
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
 * 字典中的一项：一个控件的动作表按投递方式分组。
 *
 * 键是 `delivery` 的取值，一个动作有多种投递方式时按字母序用 `+` 连接；值是该组的
 * 动作名，顺序与端口返回的动作表相同。`delivery` 为空的动作放入 `unavailable`，值是原因。
 * 组间不保留原顺序：按投递方式分组后同一组动作名只写一次，动作名的相对顺序不构成
 * 对调用方的约定。
 */
type ActionGroups = Record<string, string[] | Record<string, string>>

/** 一个动作表的字典形状。组的键按字母序排列，`unavailable` 位于最后，同一张表只有一种写法。 */
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

/** 动作字典。下标按首次登记的先后编号，同一结果中每种分组只占一个下标。 */
class ActionSets {
  readonly list: ActionGroups[] = []
  #index = new Map<string, number>()

  /** 该动作表的下标、字典形状，以及它是否尚未登记。只查询，不登记。 */
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

/** 单个控件的投递形状。`element` 可以是已截取前缀的版本，省略字数随之附带。 */
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
  }
}

/**
 * 视图中的窗口标题：超过 `MAX_TITLE_CHARS` 时只保留前缀，并标明省略的字数。
 *
 * 只用于大观察路径。完整原值在存盘正文的第一行，可按 `delivery.resourceId` 读取；
 * 保留前缀而不整体删除该字段，是因为动作行上的窗口名取自该字段。
 */
function boundedTitle(snapshot: DesktopSnapshot): Record<string, unknown> {
  if (snapshot.title.length <= MAX_TITLE_CHARS) return { ...snapshot }
  return {
    ...snapshot,
    title: snapshot.title.slice(0, MAX_TITLE_CHARS),
    titleOmittedChars: snapshot.title.length - MAX_TITLE_CHARS,
  }
}

/** message 中的投递事实：已投递数量、其余部分的读取位置，或无法读取的原因。 */
function noteOf(delivery: Delivery): string {
  const head = `已投递 ${delivery.deliveredElements}/${delivery.totalElements} 个控件`
  if (delivery.resourceId !== undefined) {
    return `${head} · 完整控件表 ${delivery.resourceId}，用 read_resource 读取`
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
 * 字段缺失、null、false、0、空串原样保留：读取存盘正文时需要按字段和值与原观察核对。
 */
function jsonlBody(snapshot: DesktopSnapshot): Uint8Array {
  const { elements, ...meta } = snapshot
  const lines = [JSON.stringify(meta), ...elements.map((e) => JSON.stringify(e))]
  return new TextEncoder().encode(lines.join('\n'))
}

/**
 * 大表视图的选取规则：本次动作目标、当前焦点控件及其祖先优先，其余按原始顺序补入，直至达到上限。
 *
 * 控件不从中间截断：超长的名称与值先保留前缀，超出上限即停止。优先控件一律放入：
 * 目标不在视图中时，模型只能再观察一次。输出按原始顺序；其余部分是原始顺序的前缀，
 * 优先控件连同祖先一起放入，因此视图中每个控件列出的祖先都在视图中，层级可按 `depth`
 * 读出。一个控件的成本包含它首次带入字典的动作表。
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
 * 即使是结构容器也照常列出的控件：本次动作目标与当前焦点控件本身。
 *
 * 它们的无名祖先照常省略：`depth` 按列出的祖先计算，省略之后层级仍可读出。
 */
function keptAnyway(elements: readonly DesktopElement[], targetRef: string | null): string[] {
  return elements.filter((e) => e.ref === targetRef || e.focused === true).map((e) => e.ref)
}

/**
 * 大表视图中不受上限约束的控件：本次动作目标、当前焦点控件，以及它们的祖先。
 *
 * 按端口返回的整份表沿 `parentRef` 查找，在省略结构容器之前计算。其中被省略的容器不在视图中，
 * 其余控件连同祖先一起放入。
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

/** 超长的名称与值只保留前 `MAX_TITLE_CHARS` 字，并标明省略的字数。未超长的原样保留。 */
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

/** 一项在视图中占用的大小，含数组分隔符。 */
function costOf(item: unknown, density: TokenDensity): number {
  return deliveredTokens(`${JSON.stringify(item)},`, density)
}

/** 整条结果中交给模型部分的大小。 */
function tokensOf(parts: DesktopResultParts, density: TokenDensity): number {
  return deliveredTokens(JSON.stringify(parts), density)
}

/**
 * 结果确定后记录一次已投递用量。
 *
 * 记录实际投递量，允许超出本批预算：动作已经执行，按预算改报失败是向模型报告虚假结果。
 */
function recorded(ctx: DesktopResultContext, parts: DesktopResultParts): DesktopResultParts {
  recordBatchSpent(ctx, tokensOf(parts, ctx.density))
  return parts
}
