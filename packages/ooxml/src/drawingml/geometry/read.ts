/**
 * 形状几何：`prstGeom`（预设名与调整值）与 `custGeom`（参数、文本矩形与路径）。
 *
 * - 只记录文档中的定义，公式求值与预设几何的路径展开在绘制阶段完成。
 * - 连接点（`cxnLst`）与调整手柄（`ahLst`）不影响显示，不读取。
 */

import { bool, eachChild, int, type Scanner } from '../../opc/read.ts'
import type {
  Geometry,
  GeometryPath,
  GeometryValue,
  Guide,
  PathCommand,
  PathPoint,
  TextRect,
} from './model.ts'

function value(x: Scanner, name: string): GeometryValue {
  const v = x.attr(name) ?? '0'
  return /^-?\d+$/.test(v) ? Number(v) : v
}

function readGuides(x: Scanner): Guide[] {
  const out: Guide[] = []
  eachChild(x, (local) => {
    if (local === 'gd') out.push({ name: x.attr('name') ?? '', formula: x.attr('fmla') ?? '' })
  })
  return out
}

function readPoints(x: Scanner): PathPoint[] {
  const out: PathPoint[] = []
  eachChild(x, (local) => {
    if (local === 'pt') out.push({ x: value(x, 'x'), y: value(x, 'y') })
  })
  return out
}

function readPath(x: Scanner): GeometryPath {
  const width = int(x, 'w', 0)
  const height = int(x, 'h', 0)
  const fill = x.attr('fill') ?? 'norm'
  const stroke = bool(x, 'stroke') ?? true
  const commands: PathCommand[] = []
  eachChild(x, (local) => {
    switch (local) {
      case 'moveTo':
      case 'lnTo': {
        const [to] = readPoints(x)
        if (to !== undefined) commands.push({ kind: local === 'moveTo' ? 'move' : 'line', to })
        return
      }
      case 'arcTo':
        commands.push({
          kind: 'arc',
          widthRadius: value(x, 'wR'),
          heightRadius: value(x, 'hR'),
          startAngle: value(x, 'stAng'),
          swingAngle: value(x, 'swAng'),
        })
        return
      case 'quadBezTo':
        commands.push({ kind: 'quad', points: readPoints(x) })
        return
      case 'cubicBezTo':
        commands.push({ kind: 'cubic', points: readPoints(x) })
        return
      case 'close':
        commands.push({ kind: 'close' })
        return
    }
  })
  return { width, height, fill, stroke, commands }
}

/** 在 `prstGeom` 或 `custGeom` 的开始标签处调用。 */
export function readGeometry(x: Scanner): Geometry {
  if (x.local === 'prstGeom') {
    const name = x.attr('prst') ?? 'rect'
    let adjust: Guide[] = []
    eachChild(x, (local) => {
      if (local === 'avLst') adjust = readGuides(x)
    })
    return { kind: 'preset', name, adjust }
  }
  let adjust: Guide[] = []
  let guides: Guide[] = []
  let textRect: TextRect | null = null
  const paths: GeometryPath[] = []
  eachChild(x, (local) => {
    if (local === 'avLst') adjust = readGuides(x)
    else if (local === 'gdLst') guides = readGuides(x)
    else if (local === 'rect') {
      textRect = {
        left: value(x, 'l'),
        top: value(x, 't'),
        right: value(x, 'r'),
        bottom: value(x, 'b'),
      }
    } else if (local === 'pathLst') {
      eachChild(x, (path) => {
        if (path === 'path') paths.push(readPath(x))
      })
    }
  })
  return { kind: 'custom', adjust, guides, textRect, paths }
}
