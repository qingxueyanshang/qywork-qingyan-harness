/**
 * 单张幻灯片的求值上下文：主题、生效的颜色映射、所属版式与母版、默认文本样式与表格样式。
 * 样式矩阵引用的求值见 `../../drawingml/shape/resolve.ts`。
 *
 * - 未实现的元素在求值过程中累加到 `found`：母版与版式上的形状在每张显示它的幻灯片上各计一次。
 */

import type { RawChart } from '../../drawingml/chart/read.ts'
import type { RawDiagram } from '../../drawingml/diagram/model.ts'
import type { StyleScope } from '../../drawingml/shape/resolve.ts'
import type { ListStyleSpec } from '../../drawingml/text/read.ts'
import type { Theme } from '../../drawingml/theme.ts'
import type { UnsupportedKind } from '../model.ts'
import type { RawInkStroke } from '../parse/ink.ts'
import type { RawPart } from '../parse/slide.ts'
import type { TableStyle } from '../parse/table.ts'

export interface SlideScope extends StyleScope {
  readonly master: RawPart
  readonly layout: RawPart
  readonly defaultTextStyle: ListStyleSpec | null
  readonly tableStyles: ReadonlyMap<string, TableStyle>
  /** 图片部件能否绘制（`drawableImage`）；部件不在包中时为 `null`。 */
  imageDrawable(part: string): boolean | null
  /** 已读取的图表部件与其主题覆盖（没有时为 `null`），按部件名；部件不存在时不在其中。 */
  readonly charts: ReadonlyMap<string, { readonly raw: RawChart; readonly theme: Theme | null }>
  /** 已读取的 SmartArt，按数据部件名；数据部件不存在时不在其中。 */
  readonly diagrams: ReadonlyMap<string, RawDiagram>
  /** 已读取的墨迹笔画，按部件名；部件不存在时不在其中。 */
  readonly inks: ReadonlyMap<string, readonly RawInkStroke[]>
  readonly found: UnsupportedKind[]
}
