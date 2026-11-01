/**
 * 预设几何：按名称取定义，解码为与自定义几何相同的结构，使两者共用同一套求值与路径展开。
 *
 * - 定义数据见 `presets.gen.ts`；解码结果按名称缓存。未知名称返回 `null`。
 */

import type {
  CustomGeometry,
  GeometryPath,
  GeometryValue,
  Guide,
  PathCommand,
  PathPoint,
  TextRect,
} from './model.ts'
import { PRESET_SHAPES } from './presets.gen.ts'

const cache = new Map<string, CustomGeometry>()
const INTEGER = /^-?\d+$/

function value(token: string | undefined): GeometryValue {
  if (token === undefined) return 0
  return INTEGER.test(token) ? Number(token) : token
}

function guides(text: string): Guide[] {
  if (text === '') return []
  return text.split(';').map((entry) => {
    const space = entry.indexOf(' ')
    return { name: entry.slice(0, space), formula: entry.slice(space + 1) }
  })
}

function textRect(text: string): TextRect | null {
  if (text === '') return null
  const [left, top, right, bottom] = text.split(' ').map(value)
  return { left: left ?? 0, top: top ?? 0, right: right ?? 0, bottom: bottom ?? 0 }
}

function path(text: string): GeometryPath {
  const colon = text.indexOf(':')
  const [w, h, fill, stroke] = text.slice(0, colon).split(' ')
  const tokens = text.slice(colon + 1).split(' ')
  const commands: PathCommand[] = []
  let i = 0
  const points = (n: number): PathPoint[] => {
    const out: PathPoint[] = []
    for (let k = 0; k < n; k++) {
      out.push({ x: value(tokens[i]), y: value(tokens[i + 1]) })
      i += 2
    }
    return out
  }
  while (i < tokens.length) {
    const op = tokens[i++]
    switch (op) {
      case 'M':
        commands.push({ kind: 'move', to: points(1)[0]! })
        break
      case 'L':
        commands.push({ kind: 'line', to: points(1)[0]! })
        break
      case 'A':
        commands.push({
          kind: 'arc',
          widthRadius: value(tokens[i]),
          heightRadius: value(tokens[i + 1]),
          startAngle: value(tokens[i + 2]),
          swingAngle: value(tokens[i + 3]),
        })
        i += 4
        break
      case 'Q':
        commands.push({ kind: 'quad', points: points(2) })
        break
      case 'C':
        commands.push({ kind: 'cubic', points: points(3) })
        break
      case 'Z':
        commands.push({ kind: 'close' })
        break
    }
  }
  return {
    width: Number(w),
    height: Number(h),
    fill: fill ?? 'norm',
    stroke: stroke !== '0',
    commands,
  }
}

/** 预设几何的定义；未知名称返回 `null`。 */
export function presetGeometry(name: string): CustomGeometry | null {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const text = Object.hasOwn(PRESET_SHAPES, name) ? PRESET_SHAPES[name] : undefined
  if (text === undefined) return null
  const [av = '', gd = '', rect = '', ...paths] = text.split('|')
  const geometry: CustomGeometry = {
    kind: 'custom',
    adjust: guides(av),
    guides: guides(gd),
    textRect: textRect(rect),
    paths: paths.map(path),
  }
  cache.set(name, geometry)
  return geometry
}
