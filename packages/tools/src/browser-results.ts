/**
 * 生成 browser 观察与选项页的工具结果。
 *
 * 小页面整份内联，格式不变；大页面整份写入正文库，结果中放入前一部分元素与规范的资源引用。
 * 四条边界：
 *
 * 1. 判定阈值与视图上限是同一个数（`observationResultBudget`），按 `deliveredTokens`
 *    计量整条结果：元素、观察元数据、动作回执、message 与资源引用都计算在内。
 *    只计量元素表会使回执与较长的 message 超出上限。
 * 2. 视图按本次顺序装入，不按目标选取。元素 `ref` 是本次观察内的序号（重新观察即重新
 *    编号），动作回执中的 `element` 是页面自报的标签文本。不要用它们识别新观察中的节点：
 *    同名同序号的另一个节点会被当作目标，而它可能正是模型下一步要点击的节点。
 * 3. 采集侧与投递侧分别记录：`truncated` / `framesPending` / `optionsTruncated` /
 *    `nextOffset` 表示未采集到，`delivery` 表示已采集但未投递。两者不能合并为一个字段。
 * 4. 截图字节不在此处处理：截图经由 `data.images` 发送，既不计入上限，也不写入存盘正文。
 */

import {
  type BrowserObservation,
  type BrowserOptionsPage,
  deliveredTokens,
  recordBatchSpent,
  type ToolContext,
  type ToolOutcome,
} from '@qywork/agent'
import type { TokenDensity } from '@qywork/ai'
import type { IntermediateResourceRef, ResourceId } from '@qywork/core'
import { deliver, type LandedResult, observationResultBudget, viewLimit } from './sink.ts'

/** 存盘正文：每行一个 JSON 值。 */
const JSONL_MIME = 'application/x-ndjson'
/**
 * 估算结果骨架时为 resource id 预留的位置。
 *
 * 实际 id 在存盘之后才产生，而视图必须在存盘之前选定。取 32 字符作为上限：高估只会使视图
 * 少装入一个元素，低估会使结果超出上限。
 */
const ID_ESTIMATE = 'r'.repeat(32)
/**
 * 视图中页面标题、网址与元素的名称、值、正文各自保留的最大字数。
 *
 * 这些字段长度没有上限（data URL、长文本框的值可达数万字），而上限按整条结果计量：
 * 一个 5,000 字的字段即可耗尽视图预算，使任何元素都无法投递。只在大页视图中生效，
 * 完整原值在存盘正文中。
 */
export const MAX_META_CHARS = 200

type BrowserResultContext = Pick<ToolContext, 'sink' | 'contextWindow' | 'density' | 'state'>

/** 端口单次观察的两种返回类型。 */
export type BrowserPage = BrowserObservation | BrowserOptionsPage

/** 按结构区分选项页与元素表：只有选项页带 `items`。 */
export function isOptionsPage(page: BrowserPage): page is BrowserOptionsPage {
  return 'items' in page
}

/** 投递信息。与采集侧的 `truncated` / `optionsTruncated` 含义不同。 */
interface Delivery {
  /** 结果中包含的项数。视图是本次表的前 N 项，顺序不变。 */
  delivered: number
  /** 本次采集到的项数。选项页顶层的 `total` 是该 select 的选项总数，与本字段无关。 */
  collected: number
  /** 仅在存盘成功时存在：完整的表按此 id 读取。 */
  resourceId?: string
  /** 仅在存盘失败时存在：失败原因。未返回的项此后无法读取。 */
  unsaved?: string
}

export interface BrowserResultInput {
  ctx: BrowserResultContext
  toolName: string
  /** 本次观察或选项页。 */
  page: BrowserPage
  /** 排在观察之前的动作回执。 */
  receipt?: Record<string, unknown>
  /** 快照的采集条件，排在观察之后。 */
  settle?: 'quiet' | 'deadline'
  /** message 中的执行事实部分。元素内容不写入 message。 */
  lead: string
  /** 上限，缺省取 `observationResultBudget(ctx.contextWindow)` 与剩余额度的较小者。 */
  limit?: number
}

