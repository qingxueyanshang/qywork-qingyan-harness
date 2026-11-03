/**
 * 覆盖范围：`fill.ts`（线性渐变起止点、路径渐变焦点、圆形与矩形路径渐变、图片裁剪与拉伸、平铺、图案、明暗修饰）、
 * `picture.ts`（位图裁剪，图元文件的图片填充、平铺与缺少字体时不绘制）、`resolution.ts`（PNG、JPEG、BMP 文件头中的分辨率）、
 * `line.ts`（线宽、虚线、端点与连接、内侧对齐、复合线、箭头与线条缩短、非纯色线条的图层）、
 * `shadow.ts`（阴影变换、只绘制阴影的偏移、内部阴影的裁剪与偏移方向）、`effects.ts`（发光与柔化边缘的剖面、膨胀量、
 * 图层效果的合成顺序、映像的渐变与变换）、`context.ts`（矩阵运算）、`recolor.ts`（图片效果的像素运算与运算顺序）。
 * 期望值取自 WPS 演示导出图。
 */

import { describe, expect, test } from 'bun:test'
import { readMetafile } from '../../metafile/index.ts'
import type { Color } from '../color.ts'
import type { Fill, ImageEffect, ImageFill, Line } from '../fill.ts'
import type { ShapePath } from '../geometry/path.ts'
import { apply, invert, multiply, rotation, scaling, translation } from './context.ts'
import {
  glowAlpha,
  glowSpread,
  NO_EFFECTS,
  paintWithEffects,
  type Reflection,
  softEdgeInset,
  softEdgeMask,
} from './effects.ts'
import {
  focusRect,
  linearGradientLine,
  paintFill,
  paintFillModifier,
  paintImageFill,
  traceRect,
} from './fill.ts'
import { dashPattern, lineWidth, paintLine } from './line.ts'
import { drawCropped, drawPicture, type PaintPicture } from './picture.ts'
import { recolorPixels } from './recolor.ts'
import { type ImageResolution, imageResolution, SCREEN_RESOLUTION } from './resolution.ts'
import { type InnerShadow, type OuterShadow, paintInnerShadows, shadowMatrix } from './shadow.ts'
import { canvasFactory, placeableWmf, RED_RECT_WMF, RecordingContext } from './test-helper.ts'

const RED: Color = { r: 1, g: 0, b: 0, a: 1 }
const BLUE: Color = { r: 0, g: 0, b: 1, a: 0.5 }
const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function resources(
  images: Record<string, { width: number; height: number }> = {},
  resolution: ImageResolution = SCREEN_RESOLUTION,
) {
  const f = canvasFactory()
  return {
    res: {
      image: (p: string) => {
        const bitmap = images[p]
        return bitmap === undefined ? null : { kind: 'bitmap' as const, bitmap, resolution }
      },
      createCanvas: f.create,
      metafileFonts: null,
    },
    created: f.created,
  }
}

function solidLine(over: Partial<Line> = {}): Line {
  return {
    width: 9525 * 2,
    fill: { kind: 'solid', color: RED },
    dash: { kind: 'preset', name: 'solid' },
    cap: 'flat',
    compound: 'sng',
    align: 'ctr',
    join: 'round',
    miterLimit: null,
    head: null,
    tail: null,
    ...over,
  }
}

const straight: ShapePath[] = [
  {
    fill: 'none',
    stroke: true,
    segments: [
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 100, y: 0 },
    ],
  },
]

describe('矩阵', () => {
  test('复合、求逆与作用于点', () => {
    const m = multiply(translation(10, 20), multiply(rotation(Math.PI / 2), scaling(2, 3)))
    const p = apply(m, 1, 1)
    expect(p.x).toBeCloseTo(10 - 3, 9)
    expect(p.y).toBeCloseTo(20 + 2, 9)
    const back = apply(invert(m), p.x, p.y)
    expect(back.x).toBeCloseTo(1, 9)
    expect(back.y).toBeCloseTo(1, 9)
  })
})

describe('渐变参数', () => {
  test('线性渐变的长度为形状框在该方向上的投影', () => {
    expect(linearGradientLine(0, false, 200, 100)).toEqual({ x0: 0, y0: 50, x1: 200, y1: 50 })
    const v = linearGradientLine(90, false, 200, 100)
    expect(v.x0).toBeCloseTo(100, 9)
    expect(v.y0).toBeCloseTo(0, 9)
    expect(v.y1).toBeCloseTo(100, 9)
    const d = linearGradientLine(45, false, 200, 100)
    const half = (Math.SQRT1_2 * 200 + Math.SQRT1_2 * 100) / 2
    expect(d.x1 - 100).toBeCloseTo(half * Math.SQRT1_2, 9)
  })

  test('scaled 时 45° 渐变的等色线平行于形状框的对角线', () => {
    const s = linearGradientLine(45, true, 200, 100)
    const dx = s.x1 - s.x0
    const dy = s.y1 - s.y0
    // 方向与反对角线 (200, -100) 垂直，起止点落在左上角与右下角的投影上。
    expect(dx * 200 - dy * 100).toBeCloseTo(0, 6)
    const t = (x: number, y: number) => ((x - s.x0) * dx + (y - s.y0) * dy) / (dx * dx + dy * dy)
    expect(t(0, 0)).toBeCloseTo(0, 9)
    expect(t(200, 100)).toBeCloseTo(1, 9)
  })

  test('路径渐变焦点区域按四边内缩比例计算', () => {
    expect(focusRect({ left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 }, 200, 100)).toEqual({
      left: 100,
      right: 100,
      top: 50,
      bottom: 50,
    })
    expect(focusRect({ left: 1, top: 0, right: 0, bottom: 1 }, 200, 100)).toEqual({
      left: 200,
      right: 200,
      top: 0,
      bottom: 0,
    })
  })
})

