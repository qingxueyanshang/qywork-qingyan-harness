/**
 * browser 观察与选项页的结果生产。
 *
 * 页面小的整份内联，格式不变；大的整份存盘，结果里放前面一部分元素加规范资源引用。
 * 四条边界：
 *
 * 1. **判定线与视图上限是同一个数**（`observationResultBudget`），按 `deliveredTokens`
 *    量整条结果——元素、观察元数据、动作回执、message 与资源引用都算在内。
 *    只量元素表会把回执与长 message 漏在上限之外。
 * 2. **视图按本次顺序装，不认目标。** 元素 `ref` 是这一次观察内的序号（重新观察即重新
 *    编号），动作回执里的 `element` 是页面自报的标签文本。不要拿它们去认新观察里的节点：
 *    同名同序号的另一个节点会被当成目标，而那正是模型下一步要点的那一个。
 * 3. **采集侧与投递侧分列**：`truncated` / `framesPending` / `optionsTruncated` /
 *    `nextOffset` 说的是没采到，`delivery` 说的是采到了没投。两者不能合并成一格。
 * 4. **截图字节不进这里**：它走 `data.images`，既不计入上限也不写进存盘正文。
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
import { deliver, type LandedResult, observationResultBudget } from './sink.ts'

/** 存盘正文：一行一个 JSON 值。 */
const JSONL_MIME = 'application/x-ndjson'
/**
 * 骨架估算时给 resource id 留的位置。
 *
 * 真 id 在存盘之后才有，而视图要在存盘之前选好。取 32 字符是上界：高估只让视图
 * 少装一个元素，低估会让结果越过上限。
 */
const ID_ESTIMATE = 'r'.repeat(32)
/**
 * 视图里页面标题与网址各自最多留多少字。
 *
 * 取 200，与采集侧对元素名称、正文的上限同一量级。页面自报的标题与网址长度无界
 * （data URL 可以有几万字），而上限按整条结果计量：5,000 字的标题加 5,000 字的网址
 * 就能把视图预算吃光，元素一个都投不出去。
 */
export const MAX_META_CHARS = 200

type BrowserResultContext = Pick<ToolContext, 'sink' | 'contextWindow' | 'density' | 'state'>

/** 端口一次观察的两种返回。 */
export type BrowserPage = BrowserObservation | BrowserOptionsPage

/** 选项页与元素表按形状分：只有选项页带 `items`。 */
export function isOptionsPage(page: BrowserPage): page is BrowserOptionsPage {
  return 'items' in page
}

/** 投递事实。与采集侧的 `truncated` / `optionsTruncated` 是两回事。 */
interface Delivery {
  /** 结果里给了多少项。视图是本次表的前 N 项，顺序不变。 */
  delivered: number
  /** 本次采到多少项。选项页顶层的 `total` 是这个 select 一共有多少选项，与它无关。 */
  collected: number
  /** 存盘成功才有：完整的表按它读。 */
  resourceId?: string
  /** 存盘没成功才有：原因。未返回的那些项此后读不回来。 */
  unsaved?: string
}

export interface BrowserResultInput {
  ctx: BrowserResultContext
  toolName: string
  /** 本次观察或选项页。 */
  page: BrowserPage
  /** 排在观察之前的动作回执。 */
  receipt?: Record<string, unknown>
  /** 快照是在什么条件下采的，排在观察之后。 */
  settle?: 'quiet' | 'deadline'
  /** message 的执行事实部分。元素内容不进 message。 */
  lead: string
  /** 上限，缺省取 `observationResultBudget(ctx.contextWindow)`。 */
  limit?: number
}

/** 结果里由这一份观察定稿的那三格。 */
export type BrowserResultParts = Pick<ToolOutcome, 'message' | 'data' | 'resources'>

/**
 * 把一份观察或选项页与本次回执合成工具结果。**五个出口只有这一个入口。**
 *
 * 存不下的部分照实说：没有 sink 或写失败时不给地址，动作回执一个字不改。
 */