/** 结果中由本次观察确定的三个字段。 */
export type BrowserResultParts = Pick<ToolOutcome, 'message' | 'data' | 'resources'>

/**
 * 将一份观察或选项页与本次回执合成为工具结果。五个出口共用此入口。
 *
 * 无法保存的部分如实说明：没有 sink 或写入失败时不提供地址，动作回执不做任何修改。
 */
export function browserResult(input: BrowserResultInput): BrowserResultParts {
  const { ctx, page } = input
  const limit = input.limit ?? viewLimit(ctx, observationResultBudget(ctx.contextWindow))
  const { list } = split(page)

  const whole = assemble(input, null)
  if (tokensOf(whole, ctx.density) <= limit) return recorded(ctx, whole)

  const body = jsonlBody(page)
  const skeleton = assemble(
    input,
    {
      view: [],
      delivery: { delivered: list.length, collected: list.length, resourceId: ID_ESTIMATE },
    },
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
  const view = pickView(list, limit - tokensOf(skeleton, ctx.density), ctx.density)

  const excerpt = JSON.stringify(view)
  const landed = deliver(ctx.sink, {
    toolName: input.toolName,
    sourceType: isOptionsPage(page) ? 'browser:options' : 'browser:observation',
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
      assemble(input, {
        view,
        delivery: {
          delivered: view.length,
          collected: list.length,
          unsaved: landed.landError ?? '本次执行没有正文库',
        },
      }),
    )
  }
  return recorded(
    ctx,
    assemble(
      input,
      {
        view,
        delivery: {
          delivered: view.length,
          collected: list.length,
          resourceId: landed.resourceId,
        },
      },
      [resourceRef(landed)],
    ),
  )
}

/**
 * 将一页拆分为五部分：表的键名、表本身、去掉截图的整页、去掉表的元数据、截图。
 *
 * 观察与选项页只在此处按结构分支，下游使用拆分出的五部分，不再重复判断。
 * `rest` 保留原字段顺序，表仍在原位：整份内联路径依赖它保持逐字不变。
 */
function split(page: BrowserPage): {
  key: 'elements' | 'items'
  list: readonly unknown[]
  rest: Record<string, unknown>
  meta: Record<string, unknown>
  image: { data: string; mime: string } | null
} {
  if (isOptionsPage(page)) {
    const { items, ...meta } = page
    return { key: 'items', list: items, rest: { ...page }, meta, image: null }
  }
  const { image, ...rest } = page
  const { elements, ...meta } = rest
  return { key: 'elements', list: elements, rest, meta, image: image ?? null }
}

/**
 * 结果的三个字段。`trimmed` 为 null 即整份内联，此时 `data` 与端口返回的内容逐字相同。
 *
 * 回执在前、展开的观察居中、`settle` 在后：调用方的界面依赖该顺序，不要调整。
 */
function assemble(
  input: BrowserResultInput,
  trimmed: { view: readonly unknown[]; delivery: Delivery } | null,
  resources: IntermediateResourceRef[] = [],
): BrowserResultParts {
  const { key, rest, image } = split(input.page)
  const page =
    trimmed === null
      ? rest
      : { ...boundedMeta(rest), [key]: trimmed.view, delivery: trimmed.delivery }
  return {
    message:
      trimmed === null ? input.lead : `${input.lead} · ${noteOf(input.page, trimmed.delivery)}`,
    data: {
      ...input.receipt,
      ...page,
      ...(image ? { images: [image] } : {}),
      ...(input.settle ? { settle: input.settle } : {}),
    },
    ...(resources.length ? { resources } : {}),
  }
}

/**
 * 视图中的页面元数据：超长的标题与网址只保留前 `MAX_META_CHARS` 字，并标明省略的字数。
 *
 * 只用于大页路径。完整原值在存盘正文的第一行，可按 `delivery.resourceId` 读取；
 * 小页整份内联，这两个字段逐字不变。
 */
function boundedMeta(rest: Record<string, unknown>): Record<string, unknown> {
  const bounded = { ...rest }
  for (const key of ['title', 'url'] as const) {
    const value = rest[key]
    if (typeof value !== 'string' || value.length <= MAX_META_CHARS) continue
    bounded[key] = value.slice(0, MAX_META_CHARS)
    bounded[`${key}OmittedChars`] = value.length - MAX_META_CHARS
  }
  return bounded
}

/** message 中的投递信息：已投递的数量、其余部分的读取位置，或无法读取的原因。 */
function noteOf(page: BrowserPage, delivery: Delivery): string {
  const unit = isOptionsPage(page) ? '选项' : '元素'
  const head = `已投递 ${delivery.delivered}/${delivery.collected} 个${unit}`
  if (delivery.resourceId !== undefined) {
    return `${head} · 完整${unit}表 ${delivery.resourceId}，用 read_resource 读取`
  }
  return `${head} · 完整${unit}表未保存 · ${delivery.unsaved} · 未返回的部分无法读取`
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
 * 存盘正文：第一行是该页的全部非元素元数据，之后每行一个完整元素，顺序不变。
 *
 * 字段缺失、null、false、0、空串均原样保留：读取时需要按字段和值与原观察核对，
 * 而 `checked` / `expanded` / `selected` 缺失表示该角色没有此属性，补 false 会改变含义。
 * 截图不在正文中，见文件头第 4 条。
 */
function jsonlBody(page: BrowserPage): Uint8Array {
  const { list, meta } = split(page)
  const lines = [JSON.stringify(meta), ...list.map((item) => JSON.stringify(item))]
  return new TextEncoder().encode(lines.join('\n'))
}

/**
 * 视图装入本次表的前若干项，直至达到上限。
 *
 * 每项的超长字段先由 `boundedItem` 截取前缀；项不从中间切开，遇到无法装入的项后不再
 * 继续查找：视图因此始终是本次表的前缀，「已投递 N/M」能准确对应投递的项。不按目标排序的
 * 理由见文件头第 2 条。
 */
function pickView(
  list: readonly unknown[],
  budget: number,
  density: TokenDensity,
): readonly unknown[] {
  const view: unknown[] = []
  let left = budget
  for (const item of list) {
    const shown = boundedItem(item)
    // 含数组分隔符。
    const cost = deliveredTokens(`${JSON.stringify(shown)},`, density)
    if (cost > left) break
    view.push(shown)
    left -= cost
  }
  return view
}

/**
 * 视图中的一项：超长的 name / value / text 只保留前 `MAX_META_CHARS` 字，并标明省略的字数。
 *
 * 采集侧保留原值，查询按原值匹配。不要删除这一步：一个超长字段会使 `pickView` 在该项处
 * 停止，其后的项均无法投递。
 */
function boundedItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item
  const record = item as Record<string, unknown>
  let bounded: Record<string, unknown> | null = null
  for (const key of ['name', 'value', 'text'] as const) {
    const value = record[key]
    if (typeof value !== 'string' || value.length <= MAX_META_CHARS) continue
    bounded ??= { ...record }
    bounded[key] = value.slice(0, MAX_META_CHARS)
    bounded[`${key}OmittedChars`] = value.length - MAX_META_CHARS
  }
  return bounded ?? item
}

/**
 * 整条结果的 token 数，不含 `images`。
 *
 * 截图以图像块发送，不进入信封文本（`agent/loop/request.ts` 组装工具结果时按 `images` 取图），
 * 按文本计量等于将超过 1 MB 的 base64 计入上限：小页会被判定为大页而存盘，大页的视图预算
 * 变为负数，任何元素都无法投递。大小判定、视图预算与记账都使用同一计量方式。
 */
function tokensOf(parts: BrowserResultParts, density: TokenDensity): number {
  const { images: _images, ...data } = parts.data ?? {}
  return deliveredTokens(JSON.stringify({ ...parts, data }), density)
}

/**
 * 结果确定后记录一次已投递用量。
 *
 * 记录的是实际投递量，允许超出本批预算：动作已经执行，按预算改报失败会向模型报告错误的结果。
 */
function recorded(ctx: BrowserResultContext, parts: BrowserResultParts): BrowserResultParts {
  recordBatchSpent(ctx, tokensOf(parts, ctx.density))
  return parts
}