describe('填充', () => {
  test('线性渐变按色标创建，rotWithShape 为假时方向不随形状旋转', () => {
    const ctx = new RecordingContext()
    const fill: Fill = {
      kind: 'gradient',
      stops: [
        { position: 0, color: RED },
        { position: 1, color: BLUE },
      ],
      shade: { kind: 'linear', angle: 0, scaled: false },
      flip: 'none',
      rotateWithShape: false,
    }
    const { res } = resources()
    const matrix = rotation(Math.PI / 2)
    paintFill(ctx, () => traceRect(ctx, 100, 100), fill, { width: 100, height: 100, matrix }, res)
    const style = ctx.named('fill')[0]!.fillStyle as { points: number[]; stops: [number, string][] }
    // 设备坐标中水平向右，在旋转 90° 的局部坐标中为竖直向上。
    expect(style.points[0]).toBeCloseTo(50, 9)
    expect(style.points[1]).toBeCloseTo(100, 9)
    expect(style.points[3]).toBeCloseTo(0, 9)
    expect(style.stops).toEqual([
      [0, '#FF0000'],
      [0.25, 'rgba(235, 0, 107, 0.875)'],
      [0.5, 'rgba(185, 0, 185, 0.75)'],
      [0.75, 'rgba(107, 0, 235, 0.625)'],
      [1, 'rgba(0, 0, 255, 0.5)'],
    ])
  })

  test('位于两端的两个色标在四分点另加色标，颜色偏向各通道较大的一端；其余色标线性', () => {
    const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 }
    const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 }
    const stopsOf = (stops: (Fill & { kind: 'gradient' })['stops']) => {
      const ctx = new RecordingContext()
      const fill: Fill = {
        kind: 'gradient',
        stops,
        shade: { kind: 'linear', angle: 0, scaled: false },
        flip: 'none',
        rotateWithShape: true,
      }
      paintFill(
        ctx,
        () => traceRect(ctx, 10, 10),
        fill,
        { width: 10, height: 10, matrix: I },
        resources().res,
      )
      return (ctx.named('fill')[0]!.fillStyle as { stops: [number, string][] }).stops
    }
    expect(
      stopsOf([
        { position: 0, color: BLACK },
        { position: 1, color: WHITE },
      ]).map((s) => s[1]),
    ).toEqual(['#000000', '#6B6B6B', '#B9B9B9', '#EBEBEB', '#FFFFFF'])
    expect(
      stopsOf([
        { position: 0, color: WHITE },
        { position: 1, color: BLACK },
      ]).map((s) => s[1]),
    ).toEqual(['#FFFFFF', '#EBEBEB', '#B9B9B9', '#6B6B6B', '#000000'])
    expect(
      stopsOf([
        { position: 0.2, color: BLACK },
        { position: 0.8, color: WHITE },
      ]),
    ).toEqual([
      [0.2, '#000000'],
      [0.8, '#FFFFFF'],
    ])
  })

  test('圆形路径渐变在单位正方形中绘制，半径为焦点到最远角的距离', () => {
    const ctx = new RecordingContext()
    const fill: Fill = {
      kind: 'gradient',
      stops: [
        { position: 0, color: RED },
        { position: 1, color: BLUE },
      ],
      shade: {
        kind: 'path',
        path: 'circle',
        focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 },
      },
      flip: 'none',
      rotateWithShape: true,
    }
    const { res } = resources()
    paintFill(
      ctx,
      () => traceRect(ctx, 200, 100),
      fill,
      { width: 200, height: 100, matrix: I },
      res,
    )
    const rect = ctx.named('fillRect')[0]!
    expect(rect.matrix).toEqual({ a: 200, b: 0, c: 0, d: 100, e: 0, f: 0 })
    const g = rect.fillStyle as { points: number[] }
    expect(g.points.slice(0, 2)).toEqual([0.5, 0.5])
    expect(g.points[5]).toBeCloseTo(Math.SQRT1_2, 9)
    expect(ctx.named('clip').length).toBe(1)
  })

  test('矩形路径渐变：焦点区域为首个色标的颜色，上下为竖直渐变带，左右为水平渐变的梯形', () => {
    const ctx = new RecordingContext()
    const fill: Fill = {
      kind: 'gradient',
      stops: [
        { position: 0, color: RED },
        { position: 1, color: BLUE },
      ],
      shade: {
        kind: 'path',
        path: 'rect',
        focus: { left: 0.25, top: 0.25, right: 0.25, bottom: 0.25 },
      },
      flip: 'none',
      rotateWithShape: true,
    }
    const { res } = resources()
    paintFill(
      ctx,
      () => traceRect(ctx, 100, 100),
      fill,
      { width: 100, height: 100, matrix: I },
      res,
    )
    const rects = ctx.named('fillRect')
    expect(rects[1]!.args).toEqual([24, 24, 52, 52])
    expect(rects[1]!.fillStyle).toBe('#FF0000')
    const bands = rects.slice(2).map((r) => [r.args, (r.fillStyle as { points: number[] }).points])
    expect(bands).toEqual([
      [
        [0, 0, 100, 25],
        [0, 25, 0, 0],
      ],
      [
        [0, 75, 100, 25],
        [0, 75, 0, 100],
      ],
    ])
    const sides = ctx.named('fill').map((c) => (c.fillStyle as { points: number[] }).points)
    expect(sides).toEqual([
      [25, 0, 0, 0],
      [75, 0, 100, 0],
    ])
  })

  test('图片裁剪：负比例时图片在目标区域内缩小，正比例时取原图的一部分', () => {
    const ctx = new RecordingContext()
    const img = { width: 100, height: 50 }
    drawCropped(ctx, img, 'high', { left: 0.1, top: 0, right: 0.1, bottom: 0.5 }, 0, 0, 80, 25)
    expect(ctx.named('drawImage')[0]!.args.slice(1)).toEqual([10, 0, 80, 25, 0, 0, 80, 25])
    const ctx2 = new RecordingContext()
    drawCropped(ctx2, img, 'high', { left: -0.5, top: 0, right: 0, bottom: 0 }, 0, 0, 150, 50)
    expect(ctx2.named('drawImage')[0]!.args.slice(1)).toEqual([0, 0, 100, 50, 50, 0, 100, 50])
  })

  test('图元文件的图片填充：图片框映射到拉伸区域、裁剪到该区域，在设备坐标中按整像素回放；平铺时按图片框的 96 dpi 尺寸栅格化', () => {
    const metafile = readMetafile(RED_RECT_WMF)!
    const picture: PaintPicture = { kind: 'metafile', metafile, images: [] }
    const zero = { left: 0, top: 0, right: 0, bottom: 0 }
    const image = (tile: ImageFill['tile']): ImageFill => ({
      part: 'a.wmf',
      crop: zero,
      stretch: zero,
      tile,
      alpha: 1,
      effects: [],
      rotateWithShape: true,
    })
    const matrix = { a: 1.5, b: 0, c: 0, d: 1.5, e: 10.3, f: 20.2 }
    const f = canvasFactory()
    const res = { image: () => picture, createCanvas: f.create, metafileFonts: null }
    const ctx = new RecordingContext()
    ctx.setTransform(1.5, 0, 0, 1.5, 10.3, 20.2)
    paintImageFill(ctx, image(null), { width: 200, height: 100, matrix }, res)
    // 图片框 100 × 50 映射到设备坐标 (10.3, 20.2) 起 300 × 150；矩形 (10, 10) 换算为 (40.3, 50.2) 后取整。
    const clip = ctx.named('rect')[0]!
    expect(clip.args).toEqual([10.3, 20.2, 300, 150])
    expect(clip.matrix).toEqual(I)
    const red = ctx.calls.findIndex((c) => c.name === 'fill' && c.fillStyle === 'rgb(255,0,0)')
    expect(red).toBeGreaterThan(0)
    expect(ctx.calls.slice(0, red).findLast((c) => c.name === 'moveTo')!.args).toEqual([40, 50])
    const tiled = new RecordingContext()
    const g = canvasFactory()
    const tile = {
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      flip: 'none' as const,
      align: 'tl',
    }
    paintImageFill(
      tiled,
      image(tile),
      { width: 200, height: 100, matrix: I },
      { ...res, createCanvas: g.create },
    )
    expect(g.created.map((c) => [c.width, c.height])).toEqual([[100, 50]])
    expect(g.created[0]!.context.named('fill').some((c) => c.fillStyle === 'rgb(255,0,0)')).toBe(
      true,
    )
  })

  test('图元文件含文字而没有字体时不绘制', () => {
    const text = placeableWmf([
      [0x02fb, -20 & 0xffff, 0, 0, 0, 400, 0, 0, 0, 0, 0x7241, 0x6169, 0x006c],
      [0x012d, 0],
      [0x0a32, 0, 20, 1, 0, 0x41, 12],
    ])
    const picture: PaintPicture = { kind: 'metafile', metafile: readMetafile(text)!, images: [] }
    const ctx = new RecordingContext()
    drawPicture(
      ctx,
      picture,
      { left: 0, top: 0, right: 0, bottom: 0 },
      { x: 0, y: 0, width: 100, height: 50 },
      I,
      'high',
      null,
    )
    expect(ctx.calls.length).toBe(0)
  })

  test('拉伸图片填充按 fillRect 内缩并乘以透明度', () => {
    const ctx = new RecordingContext()
    const { res } = resources({ '/ppt/media/a.png': { width: 10, height: 10 } })
    const fill: Fill = {
      kind: 'picture',
      image: {
        part: '/ppt/media/a.png',
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        stretch: { left: 0.1, top: 0.2, right: 0.1, bottom: 0.2 },
        tile: null,
        alpha: 0.5,
        effects: [],
        rotateWithShape: true,
      },
    }
    paintFill(ctx, () => traceRect(ctx, 100, 50), fill, { width: 100, height: 50, matrix: I }, res)
    const draw = ctx.named('drawImage')[0]!
    expect(draw.args.slice(5)).toEqual([10, 10, 80, 30])
    expect(draw.alpha).toBe(0.5)
  })

  test('平铺图片以图案填充，对齐与缩放写入图案变换', () => {
    const ctx = new RecordingContext()
    const { res } = resources({ p: { width: 10, height: 20 } })
    const fill: Fill = {
      kind: 'picture',
      image: {
        part: 'p',
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        stretch: null,
        tile: { offsetX: 9525, offsetY: 0, scaleX: 2, scaleY: 1, flip: 'none', align: 'br' },
        alpha: 1,
        effects: [],
        rotateWithShape: true,
      },
    }
    paintFill(ctx, () => traceRect(ctx, 100, 50), fill, { width: 100, height: 50, matrix: I }, res)
    const pattern = ctx.named('fillRect')[0]!.fillStyle as { transform: Record<string, number> }
    expect(pattern.transform).toEqual({ a: 2, b: 0, c: 0, d: 1, e: 100 - 20 + 1, f: 50 - 20 })
  })

  test('平铺单元按图片的分辨率换算为 96 dpi 像素并取整', () => {
    const ctx = new RecordingContext()
    const { res } = resources({ p: { width: 120, height: 90 } }, { x: 150, y: 75 })
    const fill: Fill = {
      kind: 'picture',
      image: {
        part: 'p',
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        stretch: null,
        tile: { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, flip: 'none', align: 'tl' },
        alpha: 1,
        effects: [],
        rotateWithShape: true,
      },
    }
    paintFill(
      ctx,
      () => traceRect(ctx, 300, 200),
      fill,
      { width: 300, height: 200, matrix: I },
      res,
    )
    const pattern = ctx.named('fillRect')[0]!.fillStyle as { transform: Record<string, number> }
    expect(pattern.transform.a! * 120).toBeCloseTo(77, 9)
    expect(pattern.transform.d! * 90).toBeCloseTo(115, 9)
  })

  test('图案填充：8 × 8 图层按前景与背景色绘制，关闭平滑', () => {
    const ctx = new RecordingContext()
    const { res, created } = resources()
    const fill: Fill = { kind: 'pattern', preset: 'horz', foreground: RED, background: BLUE }
    paintFill(ctx, () => traceRect(ctx, 10, 10), fill, { width: 10, height: 10, matrix: I }, res)
    expect(created[0]!.width).toBe(8)
    const cells = created[0]!.context.named('fillRect')
    expect(cells[0]!.fillStyle).toBe('rgba(0, 0, 255, 0.5)')
    expect(cells.slice(1).map((c) => c.args)).toEqual(
      Array.from({ length: 8 }, (_, x) => [x, 0, 1, 1]),
    )
  })

  test('明暗修饰叠加半透明白色或黑色', () => {
    const ctx = new RecordingContext()
    paintFillModifier(ctx, () => traceRect(ctx, 1, 1), 'darkenLess')
    expect(ctx.named('fill')[0]!.fillStyle).toBe('rgba(0,0,0,0.2)')
    const ctx2 = new RecordingContext()
    paintFillModifier(ctx2, () => traceRect(ctx2, 1, 1), 'norm')
    expect(ctx2.calls.length).toBe(0)
  })
})

