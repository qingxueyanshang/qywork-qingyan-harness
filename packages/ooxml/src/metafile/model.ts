/**
 * 图元文件读取的结果：WMF 与 EMF 的记录换算为同一组 GDI 绘制命令（`MetaOp`），由 `play.ts` 按设备上下文的状态绘制。
 *
 * - 坐标为记录中的逻辑坐标；`clipRegion` 的矩形为设备坐标（EMF 区域数据的单位）。
 * - 对象的选入在读取时按对象表解析为对象本身（`pen`、`brush`、`font`），删除对象不影响已选入的对象。
 * - 位图在读取时解码为非预乘的 RGBA 像素（`Metafile.bitmaps`），命令按下标引用。
 * - `unsupported` 列出未实现的记录与参数取值（去重）；不为空时整张图片不绘制，由调用方计入能力边界。
 */

import type { Matrix } from '../drawingml/paint/context.ts'
import type { Pixels } from './dib.ts'

export interface Point {
  readonly x: number
  readonly y: number
}

/** 矩形的四条边，按记录原样（`right` 可小于 `left`，`bottom` 可小于 `top`）。 */
export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** 位图中的像素矩形，行序自上而下。 */
export interface PixelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** `COLORREF` 的红、绿、蓝分量（0–255）。 */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface Pen {
  /** 画笔样式：只有实线与空画笔。 */
  readonly style: 'solid' | 'null'
  /** 线宽（逻辑单位）；`cosmetic` 为真时线宽恒为 1 个设备像素。 */
  readonly width: number
  readonly cosmetic: boolean
  readonly color: Rgb
  readonly cap: 'round' | 'square' | 'butt'
  readonly join: 'round' | 'bevel' | 'miter'
}

export type Brush = { readonly kind: 'solid'; readonly color: Rgb } | { readonly kind: 'null' }

export interface Font {
  /** `lfHeight`（逻辑单位）：负值为 em 高度，正值为字符单元高度。 */
  readonly height: number
  readonly weight: number
  readonly italic: boolean
  readonly face: string
}

export type MetaOp =
  | { readonly op: 'save' }
  /** 负值为相对当前状态的层数，正值为第几次保存的状态。 */
  | { readonly op: 'restore'; readonly index: number }
  | { readonly op: 'mapMode'; readonly mode: number }
  | {
      readonly op: 'windowOrg' | 'windowExt' | 'viewportOrg' | 'viewportExt'
      readonly x: number
      readonly y: number
    }
  /** 世界变换：`set` 替换，`left` 在当前变换之前施加，`right` 在当前变换之后施加，`identity` 复位。 */
  | {
      readonly op: 'world'
      readonly mode: 'set' | 'left' | 'right' | 'identity'
      readonly matrix: Matrix
    }
  | { readonly op: 'pen'; readonly pen: Pen }
  | { readonly op: 'brush'; readonly brush: Brush }
  | { readonly op: 'font'; readonly font: Font }
  | { readonly op: 'textColor' | 'bkColor'; readonly color: Rgb }
  | { readonly op: 'bkMode'; readonly opaque: boolean }
  /** `TA_*` 标志：水平为 `TA_LEFT`、`TA_RIGHT`、`TA_CENTER`，竖直为 `TA_TOP`、`TA_BOTTOM`、`TA_BASELINE`。 */
  | { readonly op: 'textAlign'; readonly align: number }
  | { readonly op: 'fillMode'; readonly evenOdd: boolean }
  | { readonly op: 'miterLimit'; readonly limit: number }
  | { readonly op: 'moveTo' | 'lineTo'; readonly p: Point }
  | {
      readonly op: 'polygon' | 'polyline' | 'polylineTo' | 'bezier' | 'bezierTo'
      readonly points: readonly Point[]
    }
  | { readonly op: 'polyPolygon' | 'polyPolyline'; readonly polys: readonly (readonly Point[])[] }
  /**
   * 矩形与椭圆。`shrink` 为真时空画笔的填充区域右边与底边各少 1 像素：WMF 记录的是绘制调用的参数，按 GDI 的规则处理；
   * EMF 记录的边界已是录制时换算的结果，WPS 不再缩小（构造文档实测）。
   */
  | { readonly op: 'rectangle' | 'ellipse'; readonly box: Box; readonly shrink: boolean }
  /** 以画刷（`PATCOPY`）、黑色或白色填充矩形，不描边。 */
  | { readonly op: 'patBlt'; readonly box: Box; readonly fill: 'brush' | 'black' | 'white' }
  /**
   * 位图复制到目标矩形（逻辑坐标）。`alpha` 为常量不透明度（0–1）；像素自身的不透明度已在解码时写入。
   */
  | {
      readonly op: 'bitmap'
      readonly dest: Box
      readonly src: PixelRect
      readonly bitmap: number
      readonly alpha: number
    }
  /**
   * 文字：`dx` 为各字符的前进宽度（逻辑单位），`null` 时按字体度量。`opaque` 先以背景色填充，`clip` 裁剪到该矩形。
   */
  | {
      readonly op: 'text'
      readonly p: Point
      readonly text: string
      readonly dx: readonly number[] | null
      readonly opaque: Box | null
      readonly clip: Box | null
    }
  | { readonly op: 'beginPath' | 'endPath' | 'closeFigure' | 'abortPath' }
  | { readonly op: 'fillPath' | 'strokePath' | 'strokeFillPath' }
  /** 以当前路径设置裁剪：`copy` 替换，`and` 与现有裁剪求交。 */
  | { readonly op: 'clipPath'; readonly mode: 'copy' | 'and' }
  /** 与逻辑坐标的矩形求交（`exclude` 为真时排除该矩形）。 */
  | { readonly op: 'clipRect'; readonly box: Box; readonly exclude: boolean }
  /** 设备坐标的矩形并集：`rects` 为 `null` 时取消裁剪。 */
  | {
      readonly op: 'clipRegion'
      readonly rects: readonly Box[] | null
      readonly mode: 'copy' | 'and'
    }

export interface Metafile {
  readonly kind: 'wmf' | 'emf'
  /**
   * 图片框：WMF 为可放置文件头的边界（逻辑坐标），EMF 为 `rclFrame` 换算到参考设备的像素坐标。绘制时图片框映射到目标矩形。
   */
  readonly frame: Box
  /** EMF 参考设备每毫米的像素数（度量映射模式按它换算）；WMF 为 `null`。 */
  readonly device: Point | null
  /** 图片框在 96 dpi 下的像素尺寸：WMF 按可放置文件头的每英寸单位数，EMF 按 `rclFrame`（0.01 毫米）。 */
  readonly size: { readonly width: number; readonly height: number }
  readonly ops: readonly MetaOp[]
  readonly bitmaps: readonly Pixels[]
  /** 文字记录使用的字体名（去重）。 */
  readonly fonts: readonly string[]
  /** 未实现的记录与参数取值（去重）。 */
  readonly unsupported: readonly string[]
}

/** 文件头无效时的图片框尺寸（此时 `unsupported` 不为空，不绘制）。 */
export const NO_SIZE: Metafile['size'] = { width: 0, height: 0 }
