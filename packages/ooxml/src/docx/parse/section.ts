/**
 * 节属性（`sectPr`）：页面尺寸、页边距、分栏、文档网格、开始方式、页码与页眉页脚引用，单位换算为磅。
 *
 * - 缺少 `pgSz`、`pgMar` 的项按 A4 纵向、上下 72 磅、左右 90 磅取值（WPS 新建文档的缺省值）。
 * - 等宽分栏按版心宽度减去栏间距后均分；不等宽分栏取各 `col` 的宽度与间距。
 * - 页眉页脚引用记录关系标识（`w:type` 为 `default`、`first`、`even`）。
 * - 页面边框（`pgBorders`）记录各边、距离基准与显示范围；艺术型边框（`w:val` 不是 `ST_Border` 的线型）按单线记录并计数。
 * - 行号、字符网格、多栏与文字方向在此计数。
 */

import type { PageBorders, PartRefs, Section, UnsupportedKind } from '../model.ts'
import { border } from '../resolve/cascade.ts'
import { readBorderSides } from './properties.ts'
import { eachChild, onOff, type Scanner, skip, wAttr, wNum } from './xml.ts'

/** 线型边框（`ST_Border` 中不是艺术图案的取值）。 */
const LINE_BORDERS = new Set([
  'single',
  'thick',
  'double',
  'dotted',
  'dashed',
  'dotDash',
  'dotDotDash',
  'triple',
  'thinThickSmallGap',
  'thickThinSmallGap',
  'thinThickThinSmallGap',
  'thinThickMediumGap',
  'thickThinMediumGap',
  'thinThickThinMediumGap',
  'thinThickLargeGap',
  'thickThinLargeGap',
  'thinThickThinLargeGap',
  'wave',
  'doubleWave',
  'dashSmallGap',
  'dashDotStroked',
  'threeDEmboss',
  'threeDEngrave',
  'outset',
  'inset',
])

function readPageBorders(x: Scanner, count: (kind: UnsupportedKind) => void): PageBorders | null {
  const from = wAttr(x, 'offsetFrom') === 'page' ? 'page' : 'text'
  const display = wAttr(x, 'display')
  const sides = readBorderSides(x)
  const side = (b: (typeof sides)['top']) => {
    const out = border(b)
    if (out === null || LINE_BORDERS.has(out.style)) return out
    count('artBorder')
    return { ...out, style: 'single' }
  }
  const out: PageBorders = {
    top: side(sides.top),
    left: side(sides.left),
    bottom: side(sides.bottom),
    right: side(sides.right),
    offsetFrom: from,
    display: display === 'firstPage' || display === 'notFirstPage' ? display : 'allPages',
  }
  return out.top || out.left || out.bottom || out.right ? out : null
}

const TWIP = 20
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NO_PARTS: PartRefs = { default: null, first: null, even: null }
const STARTS = new Set(['nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn'])

export const DEFAULT_SECTION: Section = {
  pageWidth: 11906 / TWIP,
  pageHeight: 16838 / TWIP,
  marginTop: 1440 / TWIP,
  marginRight: 1800 / TWIP,
  marginBottom: 1440 / TWIP,
  marginLeft: 1800 / TWIP,
  header: 851 / TWIP,
  footer: 992 / TWIP,
  gutter: 0,
  columns: [{ width: (11906 - 3600) / TWIP, space: 0 }],
  gridType: 'default',
  linePitch: 0,
  start: 'nextPage',
  titlePage: false,
  numberFormat: 'decimal',
  numberStart: null,
  headers: NO_PARTS,
  footers: NO_PARTS,
  pageBorders: null,
}

const GRID_TYPES = new Set(['default', 'lines', 'linesAndChars', 'snapToChars'])

