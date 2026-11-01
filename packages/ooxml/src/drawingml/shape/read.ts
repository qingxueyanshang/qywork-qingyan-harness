/**
 * DrawingML 形状属性的读取：非可视属性、`xfrm`、`spPr`（`grpSpPr`）与样式引用（`style`）。
 *
 * - 只记录文档中出现的属性（`spPr` 各项缺失时为 `null`），样式引用与坐标换算在 `resolve.ts` 中完成。
 * - 读取函数在对应元素的开始标签处调用，返回时位于其结束标签。元素按本地名匹配，不限定前缀。
 */

import { bool, eachChild, int, num, type Scanner } from '../../opc/read.ts'
import { type ColorSpec, isColorElement, readColor } from '../color.ts'
import {
  type EffectSpec,
  type FillSpec,
  isFillElement,
  type LineSpec,
  readEffects,
  readFill,
  readLine,
  readThreeD,
} from '../fill.ts'
import type { Geometry } from '../geometry/model.ts'
import { readGeometry } from '../geometry/read.ts'
import type { TextContext } from '../text/read.ts'
import type { FindingSink } from './model.ts'

export interface Xfrm {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation: number
  readonly flipH: boolean
  readonly flipV: boolean
  /** 组合的子坐标系（`chOff`、`chExt`）；其他形状为 `null`。 */
  readonly child: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  } | null
}

export interface StyleRef {
  readonly idx: number
  readonly color: ColorSpec | null
}

/** `style`：`font` 的 `idx` 为 `major`、`minor` 或 `none`。 */
export interface StyleRefs {
  readonly line: StyleRef | null
  readonly fill: StyleRef | null
  readonly effect: StyleRef | null
  readonly font: { readonly idx: string; readonly color: ColorSpec | null } | null
}

/** `spPr` 或 `grpSpPr`：未出现的项为 `null`。 */
export interface ShapeProps {
  readonly xfrm: Xfrm | null
  readonly geometry: Geometry | null
  readonly fill: FillSpec | null
  readonly line: LineSpec | null
  readonly effects: readonly EffectSpec[] | null
}

export const EMPTY_PROPS: ShapeProps = {
  xfrm: null,
  geometry: null,
  fill: null,
  line: null,
  effects: null,
}

export interface Connection {
  readonly shape: number
  readonly site: number
}

export interface NonVisual {
  readonly id: number
  readonly name: string
  readonly hidden: boolean
  /** `cNvSpPr/@txBox`。 */
  readonly textBox: boolean
  /** 连接线的 `stCxn` 与 `endCxn`。 */
  readonly start: Connection | null
  readonly end: Connection | null
}

export const EMPTY_NON_VISUAL: NonVisual = {
  id: 0,
  name: '',
  hidden: false,
  textBox: false,
  start: null,
  end: null,
}

function readConnection(x: Scanner): Connection {
  return { shape: int(x, 'id', 0), site: int(x, 'idx', 0) }
}

/**
 * 在 `nvSpPr`、`nvPicPr`、`nvCxnSpPr`、`nvGrpSpPr` 等非可视属性元素的开始标签处调用。
 * `other` 处理 `cNvPr`、`cNvSpPr`、`cNvCxnSpPr` 之外的子元素（如 PresentationML 的 `nvPr`），可以读到该子元素的结束标签为止。
 */
export function readNonVisual(x: Scanner, other: ((local: string) => void) | null): NonVisual {
  let id = 0
  let name = ''
  let hidden = false
  let textBox = false
  let start: Connection | null = null
  let end: Connection | null = null
  eachChild(x, (local) => {
    if (local === 'cNvPr') {
      id = int(x, 'id', 0)
      name = x.attr('name') ?? ''
      hidden = bool(x, 'hidden') ?? false
    } else if (local === 'cNvSpPr') {
      textBox = bool(x, 'txBox') ?? false
    } else if (local === 'cNvCxnSpPr') {
      eachChild(x, (child) => {
        if (child === 'stCxn') start = readConnection(x)
        else if (child === 'endCxn') end = readConnection(x)
      })
    } else if (other !== null) {
      other(local)
    }
  })
  return { id, name, hidden, textBox, start, end }
}

/** 在 `xfrm` 的开始标签处调用。 */
export function readXfrm(x: Scanner): Xfrm {
  const rotation = (num(x, 'rot') ?? 0) / 60000
  const flipH = bool(x, 'flipH') ?? false
  const flipV = bool(x, 'flipV') ?? false
  let px = 0
  let py = 0
  let width = 0
  let height = 0
  let child: Xfrm['child'] = null
  let cx = 0
  let cy = 0
  let cw = 0
  let ch = 0
  let hasChild = false
  eachChild(x, (local) => {
    if (local === 'off') {
      px = int(x, 'x', 0)
      py = int(x, 'y', 0)
    } else if (local === 'ext') {
      width = int(x, 'cx', 0)
      height = int(x, 'cy', 0)
    } else if (local === 'chOff') {
      cx = int(x, 'x', 0)
      cy = int(x, 'y', 0)
      hasChild = true
    } else if (local === 'chExt') {
      cw = int(x, 'cx', 0)
      ch = int(x, 'cy', 0)
      hasChild = true
    }
  })
  if (hasChild) child = { x: cx, y: cy, width: cw, height: ch }
  return { x: px, y: py, width, height, rotation, flipH, flipV, child }
}

/** 在 `spPr` 或 `grpSpPr` 的开始标签处调用。改变外观的三维设置登记为 `effect3d`。 */
export function readShapeProps(x: Scanner, cx: TextContext): ShapeProps {
  let xfrm: Xfrm | null = null
  let geometry: Geometry | null = null
  let fill: FillSpec | null = null
  let line: LineSpec | null = null
  let effects: EffectSpec[] | null = null
  eachChild(x, (local) => {
    if (local === 'xfrm') xfrm = readXfrm(x)
    else if (local === 'prstGeom' || local === 'custGeom') geometry = readGeometry(x)
    else if (isFillElement(local)) fill = readFill(x, cx.rels)
    else if (local === 'ln') line = readLine(x, cx.rels)
    else if (local === 'effectLst') effects = readEffects(x)
    else if (local === 'effectDag') effects = [{ kind: 'other', name: 'effectDag' }]
    else if ((local === 'scene3d' || local === 'sp3d') && readThreeD(x)) cx.found.push('effect3d')
  })
  return { xfrm, geometry, fill, line, effects }
}

function readStyleRef(x: Scanner): StyleRef {
  const idx = int(x, 'idx', 0)
  let color: ColorSpec | null = null
  let found = false
  eachChild(x, (local) => {
    if (found || !isColorElement(local)) return
    found = true
    color = readColor(x)
  })
  return { idx, color }
}

/** 在 `style` 的开始标签处调用。 */
export function readStyle(x: Scanner): StyleRefs {
  let line: StyleRef | null = null
  let fill: StyleRef | null = null
  let effect: StyleRef | null = null
  let font: StyleRefs['font'] = null
  eachChild(x, (local) => {
    if (local === 'lnRef') line = readStyleRef(x)
    else if (local === 'fillRef') fill = readStyleRef(x)
    else if (local === 'effectRef') effect = readStyleRef(x)
    else if (local === 'fontRef') {
      const idx = x.attr('idx') ?? 'none'
      font = { idx, color: readStyleRef(x).color }
    }
  })
  return { line, fill, effect, font }
}

/** `effectLst` 中未识别的效果（`other`）登记为 `effect`。 */
export function countOtherEffects(props: ShapeProps, found: FindingSink): void {
  for (const e of props.effects ?? []) if (e.kind === 'other') found.push('effect')
}