describe('线条', () => {
  test('宽度为 0 时为 1 个设备像素；虚线为线宽的倍数', () => {
    expect(lineWidth(solidLine({ width: 0 }), scaling(2, 2))).toBe(0.5)
    expect(dashPattern(solidLine({ dash: { kind: 'preset', name: 'sysDash' } }), 2)).toEqual([6, 2])
    expect(
      dashPattern(solidLine({ dash: { kind: 'custom', stops: [{ dash: 1.5, space: 0.5 }] } }), 4),
    ).toEqual([6, 2])
  })

  /** 原始失败形状：圆形端点的 `sysDot` 趋势线画成实线，Canvas 把半圆加在每段两端之外，间隔被填满。 */
  test('圆形端点的虚线：线段缩短一个线宽、间隔加长一个线宽；方形端点只用于实线', () => {
    const dot = { kind: 'preset', name: 'sysDot' } as const
    expect(dashPattern(solidLine({ cap: 'rnd', dash: dot }), 2)).toEqual([0, 4])
    expect(
      dashPattern(solidLine({ cap: 'rnd', dash: { kind: 'preset', name: 'dash' } }), 2),
    ).toEqual([6, 8])
    expect(dashPattern(solidLine({ cap: 'sq', dash: dot }), 2)).toEqual([2, 2])
    const caps = (line: Line) => {
      const ctx = new RecordingContext()
      paintLine(ctx, straight, line, { width: 100, height: 0, matrix: I }, resources().res, {
        width: 200,
        height: 200,
      })
      return ctx.lineCap
    }
    expect(caps(solidLine({ cap: 'sq', dash: dot }))).toBe('butt')
    expect(caps(solidLine({ cap: 'sq' }))).toBe('square')
  })

  test('纯色单线直接描边，端点与连接按线条设置', () => {
    const ctx = new RecordingContext()
    const { res } = resources()
    paintLine(
      ctx,
      straight,
      solidLine({ cap: 'rnd', join: 'miter', miterLimit: 8 }),
      { width: 100, height: 0, matrix: I },
      res,
      {
        width: 200,
        height: 200,
      },
    )
    const s = ctx.named('stroke')[0]!
    expect(s.lineWidth).toBe(2)
    expect(s.strokeStyle).toBe('#FF0000')
    expect(ctx.lineCap).toBe('round')
    expect(ctx.miterLimit).toBe(8)
  })

  test('三角形箭头：线条缩短到箭头底部，箭头为填充的三角形', () => {
    const ctx = new RecordingContext()
    const { res } = resources()
    const line = solidLine({
      width: 9525 * 4,
      tail: { type: 'triangle', width: 'med', length: 'lg' },
    })
    paintLine(ctx, straight, line, { width: 100, height: 0, matrix: I }, res, {
      width: 200,
      height: 200,
    })
    const lines = ctx.named('lineTo')
    expect(lines[0]!.args).toEqual([100 - 20, 0])
    const tip = ctx.named('moveTo').at(-1)!.args
    expect(tip[0]).toBeCloseTo(100, 9)
    expect(lines.at(-2)!.args[0]).toBeCloseTo(80, 9)
    expect(lines.at(-2)!.args[1]).toBeCloseTo(-6, 9)
    expect(ctx.named('fill').length).toBe(1)
  })

  test('箭头只画在开放路径上；细线按 2 像素计算箭头尺寸', () => {
    const ctx = new RecordingContext()
    const { res } = resources()
    const closed: ShapePath[] = [
      { fill: 'norm', stroke: true, segments: [...straight[0]!.segments, { kind: 'close' }] },
    ]
    const line = solidLine({ width: 9525, head: { type: 'oval', width: 'sm', length: 'sm' } })
    paintLine(ctx, closed, line, { width: 100, height: 0, matrix: I }, res, {
      width: 200,
      height: 200,
    })
    expect(ctx.named('ellipse').length).toBe(0)
    const ctx2 = new RecordingContext()
    paintLine(ctx2, straight, line, { width: 100, height: 0, matrix: I }, res, {
      width: 200,
      height: 200,
    })
    expect(ctx2.named('ellipse')[0]!.args.slice(0, 4)).toEqual([0, 0, 2, 2])
  })

  test('内侧对齐裁剪到路径内部并以两倍线宽描边', () => {
    const ctx = new RecordingContext()
    const { res } = resources()
    const closed: ShapePath[] = [
      { fill: 'norm', stroke: true, segments: [...straight[0]!.segments, { kind: 'close' }] },
    ]
    paintLine(ctx, closed, solidLine({ align: 'in' }), { width: 100, height: 0, matrix: I }, res, {
      width: 200,
      height: 200,
    })
    expect(ctx.named('clip').length).toBe(1)
    expect(ctx.named('stroke')[0]!.lineWidth).toBe(4)
  })

  test('复合线在图层中描出：dbl 擦去中间三分之一', () => {
    const ctx = new RecordingContext()
    const { res, created } = resources()
    paintLine(
      ctx,
      straight,
      solidLine({ width: 9525 * 9, compound: 'dbl' }),
      { width: 100, height: 0, matrix: I },
      res,
      {
        width: 200,
        height: 200,
      },
    )
    const strokes = created[0]!.context.named('stroke')
    expect(strokes.map((s) => [s.lineWidth, s.composite])).toEqual([
      [9, 'source-over'],
      [3, 'destination-out'],
    ])
    expect(ctx.named('drawImage').length).toBe(1)
  })

  test('渐变线条：线条图层以填充图层覆盖（source-in）', () => {
    const ctx = new RecordingContext()
    const { res, created } = resources()
    const line = solidLine({
      fill: {
        kind: 'gradient',
        stops: [
          { position: 0, color: RED },
          { position: 1, color: BLUE },
        ],
        shade: { kind: 'linear', angle: 0, scaled: false },
        flip: 'none',
        rotateWithShape: true,
      },
    })
    paintLine(ctx, straight, line, { width: 100, height: 10, matrix: I }, res, {
      width: 200,
      height: 200,
    })
    expect(created.length).toBe(2)
    const composite = created[0]!.context.named('drawImage')[0]!
    expect(composite.composite).toBe('source-in')
    expect(composite.args[0]).toBe(created[1])
  })
})

