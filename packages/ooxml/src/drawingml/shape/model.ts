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
 * 形状与文字中绘制端不实现的内容：`textWarp` 艺术字变形；`effect3d` 改变外观的三维设置；`effect` 外部阴影之外的效果；
 * `verticalText` 按旋转绘制之外的竖排文字；`pictureBullet` 图片项目符号；`imageFormat` 浏览器无法解码的图片。
 */
export type DrawingFinding =
  | 'textWarp'
  | 'effect3d'
  | 'effect'
  | 'verticalText'
  | 'pictureBullet'
  | 'imageFormat'

/** 登记未实现内容的去处；各格式的计数数组（元素类型包含 `DrawingFinding`）均满足。 */
export interface FindingSink {
  push(...kinds: DrawingFinding[]): unknown
}
