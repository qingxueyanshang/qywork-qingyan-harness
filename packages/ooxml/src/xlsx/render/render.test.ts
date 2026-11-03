/**
 * 覆盖：`axis.ts`（偏移、区段与二分查找）、`fonts.ts`（字体链回退、合成粗体加宽、逐字分段、整数前进宽度、
 * 主机上没有的字体的替代字体）、
 * `geometry.ts`（最大数字宽度、列宽与行高换算、按内容推算行高、未写出单元格按行样式与列样式取行高、标准行高、
 * 默认行高的 customHeight、含相邻行的边框增量、随数字宽度变化的留白、缩进宽度）、
 * `text.ts`（自动换行、单行行高 `lineBox`、自动换行各行按实际使用的字体取行高）、
 * `cell-text.ts`（「常规」对齐、溢出、`#` 填充、常规格式按宽度取舍、填充对齐、分散对齐、旋转、居中的行位置、
 * 留白与自动换行行宽、数字格式空白的宽度与自动换行时末尾空白、自动换行的行居中取整、逻辑值不按行排版）、
 * `conditional.ts` 与 `../formula.ts`（条件格式规则与公式求值、空白单元格的比较、差异样式填充的叠加）、`painter.ts`（以记录调用的上下文检查
 * 网格线与填充的覆盖规则、指定颜色的点线网格线、图案填充的像素单元、各线型边框相对网格线的位置、文字与筛选按钮、点阵绘制与逐字定位、合成粗体的两次绘制、
 * 绘图对象的上下次序、图片按共用图片接口绘制、冻结窗格各块的平移、区域外的形状）、`shapes.ts`（锚点换算、旋转接近 90° 时的宽高互换、组合内的换算、绘制范围、形状文字的字体与单倍行高、形状与图表文字的 ClearType 字形）。
 * Bun 中没有 Canvas，像素结果由对比基准验证。
 * 「本机字体的单行行高」读取 Windows 字体目录中的真实文件，其他平台跳过；期望值取自 WPS 实测（含缺失字体的行高与留白分界）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChart } from '../../drawingml/chart/read.ts'
import { resolveChart } from '../../drawingml/chart/resolve.ts'
import { DEFAULT_COLOR_MAP } from '../../drawingml/color.ts'
import type { Matrix } from '../../drawingml/paint/context.ts'
import type { PaintPicture } from '../../drawingml/paint/picture.ts'
import { SCREEN_RESOLUTION } from '../../drawingml/paint/resolution.ts'
import {
  canvasFactory,
  placeableWmf,
  type RecordingCanvas,
  RecordingContext,
} from '../../drawingml/paint/test-helper.ts'
import type { Frame } from '../../drawingml/shape/model.ts'
import { layoutBody } from '../../drawingml/text/body.ts'
import { FaceCache } from '../../drawingml/text/fonts.ts'
import type { RunStyle, TextBody } from '../../drawingml/text/model.ts'
import { EMPTY_THEME } from '../../drawingml/theme.ts'
import {
  type BitmapGlyph,
  type EmbeddedBitmaps,
  extractFace,
  type FontMetrics,
} from '../../font/index.ts'
import type { CoverageGlyph, PixelData } from '../../glyph/cleartype/index.ts'
import { readMetafile } from '../../metafile/index.ts'
import { canEvaluate, evaluateFormula } from '../formula.ts'
import type {
  BorderLineStyle,
  Cell,
  CellStyle,
  CfRule,
  DifferentialStyle,
  DrawingAnchor,
  ShapeNode,
  SheetImage,
  SheetShape,
  Workbook,
  Worksheet,
} from '../model.ts'
import { Axis } from './axis.ts'
import { type CellBox, cellContent, layoutCell, resolveHorizontal } from './cell-text.ts'
import { ConditionalFormats } from './conditional.ts'
import { FontSet, type LoadedFace, loadFace, substituteFont, syntheticBoldExtra } from './fonts.ts'
import {
  buildGeometry,
  columnPixels,
  defaultColumnPixels,
  fontLineHeight,
  indentPixels,
  maxDigitWidth,
  rowPixels,
  standardRowHeight,
  textPadding,
} from './geometry.ts'
import {
  createScene,
  type PaintContext,
  paintRegion,
  paintView,
  type SheetResources,
} from './painter.ts'
import { placeShape, shapeFaces } from './shapes.ts'
import { lineBox, lineBoxOf, lineMetrics, makeRun, wrappedLineMetrics, wrapRuns } from './text.ts'

/**
 * 等宽测试字体：ASCII 半角（0.5 em），汉字全角（1 em）；`cjk` 为假时没有汉字字形。
 * 纵向度量：上升 round(0.8·ppem)，其余为下降；`leading` 为外部行距（像素）；`ascentExtra` 使上升高度超出 ppem。
 * `integer` 为真时前进宽度取 ppem 下四舍五入的整数；`bitmaps` 为内嵌点阵。
 */
function fakeFace(
  family: string,
  opts: {
    cjk: boolean
    bold?: boolean
    digit?: number
    leading?: number
    ascentExtra?: number
    integer?: boolean
    bitmaps?: EmbeddedBitmaps
  },
): LoadedFace {
  const has = (cp: number) => (cp < 0x2e80 ? cp >= 32 && cp < 0x7f : opts.cjk)
  const unit = (cp: number) => (cp >= 0x2e80 ? 1 : cp >= 48 && cp <= 57 ? (opts.digit ?? 0.5) : 0.5)
  const metrics: FontMetrics = {
    unitsPerEm: 1000,
    numGlyphs: 100,
    glyphId: (cp) => (has(cp) ? (cp >= 0x2e80 ? 2 : 1) : 0),
    advanceWidth: (cp) => unit(cp) * 1000,
    advance: (cp, size) => unit(cp) * size,
  }
  return {
    family,
    bold: opts.bold ?? false,
    italic: false,
    metrics,
    vertical: (ppem) => {
      const ascent = Math.round(ppem * 0.8) + (opts.ascentExtra ?? 0)
      const descent = ppem - Math.round(ppem * 0.8)
      return {
        ascent,
        descent,
        height: ascent + descent,
        internalLeading: ascent + descent - ppem,
        externalLeading: opts.leading ?? 0,
      }
    },
    pixelAdvance: (cp, ppem) => (opts.integer ? Math.round(unit(cp) * ppem) : null),
    bitmaps: opts.bitmaps ?? null,
    clearType: null,
    text: {
      metrics,
      vertical: {
        unitsPerEm: 1000,
        hheaAscender: 800,
        hheaDescender: -200,
        hheaLineGap: 0,
        winAscent: 800,
        winDescent: 200,
        averageWidth: 500,
        eastAsianCodePage: opts.cjk,
        superscriptSize: 650,
        superscriptOffset: 350,
        subscriptSize: 650,
        subscriptOffset: 150,
      },
    },
  }
}

const fonts = new FontSet(
  [fakeFace('西文', { cjk: false }), fakeFace('宋体', { cjk: true })],
  ['宋体'],
)

const font = {
  name: '西文',
  size: 12,
  bold: false,
  italic: false,
  underline: 'none',
  strike: false,
  color: null,
  vertAlign: 'baseline',
} as const

function style(over: Partial<CellStyle> = {}): CellStyle {
  return {
    font,
    fill: null,
    border: null,
    alignment: {
      horizontal: 'general',
      vertical: 'bottom',
      wrap: false,
      shrink: false,
      rotation: 0,
      indent: 0,
    },
    numFmt: 'General',
    ...over,
  }
}

/** 条件格式命中后加粗并改为红色。 */
const redBold: DifferentialStyle = {
  bold: true,
  italic: null,
  strike: null,
  underline: null,
  color: '#ff0000',
  fill: null,
  border: null,
  numFmt: null,
}

function workbook(sheet: Worksheet, styles: CellStyle[] = [style()]): Workbook {
  return {
    sheets: [sheet],
    styles,
    defaultFont: font,
    minorFont: null,
    date1904: false,
    palette: [],
    activeSheet: 0,
    fontNames: ['西文'],
    unsupported: {},
  }
}

function sheetOf(cells: Record<string, Cell>, over: Partial<Worksheet> = {}): Worksheet {
  const map = new Map<number, Map<number, Cell>>()
  for (const [ref, cell] of Object.entries(cells)) {
    const col = ref.charCodeAt(0) - 65
    const row = Number(ref.slice(1)) - 1
    const line = map.get(row) ?? new Map()
    line.set(col, cell)
    map.set(row, line)
  }
  return {
    name: 'S',
    state: 'visible',
    cells: map,
    rows: new Map(),
    cols: [],
    format: {
      defaultRowHeight: 15,
      zeroHeight: false,
      customHeight: false,
      defaultColWidth: 10,
      baseColWidth: 8,
      declared: true,
    },
    merges: [],
    view: {
      showGridLines: true,
      gridColor: null,
      zoom: 100,
      rightToLeft: false,
      frozenRows: 0,
      frozenCols: 0,
      topLeft: { row: 0, col: 0 },
    },
    conditionalFormats: [],
    images: [],
    shapes: [],
    charts: [],
    autoFilter: null,
    maxRow: 10,
    maxCol: 5,
    unsupported: {},
    ...over,
  }
}

const num = (value: number, s = 0): Cell => ({ value: { type: 'number', value }, style: s })
const str = (value: string, s = 0): Cell => ({
  value: { type: 'string', value, runs: null },
  style: s,
})

describe('坐标轴', () => {
  test('逐项尺寸、区段与默认尺寸', () => {
    const axis = new Axis([10, 0, 20], 5, [{ from: 5, to: 6, size: 7 }], 100)
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => axis.offset(i))).toEqual([
      0, 10, 10, 30, 35, 40, 47, 54,
    ])
    expect(axis.size(1)).toBe(0)
    expect(axis.size(6)).toBe(7)
    expect(axis.total).toBe(30 + 2 * 5 + 2 * 7 + 93 * 5)
    expect(axis.indexAt(9)).toBe(0)
    expect(axis.indexAt(10)).toBe(2)
    expect(axis.indexAt(41)).toBe(5)
    expect(axis.indexAt(60)).toBe(8)
    expect(axis.indexAt(1e9)).toBe(99)
  })
})

describe('字体', () => {
  test('缺字逐字回退并分段；没有粗体字形时按合成粗体加宽', () => {
    const chain = fonts.chain('西文', false, false)
    expect(chain.width('AB汉', 10)).toBe(5 + 5 + 10)
    expect(chain.segments('AB汉C', 10).map((s) => [s.text, s.css, s.width])).toEqual([
      ['AB', '"西文"', 10],
      ['汉', '"宋体"', 10],
      ['C', '"西文"', 5],
    ])
    const bold = fonts.chain('西文', true, false)
    expect(bold.width('AB', 10)).toBe(10 + 2 * syntheticBoldExtra(10))
    expect(bold.segments('A', 10)[0]!.letterSpacing).toBe(1)
    expect(syntheticBoldExtra(48)).toBe(2)
  })
  test('字体表能确定整数宽度时按 ppem 取整数宽度，否则取线性宽度', () => {
    const set = new FontSet([fakeFace('整', { cjk: true, integer: true })], [])
    const chain = set.chain('整', false, false)
    // 11 磅：px 14.67，ppem 15；半角 7.5 取整为 8，全角 15。
    expect(chain.width('a汉', (11 * 4) / 3)).toBe(8 + 15)
    expect(chain.charWidth(0x61, (11 * 4) / 3)).toBe(8)
    expect(fonts.chain('宋体', false, false).width('a汉', (11 * 4) / 3)).toBeCloseTo(22, 10)
  })
  test('主机上没有的字体：字体替换表取替换后的字体，东亚名称与 Arial Unicode MS 取宋体，其余取 Arial', () => {
    const cases: [string, string][] = [
      ['Inherit', 'Arial'],
      ['STSong', 'Arial'],
      ['MS Mincho', 'Arial'],
      ['Cafè Sans', 'Arial'],
      ['arial unicode ms', 'Arial'],
      ['Arial Unicode MS', '宋体'],
      ['思源黑体', '宋体'],
      ['仿宋_GB2312', '宋体'],
      ['굴림', '宋体'],
      ['Ｑｙ', '宋体'],
      ['Helvetica', 'Arial'],
      ['times', 'Times New Roman'],
      ['FangSong_GB2312', '仿宋'],
      ['KaiTi_GB2312', '楷体'],
    ]
    for (const [name, expected] of cases)
      expect([name, substituteFont(name)]).toEqual([name, expected])
    const set = new FontSet(
      [fakeFace('Arial', { cjk: false }), fakeFace('宋体', { cjk: true })],
      ['宋体'],
    )
    const families = (name: string, s = set) =>
      s.chain(name, false, false).faces.map((f) => f.family)
    expect(families('Inherit')).toEqual(['Arial', '宋体'])
    expect(families('思源黑体')).toEqual(['宋体'])
    // 形状文字另有规则：`face` 不做替代。
    expect(set.face('Inherit', false, false)).toBeNull()
    // 替代字体同样不在字体集中时从回退字体开始。
    expect(families('Inherit', new FontSet([fakeFace('宋体', { cjk: true })], ['宋体']))).toEqual([
      '宋体',
    ])
  })
})

