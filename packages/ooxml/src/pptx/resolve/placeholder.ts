/**
 * 占位符匹配：幻灯片占位符 → 版式占位符 → 母版占位符，以及占位符类型对应的母版文本样式。
 *
 * - 类别：`title` 与 `ctrTitle` 为标题类；`body`、`subTitle`、`obj`、`chart`、`tbl`、`clipArt`、`dgm`、`media`、`pic`
 *   为正文类；其余类型各自成类。
 * - 幻灯片 → 版式：只按 `idx` 匹配，并要求类型兼容。幻灯片占位符为 `body`、`obj`、`subTitle` 时，可匹配同 `idx` 的
 *   任一正文类版式占位符（类型相同者优先）；其余类型要求类型相同（`title` 与 `ctrTitle` 互不匹配）。
 *   没有 `idx` 匹配时不按类型在版式中查找。以上为 WPS 实测：没有 `idx` 的 `dt` 不匹配版式中 `idx` 为 10 的 `dt`，
 *   `pic`、`tbl` 不匹配同 `idx` 的 `obj`，`chart` 不匹配同 `idx` 的 `body`。
 * - 版式 → 母版：先取类型相同者，再按类别取母版的 `title` 或 `body`（`ctrTitle` → `title`，正文类 → `body`）。
 *   母版每种类型只有一个占位符，不比较 `idx`。版式中没有匹配的幻灯片占位符同样按此规则直接匹配母版。
 * - 只在部件的顶层形状中查找：占位符不位于组合内。
 * - 文本样式：标题类取 `titleStyle`，正文类取 `bodyStyle`，其余占位符与非占位符形状归入 `other`（由调用方取 `defaultTextStyle`）。
 */

import type { PlaceholderType } from '../model.ts'
import type { RawPlaceholder, RawShape } from '../parse/shape.ts'

const TITLE_CLASS = new Set<PlaceholderType>(['title', 'ctrTitle'])
const BODY_CLASS = new Set<PlaceholderType>([
  'body',
  'subTitle',
  'obj',
  'chart',
  'tbl',
  'clipArt',
  'dgm',
  'media',
  'pic',
])
/** 可放入任一正文类版式占位符的幻灯片占位符类型。 */
const TEXT_TYPES = new Set<PlaceholderType>(['body', 'obj', 'subTitle'])

function typeClass(type: PlaceholderType): string {
  if (TITLE_CLASS.has(type)) return 'title'
  if (BODY_CLASS.has(type)) return 'body'
  return type
}

function placeholders(shapes: readonly RawShape[]): (RawShape & { placeholder: RawPlaceholder })[] {
  return shapes.filter(
    (s): s is RawShape & { placeholder: RawPlaceholder } => s.placeholder !== null,
  )
}

export function matchLayoutPlaceholder(
  ph: RawPlaceholder,
  shapes: readonly RawShape[],
): RawShape | null {
  const compatible = TEXT_TYPES.has(ph.type)
    ? (t: PlaceholderType) => BODY_CLASS.has(t)
    : (t: PlaceholderType) => t === ph.type
  const byIdx = placeholders(shapes).filter(
    (s) => s.placeholder.idx === ph.idx && compatible(s.placeholder.type),
  )
  return byIdx.find((s) => s.placeholder.type === ph.type) ?? byIdx[0] ?? null
}

export function matchMasterPlaceholder(
  ph: RawPlaceholder,
  shapes: readonly RawShape[],
): RawShape | null {
  const list = placeholders(shapes)
  const exact = list.find((s) => s.placeholder.type === ph.type)
  if (exact !== undefined) return exact
  const cls = typeClass(ph.type)
  if (cls !== 'title' && cls !== 'body') return null
  return list.find((s) => s.placeholder.type === cls) ?? null
}

/** 文本样式的类别：标题类为 `title`，正文类为 `body`，其余占位符与非占位符形状为 `other`。 */
export function textStyleKind(ph: RawPlaceholder | null): 'title' | 'body' | 'other' {
  if (ph === null) return 'other'
  const cls = typeClass(ph.type)
  return cls === 'title' ? 'title' : cls === 'body' ? 'body' : 'other'
}
