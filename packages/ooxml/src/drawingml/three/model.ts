/**
 * DrawingML 三维设置：`scene3d`（相机与光照方案）与 `sp3d`（棱台、挤出、轮廓、材质）的读取结果，
 * 以及绘制端使用的求值结果（`ThreeD`）。角度为度，长度为 EMU。
 */

/** `rot`：纬度、经度与绕视线的旋转，度。 */
export interface Rotation3D {
  readonly lat: number
  readonly lon: number
  readonly rev: number
}

export interface Scene3D {
  /** `camera/@prst`。 */
  readonly camera: string
  /** `camera/@fov`；未写出时为 `null`。 */
  readonly fov: number | null
  /** `camera/rot`；未写出时为 `null`。 */
  readonly rotation: Rotation3D | null
  /** `lightRig/@rig`。 */
  readonly rig: string
}

export interface Bevel3D {
  readonly width: number
  readonly height: number
  readonly preset: string
}

export interface Shape3D {
  readonly extrusion: number
  readonly contour: number
  readonly top: Bevel3D | null
  readonly bottom: Bevel3D | null
  readonly material: string
}

/**
 * 绘制端的三维效果：旋转（度）、透视距离（像素；正交投影为 `null`），与光照（颜色通道 c 变为 `scale` × c + `add`，
 * 0–255，透明度不变）。
 */
export interface ThreeD {
  readonly rotation: Rotation3D
  readonly distance: number | null
  readonly scale: number
  readonly add: number
}