describe('行高与列宽', () => {
  test('最大数字宽度按整数像素字号取整，列宽按 Excel 公式换算', () => {
    // 11 磅为 15 像素字号，数字半角 7.5 像素，四舍五入为 8。
    expect(maxDigitWidth({ ...font, size: 11 }, fonts)).toBe(8)
    expect(columnPixels(9.140625, 7)).toBe(64)
    expect(columnPixels(9, 8)).toBe(72)
    expect(columnPixels(102.4140625, 8)).toBe(819)
    expect(rowPixels(26)).toBe(34)
    expect(rowPixels(13.5)).toBe(18)
  })
  test('未指定 defaultColWidth 时默认列宽为 baseColWidth + 1 个字符；没有 sheetFormatPr 时为 72 像素（WPS 实测）', () => {
    const width = (baseColWidth: number, declared: boolean, mdw: number) =>
      defaultColumnPixels(
        sheetOf(
          {},
          {
            format: {
              defaultRowHeight: 15,
              zeroHeight: false,
              customHeight: false,
              defaultColWidth: null,
              baseColWidth,
              declared,
            },
          },
        ),
        mdw,
      )
    expect([6, 7, 8, 10, 12, 14, 16, 19].map((m) => width(8, true, m))).toEqual([
      54, 63, 72, 90, 108, 126, 144, 171,
    ])
    expect(width(10, true, 7)).toBe(77)
    expect([6, 7, 8, 10].map((m) => width(8, false, m))).toEqual([72, 72, 72, 72])
  })
  test('指定行高向下取整；其余行按字体与换行推算，保存的 ht 不参与', () => {
    const wrap = style({
      alignment: {
        horizontal: 'left',
        vertical: 'top',
        wrap: true,
        shrink: false,
        rotation: 0,
        indent: 0,
      },
    })
    const big = style({ font: { ...font, size: 20 } })
    const sheet = sheetOf(
      { A1: str('x'), A2: str('一二三四五六七八九十', 1), A3: str('x', 2), A4: str('x') },
      {
        cols: [{ min: 0, max: 0, width: 5, hidden: false, style: null }],
        rows: new Map([
          [0, { height: 26, custom: true, hidden: false, style: null }],
          [1, { height: null, custom: false, hidden: false, style: null }],
          [2, { height: null, custom: false, hidden: false, style: null }],
          [3, { height: 30, custom: false, hidden: false, style: null }],
          [5, { height: null, custom: false, hidden: true, style: null }],
        ]),
      },
    )
    const g = buildGeometry(workbook(sheet, [style(), wrap, big]), sheet, fonts)
    expect(g.mdw).toBe(8)
    expect(g.cols.size(0)).toBe(columnPixels(5, 8))
    expect(g.rows.size(0)).toBe(34)
    // 12 磅为 16 像素字号：上升 13、下降 3，单行行高 16 + 3 + 1 = 20。
    // 列宽 44 像素，留白后 39 像素，16 像素的汉字每行 2 个：5 行，每行 20。
    expect(g.rows.size(1)).toBe(5 * 20)
    // 20 磅为 27 像素字号：下降 5，单行行高 27 + 5 + 1。
    expect(g.rows.size(2)).toBe(33)
    // 保存的 ht 为 30 磅（40 像素）而没有 customHeight：按内容取 20。
    expect(g.rows.size(3)).toBe(20)
    expect(g.rows.size(4)).toBe(20)
    expect(g.rows.size(5)).toBe(0)
  })
})

describe('单行行高、标准行高与边框增量', () => {
  const sized = (size: number) => ({ ...font, size })
  test('单行行高 = ppem + 下降 + 1 + 2·max(0, 上升 − ppem, ⌊(外部行距 − 1)/2⌋)', () => {
    const plain = new FontSet([fakeFace('A', { cjk: true })], [])
    const tall = new FontSet([fakeFace('A', { cjk: true, ascentExtra: 4 })], [])
    const lead = (leading: number) => new FontSet([fakeFace('A', { cjk: true, leading })], [])
    const a = { ...font, name: 'A', size: 14 }
    // 14 磅为 19 像素字号：上升 15、下降 4。
    expect(fontLineHeight(a, plain)).toBe(19 + 4 + 1)
    // 上升 19 超出 ppem 0；上升 20 超出 1，加 2。
    expect(fontLineHeight(a, new FontSet([fakeFace('A', { cjk: true, ascentExtra: 5 })], []))).toBe(
      19 + 4 + 1 + 2,
    )
    expect(fontLineHeight(a, tall)).toBe(19 + 4 + 1)
    // 外部行距 2 不加，3 与 4 加 2，5 加 4。
    expect([2, 3, 4, 5].map((e) => fontLineHeight(a, lead(e)))).toEqual([24, 26, 26, 28])
    expect(fontLineHeight(sized(11), fonts)).toBe(15 + 3 + 1)
  })

  test('标准行高：各列默认样式字体的单行行高取最大，第 16384 列不参与；不带 customHeight 时与默认行高无关', () => {
    const fmt = (defaultRowHeight: number, customHeight: boolean, cols: Worksheet['cols'] = []) =>
      sheetOf(
        {},
        {
          cols,
          format: {
            defaultRowHeight,
            zeroHeight: false,
            customHeight,
            defaultColWidth: 10,
            baseColWidth: 8,
            declared: true,
          },
        },
      )
    // 样式 0 为 12 磅（行高 20），样式 1 为 20 磅（33），样式 2 为 9 磅（12 + 2 + 1 = 15）。
    const styles = [style(), style({ font: sized(20) }), style({ font: sized(9) })]
    const std = (sheet: Worksheet) => standardRowHeight(workbook(sheet, styles), sheet, fonts)
    const col = (min: number, max: number, s: number, hidden = false) => ({
      min,
      max,
      width: null,
      hidden,
      style: s,
    })
    // 原始失败形状：默认行高 17.5 磅（23 像素）而 WPS 取 25，默认行高 14 磅（18 像素）而 WPS 取 19。
    expect(std(fmt(17.5, false))).toBe(20)
    expect(std(fmt(35.5, false))).toBe(20)
    expect(std(fmt(15, false, [col(2, 2, 1, true)]))).toBe(33)
    expect(std(fmt(15, false, [col(0, 16383, 2)]))).toBe(15)
    expect(std(fmt(15, false, [col(0, 16382, 2)]))).toBe(15)
    expect(std(fmt(15, false, [col(0, 16381, 2)]))).toBe(20)
    expect(std(fmt(15.75, true, [col(2, 2, 1)]))).toBe(21)
  })

  test('按内容推算：未写出的单元格按行样式、列样式或样式 0 取行高；写出的单元格（含没有值的）按自身样式；标准行高不是下限', () => {
    const styles = [style(), style({ font: sized(20) }), style({ font: sized(9) })]
    const empty: Cell = { value: null, style: 0 }
    const auto = (s: number | null = null) => ({
      height: null,
      custom: false,
      hidden: false,
      style: s,
    })
    const all = sheetOf(
      { A1: str('x', 2), A2: str('x', 2), B2: empty, A3: str('x', 2) },
      {
        cols: [{ min: 0, max: 16383, width: null, hidden: false, style: 2 }],
        rows: new Map([
          [0, auto()],
          [1, auto()],
          [2, auto(1)],
          [3, auto()],
        ]),
      },
    )
    const g = buildGeometry(workbook(all, styles), all, fonts)
    expect([0, 1, 2, 3, 4].map((r) => g.rows.size(r))).toEqual([15, 20, 33, 15, 15])
    const part = sheetOf(
      { C1: str('x', 2), A2: str('x', 2) },
      {
        cols: [{ min: 2, max: 2, width: null, hidden: false, style: 1 }],
        rows: new Map([
          [0, auto()],
          [1, auto()],
        ]),
      },
    )
    const h = buildGeometry(workbook(part, styles), part, fonts)
    expect([0, 1, 2].map((r) => h.rows.size(r))).toEqual([20, 33, 33])
  })

  test('默认行高带 customHeight 的工作表：文件中有的行按内容推算，只有文件中没有的行取默认行高（WPS 实测）', () => {
    const big = style({ font: sized(20) })
    const row = (height: number | null, custom: boolean) => ({
      height,
      custom,
      hidden: false,
      style: null,
    })
    const sheet = sheetOf(
      { A1: str('x', 1) },
      {
        format: {
          defaultRowHeight: 30,
          zeroHeight: false,
          customHeight: true,
          defaultColWidth: 10,
          baseColWidth: 8,
          declared: true,
        },
        rows: new Map([
          [0, row(115.65, false)],
          [1, row(30, false)],
          [2, row(null, false)],
          [3, row(10, true)],
        ]),
      },
    )
    const g = buildGeometry(workbook(sheet, [style(), big]), sheet, fonts)
    // 第 1 行 20 磅：27 + 5 + 1；第 2、3 行没有单元格，按样式 0 的 12 磅：16 + 3 + 1，低于默认行高 40。
    expect([0, 1, 2, 3, 4].map((r) => g.rows.size(r))).toEqual([33, 20, 20, 13, 40])
  })

  test('边框：两行之间的横线逐列取较宽的一条，上行加 ⌊w/2⌋、下行加 ⌊(w − 1)/2⌋', () => {
    const line = (s: BorderLineStyle) => ({ style: s, color: '#000000' })
    const bordered = (top: BorderLineStyle | null, bottom: BorderLineStyle | null) =>
      style({
        border: {
          left: null,
          right: null,
          top: top ? line(top) : null,
          bottom: bottom ? line(bottom) : null,
          diagonalUp: null,
          diagonalDown: null,
        },
      })
    const cases: [BorderLineStyle | null, BorderLineStyle | null, number][] = [
      [null, 'thin', 0],
      [null, 'dashed', 0],
      [null, 'medium', 1],
      [null, 'mediumDashDot', 1],
      [null, 'slantDashDot', 1],
      [null, 'thick', 1],
      [null, 'double', 1],
      ['medium', null, 0],
      ['thick', null, 1],
      ['double', 'double', 2],
    ]
    for (const [top, bottom, extra] of cases) {
      const sheet = sheetOf(
        { A1: str('x', 1) },
        { rows: new Map([[0, { height: null, custom: false, hidden: false, style: null }]]) },
      )
      const g = buildGeometry(workbook(sheet, [style(), bordered(top, bottom)]), sheet, fonts)
      expect([top, bottom, g.rows.size(0)]).toEqual([top, bottom, 20 + extra])
    }
    // 下行的中粗顶边使上行加 1；上行细底边、下行粗顶边时取粗线，上下两行各加 1。
    const auto = { height: null, custom: false, hidden: false, style: null }
    const rows = new Map([
      [0, auto],
      [1, auto],
      [2, auto],
      [3, auto],
    ])
    const styles = [
      style(),
      bordered('medium', null),
      bordered(null, 'thin'),
      bordered('thick', null),
    ]
    const adjacent = sheetOf(
      { A1: str('x'), A2: str('x', 1), A3: str('x', 2), A4: str('x', 3), B3: str('x') },
      { rows },
    )
    const g = buildGeometry(workbook(adjacent, styles), adjacent, fonts)
    expect([0, 1, 2, 3].map((r) => g.rows.size(r))).toEqual([21, 20, 21, 21])
  })
})

