/**
 * 覆盖 `three/`：`read.ts` 的读取与缺省值、`camera.ts` 的预设、`rot` 的合成、透视、光照与未实现内容的登记，
 * `paint.ts` 的逐像素投影与着色。期望值取自 WPS 演示导出图的实测。
 */

import { describe, expect, test } from 'bun:test'
import { PartScanner } from '../../opc/scanner.ts'
import type { Matrix, PaintCanvas, PaintContext } from '../paint/context.ts'
import { RecordingContext } from '../paint/test-helper.ts'
import type { DrawingFinding } from '../shape/model.ts'
import type { ShapeScene } from '../shape/paint.ts'
import { projector, resolveThreeD, visibleThreeD } from './camera.ts'
import type { Scene3D, ThreeD } from './model.ts'
import { type PixelData, paintThreeD } from './paint.ts'
import { readScene3D, readShape3D } from './read.ts'

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function at(xml: string): PartScanner {
  const x = new PartScanner(xml)
  x.next()
  return x
}

function scene(
  camera: string,
  rotation: Scene3D['rotation'] = null,
  rig = 'threePt',
  fov: number | null = null,
): Scene3D {
  return { camera, fov, rotation, rig }
}

function sink(): { found: DrawingFinding[]; push: (...k: DrawingFinding[]) => number } {
  const found: DrawingFinding[] = []
  return { found, push: (...k) => found.push(...k) }
}

describe('读取', () => {
  test('相机、旋转与光照方案；棱台缺省 76200 EMU 的 circle，材质缺省 warmMatte', () => {
    const s = readScene3D(
      at(
        `<a:scene3d ${A}><a:camera prst="perspectiveRight" fov="3600000"><a:rot lat="0" lon="20999994" rev="0"/></a:camera>` +
          '<a:lightRig rig="contrasting" dir="t"><a:rot lat="0" lon="0" rev="7200000"/></a:lightRig></a:scene3d>',
      ),
    )
    expect(s.camera).toBe('perspectiveRight')
    expect(s.fov).toBe(60)
    expect(s.rotation?.lon).toBeCloseTo(349.9999, 3)
    expect(s.rig).toBe('contrasting')
    const sp = readShape3D(at(`<a:sp3d ${A} contourW="6350"><a:bevelT/></a:sp3d>`))
    expect(sp).toEqual({
      extrusion: 0,
      contour: 6350,
      top: { width: 76200, height: 76200, preset: 'circle' },
      bottom: null,
      material: 'warmMatte',
    })
  })

  test('文字的三维设置只在改变外观时登记', () => {
    const front = readScene3D(
      at(
        `<a:scene3d ${A}><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>`,
      ),
    )
    expect(visibleThreeD(front, null)).toBe(false)
    expect(visibleThreeD(scene('perspectiveFront'), null)).toBe(true)
    expect(visibleThreeD(null, readShape3D(at(`<a:sp3d ${A}/>`)))).toBe(false)
    expect(visibleThreeD(null, readShape3D(at(`<a:sp3d ${A} extrusionH="10"/>`)))).toBe(true)
    expect(visibleThreeD(null, readShape3D(at(`<a:sp3d ${A}><a:bevelT/></a:sp3d>`)))).toBe(true)
  })
})

describe('求值', () => {
  test('正视也按光照方案着色：threePt 为 1.039c + 6.5，contrasting 为 0.969c', () => {
    const s = sink()
    expect(resolveThreeD(scene('orthographicFront'), null, s)).toEqual({
      rotation: { lat: 0, lon: 0, rev: 0 },
      distance: null,
      scale: 1.039,
      add: 6.5,
    })
    expect(resolveThreeD(scene('orthographicFront', null, 'contrasting'), null, s)?.scale).toBe(
      0.969,
    )
    expect(s.found).toEqual([])
  })

  test('rot 取代预设的旋转，透视距离按预设视角；fov 只作用于透视', () => {
    const s = sink()
    const r = resolveThreeD(scene('perspectiveRight', { lat: 0, lon: 350, rev: 0 }), null, s)!
    expect(r.rotation.lon).toBe(350)
    expect(r.distance).toBeCloseTo(595 / Math.tan(Math.PI / 8), 6)
    expect(resolveThreeD(scene('perspectiveRight'), null, s)!.rotation.lon).toBe(-20)
    expect(
      resolveThreeD(scene('orthographicFront', null, 'threePt', 60), null, s)!.distance,
    ).toBeNull()
    expect(
      resolveThreeD(scene('perspectiveFront', null, 'threePt', 90), null, s)!.distance,
    ).toBeCloseTo(595, 6)
  })

  test('挤出与轮廓登记一次 effect3d，正面照常投影；斜二测按平面绘制；未实测的光照方案不着色', () => {
    const s = sink()
    const shape = {
      extrusion: 146050,
      contour: 38100,
      top: null,
      bottom: null,
      material: 'warmMatte',
    }
    const r = resolveThreeD(
      scene('perspectiveRelaxedModerately', { lat: 294.85, lon: 0, rev: 0 }, 'contrasting'),
      shape,
      s,
    )
    expect(r?.rotation.lat).toBe(294.85)
    expect(s.found).toEqual(['effect3d'])
    expect(resolveThreeD(scene('obliqueTopLeft'), null, s)).toBeNull()
    expect(resolveThreeD(scene('perspectiveFront', null, 'sunrise'), null, s)).toEqual({
      rotation: { lat: 0, lon: 0, rev: 0 },
      distance: 595 / Math.tan(Math.PI / 8),
      scale: 1,
      add: 0,
    })
    expect(s.found).toEqual(['effect3d', 'effect3d', 'effect3d'])
    expect(resolveThreeD(null, shape, s)).toBeNull()
  })

  test('棱台不改变外观，不登记；材质 flat 不着色，未实测的材质登记', () => {
    const s = sink()
    const bevel = (material: string) => ({
      extrusion: 0,
      contour: 0,
      top: { width: 76200, height: 76200, preset: 'circle' },
      bottom: null,
      material,
    })
    expect(resolveThreeD(scene('orthographicFront'), bevel('warmMatte'), s)?.add).toBe(6.5)
    expect(resolveThreeD(scene('orthographicFront'), bevel('flat'), s)?.scale).toBe(1)
    expect(s.found).toEqual([])
    resolveThreeD(scene('orthographicFront'), bevel('powder'), s)
    expect(s.found).toEqual(['effect3d'])
  })

  test('光照的加项按 lat、lon 插值：threePt 在 lat −30°、lon 30° 处为 71.5', () => {
    const r = resolveThreeD(
      scene('orthographicFront', { lat: 330, lon: 30, rev: 0 }),
      null,
      sink(),
    )!
    expect(r.add).toBeCloseTo(71.5, 6)
    const mid = resolveThreeD(
      scene('orthographicFront', { lat: 0, lon: 15, rev: 0 }),
      null,
      sink(),
    )!
    expect(mid.add).toBeCloseTo((6.5 + 9.5) / 2, 6)
  })
})

