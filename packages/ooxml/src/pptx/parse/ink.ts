/**
 * 墨迹部件（`contentPart` 经 `customXml` 关系引用的 InkML）：各笔画的点、压力、笔宽与颜色。
 *
 * - `trace` 的数值按 InkML 的限定符解码：`!` 为显式值，`'` 为一阶差分，`"` 为二阶差分；没有限定符的值沿用该通道
 *   上一个值的方式。值之间以空白或负号分隔，点之间以逗号分隔。
 * - 坐标取通道 `X`、`Y`，不按单位换算：绘制时按笔画外接框对应 `contentPart` 的位置尺寸（见 `../resolve/ink.ts`）。
 * - 压力为通道 `F` 除以其 `max`；没有 `F` 通道或没有 `max` 时为 `null`。
 * - 笔刷取 `brushRef` 所指的 `brush`：`width`（厘米，缺省 0.0529 厘米即 1.5 磅）、`color`（缺省黑色）；
 *   `transparency`、`tip` 等其他属性不读取。`traceGroup` 中的 `trace` 一并读取。
 */

import { type Color, parseHexColor } from '../../drawingml/color.ts'
import { eachChild, readText, type Scanner } from '../../opc/read.ts'

export interface InkPoint {
  readonly x: number
  readonly y: number
  /** 0–1；没有压力通道时为 `null`。 */
  readonly pressure: number | null
}

export interface RawInkStroke {
  readonly points: readonly InkPoint[]
  /** 笔宽，厘米。 */
  readonly width: number
  readonly color: Color
}

interface Brush {
  readonly width: number
  readonly color: Color
}

const DEFAULT_BRUSH: Brush = { width: 0.0529, color: { r: 0, g: 0, b: 0, a: 1 } }
const VALUE = /([!'"]?)\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g

/** 解码一条 `trace` 的文字：每点各通道的值，通道数为 `channels`。 */
export function decodeTrace(text: string, channels: number): number[][] {
  const mode: string[] = new Array(channels).fill('!')
  const prev: number[] = new Array(channels).fill(0)
  const velocity: number[] = new Array(channels).fill(0)
  const out: number[][] = []
  for (const chunk of text.split(',')) {
    const point: number[] = []
    for (const m of chunk.matchAll(VALUE)) {
      const i = point.length
      if (i >= channels) break
      if (m[1] !== '') mode[i] = m[1]!
      const v = Number(m[2])
      const p = prev[i]!
      const d = mode[i] === '!' ? v - p : mode[i] === "'" ? v : velocity[i]! + v
      velocity[i] = d
      prev[i] = p + d
      point.push(p + d)
    }
    if (point.length >= 2) out.push(point)
  }
  return out
}

function readBrush(x: Scanner): Brush {
  let width = DEFAULT_BRUSH.width
  let color = DEFAULT_BRUSH.color
  eachChild(x, (local) => {
    if (local !== 'brushProperty') return
    const name = x.attr('name')
    const value = x.attr('value')
    if (name === 'width' && value !== null && Number(value) > 0) width = Number(value)
    else if (name === 'color') color = parseHexColor(value?.replace(/^#/, '') ?? null) ?? color
  })
  return { width, color }
}

/** 读取 InkML 部件（扫描器位于部件开头）的全部笔画；没有 `X`、`Y` 通道的上下文中的笔画不读取。 */
export function readInk(x: Scanner): RawInkStroke[] {
  const brushes = new Map<string, Brush>()
  let channels: string[] = []
  let maxPressure: number | null = null
  const strokes: RawInkStroke[] = []
  const readTrace = () => {
    const brush = brushes.get((x.attr('brushRef') ?? '').replace(/^#/, '')) ?? DEFAULT_BRUSH
    const values = decodeTrace(readText(x), channels.length)
    const ix = channels.indexOf('X')
    const iy = channels.indexOf('Y')
    const iF = channels.indexOf('F')
    if (ix < 0 || iy < 0) return
    const points = values.map((v) => ({
      x: v[ix]!,
      y: v[iy]!,
      pressure:
        iF < 0 || maxPressure === null || v[iF] === undefined
          ? null
          : Math.min(1, Math.max(0, v[iF] / maxPressure)),
    }))
    if (points.length > 0) strokes.push({ points, width: brush.width, color: brush.color })
  }
  const visit = (local: string) => {
    if (
      local === 'definitions' ||
      local === 'context' ||
      local === 'inkSource' ||
      local === 'traceGroup'
    )
      eachChild(x, visit)
    else if (local === 'traceFormat') {
      channels = []
      eachChild(x, (c) => {
        if (c !== 'channel') return
        const name = x.attr('name') ?? ''
        channels.push(name)
        if (name === 'F') {
          const max = Number(x.attr('max'))
          maxPressure = max > 0 ? max : null
        }
      })
    } else if (local === 'brush') brushes.set(x.attr('xml:id') ?? '', readBrush(x))
    else if (local === 'trace') readTrace()
  }
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 1) continue
    eachChild(x, visit)
    break
  }
  return strokes
}