describe.skipIf(process.platform !== 'win32')('本机字体的单行行高（WPS 实测）', () => {
  const dir = join(process.env.WINDIR ?? 'C:Windows', 'Fonts')
  const face = (file: string, family: string, index = 0) =>
    loadFace(extractFace(new Uint8Array(readFileSync(join(dir, file))), index), family)
  // [字体, 文件, 磅, WPS 行高（像素）]：取自 WPS 对无 ht 行按内容推算的行高。
  const cases: [string, string, number, number][] = [
    ['宋体', 'simsun.ttc', 6, 12],
    ['宋体', 'simsun.ttc', 10.5, 17],
    ['宋体', 'simsun.ttc', 11, 18],
    ['宋体', 'simsun.ttc', 12, 19],
    ['宋体', 'simsun.ttc', 14, 25],
    ['宋体', 'simsun.ttc', 24, 42],
    ['Calibri', 'calibri.ttf', 11, 20],
    ['Calibri', 'calibri.ttf', 24, 42],
    ['Arial', 'arial.ttf', 11, 19],
    ['微软雅黑', 'msyh.ttc', 11.25, 22],
  ]
  test.each(cases)('%s %d 磅', (family, file, size, expected) => {
    const set = new FontSet([face(file, family)], [])
    expect(fontLineHeight({ ...font, name: family, size }, set)).toBe(expected)
  })
  test('主机上没有的字体按替代字体取行高：Inherit 与 Arial 逐字号相同，粗体取 Arial 粗体，含汉字的名称取宋体', () => {
    const set = new FontSet(
      [face('arial.ttf', 'Arial'), face('arialbd.ttf', 'Arial'), face('simsun.ttc', '宋体')],
      ['宋体'],
    )
    const height = (name: string, size: number, bold = false) =>
      fontLineHeight({ ...font, name, size, bold }, set)
    // [磅, WPS 行高]：WPS 对字体名 Inherit 的单元格按内容推算的行高。
    for (const [size, expected] of [
      [6, 11],
      [8, 15],
      [14, 24],
      [18, 31],
      [48, 79],
    ] as const) {
      expect([size, height('Inherit', size)]).toEqual([size, expected])
    }
    expect([height('Inherit', 7, true), height('Inherit', 11, true)]).toEqual([12, 20])
    expect([height('方正小标宋简体', 14), height('Arial Unicode MS', 24)]).toEqual([25, 42])
  })
  test('留白按单元格字体的数字宽度：与 WPS 实测的分界一致', () => {
    const set = new FontSet(
      [
        face('simsun.ttc', '宋体'),
        face('arial.ttf', 'Arial'),
        face('times.ttf', 'Times New Roman'),
      ],
      [],
    )
    // [字体, ppem, WPS 左留白]：留白在相邻 ppem 之间变化的位置。
    for (const [name, ppem, left] of [
      ['宋体', 24, 4],
      ['宋体', 25, 5],
      ['Arial', 22, 4],
      ['Arial', 23, 5],
      ['Times New Roman', 19, 3],
      ['Times New Roman', 20, 4],
    ] as const) {
      const pad = textPadding({ ...font, name, size: ppem * 0.75 }, set)
      expect([name, ppem, pad.left, pad.right]).toEqual([name, ppem, left, left - 1])
    }
  })
})

describe('自动换行的行高', () => {
  test('每行按行中实际使用的字体取行高：西文字体单元格中只有汉字的行按回退字体', () => {
    // 西文字体外部行距 2（单行行高 20 + 0），回退字体外部行距 5（单行行高 20 + 4）。
    const set = new FontSet(
      [fakeFace('西', { cjk: false }), fakeFace('中', { cjk: true, leading: 5 })],
      ['中'],
    )
    const f = { ...font, name: '西' }
    const mixed = wrappedLineMetrics([makeRun('a汉', f, set)])
    const latin = wrappedLineMetrics([makeRun('ab', f, set)])
    const cjk = wrappedLineMetrics([makeRun('汉字', f, set)])
    expect([latin.height, mixed.height, cjk.height]).toEqual([20, 24, 24])
    // 不换行时按主字体，与内容无关。
    expect(lineMetrics([makeRun('汉字', f, set)]).height).toBe(20)
  })

  test('下降不超过 1 像素且有外部行距时，单行行高的 max 项至少为 1', () => {
    const face = fakeFace('小', { cjk: true, leading: 1 })
    const tiny = { ...face, vertical: (p: number) => ({ ...face.vertical(p), descent: 1 }) }
    expect(lineBox(tiny, 6).height).toBe(8 + 1 + 1 + 2)
    expect(lineBox(face, 6).height).toBe(8 + 2 + 1)
  })
})

describe('自动换行', () => {
  const lines = (text: string, width: number) =>
    wrapRuns([makeRun(text, font, fonts)], width).map((l) => l.runs.map((r) => r.text).join(''))

  test('西文按单词断开，汉字逐字可断，过长的单词按字符断开，行首空格去掉', () => {
    expect(lines('ab cd ef', 40)).toEqual(['ab cd', 'ef'])
    expect(lines('一二三四五', 40)).toEqual(['一二', '三四', '五'])
    expect(lines('abcdefghij', 30)).toEqual(['abc', 'def', 'ghi', 'j'])
    expect(lines('ab\ncd', 100)).toEqual(['ab', 'cd'])
  })

  test('文字以换行符结尾时其后另有一个空行，行高取换行符所在段的字体（WPS 实测）', () => {
    expect(lines('ab\n', 100)).toEqual(['ab', ''])
    expect(lines('ab\n\n', 100)).toEqual(['ab', '', ''])
    expect(lines('\nab', 100)).toEqual(['', 'ab'])
    const out = wrapRuns([makeRun('ab\n', font, fonts)], 100)
    expect(out.map((l) => lineBoxOf(l).height)).toEqual([20, 20])
  })

  // 每个汉字与全角标点 16 像素，行宽 40 像素容纳两个。
  test('断点与禁则取共用的断行规则：行首禁则字符不在行首，行尾禁则字符不在行尾，连字符之后可断', () => {
    expect(lines('一二，三', 40)).toEqual(['一', '二，', '三'])
    expect(lines('一二（三', 40)).toEqual(['一二', '（三'])
    expect(lines('一（二三', 40)).toEqual(['一', '（二', '三'])
    expect(lines('ab-cdef', 40)).toEqual(['ab-', 'cdef'])
  })

  test('富文本换行后每行保留各段的字体，相邻的同段字符合并', () => {
    const bold = { ...font, bold: true }
    const out = wrapRuns([makeRun('一二', font, fonts), makeRun('三四', bold, fonts)], 40)
    expect(out.map((l) => l.runs.map((r) => [r.text, r.font.bold]))).toEqual([
      [['一二', false]],
      [['三四', true]],
    ])
  })
})

function box(
  left: number,
  right: number,
  spillable: (c: number) => boolean = () => false,
): CellBox {
  return {
    left,
    right,
    top: 0,
    bottom: 20,
    col: 1,
    lastCol: 1,
    merged: false,
    colLeft: (c) => left + (c - 1) * (right - left),
    colRight: (c) => left + (c - 1) * (right - left) + (right - left),
    spillable,
  }
}

function layout(cell: Cell, st: CellStyle, b: CellBox, set: FontSet = fonts) {
  const wb = workbook(sheetOf({}), [st])
  return layoutCell(
    {
      content: cellContent(cell.value!, st.numFmt, wb),
      alignment: st.alignment,
      font: st.font,
      colorOverride: null,
      fonts: set,
      indentUnit: 24,
    },
    b,
  )
}

/** 指定水平对齐与自动换行的样式（垂直靠下）。 */
function aligned(
  horizontal: CellStyle['alignment']['horizontal'],
  wrap: boolean,
  over: Partial<CellStyle> = {},
) {
  return style({
    alignment: { horizontal, vertical: 'bottom', wrap, shrink: false, rotation: 0, indent: 0 },
    ...over,
  })
}

