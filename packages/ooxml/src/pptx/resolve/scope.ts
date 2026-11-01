/**
 * 单张幻灯片的求值上下文：主题、生效的颜色映射、所属版式与母版、默认文本样式与表格样式。
 * 样式矩阵引用的求值见 `../../drawingml/shape/resolve.ts`。
 *
 * - 未实现的元素在求值过程中累加到 `found`：母版与版式上的形状在每张显示它的幻灯片上各计一次。
 */

import type { RawChart } from '../../drawingml/chart/read.ts'
import type { StyleScope } from '../../drawingml/shape/resolve.ts'
import type { ListStyleSpec } from '../../drawingml/text/read.ts'
import type { UnsupportedKind } from '../model.ts'
import type { RawPart } from '../parse/slide.ts'
import type { TableStyle } from '../parse/table.ts'

export interface SlideScope extends StyleScope {
  readonly master: RawPart
  readonly layout: RawPart
  readonly defaultTextStyle: ListStyleSpec | null
  readonly tableStyles: ReadonlyMap<string, TableStyle>
  /** 部件的内容类型；部件不在包中时为 `null`。 */
  imageType(part: string): string | null
  /** 已读取的图表部件，按部件名；部件不存在时不在其中。 */
  readonly charts: ReadonlyMap<string, RawChart>
  readonly found: UnsupportedKind[]
}