describe('外部阴影', () => {
  const base: OuterShadow = {
    kind: 'outerShadow',
    color: { r: 0, g: 0, b: 0, a: 0.5 },
    blur: 9525 * 4,
    distance: 9525 * 10,
    direction: 90,
    scaleX: 1,
    scaleY: 1,
    skewX: 0,
    skewY: 0,
    align: 'b',
    rotateWithShape: false,
  }

  test('偏移按方向与距离换算为设备像素；缩放以对齐点为原点', () => {
    const m = shadowMatrix(base, scaling(2, 2), 50, 20, 2)
    expect(apply(m, 0, 0)).toEqual({ x: 0, y: 20 })
    const scaled = shadowMatrix({ ...base, scaleX: 0.5, scaleY: -0.5, distance: 0 }, I, 100, 40, 1)
    // 对齐点为底边中点 (50, 40)：该点不动，顶边中点翻到下方。
    expect(apply(scaled, 50, 40)).toEqual({ x: 50, y: 40 })
    expect(apply(scaled, 50, 0)).toEqual({ x: 50, y: 60 })
  })

  test('rotWithShape 为真时偏移方向随形状旋转', () => {
    const m = shadowMatrix(
      { ...base, rotateWithShape: true, direction: 0 },
      rotation(Math.PI / 2),
      10,
      10,
      1,
    )
    const p = apply(m, 0, 0)
    expect(p.x).toBeCloseTo(0, 9)
    expect(p.y).toBeCloseTo(10, 9)
  })

  test('先绘制阴影（图层移出画布、阴影偏移移回），再绘制图层本身', () => {
    const ctx = new RecordingContext()
    const { res, created } = resources()
    paintWithEffects(
      ctx,
      { ...NO_EFFECTS, shadows: [base] },
      { matrix: I, width: 10, height: 10, scale: 1 },
      { x: 5, y: 6, w: 10, h: 10 },
      res,
      { width: 100, height: 100 },
      (c) => c.fillRect(0, 0, 1, 1),
    )
    const draws = ctx.named('drawImage')
    expect(draws.length).toBe(2)
    expect(draws[0]!.args[0]).toBe(created[0])
    const away = 100 + 5 + 10 + 1000
    expect(draws[0]!.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: -away, f: 10 })
    expect(draws[1]!.matrix).toEqual(I)
    expect(draws[1]!.args.slice(1)).toEqual([5, 6])
  })

  test('内部阴影：裁剪到形状区域后填充区域之外的轮廓，阴影向 dir 的反方向偏移而出现在 dir 一侧', () => {
    const ctx = new RecordingContext()
    const inner: InnerShadow = {
      kind: 'innerShadow',
      color: RED,
      blur: 9525 * 4,
      distance: 9525 * 10,
      direction: 45,
    }
    const append = () => ctx.rect(0, 0, 20, 10)
    paintInnerShadows(ctx, append, [inner], {
      matrix: scaling(2, 2),
      width: 20,
      height: 10,
      scale: 2,
    })
    const names = ctx.calls.map((c) => c.name).filter((n) => n === 'clip' || n === 'fill')
    expect(names).toEqual(['clip', 'fill'])
    expect(ctx.named('fill')[0]!.args).toEqual(['evenodd'])
    expect(ctx.shadowOffsetX).toBeCloseTo(-20 * Math.SQRT1_2, 9)
    expect(ctx.shadowOffsetY).toBeCloseTo(-20 * Math.SQRT1_2, 9)
    expect(ctx.shadowBlur).toBe(8)
  })
})