describe('单元格文字', () => {
  test('「常规」对齐：数字靠右、文本靠左、逻辑值与错误值居中', () => {
    expect(resolveHorizontal('general', 'number')).toBe('right')
    expect(resolveHorizontal('general', 'text')).toBe('left')
    expect(resolveHorizontal('general', 'boolean')).toBe('center')
    expect(resolveHorizontal('general', 'error')).toBe('center')
    const n = layout(num(12), style(), box(100, 200))!
    expect(n.fragments[0]!.x + n.fragments[0]!.width).toBe(200 - 2)
    const t = layout(str('ab'), style(), box(100, 200))!
    expect(t.fragments[0]!.x).toBe(103)
  })
  test('靠下时文字行的下沿与下网格线重合', () => {
    const t = layout(str('ab'), style(), box(0, 100))!
    // 16 像素字号：上升 12.8、下降 3.2，基线取整到 17。
    expect(t.fragments[0]!.y).toBe(17)
  })
  test('文本溢出到相邻空单元格，遇到非空单元格停止；居中向两侧溢出', () => {
    const long = str('abcdefghijklmnop')
    const spill = layout(
      long,
      style(),
      box(100, 150, (c) => c === 2 || c === 3),
    )!
    expect([spill.firstCol, spill.lastCol]).toEqual([1, 3])
    expect(spill.clip.right).toBe(250)
    const blocked = layout(
      long,
      style(),
      box(100, 150, () => false),
    )!
    expect([blocked.firstCol, blocked.lastCol, blocked.clip.right]).toEqual([1, 1, 150])
    const centered = style({
      alignment: {
        horizontal: 'center',
        vertical: 'bottom',
        wrap: false,
        shrink: false,
        rotation: 0,
        indent: 0,
      },
    })
    const both = layout(
      long,
      centered,
      box(100, 150, (c) => c === 0 || c === 2),
    )!
    expect([both.firstCol, both.lastCol]).toEqual([0, 2])
  })
  test('数字宽度不足：非常规格式以 # 填满，常规格式先减少小数位', () => {
    const fixed = style({ numFmt: '0.00' })
    const hashes = layout(num(123456.78), fixed, box(0, 40))!
    expect(hashes.fragments[0]!.text).toBe('#'.repeat(Math.floor(35 / 8)))
    const general = layout(num(Math.PI), style(), box(0, 30))!
    expect(general.fragments[0]!.text).toBe('3.1')
    const date = layout(num(-1), style({ numFmt: 'yyyy/m/d' }), box(0, 100))!
    expect(date.fragments[0]!.text).toMatch(/^#+$/)
  })
  test('容纳判定：常规数字按字符数乘最大数字宽度，可超出留白之间 1 像素；其他格式按实际宽度，可超出 3 像素', () => {
    // 数字 8 像素，留白 3 + 2。
    const text = (v: number, st: CellStyle, right: number, set = fonts) =>
      layout(num(v), st, box(0, right), set)!.fragments[0]!.text
    expect(text(Math.PI, style(), 44)).toBe('3.142')
    expect(text(Math.PI, style(), 43)).toBe('3.14')
    // 数字 9.6 像素（最大数字宽度取整为 10，留白 4 + 3），小数点 8 像素：「3.142」实际宽 46.4，估计宽 50。
    const wide = new FontSet([fakeFace('西文', { cjk: false, digit: 0.6 })], [])
    expect(text(Math.PI, style(), 56, wide)).toBe('3.142')
    expect(text(Math.PI, style(), 55, wide)).toBe('3.14')
    const fixed = style({ numFmt: '0.00' })
    expect(text(123.45, fixed, 50)).toBe('123.45')
    expect(text(123.45, fixed, 49)).toMatch(/^#+$/)
  })
  test('会计格式：常规对齐时数字靠右，右侧留出一个空格', () => {
    const acc = style({ numFmt: '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"_ ;_ @_ ' })
    const l = layout(num(1234), acc, box(0, 100))!
    const digits = l.fragments.find((f) => f.text === '1,234')!
    // 右侧留出一个空格（8 像素）的位置。
    expect(digits.x + digits.width).toBe(100 - 2 - 8)
  })
  test('* 填充重复整数次（总宽可超出留白之间 3 像素），整段按水平对齐放置', () => {
    const aligned = (horizontal: CellStyle['alignment']['horizontal']) =>
      style({ numFmt: '* 0', alignment: { ...style().alignment, horizontal } })
    // 留白之间 45 像素：「12」16 像素加 4 个空格共 48 像素。
    const digitsX = (horizontal: CellStyle['alignment']['horizontal']) =>
      layout(num(12), aligned(horizontal), box(0, 50))!.fragments.find((f) => f.text === '12')!.x
    expect(digitsX('left')).toBe(3 + 32)
    expect(digitsX('center')).toBe(1.5 + 32)
    expect(digitsX('right')).toBe(0 + 32)
    expect(digitsX('general')).toBe(0 + 32)
  })
  test('自动换行、分散对齐、填充对齐与旋转', () => {
    const wrap = style({
      alignment: {
        horizontal: 'left',
        vertical: 'top',
        wrap: true,
        shrink: false,
        rotation: 0,
        indent: 0,
      },
    })
    expect(layout(str('ab cd ef'), wrap, box(0, 40))!.fragments.map((f) => f.text)).toEqual([
      'ab',
      'cd',
      'ef',
    ])
    // 居中的两行：每行占单行行高 20，整体居中后行顶向零取整，基线在行顶之下 `LineBox.baseline`（ppem + 1）。
    const centerWrap = style({
      alignment: { ...wrap.alignment, vertical: 'center' },
    })
    const tall: CellBox = { ...box(0, 40), bottom: 55 }
    expect(layout(str('ab cd'), centerWrap, tall)!.fragments.map((f) => f.y)).toEqual([24, 44])
    // 居中单行：(55 − 20) / 2 向零取整为 17，基线 17 + 17。
    const centerOne = style({ alignment: { ...centerWrap.alignment, wrap: false } })
    expect(layout(str('ab'), centerOne, tall)!.fragments[0]!.y).toBe(34)
    const dist = style({
      alignment: {
        horizontal: 'distributed',
        vertical: 'bottom',
        wrap: false,
        shrink: false,
        rotation: 0,
        indent: 0,
      },
    })
    const d = layout(str('一二三'), dist, box(0, 100))!
    expect(d.fragments.map((f) => f.x)).toEqual([3, 3 + 16 + (95 - 48) / 2, 3 + 32 + 95 - 48])
    const fill = style({
      alignment: {
        horizontal: 'fill',
        vertical: 'bottom',
        wrap: false,
        shrink: false,
        rotation: 0,
        indent: 0,
      },
    })
    expect(layout(str('ab'), fill, box(0, 50))!.fragments[0]!.text).toBe(
      'abababab'.slice(0, 2 * Math.floor(45 / 16)),
    )
    const rot = style({
      alignment: {
        horizontal: 'general',
        vertical: 'bottom',
        wrap: false,
        shrink: false,
        rotation: 135,
        indent: 0,
      },
    })
    expect(layout(str('ab'), rot, box(0, 50))!.rotate?.angle).toBe(-45)
  })
  test('留白随单元格字体的最大数字宽度 w 变化：左 ⌊5(w + 6)/19⌋、右少 1，粗体按粗体宽度；自动换行的行宽同样扣除', () => {
    // 测试字体的数字为 0.5 em：7 磅 ppem 9 时 w = 5，11 磅 w = 8，18 磅 w = 12，20 磅 w = 14。
    const pads = [7, 11, 18, 20].map((size) => textPadding({ ...font, size }, fonts))
    expect(pads.map((p) => [p.left, p.right])).toEqual([
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ])
    // 合成粗体每字加宽 1：18 磅粗体 w = 13。
    expect(textPadding({ ...font, size: 18, bold: true }, fonts).left).toBe(5)
    const big = { ...font, size: 18 }
    expect(layout(str('ab'), style({ font: big }), box(100, 200))!.fragments[0]!.x).toBe(104)
    const n = layout(num(12), style({ font: big }), box(100, 200))!.fragments[0]!
    expect(n.x + n.width).toBe(200 - 3)
    // 7 磅（字宽 14/3）：21 个半角字符宽 98，列宽 102 扣除留白 2 与 1 后容纳一行；按 3 与 2 扣除时需换行。
    const small = aligned('left', true, { font: { ...font, size: 7 } })
    expect(layout(str('a'.repeat(21)), small, box(0, 102))!.fragments).toHaveLength(1)
  })
  test('数字格式的空白取空格宽度；自动换行时数字末尾的空白不占宽度，开头的保留', () => {
    // 数字为 1 em、其余半角字符 0.5 em：「0」16 像素，空格 8 像素；数字宽度 16 时留白为 5 与 4。
    const wide = new FontSet([fakeFace('西文', { cjk: false, digit: 1 })], [])
    // 靠右时文字起点 = 96 − 显示宽度：「1」加一个空格为 72，只有「1」为 80。
    const start = (numFmt: string, wrap: boolean) =>
      layout(num(1), aligned('right', wrap, { numFmt }), box(0, 100), wide)!.fragments[0]!.x
    expect([start('0_ ', false), start('0_0', false), start('0" "', false)]).toEqual([72, 72, 72])
    expect([start('0_ ', true), start('#,##0_ ', true), start('0" "', true)]).toEqual([80, 80, 80])
    const left = layout(num(1), aligned('left', true, { numFmt: '_ 0' }), box(0, 100), wide)!
    expect(left.fragments[0]!.x).toBe(5 + 8)
  })
  test('自动换行的行居中时余量为奇数向左取整；逻辑值与数字在自动换行的单元格中仍按单行排版', () => {
    // 可用宽度 3–98，「TRUE」宽 32：余量 63。
    const text = layout(str('TRUE'), aligned('center', true), box(0, 100))!
    expect(text.fragments[0]!.x).toBe(34)
    const bool = layout(
      { value: { type: 'boolean', value: true }, style: 0 },
      aligned('center', true),
      box(0, 100),
    )!
    expect(bool.fragments[0]!.x).toBe(34.5)
  })
})

describe('公式与条件格式', () => {
  const sheet = sheetOf({ A1: num(5), A2: num(15), A3: num(10), B1: str('扣分项'), C1: num(2) })
  const wb = workbook(sheet)
  test('求值：引用、运算、比较与函数；不支持的函数无法求值', () => {
    expect(evaluateFormula('$A$1*2+C1', wb, sheet, 0, 0)).toBe(12)
    expect(evaluateFormula('A1>C1', wb, sheet, 1, 0)).toBe(true)
    expect(evaluateFormula('NOT(ISERROR(SEARCH("扣分",B1)))', wb, sheet, 0, 0)).toBe(true)
    expect(evaluateFormula('#REF!/1000', wb, sheet, 0, 0)).toEqual({ error: '#REF!' })
    expect(evaluateFormula('"a"&1', wb, sheet, 0, 0)).toBe('a1')
    expect(canEvaluate('MOD(ROW(),2)=0')).toBe(true)
    expect(canEvaluate('INDIRECT("A1")')).toBe(false)
    expect(canEvaluate('SUM(A1:A3)')).toBe(false)
  })
  test('规则按优先级合并，色阶插值，前 N 项', () => {
    const rules: CfRule[] = [
      {
        type: 'cellIs',
        operator: 'greaterThan',
        formulas: ['$C$1*4'],
        priority: 1,
        stopIfTrue: false,
        dxf: redBold,
      },
      {
        type: 'colorScale',
        thresholds: [
          { type: 'min', value: null },
          { type: 'max', value: null },
        ],
        colors: ['#000000', '#ffffff'],
        priority: 2,
        stopIfTrue: false,
        dxf: null,
      },
      {
        type: 'top10',
        rank: 1,
        percent: false,
        bottom: false,
        priority: 3,
        stopIfTrue: false,
        dxf: redBold,
      },
    ]
    const cf = new ConditionalFormats(
      wb,
      sheetOf(
        Object.fromEntries(
          [...sheet.cells].flatMap(([r, l]) =>
            [...l].map(([c, v]) => [`${String.fromCharCode(65 + c)}${r + 1}`, v]),
          ),
        ),
        {
          conditionalFormats: [{ ranges: [{ top: 0, left: 0, bottom: 2, right: 0 }], rules }],
        },
      ),
    )
    expect(cf.at(0, 0, { type: 'number', value: 5 })?.color).toBeNull()
    expect(cf.at(0, 0, { type: 'number', value: 5 })?.fill).toEqual({
      kind: 'pattern',
      pattern: 'solid',
      fg: '#000000',
      bg: '#000000',
    })
    const top = cf.at(1, 0, { type: 'number', value: 15 })!
    expect(top.color).toBe('#ff0000')
    expect(top.bold).toBe(true)
    expect(top.fill).toEqual({ kind: 'pattern', pattern: 'solid', fg: '#ffffff', bg: '#ffffff' })
    expect(
      cf.at(2, 0, { type: 'number', value: 10 })?.fill?.kind === 'pattern' &&
        cf.at(2, 0, { type: 'number', value: 10 })?.fill,
    ).toMatchObject({ fg: '#808080' })
  })

  test('cellIs 中空白单元格按空值参与比较，没有缓存值的公式不参与（WPS 实测）', () => {
    const rule = (operator: 'equal' | 'lessThan', formula: string): CfRule => ({
      type: 'cellIs',
      operator,
      formulas: [formula],
      priority: 1,
      stopIfTrue: false,
      dxf: redBold,
    })
    const hit = (r: CfRule, value: Cell['value']) =>
      new ConditionalFormats(
        wb,
        sheetOf(
          {},
          {
            conditionalFormats: [
              { ranges: [{ top: 0, left: 0, bottom: 0, right: 2 }], rules: [r] },
            ],
          },
        ),
      ).at(0, 1, value) !== null
    expect(hit(rule('equal', '$Z$1'), null)).toBe(true)
    expect(hit(rule('equal', '0'), null)).toBe(true)
    expect(hit(rule('equal', '""'), null)).toBe(true)
    expect(hit(rule('lessThan', '5'), null)).toBe(true)
    expect(hit(rule('equal', '" "'), null)).toBe(false)
    expect(hit(rule('equal', '""'), { type: 'number', value: 0 })).toBe(false)
    expect(hit(rule('equal', '$Z$1'), { type: 'formula', value: '=A1' })).toBe(false)
  })

  test('差异样式的填充：图案色缺失为黑色，底色缺失取单元格的纯色填充或白色（WPS 实测）', () => {
    const cf = new ConditionalFormats(wb, sheetOf({}))
    const blue = { kind: 'pattern', pattern: 'solid', fg: '#99ccff', bg: '#99ccff' } as const
    const hatch = { kind: 'pattern', pattern: 'lightUp', fg: null, bg: null } as const
    expect(cf.overlay(hatch, blue)).toEqual({
      kind: 'pattern',
      pattern: 'lightUp',
      fg: '#000000',
      bg: '#99ccff',
    })
    expect(cf.overlay(hatch, null)).toEqual({
      kind: 'pattern',
      pattern: 'lightUp',
      fg: '#000000',
      bg: '#ffffff',
    })
    expect(cf.overlay({ ...hatch, fg: '#ff0000', bg: '#ffff00' }, blue)).toEqual({
      kind: 'pattern',
      pattern: 'lightUp',
      fg: '#ff0000',
      bg: '#ffff00',
    })
    // 只有 fgColor 的纯色差异样式：颜色缺失，取单元格自身的填充色。
    const solidFg = { kind: 'pattern', pattern: 'solid', fg: null, bg: null } as const
    expect(cf.overlay(solidFg, blue)).toEqual(blue)
    expect(cf.overlay(solidFg, null)).toEqual({
      kind: 'pattern',
      pattern: 'solid',
      fg: '#ffffff',
      bg: '#ffffff',
    })
    // 相同输入得到同一对象：绘制按填充对象分组。
    expect(cf.overlay(hatch, blue)).toBe(cf.overlay(hatch, blue))
  })
})

/** 记录上下文的像素缓冲区尺寸。 */
const PIXELS_W = 400
const PIXELS_H = 200

/**
 * 记录绘制调用的上下文；`rects`、`texts` 另按调用顺序保留 `fillRect`、`fillText` 的参数与调用时的填充色。
 * 像素读写作用于白色的 `PIXELS_W × PIXELS_H` 缓冲区 `pixels`（RGBA），区域之外的像素读为白色、写入时丢弃。
 */
class SheetRecorder extends RecordingContext implements PaintContext {
  readonly rects: [string, number, number, number, number][] = []
  readonly texts: [string, number, number][] = []
  readonly pixels = new Uint8ClampedArray(4 * PIXELS_W * PIXELS_H).fill(255)
  getTransform(): Matrix {
    return this.matrix
  }
  getImageData(sx: number, sy: number, sw: number, sh: number): PixelData {
    const data = new Uint8ClampedArray(4 * sw * sh).fill(255)
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const px = sx + x
        const py = sy + y
        if (px < 0 || py < 0 || px >= PIXELS_W || py >= PIXELS_H) continue
        data.set(
          this.pixels.subarray(4 * (py * PIXELS_W + px), 4 * (py * PIXELS_W + px) + 4),
          4 * (y * sw + x),
        )
      }
    return { data, width: sw, height: sh }
  }
  putImageData(img: PixelData, dx: number, dy: number): void {
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const px = dx + x
        const py = dy + y
        if (px < 0 || py < 0 || px >= PIXELS_W || py >= PIXELS_H) continue
        this.pixels.set(
          img.data.subarray(4 * (y * img.width + x), 4 * (y * img.width + x) + 4),
          4 * (py * PIXELS_W + px),
        )
      }
  }
  override fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push([String(this.fillStyle), x, y, w, h])
    super.fillRect(x, y, w, h)
  }
  override fillText(text: string, x: number, y: number): void {
    this.texts.push([text, x, y])
    super.fillText(text, x, y)
  }
}

