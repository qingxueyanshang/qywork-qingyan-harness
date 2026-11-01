/**
 * 覆盖范围：`formula.ts`（17 种运算、内置量、调整值覆盖）、`preset.ts`（预设定义解码）、
 * `path.ts`（路径展开、`arcTo` 的参数角换算、路径坐标系缩放、输出单位、文本矩形、端点切线）。
 */

import { describe, expect, test } from 'bun:test'
import { evaluateFormula, evaluateGuides } from './formula.ts'
import type { Geometry } from './model.ts'
import { pathEnds, type Segment, shapeOutline } from './path.ts'
import { presetGeometry } from './preset.ts'
import { PRESET_SHAPES } from './presets.gen.ts'

const values = new Map<string, number>([
  ['a', 10],
  ['b', 20],
  ['c', 4],
  ['neg', -3],
])
const lookup = (n: string) => values.get(n) ?? 0
const f = (formula: string) => evaluateFormula(formula, lookup)

describe('公式', () => {
  test('17 种运算按定义求值，角度为六万分之一度', () => {
    expect(f('val 7')).toBe(7)
    expect(f('*/ a b c')).toBe(50)
    expect(f('+- a b c')).toBe(26)
    expect(f('+/ a b c')).toBe(7.5)
    expect(f('?: a b c')).toBe(20)
    expect(f('?: neg b c')).toBe(4)
    expect(f('abs neg')).toBe(3)
    expect(f('at2 1 1')).toBeCloseTo(2700000, 6)
    expect(f('cat2 a 1 1')).toBeCloseTo(10 * Math.SQRT1_2, 9)
    expect(f('sat2 a 1 1')).toBeCloseTo(10 * Math.SQRT1_2, 9)
    expect(f('cos a 5400000')).toBeCloseTo(0, 9)
    expect(f('sin a 5400000')).toBeCloseTo(10, 9)
    expect(f('tan a 2700000')).toBeCloseTo(10, 9)
    expect(f('max a b')).toBe(20)
    expect(f('min a b')).toBe(10)
    expect(f('mod 3 4 12')).toBe(13)
    expect(f('pin a 5 b')).toBe(10)
    expect(f('pin a 25 b')).toBe(20)
    expect(f('pin a 15 b')).toBe(15)
    expect(f('sqrt 16')).toBe(4)
  })

  test('除数为 0 与未知运算得 0', () => {
    expect(f('*/ a b 0')).toBe(0)
    expect(f('+/ a b 0')).toBe(0)
    expect(f('foo a')).toBe(0)
  })

  test('内置量与调整值：形状的调整值按名称覆盖定义中的缺省值，参数按顺序求值', () => {
    const v = evaluateGuides(
      [
        { name: 'adj', formula: 'val 25000' },
        { name: 'adj2', formula: 'val 1' },
      ],
      [{ name: 'adj', formula: 'val 50000' }],
      [
        { name: 'x1', formula: '*/ w adj 100000' },
        { name: 'x2', formula: '+- x1 wd4 0' },
        { name: 'y1', formula: '*/ ss 1 1' },
        { name: 'a', formula: '+- 3cd4 cd8 0' },
        { name: 'q', formula: '+- ssd8 hd2 ls' },
      ],
      400,
      200,
    )
    expect(v.get('adj')).toBe(50000)
    expect(v.get('adj2')).toBe(1)
    expect(v.get('x1')).toBe(200)
    expect(v.get('x2')).toBe(300)
    expect(v.get('y1')).toBe(200)
    expect(v.get('a')).toBe(16200000 + 2700000)
    expect(v.get('q')).toBe(25 + 100 - 400)
  })
})

function finite(segments: readonly Segment[]): boolean {
  return segments.every((s) =>
    Object.values(s).every((v) => typeof v !== 'number' || Number.isFinite(v)),
  )
}

describe('预设几何', () => {
  test('全部预设都能解码并在非正方形尺寸下得到有限坐标', () => {
    const names = Object.keys(PRESET_SHAPES)
    expect(names.length).toBe(187)
    for (const name of names) {
      const def = presetGeometry(name)
      expect(def).not.toBeNull()
      const outline = shapeOutline({ kind: 'preset', name, adjust: [] }, 914400, 457200)
      expect(outline.paths.length).toBeGreaterThan(0)
      for (const p of outline.paths) expect(finite(p.segments)).toBe(true)
    }
  })

  test('upArrow 为 downArrow 的上下镜像', () => {
    const up = shapeOutline({ kind: 'preset', name: 'upArrow', adjust: [] }, 100, 200)
    const down = shapeOutline({ kind: 'preset', name: 'downArrow', adjust: [] }, 100, 200)
    const pts = (s: readonly Segment[]) =>
      s.flatMap((x) => ('x' in x && x.kind !== 'arc' ? [[x.x, x.y]] : []))
    const mirrored = pts(down.paths[0]!.segments)
      .map(([x, y]) => `${x},${200 - y!}`)
      .sort()
    expect(
      pts(up.paths[0]!.segments)
        .map(([x, y]) => `${x},${y}`)
        .sort(),
    ).toEqual(mirrored)
  })

  test('未知名称按矩形处理', () => {
    const o = shapeOutline({ kind: 'preset', name: 'notAShape', adjust: [] }, 10, 20)
    expect(o.paths[0]!.segments).toEqual([
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 10, y: 0 },
      { kind: 'line', x: 10, y: 20 },
      { kind: 'line', x: 0, y: 20 },
      { kind: 'close' },
    ])
  })
})