describe('发光、柔化边缘与映像', () => {
  /** 宽 `w` 高 `h` 的不透明矩形放在四周留白 `pad` 的图层中。 */
  const rect = (w: number, h: number, pad: number) => {
    const W = w + 2 * pad
    const H = h + 2 * pad
    const a = new Float32Array(W * H)
    for (let y = pad; y < pad + h; y++) a.fill(1, y * W + pad, y * W + pad + w)
    return { a, W, H }
  }

  test('膨胀量：发光为半径的 0.425 倍、柔化边缘为 0.83 倍（向下取整，设备像素）', () => {
    // WPS 演示实测：发光 2、4、8、12、16、20、28 磅，柔化边缘 2、4、8、12、16、24 磅。
    expect([2, 4, 8, 12, 16, 20, 28].map((pt) => glowSpread((pt * 4) / 3))).toEqual([
      1, 2, 4, 6, 9, 11, 15,
    ])
    expect([2, 4, 8, 12, 16, 24].map((pt) => softEdgeInset((pt * 4) / 3))).toEqual([
      2, 4, 8, 13, 17, 26,
    ])
  })

  test('矩形 12 磅发光的边缘剖面', () => {
    const { a, W } = rect(160, 80, 30)
    const g = glowAlpha(a, W, 140, glowSpread(16))
    const row = 30 + 40
    // 自矩形左边向外第 1–12 个像素（WPS 演示导出图，白底红色发光）。
    const wps = [0.992, 0.973, 0.929, 0.855, 0.749, 0.6, 0.4, 0.247, 0.141, 0.071, 0.027, 0.004]
    for (const [i, v] of wps.entries())
      expect(Math.abs(g[row * W + 29 - i]! - v)).toBeLessThan(0.02)
    // 形状内部同样有发光（半透明填充之下可见）。
    expect(g[row * W + 100]!).toBeCloseTo(1, 3)
  })

  test('矩形 12 磅柔化边缘的边缘剖面', () => {
    const { a, W } = rect(200, 120, 5)
    const m = softEdgeMask(a, W, 130, softEdgeInset(16))
    const row = 5 + 60
    // 自矩形左边向内第 1–24 个像素（WPS 演示导出图，白底黑色矩形）。
    const wps = [
      0, 0.004, 0.008, 0.02, 0.031, 0.055, 0.082, 0.118, 0.161, 0.216, 0.278, 0.357, 0.447, 0.549,
      0.639, 0.718, 0.78, 0.835, 0.882, 0.918, 0.945, 0.965, 0.98, 0.988,
    ]
    for (const [i, v] of wps.entries()) expect(Math.abs(m[row * W + 5 + i]! - v)).toBeLessThan(0.02)
  })

  test('合成顺序：映像、阴影、内容；映像按对称轴翻转，渐变自对称轴由 stA 变为 endA', () => {
    const ctx = new RecordingContext()
    const { res, created } = resources()
    const reflection: Reflection = {
      kind: 'reflection',
      blur: 0,
      distance: 0,
      direction: 90,
      scaleX: 1,
      scaleY: -1,
      skewX: 0,
      skewY: 0,
      align: 'bl',
      rotateWithShape: false,
      startAlpha: 0.5,
      startPosition: 0,
      endAlpha: 0,
      endPosition: 0.5,
      fadeDirection: 90,
    }
    const shadow = {
      kind: 'outerShadow' as const,
      color: { r: 0, g: 0, b: 0, a: 0.5 },
      blur: 0,
      distance: 9525,
      direction: 0,
      scaleX: 1,
      scaleY: 1,
      skewX: 0,
      skewY: 0,
      align: 'b',
      rotateWithShape: false,
    }
    paintWithEffects(
      ctx,
      { ...NO_EFFECTS, shadows: [shadow], reflection },
      { matrix: translation(10, 20), width: 100, height: 40, scale: 1 },
      { x: 10, y: 20, w: 100, h: 40 },
      res,
      { width: 400, height: 400 },
      (c) => c.fillRect(0, 0, 1, 1),
    )
    const draws = ctx.named('drawImage')
    expect(draws.length).toBe(3)
    // 映像：内容图层的副本，以底边 y = 60 为对称轴翻转。
    expect(draws[0]!.args[0]).toBe(created[1])
    expect(apply(draws[0]!.matrix, 50, 60)).toEqual({ x: 50, y: 60 })
    expect(apply(draws[0]!.matrix, 50, 20)).toEqual({ x: 50, y: 100 })
    expect(draws[2]!.args[0]).toBe(created[0])
    // 渐变在局部坐标中自底边（对称轴）指向顶边。
    const fill = created[1]!.context.named('fillRect')[0]!
    const g = fill.fillStyle as { points: number[]; stops: [number, string][] }
    expect(fill.composite).toBe('destination-in')
    for (const [i, v] of [0, 40, 0, 0].entries()) expect(g.points[i]!).toBeCloseTo(v, 9)
    expect(g.stops).toEqual([
      [0, 'rgba(0,0,0,0.5)'],
      [0.5, 'rgba(0,0,0,0)'],
    ])
  })
})