function recorder(): {
  ctx: SheetRecorder
  rects: SheetRecorder['rects']
  texts: SheetRecorder['texts']
} {
  const ctx = new SheetRecorder()
  return { ctx, rects: ctx.rects, texts: ctx.texts }
}

/** 没有图片、图层只记录创建的绘制资源；`contrast` 为显示器的 ClearType 对比度，省略时显示器不使用 ClearType。 */
function resources(contrast?: number): SheetResources {
  return {
    images: [],
    createCanvas: canvasFactory().create,
    clearType: contrast === undefined ? null : { contrast },
  }
}

/** 画布像素缓冲区中 (x, y) 的 RGB。 */
function rgbAt(ctx: SheetRecorder, x: number, y: number): number[] {
  return Array.from(ctx.pixels.subarray(4 * (y * PIXELS_W + x), 4 * (y * PIXELS_W + x) + 3))
}

describe('绘制', () => {
  test('点阵模式下按点阵逐字填充像素，裁去上升、下降之外的行；粗体按 GDI 加粗；斜体取倾斜的单色字形；取不到单色字形的字用 fillText', () => {
    // 汉字的点阵：2 × 3，第 1 行全着墨，其余只有左列。
    const glyph: BitmapGlyph = {
      width: 2,
      height: 3,
      bearingX: 1,
      bearingY: 2,
      advance: 16,
      pixels: new Uint8Array([1, 1, 1, 0, 1, 0]),
    }
    // 合成斜体的单色字形：1 × 1。
    const oblique: BitmapGlyph = {
      ...glyph,
      width: 1,
      height: 1,
      bearingX: 0,
      bearingY: 1,
      pixels: new Uint8Array([1]),
    }
    const bitmaps: EmbeddedBitmaps = {
      sizes: [16],
      screenMode: (ppem) => ppem === 16,
      glyph: (ppem, id, slanted) => (ppem === 16 && id === 2 ? (slanted ? oblique : glyph) : null),
    }
    const face = fakeFace('点', { cjk: true, integer: true, bitmaps })
    // 下降高度设为 0：基线以下的行全部不绘制。
    const set = new FontSet(
      [{ ...face, vertical: (p) => ({ ...face.vertical(p), descent: 0 }) }],
      [],
    )
    const paint = (st: CellStyle) => {
      const sheet = sheetOf({ A1: str('汉a', 1) }, { maxRow: 1, maxCol: 1 })
      const scene = createScene(workbook(sheet, [style(), st]), sheet, set)
      const r = recorder()
      paintRegion(r.ctx, scene, { x: 0, y: 0, width: 200, height: 40 }, resources())
      return r
    }
    const base = { ...font, name: '点' }
    const plain = paint(style({ font: base }))
    const ink = plain.rects.filter((r) => r[0] === '#000000')
    // 文字起点 x = 3，基线 y = 行高 20 − 下降 0 = 20；点阵第 3 行（y = 20）在基线之下，不绘制。
    expect(ink).toEqual([
      ['#000000', 4, 18, 2, 1],
      ['#000000', 4, 19, 1, 1],
    ])
    // 取不到单色字形的「a」在全角宽度 16 之后以 fillText 绘制。
    expect(plain.texts).toEqual([['a', 19, 20]])
    const bold = paint(style({ font: { ...base, bold: true } })).rects.filter(
      (r) => r[0] === '#000000',
    )
    expect(bold).toEqual([
      ['#000000', 4, 18, 3, 1],
      ['#000000', 4, 19, 2, 1],
    ])
    // 斜体同样不平滑：字体没有斜体字形时取倾斜的单色字形，不取点阵。
    const italic = paint(style({ font: { ...base, italic: true } }))
    expect(italic.rects.filter((r) => r[0] === '#000000')).toEqual([['#000000', 3, 19, 1, 1]])
    expect(italic.texts).toEqual([['a', 19, 20]])
  })

  test('显示器使用 ClearType 时按 ClearType 字形逐字写入画布像素，不调用 fillText；裁去上升、下降之外的行与单元格之外的像素', () => {
    // 字形：第 1 行覆盖 6、(3, 2, 1)，第 2 行（基线之下）覆盖 6。
    const glyph: CoverageGlyph = {
      width: 2,
      height: 2,
      bearingX: 0,
      bearingY: 1,
      coverage: Uint8Array.from([6, 6, 6, 3, 2, 1, 6, 6, 6, 6, 6, 6]),
    }
    const face = fakeFace('清', { cjk: true, integer: true })
    const set = new FontSet(
      [
        {
          ...face,
          vertical: (p) => ({ ...face.vertical(p), descent: 0 }),
          clearType: { glyph: () => glyph },
        },
      ],
      [],
    )
    const sheet = sheetOf({ A1: str('aa', 1) }, { maxRow: 1, maxCol: 1 })
    const scene = createScene(
      workbook(sheet, [style(), style({ font: { ...font, name: '清' } })]),
      sheet,
      set,
    )
    const r = recorder()
    paintRegion(r.ctx, scene, { x: 0, y: 0, width: 200, height: 40 }, resources(1200))
    expect(r.texts).toEqual([])
    // 文字起点 x = 3，前进宽度 8，基线 y = 20；覆盖 (3, 2, 1) 在对比度 1200 下混合为 (144, 182, 219)。
    expect([
      rgbAt(r.ctx, 3, 19),
      rgbAt(r.ctx, 4, 19),
      rgbAt(r.ctx, 11, 19),
      rgbAt(r.ctx, 12, 19),
    ]).toEqual([
      [0, 0, 0],
      [144, 182, 219],
      [0, 0, 0],
      [144, 182, 219],
    ])
    expect([rgbAt(r.ctx, 3, 20), rgbAt(r.ctx, 5, 19)]).toEqual([
      [255, 255, 255],
      [255, 255, 255],
    ])
    // 对比度取自显示器的设置：1000 时解码与编码为线性，覆盖 (3, 2, 1) 为 (128, 170, 212)。
    const linear = recorder()
    paintRegion(linear.ctx, scene, { x: 0, y: 0, width: 200, height: 40 }, resources(1000))
    expect(rgbAt(linear.ctx, 4, 19)).toEqual([128, 170, 212])
    // 显示器不使用 ClearType 时以浏览器字体逐字绘制，不写入画布像素。
    const plain = recorder()
    paintRegion(plain.ctx, scene, { x: 0, y: 0, width: 200, height: 40 }, resources())
    expect(plain.texts).toEqual([
      ['a', 3, 20],
      ['a', 11, 20],
    ])
    expect(rgbAt(plain.ctx, 3, 19)).toEqual([255, 255, 255])
  })

  test.skipIf(process.platform !== 'win32')(
    '楷体 12 磅的数字与 WPS 屏幕显示逐像素相同（对比度 1200）',
    () => {
      // 期望值：对比基准「2025AA企模研究生中科大校赛市场3(1)」第 3 页「初期」D13「706065.00」的墨迹框（WPS 表格，
      // CopyPicture 的位图，系统 ClearType 对比度 1200），每像素 6 位十六进制 RGB。
      const expected = [
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdbdbffffffffffffffffffffffffffffffffffffffffffffffffffdbdbdbffffffffffffffffffffffffffffffffffffdbdbffffffffffffffffffffffffffffffffffffffffffffffffffdbdbdbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdbdbffffffffffffffffffffffffffffffffffffffffffffdbdbffffffffffffffffffffff',
        'ffb66600000000000000000000000000000000000066b6ffffffffffffdb903a000000000000003a66b6dbffffffffffffffffffffffffffffffffb666000066b6ffffffffffffffffffffffffdb903a000000000000003a66b6dbffffffffffffffffffffffffffffffffb666000066b6ffffffffffffffffffffffb6660000000000000000000000000066b6ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdb903a000000000000003a66b6dbffffffffffffffffffffdb903a000000000000003a66b6dbffffffffff',
        'ffffffdbdbdbdbdbdbdbdbdbdbdbdbdbdb903a003a90dbffffffffb66600003a90dbffffffdbb66600003a90dbffffffffffffffffffffffffb66600003a90dbffffffffffffffffffffffb66600003a90dbffffffdbb66600003a90dbffffffffffffffffffffffffb66600003a90dbffffffffffffffffffffffdb903a0066b6dbdbdbdbdbdbdbdbdbdbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb66600003a90dbffffffdbb66600003a90dbffffffffffffb66600003a90dbffffffdbb66600003a90dbffffff',
        'ffffffffffffffffffffffffffffffb666003a90dbffffffffdb903a000066b6ffffffffffffffffb666003a90dbffffffffffffffffffb66600003a90dbffffffffffffffffffffffdb903a000066b6ffffffffffffffffb666003a90dbffffffffffffffffffb66600003a90dbffffffffffffffffffffffffdb903a003a90dbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdb903a000066b6ffffffffffffffffb666003a90dbffffffdb903a000066b6ffffffffffffffffb666003a90dbffff',
        'ffffffffffffffffffffffffffdb903a0066b6ffffffffffffb666000066b6ffffffffffffffffffdb903a0066b6ffffffffffffffb66600003a90b6dbdbdbffffffffffffffffffffb666000066b6ffffffffffffffffffdb903a0066b6ffffffffffffffb66600003a90b6dbdbdbffffffffffffffffffffffb666003a66b6b690906690b6b6dbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb666000066b6ffffffffffffffffffdb903a0066b6ffffffb666000066b6ffffffffffffffffffdb903a0066b6ffff',
        'ffffffffffffffffffffffffb666003a90dbffffffffffffdb903a003a90dbffffffffffffffffffdb903a003a90dbffffffffdb903a00000000003a3a000000003a6690dbffffffdb903a003a90dbffffffffffffffffffdb903a003a90dbffffffffdb903a00000000003a3a000000003a6690dbffffffffdb903a0000003a3a666666663a0000003a66b6ffffffffffffffffffffffffffffffffffffffffffffffffffffffffdb903a003a90dbffffffffffffffffffdb903a003a90dbffdb903a003a90dbffffffffffffffffffdb903a003a90dbff',
        'ffffffffffffffffffffdb903a003a90dbffffffffffffffdb903a003a90dbffffffffffffffffffffb666003a90dbffffffb66600003a90dbffffffffffffdbb6903a000066b6ffdb903a003a90dbffffffffffffffffffffb666003a90dbffffffb66600003a90dbffffffffffffdbb6903a000066b6ffffdbb69090b6ffffffffffffffffffb66600003a90dbffffffffffffffffffffffffffffffffffffffffffffffffffffdb903a003a90dbffffffffffffffffffffb666003a90dbffdb903a003a90dbffffffffffffffffffffb666003a90dbff',
        'ffffffffffffffffffdb903a0066b6ffffffffffffffffffffb666003a90dbffffffffffffffffffdb903a003a90dbffffb666000066b6ffffffffffffffffffffdb903a003a90dbffb666003a90dbffffffffffffffffffdb903a003a90dbffffb666000066b6ffffffffffffffffffffdb903a003a90dbffffffffffffffffffffffffffffffffdb903a0066b6ffffffffffffffffffffffffffffffffffffffffffffffffffffffb666003a90dbffffffffffffffffffdb903a003a90dbffffb666003a90dbffffffffffffffffffdb903a003a90dbff',
        'ffffffffffffffffb666000066b6ffffffffffffffffffffffb666000066b6ffffffffffffffffffdb903a0066b6ffffffb666000066b6ffffffffffffffffffffdb903a003a90dbffb666000066b6ffffffffffffffffffdb903a0066b6ffffffb666000066b6ffffffffffffffffffffdb903a003a90dbffffffdbffffffffffffffffffffffffb666000066b6ffffffffffffffffffffffffffffffffffffffffffffffffffffffb666000066b6ffffffffffffffffffdb903a0066b6ffffffb666000066b6ffffffffffffffffffdb903a0066b6ffff',
        'ffffffffffffffb666000066b6ffffffffffffffffffffffffffb66600003a90dbffffffffffffdb903a003a90dbffffffdb903a003a90dbffffffffffffffffffb666000066b6ffffffb66600003a90dbffffffffffffdb903a003a90dbffffffdb903a003a90dbffffffffffffffffffb666000066b6ffb666000066b6ffffffffffffffffffdb903a003a90dbffffffffffffffffffffffffffffffffffffffffffffffffffffffffb66600003a90dbffffffffffffdb903a003a90dbffffffffb66600003a90dbffffffffffffdb903a003a90dbffff',
        'ffffffffffffb66600003a90dbffffffffffffffffffffffffffffdb903a00003a6690b6b6903a00000066b6ffffffffffffdb903a0000003a90b6b6b6b690663a00003a90dbffffffffffdb903a00003a6690b6b6903a00000066b6ffffffffffffdb903a0000003a90b6b6b6b690663a00003a90dbffffffdb903a00003a6690b6b6b690663a00000066b6ffffffffffffdbb666000066b6dbffffffffffffffffffffffffffffffffffdb903a00003a6690b6b6903a00000066b6ffffffffffffffdb903a00003a6690b6b6903a00000066b6ffffffff',
        'ffffffffffdbb6906690b6dbffffffffffffffffffffffffffffffffffffdbb690663a3a3a3a6690b6dbffffffffffffffffffffffdbb690663a3a3a3a3a3a3a66b6dbffffffffffffffffffffffdbb690663a3a3a3a6690b6dbffffffffffffffffffffffdbb690663a3a3a3a3a3a3a66b6dbffffffffffffffffffdbb6663a3a3a3a3a3a3a66b6dbdbffffffffffffffffffb6663a3a66b6ffffffffffffffffffffffffffffffffffffffffffdbb690663a3a3a3a6690b6dbffffffffffffffffffffffffdbb690663a3a3a3a6690b6dbffffffffffff',
      ]
      const dir = join(process.env.WINDIR ?? 'C:Windows', 'Fonts')
      const kai = loadFace(new Uint8Array(readFileSync(join(dir, 'simkai.ttf'))), '楷体')
      const set = new FontSet([kai], [])
      const sheet = sheetOf({ A1: str('706065.00', 1) }, { maxRow: 1, maxCol: 1 })
      const kaiStyle = style({ font: { ...font, name: '楷体' } })
      const scene = createScene(workbook(sheet, [style(), kaiStyle]), sheet, set)
      const r = recorder()
      paintRegion(r.ctx, scene, { x: 0, y: 0, width: 200, height: 40 }, resources(1200))
      const hex = (x: number, y: number) =>
        rgbAt(r.ctx, x, y)
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')
      // 墨迹框：非白色像素的范围（网格线在第 0 行、第 0 列之外不计）。
      let x0 = Infinity
      let y0 = Infinity
      for (let y = 1; y < 30; y++)
        for (let x = 1; x < 150; x++)
          if (hex(x, y) !== 'ffffff') {
            x0 = Math.min(x0, x)
            y0 = Math.min(y0, y)
          }
      const width = expected[0]!.length / 6
      const actual = expected.map((_, y) =>
        Array.from({ length: width }, (_, x) => hex(x0 + x, y0 + y)).join(''),
      )
      expect(actual).toEqual(expected)
    },
  )

  test('中粗类边框占网格线及其上方或左方 1 像素，粗线以网格线为中心并向两端各延长 1 像素，细线占网格线', () => {
    const edge = (s: BorderLineStyle) => ({ style: s, color: '#123456' })
    const boxed = (s: BorderLineStyle) =>
      style({
        border: {
          left: edge(s),
          right: null,
          top: edge(s),
          bottom: null,
          diagonalUp: null,
          diagonalDown: null,
        },
      })
    const paint = (s: BorderLineStyle) => {
      const sheet = sheetOf({ B2: { value: null, style: 1 } }, { maxRow: 3, maxCol: 3 })
      const scene = createScene(workbook(sheet, [style(), boxed(s)]), sheet, fonts)
      const { ctx, rects } = recorder()
      paintRegion(ctx, scene, { x: 0, y: 0, width: 240, height: 60 }, resources())
      const x = scene.geometry.cols.offset(1)
      const y = scene.geometry.rows.offset(1)
      return { lines: rects.filter((r) => r[0] === '#123456').map((r) => r.slice(1)), x, y }
    }
    const medium = paint('medium')
    expect(medium.lines).toContainEqual([medium.x, medium.y - 1, expect.any(Number), 2])
    expect(medium.lines).toContainEqual([medium.x - 1, medium.y, 2, expect.any(Number)])
    const thick = paint('thick')
    expect(thick.lines).toContainEqual([thick.x - 1, thick.y - 1, expect.any(Number), 3])
    const thin = paint('thin')
    expect(thin.lines).toContainEqual([thin.x, thin.y, expect.any(Number), 1])
  })

  test('虚线图案沿整条线连续，相位以区域起点之后 1 像素为周期起点；粗线两端各延长 1 像素', () => {
    const edge = (s: BorderLineStyle) => ({ style: s, color: '#123456' })
    const topped = (s: BorderLineStyle) =>
      style({
        border: {
          left: null,
          right: null,
          top: edge(s),
          bottom: null,
          diagonalUp: null,
          diagonalDown: null,
        },
      })
    /** B2:C2 上边框所在行的着墨像素（画布坐标）。 */
    const inked = (s: BorderLineStyle, regionX: number, row = 0) => {
      const cell = { value: null, style: 1 }
      const sheet = sheetOf({ B2: cell, C2: cell }, { maxRow: 3, maxCol: 4 })
      const scene = createScene(workbook(sheet, [style(), topped(s)]), sheet, fonts)
      const { ctx, rects } = recorder()
      paintRegion(ctx, scene, { x: regionX, y: 0, width: 240, height: 60 }, resources())
      const y = scene.geometry.rows.offset(1) + row
      const xs = new Set<number>()
      for (const [color, x, ry, w, h] of rects) {
        if (color !== '#123456' || y < ry || y >= ry + h) continue
        for (let i = x; i < x + w; i++) xs.add(i)
      }
      const from = scene.geometry.cols.offset(1) - regionX
      const to = scene.geometry.cols.offset(3) - regionX
      return { xs: [...xs].sort((a, b) => a - b), from, to }
    }
    const expected = (from: number, to: number, on: (p: number) => boolean) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((x) => on((x - 1) % 4))
    const dotted = inked('dotted', 0)
    expect(dotted.xs).toEqual(expected(dotted.from, dotted.to, (p) => p < 2))
    const shifted = inked('dotted', 3)
    expect(shifted.xs).toEqual(expected(shifted.from, shifted.to, (p) => p < 2))
    const dashed = inked('dashed', 0)
    expect(dashed.xs).toEqual(expected(dashed.from, dashed.to, (p) => p < 3))
    const hair = inked('hair', 0)
    expect(hair.xs).toEqual(expected(hair.from, hair.to, (p) => p % 2 === 1))
    const thick = inked('thick', 0)
    expect(thick.xs[0]).toBe(thick.from - 1)
    expect(thick.xs.at(-1)).toBe(thick.to + 1)
    // 斜点划线：上一行为 9、3、3、3 的点划线，下一行各段左移 1 像素并缩短 1 像素。
    const upper = inked('slantDashDot', 0, -1)
    const lower = inked('slantDashDot', 0, 0)
    const phase = (x: number) => (((x - 1) % 18) + 18) % 18
    const upperOn = (p: number) => p < 9 || (p >= 12 && p < 15)
    const lowerOn = (p: number) => p === 17 || p < 9 || (p >= 11 && p < 15)
    expect(upper.xs).toEqual(
      expected(upper.from, upper.to, () => true).filter((x) => upperOn(phase(x))),
    )
    expect(lower.xs).toEqual(
      expected(lower.from, lower.to, () => true).filter((x) => lowerOn(phase(x))),
    )
  })
  test('没有粗体字形时以常规字形在原位与右移 1 像素处各绘制一次；有粗体字形时绘制一次', () => {
    const paint = (set: FontSet) => {
      const sheet = sheetOf({ A1: str('ab', 1) }, { maxRow: 1, maxCol: 1 })
      const st = style({ font: { ...font, bold: true } })
      const scene = createScene(workbook(sheet, [style(), st]), sheet, set)
      const ctx = new SheetRecorder()
      paintRegion(ctx, scene, { x: 0, y: 0, width: 200, height: 40 }, resources())
      return ctx.named('fillText').map((c) => [c.args[0], c.args[1], c.font.includes('bold')])
    }
    expect(paint(new FontSet([fakeFace('西文', { cjk: false })], []))).toEqual([
      ['ab', 3, false],
      ['ab', 4, false],
    ])
    const real = new FontSet(
      [fakeFace('西文', { cjk: false }), fakeFace('西文', { cjk: false, bold: true })],
      [],
    )
    expect(paint(real)).toEqual([['ab', 3, true]])
  })
  test('填充覆盖四周网格线（区域左沿与上沿除外）；与填充相邻的网格线不画', () => {
    const yellow = style({
      fill: { kind: 'pattern', pattern: 'solid', fg: '#ffff00', bg: '#ffff00' },
    })
    const sheet = sheetOf(
      { A1: { value: null, style: 1 }, C3: { value: null, style: 1 } },
      { maxRow: 3, maxCol: 3 },
    )
    const scene = createScene(workbook(sheet, [style(), yellow]), sheet, fonts)
    const { ctx, rects } = recorder()
    paintRegion(ctx, scene, { x: 0, y: 0, width: 240, height: 60 }, resources())
    const w = scene.geometry.cols.size(0)
    const h = scene.geometry.rows.size(0)
    expect(rects).toContainEqual(['#ffff00', 1, 1, w, h])
    expect(rects).toContainEqual(['#ffff00', 2 * w, 2 * h, w + 1, h + 1])
    const grid = rects.filter((r) => r[0] === '#e6e6e6')
    // C3 上沿与左沿的网格线不画；B1 上沿照常绘制。
    expect(grid).not.toContainEqual(['#e6e6e6', 2 * w, 2 * h, w + 1, 1])
    expect(grid).not.toContainEqual(['#e6e6e6', 2 * w, 2 * h, 1, h + 1])
    expect(grid).toContainEqual(['#e6e6e6', w, 0, w + 1, 1])
  })

  test('指定 gridColor 时网格线为该颜色的点线，横线在相对区域左沿的偶数像素着色（WPS 实测）', () => {
    const view = {
      showGridLines: true,
      gridColor: '#ff0000',
      zoom: 100,
      rightToLeft: false,
      frozenRows: 0,
      frozenCols: 0,
      topLeft: { row: 0, col: 0 },
    }
    /** 第 2 行上沿横线与第 2 列左沿竖线的着色像素（画布坐标）。 */
    const inked = (regionX: number, regionY: number) => {
      const sheet = sheetOf({ A1: str('x') }, { maxRow: 3, maxCol: 3, view })
      const scene = createScene(workbook(sheet, [style()]), sheet, fonts)
      const { ctx, rects } = recorder()
      paintRegion(ctx, scene, { x: regionX, y: regionY, width: 200, height: 60 }, resources())
      const y = scene.geometry.rows.offset(1) - regionY
      const x = scene.geometry.cols.offset(1) - regionX
      const xs: number[] = []
      const ys: number[] = []
      for (const [color, rx, ry, w, h] of rects) {
        if (color !== '#ff0000') continue
        expect(w * h).toBe(1)
        if (ry === y) xs.push(rx)
        if (rx === x) ys.push(ry)
      }
      return { xs, ys }
    }
    for (const [rx, ry] of [
      [0, 0],
      [3, 5],
    ] as const) {
      const { xs, ys } = inked(rx, ry)
      expect(xs.length).toBeGreaterThan(20)
      expect(xs.every((x) => x % 2 === 0)).toBe(true)
      expect(ys.length).toBeGreaterThan(5)
      expect(ys.every((y) => y % 2 === 0)).toBe(true)
    }
  })

  test('图案填充以 8×8 像素单元平铺，原点为工作表左上角（WPS 实测）', () => {
    const hatch = style({
      fill: { kind: 'pattern', pattern: 'lightUp', fg: '#000000', bg: '#ffffff' },
    })
    const sheet = sheetOf({ B2: { value: null, style: 1 } }, { maxRow: 3, maxCol: 3 })
    const scene = createScene(workbook(sheet, [style(), hatch]), sheet, fonts)
    const factory = canvasFactory()
    const { ctx, rects } = recorder()
    // 浏览器在 createPattern 时复制图层像素：创建平铺时单元必须已画完（底色 1 次加 16 个点）。
    const drawnAtCreate: number[] = []
    const create = ctx.createPattern.bind(ctx)
    ctx.createPattern = (image, repetition) => {
      drawnAtCreate.push((image as RecordingCanvas).context.named('fillRect').length)
      return create(image, repetition)
    }
    paintRegion(
      ctx,
      scene,
      { x: 10, y: 4, width: 240, height: 60 },
      {
        images: [],
        createCanvas: factory.create,
        clearType: null,
      },
    )
    const tile = factory.created.find((c) => c.width === 8 && c.height === 8)!
    const ink = tile.context
      .named('fillRect')
      .filter((c) => c.fillStyle === '#000000')
      .map((c) => [c.args[0], c.args[1]])
    // lightUp：每行一点，x + y ≡ 3（模 4）。
    expect(ink).toEqual(
      Array.from({ length: 8 }, (_, y) => [0, 1].map((k) => [((3 - y) & 3) + 4 * k, y]))
        .flat()
        .sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!),
    )
    const filled = rects.find((r) => r[0].includes('object'))
    expect(filled).toBeDefined()
    const pattern = ctx.named('fillRect').find((c) => typeof c.fillStyle === 'object')!
      .fillStyle as { transform: { e: number; f: number } }
    expect([pattern.transform.e, pattern.transform.f]).toEqual([-10, -4])
    expect(drawnAtCreate).toEqual([17])
  })

  test('缩进一级为 2·MDW + 2·⌈MDW/12⌉ 像素，与单元格字体无关（WPS 实测）', () => {
    expect([6, 7, 8, 9, 12, 13, 16, 19, 24, 32].map(indentPixels)).toEqual([
      14, 16, 18, 20, 26, 30, 36, 42, 52, 70,
    ])
    const indented = style({
      alignment: {
        horizontal: 'left',
        vertical: 'bottom',
        wrap: false,
        shrink: false,
        rotation: 0,
        indent: 2,
      },
    })
    const sheet = sheetOf({ A1: str('ab', 1) }, { maxRow: 1, maxCol: 1 })
    const scene = createScene(workbook(sheet, [style(), indented]), sheet, fonts)
    const { ctx, texts } = recorder()
    paintRegion(ctx, scene, { x: 0, y: 0, width: 200, height: 40 }, resources())
    const pad = textPadding(font, fonts).left
    expect(texts[0]?.[1]).toBe(pad + 2 * indentPixels(scene.geometry.mdw))
  })

  test('两种填充之间的线归区域内首次出现较晚的填充，与两格的左右上下位置无关', () => {
    const solid = (c: string) =>
      style({ fill: { kind: 'pattern', pattern: 'solid', fg: c, bg: c } })
    const paint = (cells: Record<string, Cell>) => {
      const sheet = sheetOf(cells, { maxRow: 4, maxCol: 4 })
      const scene = createScene(
        workbook(sheet, [style(), solid('#ff0000'), solid('#0000ff')]),
        sheet,
        fonts,
      )
      const { ctx, rects } = recorder()
      paintRegion(ctx, scene, { x: 0, y: 0, width: 300, height: 80 }, resources())
      const w = scene.geometry.cols.size(0)
      const h = scene.geometry.rows.size(0)
      return { order: rects.filter((r) => r[0] !== '#ffffff' && r[0] !== '#e6e6e6'), w, h }
    }
    const red = { value: null, style: 1 }
    const blue = { value: null, style: 2 }
    // 红色先出现：蓝色在后绘制，B2|C2 与 B2/B3 两条线都归蓝色。
    const a = paint({ B2: red, C2: blue, B3: blue })
    expect(a.order).toEqual([
      ['#ff0000', a.w, a.h, a.w + 1, a.h + 1],
      ['#0000ff', 2 * a.w, a.h, a.w + 1, a.h + 1],
      ['#0000ff', a.w, 2 * a.h, a.w + 1, a.h + 1],
    ])
    // A1 的蓝色先出现：红色在后绘制，同样两条线归红色。
    const b = paint({ A1: blue, B2: red, C2: blue, B3: blue })
    expect(b.order.map((r) => r[0])).toEqual(['#0000ff', '#0000ff', '#0000ff', '#ff0000'])
  })
  test('不显示网格线时只有白底；文字与筛选按钮', () => {
    const sheet = sheetOf(
      { A1: str('标题') },
      {
        view: {
          showGridLines: false,
          gridColor: null,
          zoom: 100,
          rightToLeft: false,
          frozenRows: 0,
          frozenCols: 0,
          topLeft: { row: 0, col: 0 },
        },
        autoFilter: { top: 0, left: 0, bottom: 3, right: 1 },
      },
    )
    const scene = createScene(workbook(sheet), sheet, fonts)
    const { ctx, rects, texts } = recorder()
    paintRegion(ctx, scene, { x: 0, y: 0, width: 300, height: 100 }, resources())
    expect(rects.some((r) => r[0] === '#e6e6e6')).toBe(false)
    expect(texts.map((t) => t[0])).toEqual(['标题'])
    expect(rects.filter((r) => r[0] === '#dbdbdb').map((r) => [r[3], r[4]])).toEqual([
      [15, 15],
      [15, 15],
    ])
  })
})