describe('投影', () => {
  const three = (rotation: ThreeD['rotation'], distance: number | null): ThreeD => ({
    rotation,
    distance,
    scale: 1,
    add: 0,
  })

  test('透视 lon 45° 的 160 × 120 图片：右侧靠近、四角与导出图相差不超过 0.6 像素', () => {
    const p = projector(three({ lat: 0, lon: 45, rev: 0 }, 595 / Math.tan(Math.PI / 8)), 160, 120)
    const measured = [
      [0, 0, 25.8, 2.3],
      [160, 0, 139.2, -2.3],
      [160, 120, 139.2, 122.3],
      [0, 120, 25.7, 117.9],
    ] as const
    for (const [u, v, x, y] of measured) {
      const q = p.forward(u, v)
      expect(Math.abs(q.x - x)).toBeLessThan(0.6)
      expect(Math.abs(q.y - y)).toBeLessThan(0.6)
      const back = p.inverse(q.x, q.y)!
      expect(back.u).toBeCloseTo(u, 6)
      expect(back.v).toBeCloseTo(v, 6)
    }
  })

  test('正交：lon 20° 宽度乘 cos 20°，lat 正值使上沿靠近；rev 30° 为逆时针', () => {
    const p = projector(three({ lat: 0, lon: 20, rev: 0 }, null), 160, 120)
    expect(p.forward(160, 60).x - p.forward(0, 60).x).toBeCloseTo(160 * Math.cos(Math.PI / 9), 6)
    const top = projector(three({ lat: 20, lon: 0, rev: 0 }, 1420), 160, 120)
    expect(top.forward(160, 0).x - top.forward(0, 0).x).toBeGreaterThan(160)
    const rev = projector(three({ lat: 0, lon: 0, rev: 30 }, null), 160, 120)
    const tl = rev.forward(0, 0)
    // 导出图实测左上角 (−19.4, 48.4)。
    expect(tl.x).toBeCloseTo(-19.3, 0)
    expect(tl.y).toBeCloseTo(48.4, 0)
  })
})

/** 逐像素图层：`putImageData` 写入、`getImageData` 读出，其余绘制调用只记录。 */
class PixelContext extends RecordingContext {
  constructor(
    readonly w: number,
    readonly h: number,
    readonly pixels = new Uint8ClampedArray(w * h * 4),
  ) {
    super()
  }
  getImageData(_x: number, _y: number, w: number, h: number): PixelData {
    return { width: w, height: h, data: new Uint8ClampedArray(this.pixels) }
  }
  putImageData(data: PixelData, _x: number, _y: number): void {
    this.pixels.set(data.data)
  }
}

class PixelCanvas implements PaintCanvas {
  readonly context: PixelContext
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.context = new PixelContext(width, height)
  }
  getContext(): PaintContext {
    return this.context
  }
}

describe('绘制', () => {
  test('平面内容按逆映射取样并着色，结果图层按设备坐标画到画布', () => {
    const layers: PixelCanvas[] = []
    const main = new RecordingContext()
    const scene: ShapeScene = {
      ctx: main,
      res: {
        image: () => null,
        createCanvas: (w, h) => {
          const c = new PixelCanvas(w, h)
          layers.push(c)
          return c
        },
      },
      scale: 1,
      canvas: { width: 200, height: 200 },
      settings: null,
    }
    const placed = {
      width: 40,
      height: 20,
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 50, f: 50 } as Matrix,
    }
    paintThreeD(
      scene,
      { rotation: { lat: 0, lon: 60, rev: 0 }, distance: null, scale: 1.039, add: 6.5 },
      placed,
      0,
      [],
      (_c, offset) => {
        // 平面图层：形状框内为灰 128。
        const src = layers[0]!.context
        for (let y = 0; y < src.h; y++) {
          for (let x = 0; x < src.w; x++) {
            const o = (y * src.w + x) * 4
            src.pixels.set([128, 128, 128, 255], o)
          }
        }
        expect(offset.e).toBe(-50)
      },
    )
    const out = layers[1]!
    // lon 60° 的正交投影把宽度 40 压为 20：结果图层宽 20，中心像素为 1.039 × 128 + 6.5。
    expect(out.width).toBe(20)
    const o = (10 * out.width + 10) * 4
    expect(out.context.pixels[o]).toBe(Math.round(1.039 * 128 + 6.5))
    expect(out.context.pixels[o + 3]).toBe(255)
    const drawn = main.named('drawImage')
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.args.slice(1)).toEqual([60, 50])
  })
})