function be32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
}

function le32(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
}

function chars(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0))
}

function pngWith(phys: [number, number, number] | null): Uint8Array {
  const head = [0x89, ...chars('PNG'), 0x0d, 0x0a, 0x1a, 0x0a]
  const ihdr = [...be32(13), ...chars('IHDR'), ...new Array(13).fill(0), 0, 0, 0, 0]
  const p =
    phys === null
      ? []
      : [...be32(9), ...chars('pHYs'), ...be32(phys[0]), ...be32(phys[1]), phys[2], 0, 0, 0, 0]
  return new Uint8Array([...head, ...ihdr, ...p, ...be32(0), ...chars('IDAT'), 0, 0, 0, 0])
}

function app0(units: number, x: number, y: number): number[] {
  return [
    0xff,
    0xe0,
    0,
    16,
    ...chars('JFIF'),
    0,
    1,
    1,
    units,
    x >> 8,
    x & 255,
    y >> 8,
    y & 255,
    0,
    0,
  ]
}

/** 大端 TIFF 头、一个 IFD（XResolution、YResolution、ResolutionUnit）与两个有理数。 */
function app1(dpi: number): number[] {
  const tiff = [...chars('MM'), 0, 42, ...be32(8), 0, 3]
  const entry = (tag: number, type: number, value: number[]) => [
    tag >> 8,
    tag & 255,
    0,
    type,
    ...be32(1),
    ...value,
  ]
  const data = 8 + 2 + 3 * 12 + 4
  const body = [
    ...tiff,
    ...entry(282, 5, be32(data)),
    ...entry(283, 5, be32(data + 8)),
    ...entry(296, 3, [0, 2, 0, 0]),
    ...be32(0),
    ...be32(dpi),
    ...be32(1),
    ...be32(dpi),
    ...be32(1),
  ]
  const len = 2 + 6 + body.length
  return [0xff, 0xe1, len >> 8, len & 255, ...chars('Exif'), 0, 0, ...body]
}

