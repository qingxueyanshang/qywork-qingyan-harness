/**
 * `scene3d` 与 `sp3d` 的读取：在元素的开始标签处调用，返回时位于其结束标签。元素按本地名匹配，不限定前缀。
 * 缺省值按 ECMA-376：棱台宽高 76200 EMU、形状 `circle`，材质 `warmMatte`。
 */

import type { Reader } from '../fill.ts'
import type { Bevel3D, Rotation3D, Scene3D, Shape3D } from './model.ts'

function eachChild(x: Reader, visit: (local: string) => void): void {
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) return
    if (t === 'start' && x.depth === depth + 1) visit(x.local)
  }
}

function num(x: Reader, name: string, fallback: number): number {
  const v = x.attr(name)
  if (v === null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function rotation(x: Reader): Rotation3D {
  return {
    lat: num(x, 'lat', 0) / 60000,
    lon: num(x, 'lon', 0) / 60000,
    rev: num(x, 'rev', 0) / 60000,
  }
}

export function readScene3D(x: Reader): Scene3D {
  let camera = 'orthographicFront'
  let fov: number | null = null
  let rot: Rotation3D | null = null
  let rig = 'threePt'
  eachChild(x, (local) => {
    if (local === 'camera') {
      camera = x.attr('prst') ?? camera
      const f = x.attr('fov')
      fov = f === null ? null : num(x, 'fov', 0) / 60000
      eachChild(x, (child) => {
        if (child === 'rot') rot = rotation(x)
      })
    } else if (local === 'lightRig') {
      rig = x.attr('rig') ?? rig
    }
  })
  return { camera, fov, rotation: rot, rig }
}

function bevel(x: Reader): Bevel3D {
  return {
    width: num(x, 'w', 76200),
    height: num(x, 'h', 76200),
    preset: x.attr('prst') ?? 'circle',
  }
}

export function readShape3D(x: Reader): Shape3D {
  const extrusion = num(x, 'extrusionH', 0)
  const contour = num(x, 'contourW', 0)
  const material = x.attr('prstMaterial') ?? 'warmMatte'
  let top: Bevel3D | null = null
  let bottom: Bevel3D | null = null
  eachChild(x, (local) => {
    if (local === 'bevelT') top = bevel(x)
    else if (local === 'bevelB') bottom = bevel(x)
  })
  return { extrusion, contour, top, bottom, material }
}
