/**
 * DrawingML 文本模型：已解决样式继承的文本框（`txBody`）。纯数据，可经 `postMessage` 传递。
 *
 * - 字号、字距、磅值行距为磅；边距、缩进、制表位为 EMU；角度为度；百分比为小数。
 * - 颜色已求值。字号为自动调整缩放之前的值，缩放比例见 `BodyProperties.autofit`。
 * - 链上都未指定的西文字体为 Arial（WPS 实测），东亚、复杂文种与符号字体为空串。
 */

import type { Color } from '../color.ts'
import type { Effect, Line, ShapeFill } from '../fill.ts'

export type Spacing =
  | { readonly unit: 'percent'; readonly value: number }
  | { readonly unit: 'points'; readonly value: number }

export type Autofit =
  | { readonly kind: 'none' }
  | { readonly kind: 'normal'; readonly fontScale: number; readonly lineSpacingReduction: number }
  | { readonly kind: 'shape' }

export interface BodyProperties {
  readonly rotation: number
  readonly vertical: string
  readonly wrap: boolean
  readonly insetLeft: number
  readonly insetTop: number
  readonly insetRight: number
  readonly insetBottom: number
  readonly anchor: string
  readonly anchorCenter: boolean
  readonly columns: number
  readonly columnSpacing: number
  readonly rtlColumns: boolean
  readonly upright: boolean
  readonly autofit: Autofit
}

export interface RunStyle {
  /** 实际字体名：主题字体已换算；西文字体未指定时为 Arial，其余未指定时为空串。 */
  readonly latin: string
  readonly ea: string
  readonly cs: string
  readonly sym: string
  readonly size: number
  readonly bold: boolean
  readonly italic: boolean
  readonly underline: string
  readonly strike: string
  readonly baseline: number
  readonly caps: string
  readonly spacing: number
  /** 字号不小于该值时启用字距调整；0 为不调整。 */
  readonly kern: number
  /** 未指定时为黑色纯色填充。 */
  readonly fill: ShapeFill
  readonly highlight: Color | null
  readonly outline: Line | null
  readonly effects: readonly Effect[]
  readonly lang: string
}

export type Run =
  | {
      readonly kind: 'text'
      readonly text: string
      readonly style: RunStyle
      readonly link: string | null
    }
  | { readonly kind: 'break'; readonly style: RunStyle }
  | {
      readonly kind: 'field'
      readonly field: string
      /** 文件中保存的字段文本。 */
      readonly text: string
      readonly style: RunStyle
      readonly link: string | null
    }

/** 项目符号的字体、颜色与字号已解决：跟随文字时取段落第一个字段（没有字段时取段落结束符）的样式。 */
export type Bullet =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'char'
      readonly char: string
      readonly font: string
      readonly color: ShapeFill
      readonly size: number
    }
  | {
      readonly kind: 'number'
      readonly scheme: string
      /** 本段的编号值。 */
      readonly number: number
      readonly font: string
      readonly color: ShapeFill
      readonly size: number
    }
  | { readonly kind: 'picture'; readonly part: string | null; readonly size: number }

export interface TabStop {
  readonly position: number
  readonly align: string
}

export interface Paragraph {
  readonly level: number
  readonly align: string
  readonly marginLeft: number
  readonly marginRight: number
  readonly indent: number
  readonly rtl: boolean
  readonly defaultTabSize: number
  readonly tabs: readonly TabStop[]
  readonly lineSpacing: Spacing
  readonly spaceBefore: Spacing
  readonly spaceAfter: Spacing
  readonly eaLineBreak: boolean
  readonly latinLineBreak: boolean
  readonly hangingPunctuation: boolean
  readonly fontAlign: string
  /** 段落没有字段时为 `none`。 */
  readonly bullet: Bullet
  readonly runs: readonly Run[]
  /** 段落结束符的样式，决定空段落的行高。 */
  readonly end: RunStyle
}

export interface TextBody {
  readonly body: BodyProperties
  readonly paragraphs: readonly Paragraph[]
}
