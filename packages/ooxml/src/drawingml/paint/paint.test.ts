/**
 * 覆盖范围：`fill.ts`（线性渐变起止点、路径渐变焦点、圆形与矩形路径渐变、图片裁剪与拉伸、平铺、图案、明暗修饰）、
 * `line.ts`（线宽、虚线、端点与连接、内侧对齐、复合线、箭头与线条缩短、非纯色线条的图层）、
 * `shadow.ts`（阴影变换、只绘制阴影的偏移、带阴影绘制的图层顺序）、`context.ts`（矩阵运算）。
 */

import { describe, expect, test } from 'bun:test'
import type { Color } from '../color.ts'
import type { Fill, Line } from '../fill.ts'
import type { ShapePath } from '../geometry/path.ts'
import { apply, invert, multiply, rotation, scaling, translation } from './context.ts'
import {
  drawCropped,
  focusRect,
  linearGradientLine,
  paintFill,
  paintFillModifier,
  traceRect,
} from './fill.ts'
import { dashPattern, lineWidth, paintLine } from './line.ts'
import { type OuterShadow, paintWithShadows, shadowMatrix } from './shadow.ts'
import { canvasFactory, RecordingContext } from './test-helper.ts'

const RED: Color = { r: 1, g: 0, b: 0, a: 1 }
const BLUE: Color = { r: 0, g: 0, b: 1, a: 0.5 }
const I = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function resources(images: Record<string, { width: number; height: number }> = {}) {
  const f = canvasFactory()
  return {
    res: { image: (p: string) => images[p] ?? null, createCanvas: f.create },
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
      [1, 'rgba(0, 0, 255, 0.5)'],
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
    drawCropped(ctx, img, { left: 0.1, top: 0, right: 0.1, bottom: 0.5 }, 0, 0, 80, 25)
    expect(ctx.named('drawImage')[0]!.args.slice(1)).toEqual([10, 0, 80, 25, 0, 0, 80, 25])
    const ctx2 = new RecordingContext()
    drawCropped(ctx2, img, { left: -0.5, top: 0, right: 0, bottom: 0 }, 0, 0, 150, 50)
    expect(ctx2.named('drawImage')[0]!.args.slice(1)).toEqual([0, 0, 100, 50, 50, 0, 100, 50])
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
    expect(ctx.globalAlpha).toBe(0.5)
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
    paintWithShadows(
      ctx,
      [base],
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
})
