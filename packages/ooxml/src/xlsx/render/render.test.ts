/**
 * 覆盖：`axis.ts`（偏移、区段与二分查找）、`fonts.ts`（字体链回退、合成粗体加宽、逐字分段、整数前进宽度）、
 * `geometry.ts`（最大数字宽度、列宽与行高换算、按内容推算行高、未写出单元格按行样式与列样式取行高、标准行高、
 * 默认行高的 customHeight、含相邻行的边框增量）、
 * `text.ts`（自动换行、单行行高 `lineBox`、自动换行各行按实际使用的字体取行高）、
 * `cell-text.ts`（「常规」对齐、溢出、`#` 填充、常规格式按宽度取舍、填充对齐、分散对齐、旋转、居中的行位置）、
 * `conditional.ts` 与 `../formula.ts`（条件格式规则与公式求值）、`painter.ts`（以记录调用的上下文检查
 * 网格线与填充的覆盖规则、文字与筛选按钮、点阵绘制与逐字定位、绘图对象的上下次序、冻结窗格各块的平移、
 * 区域外的形状）、`shapes.ts`（锚点换算、旋转接近 90° 时的宽高互换、组合内的换算、绘制范围、形状文字的字体与单倍行高）。
 * Bun 中没有 Canvas，像素结果由对比基准验证。
 * 「本机字体的单行行高」读取 Windows 字体目录中的真实文件，其他平台跳过；期望值取自 WPS 实测。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Matrix, PaintImage } from '../../drawingml/paint/context.ts'
import { canvasFactory, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import type { Frame } from '../../drawingml/shape/model.ts'
import { layoutBody } from '../../drawingml/text/body.ts'
import { FaceCache } from '../../drawingml/text/fonts.ts'
import type { RunStyle, TextBody } from '../../drawingml/text/model.ts'
import {
  type BitmapGlyph,
  type EmbeddedBitmaps,
  extractFace,
  type FontMetrics,
} from '../../font/index.ts'
import { canEvaluate, evaluateFormula } from '../formula.ts'
import type {
  BorderLineStyle,
  Cell,
  CellStyle,
  CfRule,
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
import { FontSet, type LoadedFace, loadFace, syntheticBoldExtra } from './fonts.ts'
import {
  buildGeometry,
  columnPixels,
  defaultColumnPixels,
  fontLineHeight,
  maxDigitWidth,
  rowPixels,
  standardRowHeight,
} from './geometry.ts'
import {
  createScene,
  type PaintContext,
  paintRegion,
  paintView,
  type SheetResources,
} from './painter.ts'
import { placeShape, shapeFaces } from './shapes.ts'
import { lineBox, lineMetrics, makeRun, wrappedLineMetrics, wrapRuns } from './text.ts'

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

function workbook(sheet: Worksheet, styles: CellStyle[] = [style()]): Workbook {
  return {
    sheets: [sheet],
    styles,
    dxfs: [
      {
        bold: true,
        italic: null,
        strike: null,
        underline: null,
        color: '#ff0000',
        fill: null,
        border: null,
        numFmt: null,
      },
    ],
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
    },
    merges: [],
    view: {
      showGridLines: true,
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
})

describe('行高与列宽', () => {
  test('最大数字宽度按整数像素字号取整，列宽按 Excel 公式换算', () => {
    // 11 磅为 15 像素字号，数字半角 7.5 像素，四舍五入为 8。
    expect(maxDigitWidth({ ...font, size: 11 }, fonts)).toBe(8)
    expect(columnPixels(9.140625, 7)).toBe(64)
    expect(columnPixels(9, 8)).toBe(72)
    expect(columnPixels(102.4140625, 8)).toBe(819)
    expect(
      defaultColumnPixels(
        sheetOf(
          {},
          {
            format: {
              defaultRowHeight: 15,
              zeroHeight: false,
              customHeight: false,
              defaultColWidth: null,
              baseColWidth: 8,
            },
          },
        ),
        7,
      ),
    ).toBe(64)
    expect(rowPixels(26)).toBe(34)
    expect(rowPixels(13.5)).toBe(18)
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

  test('默认行高带 customHeight 的工作表：没有自定义行高的行不按内容推算', () => {
    const big = style({ font: sized(20) })
    const sheet = sheetOf(
      { A1: str('x', 1) },
      {
        format: {
          defaultRowHeight: 13.5,
          zeroHeight: false,
          customHeight: true,
          defaultColWidth: 10,
          baseColWidth: 8,
        },
        rows: new Map([[0, { height: 30, custom: false, hidden: false, style: null }]]),
      },
    )
    expect(buildGeometry(workbook(sheet, [style(), big]), sheet, fonts).rows.size(0)).toBe(18)
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

function layout(cell: Cell, st: CellStyle, b: CellBox) {
  const wb = workbook(sheetOf({}), [st])
  return layoutCell(
    {
      content: cellContent(cell.value!, st.numFmt, wb),
      alignment: st.alignment,
      font: st.font,
      colorOverride: null,
      fonts,
      indentUnit: 24,
    },
    b,
  )
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
  test('会计格式：填充字符之前靠左，之后靠右', () => {
    const acc = style({ numFmt: '_ * #,##0_ ;_ * \\-#,##0_ ;_ * "-"_ ;_ @_ ' })
    const l = layout(num(1234), acc, box(0, 100))!
    const digits = l.fragments.find((f) => f.text === '1,234')!
    // 右侧留出一个空格（8 像素）的位置。
    expect(digits.x + digits.width).toBe(100 - 2 - 8)
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
        dxf: 0,
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
        dxf: 0,
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
})

/** 记录绘制调用的上下文；`rects`、`texts` 另按调用顺序保留 `fillRect`、`fillText` 的参数与调用时的填充色。 */
class SheetRecorder extends RecordingContext implements PaintContext {
  readonly rects: [string, number, number, number, number][] = []
  readonly texts: [string, number, number][] = []
  getTransform(): Matrix {
    return this.matrix
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

/** 没有图片、图层只记录创建的绘制资源。 */
function resources(): SheetResources {
  return { images: [], createCanvas: canvasFactory().create }
}

describe('绘制', () => {
  test('点阵模式下按点阵逐字填充像素，裁去上升、下降之外的行；粗体按 GDI 加粗；斜体与没有点阵的字形用 fillText', () => {
    // 汉字的点阵：2 × 3，第 1 行全着墨，其余只有左列。
    const glyph: BitmapGlyph = {
      width: 2,
      height: 3,
      bearingX: 1,
      bearingY: 2,
      advance: 16,
      pixels: new Uint8Array([1, 1, 1, 0, 1, 0]),
    }
    const bitmaps: EmbeddedBitmaps = {
      sizes: [16],
      screenMode: (ppem, italic) => ppem === 16 && !italic,
      glyph: (ppem, id) => (ppem === 16 && id === 2 ? glyph : null),
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
    // 没有点阵的「a」在全角宽度 16 之后以 fillText 绘制。
    expect(plain.texts).toEqual([['a', 19, 20]])
    const bold = paint(style({ font: { ...base, bold: true } })).rects.filter(
      (r) => r[0] === '#000000',
    )
    expect(bold).toEqual([
      ['#000000', 4, 18, 3, 1],
      ['#000000', 4, 19, 2, 1],
    ])
    const italic = paint(style({ font: { ...base, italic: true } }))
    expect(italic.rects.some((r) => r[0] === '#000000')).toBe(false)
    // 斜体不用点阵；字体有整数前进宽度，逐字绘制在排版位置上。
    expect(italic.texts).toEqual([
      ['汉', 3, 20],
      ['a', 19, 20],
    ])
  })

  test('填充覆盖右侧与下侧网格线；与填充相邻的网格线不画', () => {
    const yellow = style({
      fill: { kind: 'pattern', pattern: 'solid', fg: '#ffff00', bg: '#ffff00' },
    })
    const sheet = sheetOf({ B2: { value: null, style: 1 } }, { maxRow: 3, maxCol: 3 })
    const scene = createScene(workbook(sheet, [style(), yellow]), sheet, fonts)
    const { ctx, rects } = recorder()
    paintRegion(ctx, scene, { x: 0, y: 0, width: 240, height: 60 }, resources())
    const w = scene.geometry.cols.size(0)
    const h = scene.geometry.rows.size(0)
    expect(rects).toContainEqual(['#ffff00', w + 1, h + 1, w, h])
    const grid = rects.filter((r) => r[0] === '#e6e6e6')
    // B2 上沿与左沿的网格线不画；A1 上沿照常绘制。
    expect(grid).not.toContainEqual(['#e6e6e6', w, h, w + 1, 1])
    expect(grid).not.toContainEqual(['#e6e6e6', w, h, 1, h + 1])
    expect(grid).toContainEqual(['#e6e6e6', 0, 0, w + 1, 1])
  })
  test('不显示网格线时只有白底；文字与筛选按钮', () => {
    const sheet = sheetOf(
      { A1: str('标题') },
      {
        view: {
          showGridLines: false,
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

const BITMAP: PaintImage = { width: 10, height: 10 }

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
    const res: SheetResources = { images: [BITMAP, BITMAP], createCanvas: canvasFactory().create }
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

  test('冻结窗格：跨越冻结线的形状在四块中各绘制一次，可滚动的块随滚动量平移', () => {
    const view = {
      showGridLines: true,
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
    paintView(
      ctx,
      scene,
      { scrollX: 30, scrollY: 0, width: 400, height: 300 },
      {
        images: [],
        createCanvas: canvasFactory().create,
      },
    )
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
    const res: SheetResources = { images: [], createCanvas: canvasFactory().create }
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

  test('形状文字的单倍行高为字号的 1.296 倍，与字体无关（演示文稿为 1.21 倍）', () => {
    const one = textBody('汉字')
    const p = one.paragraphs[0]!
    const big = { ...p, runs: p.runs.map((r) => ({ ...r, style: { ...r.style, size: 20 } })) }
    const text: TextBody = { ...one, paragraphs: [big, big, big] }
    const sheet = sheetOf({})
    const faces = shapeFaces(workbook(sheet), fonts)!
    const tops = layoutBody(text, 200, { faces, slideNumber: null }).paragraphs.map((q) => q.y)
    expect(tops[1]! - tops[0]!).toBeCloseTo(1.296 * 20, 6)
    expect(tops[2]! - tops[1]!).toBeCloseTo(1.296 * 20, 6)
    const song = fonts.face('宋体', false, false)!
    const slideFont = { face: song.text, family: song.family, bold: false, italic: false }
    const source = { face: () => slideFont, fallback: slideFont }
    const slide = layoutBody(text, 200, { faces: new FaceCache(source), slideNumber: null })
    expect(slide.paragraphs[1]!.y - slide.paragraphs[0]!.y).toBeCloseTo(1.21 * 20, 6)
  })
})
