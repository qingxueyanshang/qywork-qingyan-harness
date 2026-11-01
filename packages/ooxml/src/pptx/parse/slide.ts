/**
 * 幻灯片、版式与母版部件，以及 `presentation.xml`。
 *
 * - 三种部件结构相同：`cSld`（背景与形状树）、颜色映射、母版的 `txStyles`；按根元素的本地名区分，不按部件路径区分。
 * - 颜色映射：母版为 `clrMap`；版式与幻灯片的 `clrMapOvr` 为 `overrideClrMapping` 时记录其映射，
 *   为 `masterClrMapping` 或缺失时为 `null`（沿用上一层）。映射值不是槽位名的键按默认映射取值。
 * - 动画按 `timing` 中不同的目标形状计数，切换效果按 `transition` 中是否有效果元素计数。
 */

import {
  type ColorMap,
  type ColorMapKey,
  type ColorSpec,
  DEFAULT_COLOR_MAP,
  isColorElement,
  readColor,
  SCHEME_SLOTS,
  type SchemeSlot,
} from '../../drawingml/color.ts'
import { type FillSpec, isFillElement, readFill } from '../../drawingml/fill.ts'
import { type ListStyleSpec, readListStyle, type TextContext } from '../../drawingml/text/read.ts'
import type { Relationships } from '../../opc/package.ts'
import { bool, eachChild, int, relAttr, type Scanner } from '../../opc/read.ts'
import type { UnsupportedKind } from '../model.ts'
import { type RawShape, readShapeTree } from './shape.ts'

export type BackgroundSpec =
  | { readonly kind: 'fill'; readonly fill: FillSpec }
  | { readonly kind: 'ref'; readonly idx: number; readonly color: ColorSpec | null }

export interface TextStyles {
  readonly title: ListStyleSpec | null
  readonly body: ListStyleSpec | null
  readonly other: ListStyleSpec | null
}

export interface RawPart {
  readonly part: string
  readonly rels: Relationships
  readonly hidden: boolean
  readonly showMasterShapes: boolean
  readonly background: BackgroundSpec | null
  readonly shapes: readonly RawShape[]
  /** 不属于任何形状的未实现元素：形状树中的墨迹、动画与切换效果。 */
  readonly found: readonly UnsupportedKind[]
  readonly colorMap: ColorMap | null
  readonly textStyles: TextStyles | null
}

export interface RawPresentation {
  readonly width: number
  readonly height: number
  readonly firstSlideNumber: number
  /** 按 `sldIdLst` 顺序的关系 ID。 */
  readonly slides: readonly string[]
  readonly masters: readonly string[]
  readonly defaultTextStyle: ListStyleSpec | null
  /** `embeddedFontLst`：每种字形一项，`id` 为字体部件的关系 ID。 */
  readonly embeddedFonts: readonly {
    readonly typeface: string
    readonly bold: boolean
    readonly italic: boolean
    readonly id: string
  }[]
}

const EMBEDDED_STYLES: Readonly<Record<string, [bold: boolean, italic: boolean]>> = {
  regular: [false, false],
  bold: [true, false],
  italic: [false, true],
  boldItalic: [true, true],
}

const SLOTS = new Set<string>(SCHEME_SLOTS)

function readColorMap(x: Scanner): ColorMap {
  const out = { ...DEFAULT_COLOR_MAP } as Record<ColorMapKey, SchemeSlot>
  for (const key of Object.keys(DEFAULT_COLOR_MAP) as ColorMapKey[]) {
    const v = x.attr(key)
    if (v !== null && SLOTS.has(v)) out[key] = v as SchemeSlot
  }
  return out
}

function readBackground(x: Scanner, rels: Relationships): BackgroundSpec | null {
  let out: BackgroundSpec | null = null
  eachChild(x, (local) => {
    if (local === 'bgPr') {
      eachChild(x, (child) => {
        if (isFillElement(child)) out = { kind: 'fill', fill: readFill(x, rels) }
      })
    } else if (local === 'bgRef') {
      const idx = int(x, 'idx', 0)
      let color: ColorSpec | null = null
      let found = false
      eachChild(x, (child) => {
        if (found || !isColorElement(child)) return
        found = true
        color = readColor(x)
      })
      out = { kind: 'ref', idx, color }
    }
  })
  return out
}

