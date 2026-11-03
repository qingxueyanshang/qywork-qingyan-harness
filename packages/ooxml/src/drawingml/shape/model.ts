/**
 * DrawingML 形状的公共模型：形状框与读取、求值时登记的未实现内容。
 */

export interface Frame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** 顺时针，度。 */
  readonly rotation: number
  readonly flipH: boolean
  readonly flipV: boolean
}

/**
 * 形状与文字中绘制端不实现的内容：`textWarp` 艺术字变形；`effect3d` 改变外观的三维设置；`effect` 外部阴影与内部阴影之外的
 * 效果；`verticalText` 按旋转绘制之外的竖排文字；`imageFormat` 无法绘制的图片（`drawableImage`，含宿主不绘制的图片项目符号，
 * 由宿主登记，见 `countText`）。
 */
export type DrawingFinding = 'textWarp' | 'effect3d' | 'effect' | 'verticalText' | 'imageFormat'

/** 登记未实现内容的去处；各格式的计数数组（元素类型包含 `DrawingFinding`）均满足。 */
export interface FindingSink {
  push(...kinds: DrawingFinding[]): unknown
}