export function browserResult(input: BrowserResultInput): BrowserResultParts {
  const { ctx, page } = input
  const limit = input.limit ?? observationResultBudget(ctx.contextWindow)
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
 * 一页拆成五格：表的键名、表本身、去掉截图的整页、去掉表的元数据、截图。
 *
 * 观察与选项页只有这一处按形状分叉，下游按拆出来的五格走，不再判一次。
 * `rest` 保留原字段次序，表仍在原位——整份内联那条路径靠它逐字不变。
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
 * 结果的三格。`trimmed` 为 null 即整份内联，此时 `data` 与端口交回的那一份逐字相同。
 *
 * 回执在前、观察展开在中、`settle` 在后：这个次序由调用方那一侧的界面消费，不要挪。
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
 * 视图里的页面元数据：超长的标题与网址只留前 `MAX_META_CHARS` 字，并标明省掉多少字。
 *
 * 只用在大页路径上。完整原值在存盘正文的第一行，按 `delivery.resourceId` 读得回来；
 * 小页整份内联，这两格逐字不变。
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

/** message 里的投递事实：给了多少、其余在哪读，或者为什么读不回来。 */
function noteOf(page: BrowserPage, delivery: Delivery): string {
  const unit = isOptionsPage(page) ? '选项' : '元素'
  const head = `已投 ${delivery.delivered}/${delivery.collected} 个${unit}`
  if (delivery.resourceId !== undefined) {
    return `${head} · 完整${unit}表 ${delivery.resourceId}，用 read_resource 读`
  }
  return `${head} · 完整${unit}表未保存 · ${delivery.unsaved} · 未返回的部分无法回读`
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
 * 存盘正文：第一行是这一页的全部非元素元数据，之后每行一个完整元素，顺序不变。
 *
 * 字段缺席、null、false、0、空串原样保留——回读要按字段和值与原观察核对，
 * 而 `checked` / `expanded` / `selected` 缺席表示这个角色没有这一项，补 false 是另一个意思。
 * 截图不在正文里，见文件头第 4 条。
 */
function jsonlBody(page: BrowserPage): Uint8Array {
  const { list, meta } = split(page)
  const lines = [JSON.stringify(meta), ...list.map((item) => JSON.stringify(item))]
  return new TextEncoder().encode(lines.join('\n'))
}

/**
 * 视图装本次表的前几项，装到上限为止。
 *
 * **项不从中间切开**，装不下的那一项之后也不再往下找：视图因此始终是本次表的前缀，
 * 「已投 N/M」说得出投的是哪几项。不按目标排序的理由见文件头第 2 条。
 */
function pickView(
  list: readonly unknown[],
  budget: number,
  density: TokenDensity,
): readonly unknown[] {
  const view: unknown[] = []
  let left = budget
  for (const item of list) {
    // 含数组分隔符。
    const cost = deliveredTokens(`${JSON.stringify(item)},`, density)
    if (cost > left) break
    view.push(item)
    left -= cost
  }
  return view
}

/**
 * 整条结果的 token 数，**不含 `images`**。
 *
 * 截图按图像块发出，不进信封文本（`agent/loop.ts` 组装工具结果时按 `images` 取图），
 * 按文本量等于把一兆多的 base64 算进上限：小页会被判成大页去存盘，大页的视图预算
 * 变成负数，一个元素都投不出去。大小判定、视图预算与记账都用这一把尺。
 */
function tokensOf(parts: BrowserResultParts, density: TokenDensity): number {
  const { images, ...data } = parts.data ?? {}
  return deliveredTokens(JSON.stringify({ ...parts, data }), density)
}

/**
 * 结果定稿后记一次已投递用量。
 *
 * 记的是实际投了多少，允许越过本波预算：动作已经执行，按预算改报失败等于骗模型。
 */
function recorded(ctx: BrowserResultContext, parts: BrowserResultParts): BrowserResultParts {
  recordBatchSpent(ctx, tokensOf(parts, ctx.density))
  return parts
}