describe('路径展开', () => {
  test('圆角矩形：调整值决定圆角半径，弧段的圆心与终点正确', () => {
    const o = shapeOutline(
      { kind: 'preset', name: 'roundRect', adjust: [{ name: 'adj', formula: 'val 50000' }] },
      200,
      100,
    )
    const segs = o.paths[0]!.segments
    expect(segs[0]).toEqual({ kind: 'move', x: 0, y: 50 })
    const arc = segs[1]!
    expect(arc.kind).toBe('arc')
    if (arc.kind !== 'arc') return
    expect(arc.cx).toBeCloseTo(50, 9)
    expect(arc.cy).toBeCloseTo(50, 9)
    expect(arc.rx).toBeCloseTo(50, 9)
    expect(arc.x).toBeCloseTo(50, 9)
    expect(arc.y).toBeCloseTo(0, 9)
    expect(o.textRect.left).toBeCloseTo(50 * 0.29289, 9)
  })

  test('arcTo 的起始角是视觉角：扁椭圆上 45° 的点换算为参数角', () => {
    const g: Geometry = {
      kind: 'custom',
      adjust: [],
      guides: [],
      textRect: null,
      paths: [
        {
          width: 0,
          height: 0,
          fill: 'norm',
          stroke: true,
          commands: [
            { kind: 'move', to: { x: 200, y: 50 } },
            {
              kind: 'arc',
              widthRadius: 100,
              heightRadius: 50,
              startAngle: 0,
              swingAngle: 2700000,
            },
          ],
        },
      ],
    }
    const arc = shapeOutline(g, 200, 100).paths[0]!.segments[1]!
    if (arc.kind !== 'arc') throw new Error('不是弧段')
    expect(arc.cx).toBeCloseTo(100, 9)
    expect(arc.cy).toBeCloseTo(50, 9)
    // 视觉角 45° 的点在椭圆上满足 y − cy = x − cx。
    expect(arc.y - arc.cy).toBeCloseTo(arc.x - arc.cx, 9)
    expect(arc.end).toBeCloseTo(Math.atan2(100, 50), 9)
  })

  test('整圈摆角保持一整圈，负摆角为逆时针', () => {
    const arcOf = (sw: number) => {
      const g: Geometry = {
        kind: 'custom',
        adjust: [],
        guides: [],
        textRect: null,
        paths: [
          {
            width: 0,
            height: 0,
            fill: 'norm',
            stroke: true,
            commands: [
              { kind: 'move', to: { x: 100, y: 50 } },
              { kind: 'arc', widthRadius: 50, heightRadius: 50, startAngle: 0, swingAngle: sw },
            ],
          },
        ],
      }
      const a = shapeOutline(g, 100, 100).paths[0]!.segments[1]!
      if (a.kind !== 'arc') throw new Error('不是弧段')
      return a
    }
    const full = arcOf(21600000)
    expect(full.end - full.start).toBeCloseTo(2 * Math.PI, 9)
    const back = arcOf(-5400000)
    expect(back.anticlockwise).toBe(true)
    expect(back.x).toBeCloseTo(50, 9)
    expect(back.y).toBeCloseTo(0, 9)
  })

  test('路径坐标系按形状尺寸缩放，输出坐标乘以单位换算系数', () => {
    const g: Geometry = {
      kind: 'custom',
      adjust: [],
      guides: [{ name: 'g', formula: '*/ w 1 2' }],
      textRect: { left: 'g', top: 0, right: 'r', bottom: 'b' },
      paths: [
        {
          width: 10,
          height: 10,
          fill: 'none',
          stroke: true,
          commands: [
            { kind: 'move', to: { x: 0, y: 0 } },
            {
              kind: 'quad',
              points: [
                { x: 5, y: 10 },
                { x: 10, y: 0 },
              ],
            },
            {
              kind: 'cubic',
              points: [
                { x: 1, y: 2 },
                { x: 3, y: 4 },
                { x: 5, y: 6 },
              ],
            },
          ],
        },
      ],
    }
    const o = shapeOutline(g, 9525 * 100, 9525 * 50, 1 / 9525)
    expect(o.paths[0]!.fill).toBe('none')
    expect(o.paths[0]!.segments[1]).toEqual({ kind: 'quad', x1: 50, y1: 50, x: 100, y: 0 })
    expect(o.paths[0]!.segments[2]).toEqual({
      kind: 'cubic',
      x1: 10,
      y1: 10,
      x2: 30,
      y2: 20,
      x: 50,
      y: 30,
    })
    expect(o.textRect).toEqual({ left: 50, top: 0, right: 100, bottom: 50 })
  })

  test('端点切线：直线沿线方向，弧段取切线方向', () => {
    const line: Segment[] = [
      { kind: 'move', x: 0, y: 0 },
      { kind: 'line', x: 10, y: 0 },
      { kind: 'line', x: 10, y: 10 },
    ]
    const e = pathEnds(line)!
    expect(e.start).toEqual({ x: 0, y: 0, angle: 0 })
    expect(e.end.angle).toBeCloseTo(Math.PI / 2, 9)
    const arc: Segment[] = [
      { kind: 'move', x: 10, y: 0 },
      {
        kind: 'arc',
        cx: 0,
        cy: 0,
        rx: 10,
        ry: 10,
        start: 0,
        end: Math.PI / 2,
        anticlockwise: false,
        x: 0,
        y: 10,
      },
    ]
    const a = pathEnds(arc)!
    expect(a.start.angle).toBeCloseTo(Math.PI / 2, 9)
    expect(a.end.angle).toBeCloseTo(Math.PI, 9)
    expect(pathEnds([{ kind: 'move', x: 1, y: 1 }])).toBeNull()
  })
})