const EMU = 9525

function framePx(x: number, y: number, width: number, height: number, rotation = 0): Frame {
  return {
    x: x * EMU,
    y: y * EMU,
    width: width * EMU,
    height: height * EMU,
    rotation,
    flipH: false,
    flipV: false,
  }
}

/** 形状框换算为像素后的位置与尺寸，保留 6 位小数。 */
function inPx(f: Frame): number[] {
  return [f.x, f.y, f.width, f.height].map((v) => Math.round((v / EMU) * 1e6) / 1e6)
}

const RED = { kind: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } } as const

function rectShape(frame: Frame, text: TextBody | null = null): ShapeNode {
  return {
    kind: 'shape',
    frame,
    geometry: { kind: 'preset', name: 'rect', adjust: [] },
    fill: RED,
    line: null,
    effects: [],
    text,
  }
}

function absolute(x: number, y: number, width: number, height: number): DrawingAnchor {
  return { kind: 'absolute', x: x * EMU, y: y * EMU, width: width * EMU, height: height * EMU }
}

function textBody(text: string): TextBody {
  const style: RunStyle = {
    latin: '西文',
    ea: '宋体',
    cs: '',
    sym: '',
    size: 12,
    bold: false,
    italic: false,
    underline: 'none',
    strike: 'noStrike',
    baseline: 0,
    caps: 'none',
    spacing: 0,
    kern: 0,
    fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
    highlight: null,
    outline: null,
    effects: [],
    lang: 'zh-CN',
  }
  return {
    body: {
      rotation: 0,
      vertical: 'horz',
      wrap: true,
      insetLeft: 91440,
      insetTop: 45720,
      insetRight: 91440,
      insetBottom: 45720,
      anchor: 't',
      anchorCenter: false,
      columns: 1,
      columnSpacing: 0,
      rtlColumns: false,
      upright: false,
      autofit: { kind: 'none' },
    },
    paragraphs: [
      {
        level: 0,
        align: 'l',
        marginLeft: 0,
        marginRight: 0,
        indent: 0,
        rtl: false,
        defaultTabSize: 914400,
        tabs: [],
        lineSpacing: { unit: 'percent', value: 1 },
        spaceBefore: { unit: 'points', value: 0 },
        spaceAfter: { unit: 'points', value: 0 },
        eaLineBreak: true,
        latinLineBreak: false,
        hangingPunctuation: false,
        fontAlign: 'auto',
        bullet: { kind: 'none' },
        runs: [{ kind: 'text', text, style, link: null }],
        end: style,
      },
    ],
  }
}