function countAnimations(x: Scanner): number {
  const targets = new Set<string>()
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t === 'start' && x.local === 'spTgt') targets.add(x.attr('spid') ?? '')
  }
  return targets.size
}

/** 解析幻灯片、版式或母版部件。`part` 为部件名，`rels` 为其关系表。 */
export function readSlidePart(x: Scanner, part: string, rels: Relationships): RawPart {
  let hidden = false
  let showMasterShapes = true
  let background: BackgroundSpec | null = null
  let shapes: RawShape[] = []
  const found: UnsupportedKind[] = []
  let colorMap: ColorMap | null = null
  let textStyles: TextStyles | null = null
  const cx: TextContext = { rels, found }
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 1) continue
    hidden = bool(x, 'show') === false
    showMasterShapes = bool(x, 'showMasterSp') ?? true
    eachChild(x, (local) => {
      if (local === 'cSld') {
        eachChild(x, (child) => {
          if (child === 'bg') background = readBackground(x, rels)
          else if (child === 'spTree') {
            const tree = readShapeTree(x, rels)
            shapes = tree.shapes
            found.push(...tree.found)
          }
        })
      } else if (local === 'clrMap') {
        colorMap = readColorMap(x)
      } else if (local === 'clrMapOvr') {
        eachChild(x, (child) => {
          if (child === 'overrideClrMapping') colorMap = readColorMap(x)
        })
      } else if (local === 'txStyles') {
        let title: ListStyleSpec | null = null
        let body: ListStyleSpec | null = null
        let other: ListStyleSpec | null = null
        eachChild(x, (child) => {
          if (child === 'titleStyle') title = readListStyle(x, cx)
          else if (child === 'bodyStyle') body = readListStyle(x, cx)
          else if (child === 'otherStyle') other = readListStyle(x, cx)
        })
        textStyles = { title, body, other }
      } else if (local === 'timing') {
        for (let n = countAnimations(x); n > 0; n--) found.push('animation')
      } else if (local === 'transition') {
        let effect = false as boolean
        eachChild(x, (child) => {
          if (child !== 'sndAc' && child !== 'extLst') effect = true
        })
        if (effect) found.push('transition')
      }
    })
    break
  }
  return { part, rels, hidden, showMasterShapes, background, shapes, found, colorMap, textStyles }
}

export function readPresentation(x: Scanner, rels: Relationships): RawPresentation {
  let width = 9144000
  let height = 6858000
  let firstSlideNumber = 1
  const slides: string[] = []
  const masters: string[] = []
  let defaultTextStyle: ListStyleSpec | null = null
  const embeddedFonts: RawPresentation['embeddedFonts'][number][] = []
  const cx: TextContext = { rels, found: [] }
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 1) continue
    firstSlideNumber = int(x, 'firstSlideNum', 1)
    eachChild(x, (local) => {
      if (local === 'sldSz') {
        width = int(x, 'cx', width)
        height = int(x, 'cy', height)
      } else if (local === 'sldIdLst' || local === 'sldMasterIdLst') {
        const list = local === 'sldIdLst' ? slides : masters
        eachChild(x, () => {
          const id = relAttr(x, 'id')
          if (id !== null) list.push(id)
        })
      } else if (local === 'defaultTextStyle') {
        defaultTextStyle = readListStyle(x, cx)
      } else if (local === 'embeddedFontLst') {
        eachChild(x, (item) => {
          if (item !== 'embeddedFont') return
          let typeface = ''
          eachChild(x, (child) => {
            if (child === 'font') typeface = x.attr('typeface') ?? ''
            const style = EMBEDDED_STYLES[child]
            const id = relAttr(x, 'id')
            if (style !== undefined && id !== null) {
              embeddedFonts.push({ typeface, bold: style[0], italic: style[1], id })
            }
          })
        })
      }
    })
    break
  }
  return { width, height, firstSlideNumber, slides, masters, defaultTextStyle, embeddedFonts }
}