/** 读取当前 `sectPr` 元素，返回时位于其结束标签。 */
export function readSection(x: Scanner, count: (kind: UnsupportedKind) => void): Section {
  const d = DEFAULT_SECTION
  let pageWidth = d.pageWidth
  let pageHeight = d.pageHeight
  let margin = {
    top: d.marginTop,
    right: d.marginRight,
    bottom: d.marginBottom,
    left: d.marginLeft,
    header: d.header,
    footer: d.footer,
    gutter: d.gutter,
  }
  let columnCount = 1
  let columnSpace = 720 / TWIP
  let equalWidth = true
  const custom: { width: number; space: number }[] = []
  let gridType: Section['gridType'] = 'default'
  let linePitch = 0
  let start: Section['start'] = 'nextPage'
  let titlePage = false
  let numberFormat = 'decimal'
  let numberStart: number | null = null
  const headers: { -readonly [K in keyof PartRefs]: string | null } = { ...NO_PARTS }
  const footers: { -readonly [K in keyof PartRefs]: string | null } = { ...NO_PARTS }
  let pageBorders: PageBorders | null = null
  eachChild(x, (local) => {
    switch (local) {
      case 'pgSz':
        pageWidth = (wNum(x, 'w') ?? pageWidth * TWIP) / TWIP
        pageHeight = (wNum(x, 'h') ?? pageHeight * TWIP) / TWIP
        break
      case 'pgMar': {
        const next = { ...margin }
        for (const key of Object.keys(next) as (keyof typeof next)[]) {
          const v = wNum(x, key)
          if (v !== null) next[key] = v / TWIP
        }
        margin = next
        break
      }
      case 'cols':
        columnCount = Math.max(1, wNum(x, 'num') ?? 1)
        columnSpace = (wNum(x, 'space') ?? 720) / TWIP
        equalWidth = wAttr(x, 'equalWidth') === null || onOff(x, 'equalWidth')
        eachChild(x, (inner) => {
          if (inner === 'col') {
            custom.push({
              width: (wNum(x, 'w') ?? 0) / TWIP,
              space: (wNum(x, 'space') ?? 0) / TWIP,
            })
          }
          skip(x)
        })
        return
      case 'docGrid': {
        const type = wAttr(x, 'type') ?? 'default'
        gridType = GRID_TYPES.has(type) ? (type as Section['gridType']) : 'default'
        linePitch = wNum(x, 'linePitch') ?? 0
        if (gridType === 'linesAndChars' || gridType === 'snapToChars') count('charGrid')
        break
      }
      case 'headerReference':
      case 'footerReference': {
        const kind = wAttr(x, 'type') ?? 'default'
        const id = x.attrNs(RELATIONSHIPS, 'id')
        const refs = local === 'headerReference' ? headers : footers
        if ((kind === 'default' || kind === 'first' || kind === 'even') && id !== null)
          refs[kind] = id
        break
      }
      case 'type': {
        const v = wAttr(x, 'val')
        if (v !== null && STARTS.has(v)) start = v as Section['start']
        break
      }
      case 'titlePg':
        titlePage = onOff(x)
        break
      case 'pgNumType':
        numberFormat = wAttr(x, 'fmt') ?? numberFormat
        numberStart = wNum(x, 'start')
        break
      case 'pgBorders':
        pageBorders = readPageBorders(x, count)
        return
      case 'lnNumType':
        count('lineNumbers')
        break
      case 'textDirection': {
        const v = wAttr(x, 'val')
        if (v !== null && v !== 'lrTb' && v !== 'tb') count('textDirection')
        break
      }
    }
    skip(x)
  })
  const text = pageWidth - margin.left - margin.right - margin.gutter
  let columns: { width: number; space: number }[]
  if (!equalWidth && custom.length > 0) columns = custom
  else {
    const width = (text - (columnCount - 1) * columnSpace) / columnCount
    columns = Array.from({ length: columnCount }, (_, i) => ({
      width,
      space: i < columnCount - 1 ? columnSpace : 0,
    }))
  }
  if (columns.length > 1) count('columns')
  return {
    pageWidth,
    pageHeight,
    marginTop: margin.top,
    marginRight: margin.right,
    marginBottom: margin.bottom,
    marginLeft: margin.left,
    header: margin.header,
    footer: margin.footer,
    gutter: margin.gutter,
    columns,
    gridType,
    linePitch: linePitch / TWIP,
    start,
    titlePage,
    numberFormat,
    numberStart,
    headers,
    footers,
    pageBorders,
  }
}