function image(anchor: DrawingAnchor, order: number): SheetImage {
  return {
    anchor,
    order,
    contentType: 'image/png',
    bytes: new Uint8Array(),
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  }
}

const BITMAP: PaintPicture = {
  kind: 'bitmap',
  bitmap: { width: 10, height: 10 },
  resolution: SCREEN_RESOLUTION,
}

describe('形状', () => {
  test('顶层形状框对齐锚点矩形；旋转接近 90° 时按互换后的宽高对齐；组合内的子形状按同一映射换算', () => {
    const rect = (x: number, y: number, width: number, height: number) => () => ({
      x,
      y,
      width,
      height,
    })
    const plain = placeShape(
      { anchor: absolute(0, 0, 1, 1), order: 0, shape: rectShape(framePx(1000, 500, 100, 50)) },
      rect(10, 20, 200, 50),
    )
    expect(inPx(plain.node.frame)).toEqual([10, 20, 200, 50])
    // 锚点为旋转后所占的矩形 50 × 100：形状框保持 100 × 50，中心对齐锚点中心。
    const turned = placeShape(
      { anchor: absolute(0, 0, 1, 1), order: 0, shape: rectShape(framePx(0, 0, 100, 50, 90)) },
      rect(0, 0, 50, 100),
    )
    expect(inPx(turned.node.frame)).toEqual([-25, 25, 100, 50])
    expect(turned.node.frame.rotation).toBe(90)
    const b = turned.bounds
    expect([b.x, b.y, b.width, b.height].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
      -2, -2, 54, 104,
    ])
    const group: ShapeNode = {
      kind: 'group',
      frame: framePx(0, 0, 200, 100),
      effects: [],
      children: [rectShape(framePx(100, 0, 100, 100))],
    }
    const placed = placeShape(
      { anchor: absolute(0, 0, 1, 1), order: 0, shape: group },
      rect(50, 0, 100, 50),
    )
    if (placed.node.kind !== 'group') throw new Error('应为组合')
    expect(inPx(placed.node.frame)).toEqual([50, 0, 100, 50])
    expect(inPx(placed.node.children[0]!.frame)).toEqual([100, 0, 50, 50])
  })

  test('图片与形状按锚点序号交错绘制；形状以调用方的变换为基准并按区域平移；区域外的形状不绘制', () => {
    const shape: SheetShape = {
      anchor: absolute(100, 20, 40, 30),
      order: 1,
      shape: rectShape(framePx(0, 0, 40, 30)),
    }
    const sheet = sheetOf(
      {},
      {
        images: [image(absolute(60, 0, 10, 10), 0), image(absolute(70, 0, 10, 10), 2)],
        shapes: [shape],
      },
    )
    const scene = createScene(workbook(sheet), sheet, fonts)
    const res: SheetResources = {
      images: [BITMAP, BITMAP],
      createCanvas: canvasFactory().create,
      clearType: null,
    }
    const ctx = new SheetRecorder()
    ctx.setTransform(2, 0, 0, 2, 0, 0)
    paintRegion(ctx, scene, { x: 50, y: 0, width: 200, height: 100 }, res, 10, 0)
    const order = ctx.calls.filter((c) => c.name === 'drawImage' || c.name === 'fill')
    expect(order.map((c) => c.name)).toEqual(['drawImage', 'fill', 'drawImage'])
    // 工作表 x = 100 的形状：区域起点 50 绘制在画布 10 处，再乘以调用方的 2 倍缩放。
    const m = order[1]!.matrix
    expect([m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([
      2, 0, 0, 2, 120, 40,
    ])
    expect(order[0]!.args.slice(5)).toEqual([20, 0, 10, 10])
    expect(ctx.matrix).toEqual({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 })

    const far = new SheetRecorder()
    paintRegion(far, scene, { x: 400, y: 0, width: 100, height: 100 }, res)
    expect(far.named('fill')).toHaveLength(0)
  })

  test('图片按共用图片接口绘制：位图以 medium 插值按裁剪比例绘制，图元文件在设备坐标中回放并以工作表字体绘制文字', () => {
    // 字体名不在字体集中的「A」：按缺少字体时的字体（回退字体宋体）绘制。
    const wmf = placeableWmf([
      [0x02fb, -20 & 0xffff, 0, 0, 0, 400, 0, 0, 0, 0, 0x6556, 0x6472, 0x6e61, 0x0061],
      [0x012d, 0],
      [0x0a32, 0, 20, 1, 0, 0x41, 12],
    ])
    const sheet = sheetOf(
      {},
      {
        images: [
          {
            ...image(absolute(10, 0, 20, 10), 0),
            crop: { left: 0.2, top: 0, right: 0.3, bottom: 0 },
          },
          { ...image(absolute(40, 0, 100, 50), 1), contentType: 'image/x-wmf', bytes: wmf },
        ],
      },
    )
    const res: SheetResources = {
      images: [BITMAP, { kind: 'metafile', metafile: readMetafile(wmf)!, images: [] }],
      createCanvas: canvasFactory().create,
      clearType: null,
    }
    const ctx = new SheetRecorder() as SheetRecorder & { imageSmoothingQuality: string }
    ctx.imageSmoothingQuality = 'low'
    ctx.setTransform(2, 0, 0, 2, 0, 0)
    paintRegion(
      ctx,
      createScene(workbook(sheet), sheet, fonts),
      { x: 0, y: 0, width: 200, height: 100 },
      res,
    )
    expect(ctx.named('drawImage').map((c) => c.args.slice(1))).toEqual([
      [2, 0, 5, 10, 10, 0, 20, 10],
    ])
    expect(ctx.imageSmoothingQuality).toBe('medium')
    const text = ctx.named('fillText').filter((c) => c.font.includes('"宋体"'))
    expect(text.map((c) => c.args[0])).toEqual(['A'])
    expect(text[0]!.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  })

  test('冻结窗格：跨越冻结线的形状在四块中各绘制一次，可滚动的块随滚动量平移', () => {
    const view = {
      showGridLines: true,
      gridColor: null,
      zoom: 100,
      rightToLeft: false,
      frozenRows: 1,
      frozenCols: 1,
      topLeft: { row: 1, col: 1 },
    }
    const probe = sheetOf({}, { view })
    const g = createScene(workbook(probe), probe, fonts).geometry
    const w = g.cols.offset(2)
    const h = g.rows.offset(2)
    const sheet = sheetOf(
      {},
      {
        view,
        shapes: [{ anchor: absolute(0, 0, w, h), order: 0, shape: rectShape(framePx(0, 0, w, h)) }],
      },
    )
    const scene = createScene(workbook(sheet), sheet, fonts)
    const ctx = new SheetRecorder()
    paintView(ctx, scene, { scrollX: 30, scrollY: 0, width: 400, height: 300 }, resources())
    const offsets = ctx.named('fill').map((c) => Math.round(c.matrix.e))
    expect(offsets.sort((a, b) => a - b)).toEqual([-30, -30, 0, 0])
  })

  test('形状文字按字体集排版绘制；字体集为空时形状照常绘制、文字不绘制', () => {
    const shape: SheetShape = {
      anchor: absolute(0, 0, 100, 40),
      order: 0,
      shape: rectShape(framePx(0, 0, 100, 40), textBody('汉字')),
    }
    const sheet = sheetOf({}, { shapes: [shape] })
    const res: SheetResources = {
      images: [],
      createCanvas: canvasFactory().create,
      clearType: null,
    }
    const ctx = new SheetRecorder()
    paintRegion(
      ctx,
      createScene(workbook(sheet), sheet, fonts),
      { x: 0, y: 0, width: 200, height: 100 },
      res,
    )
    const glyphs = ctx.named('fillText').filter((c) => c.font.includes('"宋体"'))
    expect(glyphs.map((c) => c.args[0])).toEqual(['汉', '字'])

    const bare = new SheetRecorder()
    const empty = new FontSet([], [])
    paintRegion(
      bare,
      createScene(workbook(sheet), sheet, empty),
      { x: 0, y: 0, width: 200, height: 100 },
      res,
    )
    expect(bare.named('fill')).toHaveLength(1)
    expect(bare.named('fillText')).toHaveLength(0)
  })

  /** 每个字形为一行 20 像素、原点左侧 10 像素起、覆盖 (3, 2, 1) 的 ClearType 字形；只有宋体带 ClearType 字形。 */
  const clearTypeFonts = () => {
    const glyph: CoverageGlyph = {
      width: 20,
      height: 1,
      bearingX: -10,
      bearingY: 1,
      coverage: Uint8Array.from({ length: 60 }, (_, i) => 3 - (i % 3)),
    }
    return new FontSet(
      [
        fakeFace('西文', { cjk: false }),
        { ...fakeFace('宋体', { cjk: true }), clearType: { glyph: () => glyph } },
      ],
      ['宋体'],
    )
  }
  /** 画布像素缓冲区中各行混合为 (144, 182, 219)（黑字在对比度 1200 下覆盖 (3, 2, 1) 的结果）的像素横坐标。 */
  const blended = (ctx: SheetRecorder) => {
    const out: number[] = []
    for (let y = 0; y < PIXELS_H; y++)
      for (let x = 0; x < PIXELS_W; x++) if (rgbAt(ctx, x, y).join() === '144,182,219') out.push(x)
    return out
  }

  /** 原始失败形状：WPS 表格的形状文字为 GDI 的 ClearType 绘制，此前一律以浏览器字体（`fillText`）绘制。 */
  test('显示器使用 ClearType 时形状文字按 ClearType 字形写入画布像素，不调用 fillText；像素不写到绘制区域之外', () => {
    const shape: SheetShape = {
      anchor: absolute(0, 0, 100, 40),
      order: 0,
      shape: rectShape(framePx(0, 0, 100, 40), textBody('汉')),
    }
    const sheet = sheetOf({}, { shapes: [shape] })
    const scene = createScene(workbook(sheet), sheet, clearTypeFonts())
    const on = recorder()
    paintRegion(on.ctx, scene, { x: 0, y: 0, width: 200, height: 100 }, resources(1200))
    expect(on.texts).toEqual([])
    // 文字起点为左边距 9.6 像素取整后的 10，字形覆盖 [0, 20)。
    expect(blended(on.ctx)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    // 区域自工作表 x = 5 起画在画布 x = 50 处：字形覆盖画布 [45, 65)，区域左沿之外的 [45, 50) 不写入。
    const shifted = recorder()
    paintRegion(shifted.ctx, scene, { x: 5, y: 0, width: 100, height: 100 }, resources(1200), 50)
    expect(blended(shifted.ctx)).toEqual(Array.from({ length: 15 }, (_, i) => 50 + i))
    const off = recorder()
    paintRegion(off.ctx, scene, { x: 0, y: 0, width: 200, height: 100 }, resources())
    expect(off.texts.map((t) => t[0])).toEqual(['汉'])
    expect(blended(off.ctx)).toEqual([])
  })

  /** 原始失败形状：WPS 表格的图表文字为 GDI 的 ClearType 绘制，此前一律以浏览器字体（`fillText`）绘制。 */
  test('显示器使用 ClearType 时图表文字按 ClearType 字形写入画布像素，不调用 fillText', () => {
    const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    const xml =
      `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r>` +
      '<a:rPr lang="zh-CN" sz="1400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="宋体"/>' +
      '<a:ea typeface="宋体"/></a:rPr><a:t>汉</a:t></a:r></a:p>' +
      '</c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>' +
      '<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="1"/>' +
      '<c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser></c:pieChart></c:plotArea></c:chart></c:chartSpace>'
    const rels = { source: '', list: [], byId: () => null, ofKind: () => [], part: () => null }
    const chart = resolveChart(readChart(xml, rels), {
      theme: EMPTY_THEME,
      colors: { scheme: EMPTY_THEME.colors, map: DEFAULT_COLOR_MAP },
      host: 'sheet',
      cells: null,
    })
    if (chart === null) throw new Error('图表不支持')
    const sheet = sheetOf({}, { charts: [{ anchor: absolute(0, 0, 300, 180), order: 0, chart }] })
    const scene = createScene(workbook(sheet), sheet, clearTypeFonts())
    const on = recorder()
    paintRegion(on.ctx, scene, { x: 0, y: 0, width: 300, height: 180 }, resources(1200))
    expect(on.texts).toEqual([])
    expect(blended(on.ctx)).toHaveLength(20)
    const off = recorder()
    paintRegion(off.ctx, scene, { x: 0, y: 0, width: 300, height: 180 }, resources())
    expect(off.texts.map((t) => t[0])).toEqual(['汉'])
    expect(blended(off.ctx)).toEqual([])
  })

  test('形状文字的单倍行高为字号的 1.296 倍，与字体无关（演示文稿为 1.2 倍）', () => {
    const one = textBody('汉字')
    const p = one.paragraphs[0]!
    const big = { ...p, runs: p.runs.map((r) => ({ ...r, style: { ...r.style, size: 20 } })) }
    const text: TextBody = { ...one, paragraphs: [big, big, big] }
    const sheet = sheetOf({})
    const faces = shapeFaces(workbook(sheet), fonts, null)!
    const tops = layoutBody(text, 200, { faces, slideNumber: null }).paragraphs.map((q) => q.y)
    expect(tops[1]! - tops[0]!).toBeCloseTo(1.296 * 20, 6)
    expect(tops[2]! - tops[1]!).toBeCloseTo(1.296 * 20, 6)
    const song = fonts.face('宋体', false, false)!
    const slideFont = { face: song.text, family: song.family, bold: false, italic: false }
    const source = { face: () => slideFont, fallback: slideFont }
    const slide = layoutBody(text, 200, { faces: new FaceCache(source), slideNumber: null })
    expect(slide.paragraphs[1]!.y - slide.paragraphs[0]!.y).toBeCloseTo(1.2 * 20, 6)
  })
})