function jpegWith(...segments: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...segments.flat(), 0xff, 0xda, 0, 2])
}

describe('imageResolution', () => {
  test('PNG：pHYs 单位为米时换算为每英寸，单位为 0 或没有 pHYs 时为 96', () => {
    const r = imageResolution(pngWith([5906, 2953, 1]))
    expect(r.x).toBeCloseTo(150.01, 2)
    expect(r.y).toBeCloseTo(75.01, 2)
    expect(imageResolution(pngWith([3, 1, 0]))).toEqual(SCREEN_RESOLUTION)
    expect(imageResolution(pngWith(null))).toEqual(SCREEN_RESOLUTION)
  })

  test('JPEG：有 JFIF 时只按 JFIF 的密度，没有 JFIF 时按 EXIF', () => {
    expect(imageResolution(jpegWith(app0(1, 150, 150)))).toEqual({ x: 150, y: 150 })
    expect(imageResolution(jpegWith(app0(2, 59, 59))).x).toBeCloseTo(149.86, 9)
    expect(imageResolution(jpegWith(app0(0, 1, 1), app1(300)))).toEqual(SCREEN_RESOLUTION)
    expect(imageResolution(jpegWith(app0(1, 72, 72), app1(300)))).toEqual({ x: 72, y: 72 })
    expect(imageResolution(jpegWith(app1(150)))).toEqual({ x: 150, y: 150 })
  })

  test('BMP 按每米像素数；GIF 与无法识别的字节为 96', () => {
    const bmp = new Uint8Array(54)
    bmp.set(chars('BM'), 0)
    bmp.set(le32(40), 14)
    bmp.set(le32(5906), 38)
    bmp.set(le32(5906), 42)
    expect(imageResolution(bmp).x).toBeCloseTo(150.01, 2)
    expect(imageResolution(new Uint8Array(chars('GIF89a')))).toEqual(SCREEN_RESOLUTION)
    expect(imageResolution(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual(SCREEN_RESOLUTION)
  })
})

describe('recolorPixels', () => {
  /** 每个像素一组 `[r, g, b, a]`。 */
  const run = (pixels: readonly (readonly number[])[], effects: readonly ImageEffect[]) => {
    const data = new Uint8ClampedArray(pixels.flat())
    recolorPixels(data, effects)
    return Array.from({ length: pixels.length }, (_, i) =>
      Array.from(data.subarray(4 * i, 4 * i + 4)),
    )
  }
  const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 }
  const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 }
  const ORANGE: Color = { r: 1, g: 128 / 255, b: 0, a: 1 }

  test('灰度为 (55 R + 183 G + 18 B) >> 8；黑白阈值 50% 的分界为灰度 128', () => {
    const rgb = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]
    expect(run(rgb, [{ kind: 'grayscale' }]).map((p) => p[0])).toEqual([54, 182, 17])
    const gray = [
      [127, 127, 127, 255],
      [128, 128, 128, 255],
    ]
    expect(run(gray, [{ kind: 'biLevel', threshold: 0.5 }]).map((p) => p[0])).toEqual([0, 255])
  })

  test('亮度与对比度：亮度 −24% 时 255 → 194、64 → 3；亮度 70% 对比度 −70% 时 64 → 224、0 → 205', () => {
    const px = [
      [255, 255, 255, 255],
      [64, 64, 64, 255],
      [0, 0, 0, 255],
    ]
    const dark = run(px, [{ kind: 'luminance', bright: -0.24, contrast: 0 }])
    expect(dark.map((p) => p[0])).toEqual([194, 3, 0])
    const washout = run(px, [{ kind: 'luminance', bright: 0.7, contrast: -0.7 }])
    expect(washout.map((p) => p[0])).toEqual([255, 224, 205])
  })

  test('双色调按灰度插值：白到黑时红色为 200，红到蓝时灰度 128 为 (127, 0, 128)；透明度不变', () => {
    const px = [
      [255, 0, 0, 255],
      [128, 128, 128, 128],
    ]
    expect(run(px, [{ kind: 'duotone', dark: WHITE, light: BLACK }])[0]).toEqual([
      200, 200, 200, 255,
    ])
    const rb = run(px, [{ kind: 'duotone', dark: RED, light: { ...BLUE, a: 1 } }])
    expect(rb[1]).toEqual([127, 0, 128, 128])
  })

  test('透明色：不透明且各通道相差不超过 1 的像素变为透明，clrTo 不参与；半透明的像素不变', () => {
    const px = [
      [255, 255, 255, 255],
      [254, 254, 254, 255],
      [253, 253, 253, 255],
      [255, 255, 254, 255],
      [255, 255, 255, 128],
    ]
    const out = run(px, [{ kind: 'colorChange', from: WHITE }])
    expect(out.map((p) => p[3])).toEqual([0, 0, 255, 0, 128])
  })

  test('运算顺序与文档顺序无关：亮度在双色调之后；黑白、灰度与双色调同时出现时只按优先的一种', () => {
    const black = [[0, 0, 0, 255]]
    const duo: ImageEffect = { kind: 'duotone', dark: BLACK, light: ORANGE }
    const lum: ImageEffect = { kind: 'luminance', bright: 0.2, contrast: 0 }
    expect(run(black, [duo, lum])[0]).toEqual([50, 50, 50, 255])
    expect(run(black, [lum, duo])[0]).toEqual([50, 50, 50, 255])
    const white = [[255, 255, 255, 255]]
    expect(run(white, [{ kind: 'biLevel', threshold: 0.5 }, duo])[0]).toEqual([255, 255, 255, 255])
    expect(run(white, [duo, { kind: 'grayscale' }])[0]).toEqual([255, 255, 255, 255])
  })
})
