/**
 * 形状几何的定义：预设几何（名称与调整值）与自定义几何（参数、文本矩形与路径）。
 *
 * - 只记录定义，公式求值与路径展开见 `formula.ts`、`path.ts`；预设几何的定义数据见 `preset.ts`。
 * - 长度与形状尺寸同单位（读取自文件时为 EMU），角度为六万分之一度。
 */

/** 几何参数：`formula` 为公式原文（如 `val 50000`、`+- w 0 adj`）。 */
export interface Guide {
  readonly name: string
  readonly formula: string
}

/** 数值字面量为 `number`，引用参数或内置量（`w`、`hd2` 等）为名称。 */
export type GeometryValue = number | string

export interface PathPoint {
  readonly x: GeometryValue
  readonly y: GeometryValue
}

export type PathCommand =
  | { readonly kind: 'move'; readonly to: PathPoint }
  | { readonly kind: 'line'; readonly to: PathPoint }
  | {
      readonly kind: 'arc'
      readonly widthRadius: GeometryValue
      readonly heightRadius: GeometryValue
      readonly startAngle: GeometryValue
      readonly swingAngle: GeometryValue
    }
  | { readonly kind: 'quad'; readonly points: readonly PathPoint[] }
  | { readonly kind: 'cubic'; readonly points: readonly PathPoint[] }
  | { readonly kind: 'close' }

export interface GeometryPath {
  /** 路径坐标系的宽高；0 表示与形状尺寸相同。 */
  readonly width: number
  readonly height: number
  /** `norm`、`none`、`lighten`、`lightenLess`、`darken`、`darkenLess`。 */
  readonly fill: string
  readonly stroke: boolean
  readonly commands: readonly PathCommand[]
}

export interface TextRect {
  readonly left: GeometryValue
  readonly top: GeometryValue
  readonly right: GeometryValue
  readonly bottom: GeometryValue
}

export interface CustomGeometry {
  readonly kind: 'custom'
  readonly adjust: readonly Guide[]
  readonly guides: readonly Guide[]
  readonly textRect: TextRect | null
  readonly paths: readonly GeometryPath[]
}

export type Geometry =
  | { readonly kind: 'preset'; readonly name: string; readonly adjust: readonly Guide[] }
  | CustomGeometry
