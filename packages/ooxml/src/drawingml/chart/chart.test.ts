/**
 * 覆盖范围：`scale.ts`（自动范围、主要单位、指定端点、刻度，数据取自 WPS 校准文件）、`../theme.ts` 读取主题覆盖、`read.ts` 与 `resolve.ts`（缓存数据、
 * 缺省样式、自动颜色、标题与数据标签的样式规则、主题东亚字体为空时的文种字体、垂直线与趋势线、不支持的内容、按引用从单元格取值）、
 * `layout.ts`（百分比取整、数值轴与散点图 x 轴标签的格式、竖直轴区间数、分类标签旋转、图例与绘图区位置、趋势线的图例项、次坐标轴、
 * 坐标轴标题、日期轴的单位数）、`date-axis.ts`（基本单位推定、自动主要单位、标签日期）、`pie3d.ts`（三维饼图的直径与投影）、
 * `paint.ts`（绘制入口不抛错且画出系列，垂直线与趋势线，三维饼图，数据标签的自定义文字与手动位置）；`../text/fonts.ts` 的 `FaceCache.glyphs` 与 `../text/body.ts`
 * 的点阵绘制；以及 `../../pptx/` 与 `../../xlsx/` 中图表的接入（图形框引用图表部件、主题覆盖、能力边界计数、
 * `../../xlsx/parse/chart-cells.ts` 的引用解析）。
 */

import { describe, expect, test } from 'bun:test'
import { parsePptx } from '../../pptx/load.ts'
import { buildPptx, buildZip, slideXml, xfrm } from '../../pptx/test-helper.ts'
import type { TextFace } from '../../text/index.ts'
import { parseXlsx } from '../../xlsx/parse/workbook.ts'
import { colorToCss, DEFAULT_COLOR_MAP, parseHexColor } from '../color.ts'
import { canvasFactory, RecordingContext } from '../paint/test-helper.ts'
import { layoutBody, paintBody } from '../text/body.ts'
import { FaceCache, type ScreenText, SINGLE_LINE } from '../text/fonts.ts'
import type { RunStyle } from '../text/model.ts'
import { EMPTY_THEME, parseTheme } from '../theme.ts'
import { autoBase, autoStep, dateLabels, dateScale, type TimeUnit, unitIndex } from './date-axis.ts'
import { labelBody, layoutChart, measure, roundPercents } from './layout.ts'
import type { Chart } from './model.ts'
import { paintChart } from './paint.ts'
import { pieGeometry, project } from './pie3d.ts'
import { readChart } from './read.ts'
import { autoColor, type ChartScope, resolveChart } from './resolve.ts'
import { autoRange, niceUnit, ticks, valueScale } from './scale.ts'

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const THEME_XML = `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="${A}" name="t"><a:themeElements>
<a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`

const THEME = parseTheme(THEME_XML)

test('parseTheme 读取图表的主题覆盖：三种方案直接位于根元素 themeOverride 之下', () => {
  const override = parseTheme(
    `<a:themeOverride xmlns:a="${A}"><a:clrScheme name="c"><a:accent1><a:srgbClr val="FF8D41"/></a:accent1></a:clrScheme>` +
      '<a:fontScheme name="f"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="微软雅黑"/></a:minorFont></a:fontScheme>' +
      '</a:themeOverride>',
  )
  expect(override.colors.accent1).toEqual(parseHexColor('FF8D41'))
  expect(override.fonts.minor.latin).toBe('微软雅黑')
})
const SCOPE: ChartScope = {
  theme: THEME,
  colors: { scheme: THEME.colors, map: DEFAULT_COLOR_MAP },
  host: 'slide',
  cells: null,
}
const EMPTY_RELS = { source: '', list: [], byId: () => null, ofKind: () => [], part: () => null }

function strCache(values: readonly string[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')
  return `<c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache>`
}

function numCache(values: readonly (number | null)[], code = 'General'): string {
  const pts = values
    .map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`))
    .join('')
  return `<c:numCache><c:formatCode>${code}</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`
}

function ser(i: number, name: string, values: readonly (number | null)[], extra = ''): string {
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>S!$B$1</c:f>${strCache([name])}</c:strRef></c:tx>` +
    `${extra}<c:cat><c:strRef><c:f>S!$A$2</c:f>${strCache(['甲', '乙', '丙', '丁'].slice(0, values.length))}</c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>S!$B$2</c:f>${numCache(values)}</c:numRef></c:val></c:ser>`
  )
}

const AXES =
  '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' +
  '<c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>' +
  '<c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/><c:crossBetween val="between"/></c:valAx>'

function chartXml(plot: string, extra = '', space = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}">` +
    `${space}<c:chart>${extra}<c:plotArea><c:layout/>${plot}</c:plotArea></c:chart></c:chartSpace>`
  )
}

function barChart(series: string, extra = ''): string {
  return `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}${extra}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`
}

function resolved(xml: string, scope: ChartScope = SCOPE): Chart {
  const chart = resolveChart(readChart(xml, EMPTY_RELS), scope)
  if (chart === null) throw new Error('图表不支持')
  return chart
}

function fakeFace(): TextFace {
  return {
    metrics: {
      unitsPerEm: 1000,
      numGlyphs: 100,
      glyphId: () => 1,
      advanceWidth: () => 500,
      advance: (_cp: number, size: number) => size / 2,
    },
    vertical: {
      unitsPerEm: 1000,
      hheaAscender: 800,
      hheaDescender: -200,
      hheaLineGap: 0,
      winAscent: 800,
      winDescent: 200,
      averageWidth: 500,
      eastAsianCodePage: false,
      superscriptSize: 650,
      superscriptOffset: 450,
      subscriptSize: 650,
      subscriptOffset: 140,
    },
  }
}

const SETTINGS = {
  faces: new FaceCache({
    face: () => null,
    fallback: { face: fakeFace(), family: 'F', bold: false, italic: false },
  }),
  slideNumber: null,
}

describe('自动刻度', () => {
  // WPS 校准文件的实测结果：数据、轴长允许的区间数上限、显示的最小值、最大值与主要单位。
  const CASES: [number[], number, number, number, number][] = [
    [[4.3, 2.5, 3.5, 4.5], 10, 0, 5, 0.5],
    [[120, 350, 980, 610], 10, 0, 1200, 200],
    [[0.12, 0.35, 0.08, 0.27], 10, 0, 0.4, 0.05],
    [[-15, 42, 8, -3], 10, -20, 50, 10],
    [[1000, 1020, 1050, 1010], 10, 970, 1060, 10],
    [[23, 87, 45, 61], 10, 0, 100, 10],
    [[5550, 371, 2650, 12000], 10, 0, 14000, 2000],
    [[7, 7, 7, 7], 10, 0, 8, 1],
    [[62, 64, 65, 63], 10, 60.5, 65.5, 0.5],
    [[0.225, 0.014, -0.042, 0.046], 10, -0.1, 0.25, 0.05],
    [[35000, 42000, 39000, 51000], 10, 0, 60000, 10000],
    [[0.5, 1.5, 2.5, 3.7], 10, 0, 4, 0.5],
    [[0, 0, 0, 0], 10, 0, 1, 0.1],
    [[4009.17, 3620.13, 4237.02, 4500, 4800], 10, 0, 5000, 500],
    [[4.3, 2.4, 2, 2.5, 4.4, 2, 3.5, 1.8, 3, 4.5, 2.8, 5], 10, 0, 6, 1],
    [[9.4, 3, 6, 8], 9, 0, 10, 2],
    [[9.4, 3, 6, 8], 10, 0, 10, 1],
    // WPS 文字（同一图表的主次坐标轴）：取整前的范围除以单位不超过上限，取整后的区间数可以超过（0.195–0.25 共 11 个）。
    [[0.215333, 0.247333], 10, 0.195, 0.25, 0.005],
    [[627331.7, 10258641.1], 10, 0, 12000000, 2000000],
  ]
  for (const [data, limit, min, max, major] of CASES) {
    test(`${data.join(' ')}（上限 ${limit}）`, () => {
      const s = valueScale(Math.min(...data), Math.max(...data), {
        min: null,
        max: null,
        major: null,
        maxIntervals: limit,
      })
      expect(s).toEqual({ min, max, major })
    })
  }

  test('数值轴链接到源的格式取第一个系列，第一个点为空时为常规（WPS 文字：缓存没有第一个点的 0.00% 系列按常规显示）', () => {
    const line = (values: readonly (number | null)[]) =>
      chartXml(
        `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
          ser(0, '线', values).replace(numCache(values), numCache(values, '0.00%')) +
          `<c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`,
      )
    const labels = (values: readonly (number | null)[]) =>
      layoutChart(resolved(line(values)), 300, 200, SETTINGS)
        .axes.find((a) => !a.horizontal)!
        .labels.map((l) => l.text)
    expect(labels([0.2, 0.3, 0.25]).every((t) => t.endsWith('%'))).toBe(true)
    expect(labels([null, 0.3, 0.25]).some((t) => t.includes('%'))).toBe(false)
  })

  test('下限取 0 的条件为跨度不小于最大值的 1/6', () => {
    expect(autoRange(1000, 1050).lo).toBe(975)
    expect(autoRange(23, 87).lo).toBe(0)
    expect(autoRange(-20, -5).hi).toBe(0)
  })

  test('指定的最小值、最大值与主要单位不被改动', () => {
    expect(valueScale(10, 90, { min: 0, max: 5000, major: 1000, maxIntervals: 10 })).toEqual({
      min: 0,
      max: 5000,
      major: 1000,
    })
    expect(valueScale(10, 90, { min: 5, max: null, major: null, maxIntervals: 10 }).min).toBe(5)
  })

  test('指定的最小值（最大值）代替数据的最小值（最大值），自动的另一端取指定值加减主要单位的整数倍', () => {
    const scale = (min: number | null, max: number | null, lo: number, hi: number) =>
      valueScale(lo, hi, { min, max, major: null, maxIntervals: 10 })
    // WPS 演示与 WPS 表格的校准文件：数据 55–58；散点图 x 值含 0 与 4600–4690、最小值 3500。
    expect(scale(0, null, 55, 58)).toEqual({ min: 0, max: 70, major: 10 })
    expect(scale(3, null, 55, 58)).toEqual({ min: 3, max: 63, major: 10 })
    expect(scale(null, 100, 55, 58)).toEqual({ min: 0, max: 100, major: 10 })
    expect(scale(3500, null, 0, 4690)).toEqual({ min: 3500, max: 4900, major: 200 })
  })

  test('数字格式中的颜色作用于数值轴标签', () => {
    const xml = chartXml(barChart(ser(0, 'a', [-3, 2, 5]))).replace(
      '<c:axPos val="l"/>',
      '<c:axPos val="l"/><c:numFmt formatCode="0;[Red]\\(0\\)" sourceLinked="0"/>',
    )
    const labels = layoutChart(resolved(xml), 300, 200, SETTINGS).axes.find(
      (a) => !a.horizontal,
    )!.labels
    const fill = (text: string) =>
      labels.find((l) => l.text === text)?.layout.paragraphs[0]?.runs[0]?.fill
    expect(fill('(2)')).toEqual({ kind: 'solid', color: parseHexColor('FF0000')! })
    expect(fill('2')).toEqual({ kind: 'solid', color: parseHexColor('000000')! })
  })

  test('散点图 x 轴链接到源的格式取第一个系列 x 值的格式', () => {
    const xml = chartXml(
      '<c:scatterChart><c:scatterStyle val="marker"/><c:ser><c:idx val="0"/><c:order val="0"/>' +
        `<c:xVal><c:numRef><c:f>S!$A$2</c:f>${numCache([3600, 4200, 4690], '#,##0')}</c:numRef></c:xVal>` +
        `<c:yVal><c:numRef><c:f>S!$B$2</c:f>${numCache([1, 2, 3])}</c:numRef></c:yVal></c:ser>` +
        '<c:axId val="1"/><c:axId val="2"/></c:scatterChart>' +
        '<c:valAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' +
        '<c:numFmt formatCode="#,##0" sourceLinked="1"/><c:crossAx val="2"/></c:valAx>' +
        '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>' +
        '<c:crossAx val="1"/></c:valAx>',
    )
    const x = layoutChart(resolved(xml), 400, 300, SETTINGS).axes.find((a) => a.horizontal)!
    expect(x.labels.map((l) => l.text)).toContain('1,000')
  })

  test('主要单位与刻度值没有浮点误差', () => {
    expect(niceUnit(0, 0.3675, 10)).toBe(0.05)
    expect(ticks({ min: 0, max: 0.4, major: 0.05 })).toEqual([
      0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4,
    ])
  })
})

describe('读取与求值', () => {
  test('缓存数据：系列名取引用的缓存，缺失的点为 null，数值分类按格式代码显示', () => {
    const xml = chartXml(
      `<c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="0"/><c:order val="0"/>` +
        `<c:tx><c:strRef><c:f>S!$B$1:$C$1</c:f>${strCache(['价格', '需求'])}</c:strRef></c:tx>` +
        `<c:cat><c:numRef><c:f>S!$A$2</c:f>${numCache([2019, 2020, 2021], '0"年"')}</c:numRef></c:cat>` +
        `<c:val><c:numRef><c:f>S!$B$2</c:f>${numCache([1, null, 3], '0%')}</c:numRef></c:val></c:ser>` +
        `<c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`,
    )
    const s = resolved(xml).plot.groups[0]!.series[0]!
    expect(s.name).toBe('价格 需求')
    expect(s.values).toEqual([1, null, 3])
    expect(s.categories).toEqual(['2019年', '2020年', '2021年'])
    expect(s.format).toBe('0%')
  })

  test('未写出 spPr：图表区白色，WPS 表格有边框而演示没有；折线 1.5 磅并带自动标记', () => {
    const xml = chartXml(
      `<c:lineChart><c:grouping val="standard"/>${ser(0, 'a', [1, 2])}${ser(1, 'b', [2, 1])}<c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`,
    )
    const slide = resolved(xml)
    expect(slide.box.fill).toEqual({ kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } })
    expect(slide.box.line).toBeNull()
    expect(resolved(xml, { ...SCOPE, host: 'sheet' }).box.line?.width).toBe(9525)
    const [a, b] = slide.plot.groups[0]!.series
    expect(a!.box.line?.width).toBe(19050)
    expect([a!.marker?.symbol, b!.marker?.symbol]).toEqual(['diamond', 'square'])
  })

  test('自动颜色：系列数超过 6 时首轮加深、次轮减淡', () => {
    expect(autoColor(0, 3)).toEqual({ kind: 'scheme', name: 'accent1', transforms: [] })
    const first = autoColor(0, 8)
    const second = autoColor(6, 8)
    expect(first.transforms[0]?.name).toBe('shade')
    expect(first.transforms[0]?.value).toBeCloseTo(0.7667, 3)
    expect(second.transforms[0]?.name).toBe('tint')
    expect(second.transforms[0]?.value).toBeCloseTo(0.7667, 3)
  })

  test('没有 c:title 时不显示标题；c:title 没有文字时多系列显示「图表标题」', () => {
    const plot = barChart(ser(0, 'a', [1, 2]) + ser(1, 'b', [2, 3]))
    expect(resolved(chartXml(plot, '<c:autoTitleDeleted val="0"/>')).title).toBeNull()
    const t = resolved(chartXml(plot, '<c:title><c:overlay val="0"/></c:title>')).title
    const run = t?.text.paragraphs[0]?.runs[0]
    expect(run?.kind === 'text' ? run.text : null).toBe('图表标题')
    expect(run?.style.bold).toBe(true)
    expect(run?.style.size).toBe(18)
  })

  test('数据标签：图表组的 txPr 不生效，显示项由系列逐项覆盖', () => {
    const groupLabels =
      '<c:dLbls><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="2400"/></a:pPr></a:p></c:txPr>' +
      '<c:showVal val="1"/><c:showCatName val="1"/></c:dLbls>'
    const own =
      '<c:dLbls><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1200"/></a:pPr></a:p></c:txPr><c:showCatName val="0"/></c:dLbls>'
    const chart = resolved(
      chartXml(barChart(ser(0, 'a', [1, 2], own) + ser(1, 'b', [2, 3]), groupLabels)),
    )
    const [a, b] = chart.plot.groups[0]!.series
    expect(a!.labels?.showValue).toBe(true)
    expect(a!.labels?.showCategory).toBe(false)
    expect(a!.labels?.text.run.size).toBe(12)
    expect(b!.labels?.text.run.size).toBe(10)
    expect(b!.labels?.position).toBe('outEnd')
  })

  test('坐标轴标签：rot="-60000000" 为自动旋转，rot="0" 为不旋转', () => {
    const axes = (rot: string) =>
      AXES.replace(
        '<c:crossAx val="2"/>',
        `<c:txPr><a:bodyPr rot="${rot}"/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr></a:p></c:txPr><c:crossAx val="2"/>`,
      )
    const plot = (rot: string) =>
      `<c:barChart><c:barDir val="col"/>${ser(0, 'a', [1])}<c:axId val="1"/><c:axId val="2"/></c:barChart>${axes(rot)}`
    expect(resolved(chartXml(plot('-60000000'))).plot.axes[0]!.text.rotation).toBeNull()
    expect(resolved(chartXml(plot('0'))).plot.axes[0]!.text.rotation).toBe(0)
  })

  test('不支持的内容使整个图表不绘制', () => {
    const area = chartXml(
      `<c:areaChart>${ser(0, 'a', [1])}<c:axId val="1"/><c:axId val="2"/></c:areaChart>${AXES}`,
    )
    expect(resolveChart(readChart(area, EMPTY_RELS), SCOPE)).toBeNull()
    const trend = chartXml(barChart(ser(0, 'a', [1], '<c:trendline/>')))
    expect(resolveChart(readChart(trend, EMPTY_RELS), SCOPE)).toBeNull()
    expect(resolveChart(readChart('<x/>', EMPTY_RELS), SCOPE)).toBeNull()
  })
})

describe('布局', () => {
  test('百分比按最大余数取整，和为 100%', () => {
    expect(roundPercents([8.2, 3.2, 1.4, 1.2], 0)).toEqual([0.59, 0.23, 0.1, 0.08])
    expect(roundPercents([1, 1, 1], 1)).toEqual([0.334, 0.333, 0.333])
    expect(roundPercents([0, 0], 0)).toEqual([0, 0])
  })

  const SIZED_AXES = AXES.replace(
    /<c:crossAx/g,
    '<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr></a:p></c:txPr><c:crossAx',
  )
  const plot = (values: number[]) =>
    `<c:barChart><c:barDir val="col"/>${ser(0, 'a', values)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${SIZED_AXES}`

  test('竖直轴的区间数随绘图区高度变化（9 磅标签在 158 像素与 163 像素之间由 5 个变为 10 个）', () => {
    const chart = resolved(chartXml(plot([9.4, 3, 6, 8])))
    const at = (height: number) =>
      layoutChart(chart, 100, height, SETTINGS).axes.find((a) => !a.horizontal)!
    // 内框高度 = 图表高度 − 上沿 14.16 − 下沿 30.27（分类标签一行）；WPS 演示实测 158.3 像素 5 个、163.3 像素 10 个。
    const low = at(202)
    const high = at(208)
    expect(low.scale?.major).toBe(2)
    expect(high.scale?.major).toBe(1)
  })

  test('上下沿较高的字体使文字框高出 0.65 × (H − 1.2) × 字号，文字仍在框顶', () => {
    const tall = fakeFace()
    const face: TextFace = {
      ...tall,
      vertical: { ...tall.vertical, winAscent: 1100, winDescent: 300 },
    }
    const settings = {
      faces: new FaceCache({
        face: (name) =>
          name === 'Tall' ? { face, family: 'Tall', bold: false, italic: false } : null,
        fallback: { face: fakeFace(), family: 'F', bold: false, italic: false },
      }),
      slideNumber: null,
    }
    const run = (latin: string): RunStyle => ({
      latin,
      ea: '',
      cs: '',
      sym: '',
      size: 9,
      bold: false,
      italic: false,
      underline: 'none',
      strike: 'noStrike',
      baseline: 0,
      caps: 'none',
      spacing: 0,
      kern: 0,
      fill: { kind: 'none' },
      highlight: null,
      outline: null,
      effects: [],
      lang: '',
    })
    const low = measure(labelBody('A', run('F')), settings)
    expect(low.frame).toBeCloseTo(low.height, 9)
    // H = 1.4：12 像素字号多出 0.65 × 0.2 × 12。多行文字也只计一次。
    const high = measure(labelBody('A', run('Tall')), settings)
    expect(high.frame - high.height).toBeCloseTo(0.65 * 0.2 * 12, 6)
    const two = measure(labelBody(['A', 'B'].join(String.fromCharCode(10)), run('Tall')), settings)
    expect(two.frame - two.height).toBeCloseTo(0.65 * 0.2 * 12, 6)
  })

  test('竖直轴的区间门槛 1.4f − 0.8 与宿主无关', () => {
    const chart = resolved(chartXml(plot([9.4, 3, 6, 8])))
    const slide = { ...chart, host: 'slide' as const }
    const major = (c: Chart, height: number) =>
      layoutChart(c, 100, height, SETTINGS).axes.find((a) => !a.horizontal)!.scale?.major
    for (const c of [slide, { ...chart, host: 'sheet' as const }]) {
      expect(major(c, 202)).toBe(2)
      expect(major(c, 208)).toBe(1)
    }
  })

  test('不旋转的分类标签顶距轴线 0.58f + 1；标题框底之下 13.74 为外沿，内框上沿再低 4.91', () => {
    const xml = chartXml(
      plot([4.3, 2.5, 3.5, 4.5]),
      '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>T</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>',
    )
    const l = layoutChart(resolved(xml), 300, 340, SETTINGS)
    const cat = l.axes.find((a) => a.horizontal)!
    expect(cat.labels[0]!.y - cat.at).toBeCloseTo(0.58 * 12 + 1, 6)
    expect(l.plot.y - (l.title!.y + l.title!.height)).toBeCloseTo(13.74 + 4.91, 6)
  })

  test('无标题无图例时内框上沿为 14.16 像素，右沿距右边 15.3 像素', () => {
    const chart = resolved(chartXml(plot([4.3, 2.5, 3.5, 4.5])))
    const l = layoutChart(chart, 300, 340, SETTINGS)
    expect(l.plot.y).toBeCloseTo(14.16, 2)
    expect(300 - (l.plot.x + l.plot.w)).toBeCloseTo(15.3, 1)
  })

  test('分类标签超过分类宽度时旋转 −45°，旋转后仍超过时 −90°', () => {
    const many = (n: number) =>
      `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strRef><c:f>S!$A$1</c:f>` +
      `${strCache(Array.from({ length: n }, (_, i) => `第${i + 1}期销售`))}</c:strRef></c:cat>` +
      `<c:val><c:numRef><c:f>S!$B$1</c:f>${numCache(Array.from({ length: n }, (_, i) => i + 1))}</c:numRef></c:val></c:ser>` +
      `<c:axId val="1"/><c:axId val="2"/></c:barChart>${SIZED_AXES}`
    const rotation = (width: number) =>
      layoutChart(resolved(chartXml(many(20))), width, 300, SETTINGS).axes.find(
        (a) => a.horizontal,
      )!.labels[0]!.rotation
    expect(rotation(4000)).toBe(0)
    expect(rotation(600)).toBe(-45)
    expect(rotation(380)).toBe(-90)
  })

  test('底部图例居中，框底在留白处；横向条形图的图例按系列倒序', () => {
    const xml = chartXml(
      `<c:barChart><c:barDir val="bar"/>${ser(0, '甲系列', [1, 2])}${ser(1, '乙系列', [2, 1])}<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
        AXES.replace('<c:axPos val="b"/>', '<c:axPos val="l"/>').replace(
          '<c:axPos val="l"/><c:majorGridlines/>',
          '<c:axPos val="b"/><c:majorGridlines/>',
        ),
      '',
    ).replace('</c:plotArea>', '</c:plotArea><c:legend><c:legendPos val="b"/></c:legend>')
    const l = layoutChart(resolved(xml), 600, 380, SETTINGS)
    const box = l.legend!.box
    expect(box.x + box.w / 2).toBeCloseTo(300, 5)
    expect(box.y + box.h).toBeCloseTo(380 - 9.25, 5)
    expect(l.legend!.entries.map((e) => e.series.name)).toEqual(['乙系列', '甲系列'])
  })
})

describe('绘制', () => {
  test('柱形与扇区都画到画布上；缺少排版设置时不绘制', () => {
    const chart = resolved(chartXml(barChart(ser(0, 'a', [1, 2]))))
    const ctx = new RecordingContext()
    const frame = {
      x: 0,
      y: 0,
      width: 300 * 9525,
      height: 200 * 9525,
      rotation: 0,
      flipH: false,
      flipV: false,
    }
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
    const scene = {
      ctx,
      res: { image: () => null, createCanvas: canvasFactory().create },
      scale: 1,
      canvas: { width: 300, height: 200 },
      settings: SETTINGS,
    }
    paintChart(scene, chart, frame, identity)
    // 图表区、绘图区以外：两根柱子各一次填充。
    expect(ctx.named('fill').length).toBeGreaterThanOrEqual(3)
    const empty = new RecordingContext()
    paintChart({ ...scene, ctx: empty, settings: null }, chart, frame, identity)
    expect(empty.calls.length).toBe(0)
  })
})

describe('宿主的像素规则', () => {
  /** 在 x、y 各偏移 0.3 像素的图形框中绘制，返回条形四边与网格线（上沿）的设备坐标。 */
  const painted = (host: Chart['host']) => {
    const green =
      '<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>'
    const xml = chartXml(barChart(ser(0, 'a', [1, 2, 3]))).replace('<c:majorGridlines/>', green)
    const chart = { ...resolved(xml), host }
    const ctx = new RecordingContext()
    const frame = {
      x: 0.3 * 9525,
      y: 0.3 * 9525,
      width: 300 * 9525,
      height: 200 * 9525,
      rotation: 0,
      flipH: false,
      flipV: false,
    }
    const scene = {
      ctx,
      res: { image: () => null, createCanvas: canvasFactory().create },
      scale: 1,
      canvas: { width: 301, height: 201 },
      settings: SETTINGS,
    }
    paintChart(scene, chart, frame, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    const device = (c: {
      args: readonly unknown[]
      matrix: { a: number; d: number; e: number; f: number }
    }) => {
      const [x, y] = c.args as [number, number]
      return [c.matrix.a * x + c.matrix.e, c.matrix.d * y + c.matrix.f]
    }
    const accent = chart.plot.groups[0]!.series[0]!.box.fill
    const color = accent.kind === 'solid' ? colorToCss(accent.color) : ''
    const fills = ctx.calls.filter((c) => c.name === 'fill' && c.fillStyle === color)
    const bars = fills.map((f) => {
      const i = ctx.calls.indexOf(f)
      return ctx.calls
        .slice(0, i)
        .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
        .slice(-4)
        .map(device)
    })
    // 网格线为绿色的一次描边，记录各段起点。
    const gridColor = colorToCss({ r: 0, g: 1, b: 0, a: 1 })
    let ys: number[] = []
    let lines: number[] = []
    for (const c of ctx.calls) {
      if (c.name === 'beginPath') ys = []
      else if (c.name === 'moveTo') ys.push(device(c)[1]!)
      else if (c.name === 'stroke' && c.strokeStyle === gridColor)
        lines = ys.map((y) => y - c.lineWidth / 2)
    }
    return { bars, lines }
  }

  test('手动布局的绘图区左上角在按比例求出的位置向左上各 0.5 像素，宽高不变', () => {
    const manual =
      '<c:plotArea><c:layout><c:manualLayout><c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/>' +
      '<c:x val="0.1"/><c:y val="0.2"/><c:w val="0.5"/><c:h val="0.5"/></c:manualLayout></c:layout>'
    const xml = chartXml(barChart(ser(0, 'a', [1, 2, 3]))).replace(
      '<c:plotArea><c:layout/>',
      manual,
    )
    const plot = layoutChart(resolved(xml), 300, 200, SETTINGS).plot
    expect([plot.x, plot.y, plot.w, plot.h]).toEqual([29.5, 39.5, 150, 100])
  })

  test('WPS 表格与 WPS 文字的条形四边与主要网格线上沿在整像素上，WPS 演示按原位置绘制', () => {
    const sheet = painted('sheet')
    expect(sheet.bars.length).toBe(3)
    for (const v of sheet.bars.flat(2)) expect(v).toBeCloseTo(Math.round(v), 9)
    expect(sheet.lines.length).toBeGreaterThan(2)
    for (const y of sheet.lines) expect(y).toBeCloseTo(Math.round(y), 9)
    const slide = painted('slide')
    expect(slide.bars.flat(2).some((v) => Math.abs(v - Math.round(v)) > 0.01)).toBe(true)
    expect(slide.lines.some((y) => Math.abs(y - Math.round(y)) > 0.01)).toBe(true)
  })
})

describe('接入', () => {
  const chart = chartXml(
    barChart(ser(0, 'a', [1, 2])),
    '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>销量</a:t></a:r></a:p></c:rich></c:tx></c:title>',
  )
  const area = chartXml(
    `<c:areaChart>${ser(0, 'a', [1])}<c:axId val="1"/><c:axId val="2"/></c:areaChart>${AXES}`,
  )
  const frame = (id: number, rid: string) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="图表"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm>${xfrm(0, 0, 3000000, 2000000)
      .replace(/a:xfrm/g, 'p:xfrm')
      .replace(/<p:xfrm>|<\/p:xfrm>/g, '')}</p:xfrm>` +
    `<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`

  test('pptx：可绘制的图表成为 chart 形状，不支持的图表计入 chart', async () => {
    const bytes = buildPptx({
      slides: [
        {
          xml: slideXml(frame(2, 'rIdC1') + frame(3, 'rIdC2')),
          rels: [
            ['rIdC1', 'chart', '../charts/chart1.xml'],
            ['rIdC2', 'chart', '../charts/chart2.xml'],
          ],
        },
      ],
      media: { 'ppt/charts/chart1.xml': chart, 'ppt/charts/chart2.xml': area },
    })
    const r = await parsePptx(bytes)
    if (!r.ok) throw new Error(r.failure.kind)
    const slide = r.value.slides[0]!
    expect(slide.shapes.map((s) => s.kind)).toEqual(['chart', 'graphic'])
    expect(slide.unsupported.chart).toBe(1)
    const shape = slide.shapes[0]!
    expect(shape.kind === 'chart' ? shape.chart.title?.text.paragraphs[0]?.runs.length : null).toBe(
      1,
    )
  })

  const X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const rels = (items: [string, string, string][]) =>
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
      .map(
        ([id, type, target]) =>
          `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
      )
      .join('')}</Relationships>`
  const anchor = (rid: string) =>
    `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="3000000" cy="2000000"/><xdr:graphicFrame macro="">` +
    `<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="图表"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}">` +
    `<c:chart xmlns:c="${C}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>`

  test('xlsx：锚定的图表进入 charts，不支持的图表计入 chart', async () => {
    const bytes = buildZip({
      '[Content_Types].xml':
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
      'xl/workbook.xml': `<workbook xmlns="${X}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': rels([
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'theme', 'theme/theme1.xml'],
      ]),
      'xl/theme/theme1.xml': THEME_XML,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${X}" xmlns:r="${REL}"><sheetData/><drawing r:id="rId1"/></worksheet>`,
      'xl/worksheets/_rels/sheet1.xml.rels': rels([
        ['rId1', 'drawing', '../drawings/drawing1.xml'],
      ]),
      'xl/drawings/drawing1.xml': `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${REL}">${anchor('rId1')}${anchor('rId2')}</xdr:wsDr>`,
      'xl/drawings/_rels/drawing1.xml.rels': rels([
        ['rId1', 'chart', '../charts/chart1.xml'],
        ['rId2', 'chart', '../charts/chart2.xml'],
      ]),
      'xl/charts/chart1.xml': chart,
      'xl/charts/chart2.xml': area,
    })
    const r = await parseXlsx(bytes)
    if (!r.ok) throw new Error(r.failure.kind)
    const sheet = r.value.sheets[0]!
    expect(sheet.charts.length).toBe(1)
    expect(sheet.charts[0]!.order).toBe(0)
    expect(sheet.charts[0]!.chart.box.line?.width).toBe(9525)
    expect(sheet.unsupported.chart).toBe(1)
    expect(r.value.fontNames).toContain('Calibri')
  })

  test('xlsx：图表部件引用主题覆盖时颜色方案与主题字体取自主题覆盖', async () => {
    const bytes = buildZip({
      '[Content_Types].xml':
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
      'xl/workbook.xml': `<workbook xmlns="${X}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': rels([
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'theme', 'theme/theme1.xml'],
      ]),
      'xl/theme/theme1.xml': THEME_XML,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${X}" xmlns:r="${REL}"><sheetData/><drawing r:id="rId1"/></worksheet>`,
      'xl/worksheets/_rels/sheet1.xml.rels': rels([
        ['rId1', 'drawing', '../drawings/drawing1.xml'],
      ]),
      'xl/drawings/drawing1.xml': `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${REL}">${anchor('rId1')}${anchor('rId2')}</xdr:wsDr>`,
      'xl/drawings/_rels/drawing1.xml.rels': rels([
        ['rId1', 'chart', '../charts/chart1.xml'],
        ['rId2', 'chart', '../charts/chart2.xml'],
      ]),
      'xl/charts/chart1.xml': chart,
      'xl/charts/_rels/chart1.xml.rels': OVERRIDE_RELS,
      'xl/theme/themeOverride1.xml': OVERRIDE_XML,
      'xl/charts/chart2.xml': chart,
    })
    const r = await parseXlsx(bytes)
    if (!r.ok) throw new Error(r.failure.kind)
    const [own, plain] = r.value.sheets[0]!.charts.map((c) => c.chart)
    expect(own!.plot.groups[0]!.series[0]!.box.fill).toEqual({ kind: 'solid', color: RED })
    expect(plain!.plot.groups[0]!.series[0]!.box.fill).not.toEqual({ kind: 'solid', color: RED })
    expect(own!.plot.axes[0]!.text.run.ea).toBe('楷体')
    expect(r.value.fontNames).toContain('Times New Roman')
  })

  const OVERRIDE_XML =
    `<a:themeOverride xmlns:a="${A}"><a:clrScheme name="o"><a:dk1><a:srgbClr val="C00000"/></a:dk1>` +
    '<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme>' +
    '<a:fontScheme name="o"><a:majorFont><a:latin typeface="Arial Black"/><a:ea typeface="黑体"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Times New Roman"/><a:ea typeface="楷体"/></a:minorFont></a:fontScheme></a:themeOverride>'
  const OVERRIDE_RELS =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${R}/themeOverride" Target="../theme/themeOverride1.xml"/></Relationships>`
  const RED = parseHexColor('FF0000')!

  test('pptx：图表部件引用主题覆盖时颜色方案与主题字体取自主题覆盖', async () => {
    const bytes = buildPptx({
      slides: [
        {
          xml: slideXml(frame(2, 'rIdC1') + frame(3, 'rIdC2')),
          rels: [
            ['rIdC1', 'chart', '../charts/chart1.xml'],
            ['rIdC2', 'chart', '../charts/chart2.xml'],
          ],
        },
      ],
      media: {
        'ppt/charts/chart1.xml': chart,
        'ppt/charts/_rels/chart1.xml.rels': OVERRIDE_RELS,
        'ppt/theme/themeOverride1.xml': OVERRIDE_XML,
        'ppt/charts/chart2.xml': chart,
      },
    })
    const r = await parsePptx(bytes)
    if (!r.ok) throw new Error(r.failure.kind)
    const charts = r.value.slides[0]!.shapes.map((s) => (s.kind === 'chart' ? s.chart : null))
    const fill = (c: Chart | null) => c?.plot.groups[0]?.series[0]?.box.fill
    expect(fill(charts[0]!)).toEqual({ kind: 'solid', color: RED })
    expect(fill(charts[1]!)).not.toEqual({ kind: 'solid', color: RED })
    expect(charts[0]!.plot.axes[0]!.text.run.latin).toBe('Times New Roman')
    expect(charts[0]!.plot.axes[0]!.text.run.ea).toBe('楷体')
  })

  test('没有主题时按空主题求值，不失败', () => {
    const c = resolveChart(readChart(chart, EMPTY_RELS), {
      theme: EMPTY_THEME,
      colors: { scheme: EMPTY_THEME.colors },
      host: 'slide',
      cells: null,
    })
    expect(c?.plot.groups[0]?.series[0]?.box.fill.kind).toBe('none')
  })
})

describe('按引用取值', () => {
  const X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
  const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const rels = (items: [string, string, string][]) =>
    `<Relationships xmlns="${PKG}">${items.map(([id, t, target]) => `<Relationship Id="${id}" Type="${R}/${t}" Target="${target}"/>`).join('')}</Relationships>`
  const refSer = (name: string, cat: string, val: string, cache: number[]) =>
    `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${name}</c:f>${strCache(['旧名称'])}</c:strRef></c:tx>` +
    `<c:cat><c:strRef><c:f>${cat}</c:f>${strCache(cache.map(String))}</c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${val}</c:f>${numCache(cache)}</c:numRef></c:val></c:ser>`
  const lineChart = (series: string, plotVis = '') =>
    chartXml(
      `<c:lineChart><c:grouping val="standard"/>${series}<c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`,
    ).replace('</c:plotArea>', `</c:plotArea>${plotVis}`)
  const cell = (ref: string, v: string) => {
    if (v.startsWith('#')) return `<c r="${ref}" t="e"><v>${v}</v></c>`
    if (v === 'TRUE') return `<c r="${ref}" t="b"><v>1</v></c>`
    if (/^-?\d/.test(v)) return `<c r="${ref}"><v>${v}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`
  }
  const rows = (data: Record<number, Record<string, string>>, hidden: number[] = []) =>
    Object.entries(data)
      .map(([r, cells]) => {
        const attr = hidden.includes(Number(r)) ? ' hidden="1"' : ''
        const body = Object.entries(cells)
          .map(([c, v]) => cell(`${c}${r}`, v))
          .join('')
        return `<row r="${r}"${attr}>${body}</row>`
      })
      .join('')
  const workbook = async (charts: string[]) => {
    const anchor = (i: number) =>
      `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="3000000" cy="2000000"/><xdr:graphicFrame macro="">` +
      `<xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="图表"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      `<xdr:xfrm/><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="rIdC${i}"/></a:graphicData></a:graphic>` +
      '</xdr:graphicFrame><xdr:clientData/></xdr:absoluteAnchor>'
    const sheet1 = rows(
      {
        1: { A: '分类', B: '新名称' },
        2: { A: '甲', B: '10' },
        3: { A: '乙', B: 'TRUE' },
        4: { A: '丙', B: '文字' },
        5: { A: '丁', B: '#N/A' },
        6: { A: '戊', B: '40' },
        7: { A: '己' },
      },
      [6],
    )
    const files: Record<string, string> = {
      '[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
      'xl/workbook.xml': `<workbook xmlns="${X}" xmlns:r="${R}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/><sheet name="数据 表" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': rels([
        ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
        ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ]),
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${X}" xmlns:r="${R}"><sheetData>${sheet1}</sheetData><drawing r:id="rId1"/></worksheet>`,
      'xl/worksheets/_rels/sheet1.xml.rels': rels([
        ['rId1', 'drawing', '../drawings/drawing1.xml'],
      ]),
      'xl/worksheets/sheet2.xml': `<worksheet xmlns="${X}"><sheetData>${rows({ 1: { A: '北', B: '5' }, 2: { A: '南', B: '9' } })}</sheetData></worksheet>`,
      'xl/drawings/drawing1.xml': `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}">${charts.map((_, i) => anchor(i)).join('')}</xdr:wsDr>`,
      'xl/drawings/_rels/drawing1.xml.rels': rels(
        charts.map((_, i): [string, string, string] => [
          `rIdC${i}`,
          'chart',
          `../charts/chart${i}.xml`,
        ]),
      ),
    }
    charts.forEach((c, i) => {
      files[`xl/charts/chart${i}.xml`] = c
    })
    const r = await parseXlsx(buildZip(files))
    if (!r.ok) throw new Error(r.failure.kind)
    return r.value.sheets[0]!.charts.map((c) => c.chart.plot.groups[0]!.series[0]!)
  }

  test('系列名、分类与值取单元格：逻辑值计 1，文字计 0，#N/A 不绘制，空单元格为空点，隐藏行略去', async () => {
    const ser6 = refSer('S!$B$1', 'S!$A$2:$A$7', 'S!$B$2:$B$7', [1, 2, 3, 4, 5, 6])
    const [s, all] = await workbook([lineChart(ser6), lineChart(ser6, '<c:plotVisOnly val="0"/>')])
    expect(s!.name).toBe('新名称')
    expect(s!.categories).toEqual(['甲', '乙', '丙', '丁', '己'])
    expect(s!.values).toEqual([10, 1, 0, null, null])
    expect([...s!.missing]).toEqual([3])
    expect(all!.categories).toEqual(['甲', '乙', '丙', '丁', '戊', '己'])
    expect(all!.values[4]).toBe(40)
  })

  test('多区域按区域顺序连接；带引号的工作表名可解析；外部工作簿用缓存值', async () => {
    const quoted = "'数据 表'"
    const [multi, other, external] = await workbook([
      lineChart(refSer('S!$B$1', '(S!$A$2,S!$A$7)', '(S!$B$2,S!$B$7)', [1, 2])),
      lineChart(refSer(`${quoted}!$A$1`, `${quoted}!$A$1:$A$2`, `${quoted}!$B$1:$B$2`, [7])),
      lineChart(refSer('[1]S!$B$1', '[1]S!$A$2:$A$3', '[1]S!$B$2:$B$3', [3, 4])),
    ])
    expect(multi!.categories).toEqual(['甲', '己'])
    expect(multi!.values).toEqual([10, null])
    expect(other!.name).toBe('北')
    expect(other!.values).toEqual([5, 9])
    expect(external!.name).toBe('旧名称')
    expect(external!.values).toEqual([3, 4])
  })
})

describe('日期轴', () => {
  const day = (y: number, m: number, d: number) =>
    (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000

  test('基本单位按数据推定：月与日相同为年，日相同为月，否则为日', () => {
    expect(autoBase([day(2015, 1, 1), day(2017, 1, 1)], false)).toBe('years')
    expect(autoBase([day(2024, 1, 1), day(2024, 3, 1)], false)).toBe('months')
    expect(autoBase([day(2024, 1, 1), day(2024, 1, 2)], false)).toBe('days')
  })

  // WPS 校准文件实测：基本单位、单位数、轴长与选出的主要单位（9 磅标签，间距下限 17.1）。
  const CASES: [TimeUnit, number, number, string][] = [
    ['days', 45, 535, '2 days'],
    ['days', 90, 535, '7 days'],
    ['days', 365, 535, '1 months'],
    ['days', 730, 335, '2 months'],
    ['months', 72, 535, '3 months'],
    ['months', 120, 535, '5 months'],
    ['years', 40, 335, '3 years'],
  ]
  for (const [base, n, length, expected] of CASES) {
    test(`${n} 个单位（${base}）、轴长 ${length}：${expected}`, () => {
      const s = { base, origin: day(2015, 1, 1), slots: n, date1904: false }
      const step = autoStep(s, length / n, 17.1)
      expect(`${step.count} ${step.unit}`).toBe(expected)
    })
  }

  test('标签从最早日期起按步长取同一日，单位下标按基本单位计', () => {
    const s = dateScale([day(2024, 1, 31), day(2024, 4, 30)], 'days', false)
    expect(s.slots).toBe(91)
    const labels = dateLabels(s, { count: 1, unit: 'months' })
    expect(labels.map((l) => l.slot)).toEqual([0, 29, 60, 90])
    expect(unitIndex(day(2024, 3, 1), dateScale([day(2024, 1, 15)], 'months', false))).toBe(2)
  })

  test('分类轴 auto 为真且分类为日期格式时按日期轴，数据点落在其日期所在的单位上', () => {
    const dates = [day(2024, 1, 1), day(2024, 1, 2), day(2024, 1, 30)]
    const axes = AXES.replace('<c:crossAx val="2"/>', '<c:crossAx val="2"/><c:auto val="1"/>')
    const xml = chartXml(
      `<c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="0"/><c:order val="0"/>` +
        `<c:cat><c:numRef><c:f>S!$A$1</c:f>${numCache(dates, 'yyyy/m/d')}</c:numRef></c:cat>` +
        `<c:val><c:numRef><c:f>S!$B$1</c:f>${numCache([3, 5, 4])}</c:numRef></c:val></c:ser>` +
        `<c:axId val="1"/><c:axId val="2"/></c:lineChart>${axes}`,
    )
    const cat = layoutChart(resolved(xml), 600, 380, SETTINGS).axes.find((a) => a.horizontal)!
    expect(cat.slots).toBe(30)
    expect(cat.labels[0]!.text).toBe('2024/1/1')
    const text = resolved(xml.replace('yyyy/m/d', 'General'))
    expect(layoutChart(text, 600, 380, SETTINGS).axes.find((a) => a.horizontal)!.slots).toBe(3)
  })
})

describe('次坐标轴与坐标轴标题', () => {
  const combo =
    `<c:barChart><c:barDir val="col"/>${ser(0, '销量', [120, 350, 980, 610])}<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
    `<c:lineChart><c:grouping val="standard"/>${ser(1, '增长率', [0.12, 0.35, 0.28, 0.41])}<c:axId val="3"/><c:axId val="4"/></c:lineChart>` +
    AXES +
    '<c:catAx><c:axId val="3"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:crossAx val="4"/></c:catAx>' +
    '<c:valAx><c:axId val="4"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="r"/>' +
    '<c:crossAx val="3"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>'
  const plotOf = (title: string) =>
    barChart(ser(0, 'a', [1, 2])).replace('<c:axPos val="l"/>', `<c:axPos val="l"/>${title}`)

  test('次数值轴按自身数据取刻度，交叉于最大值时位于右侧，标签左对齐在绘图区右侧', () => {
    const l = layoutChart(resolved(chartXml(combo)), 580, 380, SETTINGS)
    const right = l.axes.find((a) => a.axis.id === 4)!
    expect(right.scale).toEqual({ min: 0, max: 0.45, major: 0.05 })
    expect(right.at).toBeCloseTo(l.plot.x + l.plot.w, 5)
    for (const label of right.labels) expect(label.x).toBeGreaterThan(l.plot.x + l.plot.w)
    expect(l.axes.find((a) => a.axis.id === 2)!.scale?.max).toBe(1200)
  })

  test('分类标签在绘图区边缘（low）时，坐标轴跨越数值轴内部也照常留出标签的高度', () => {
    const bars = (axes: string) =>
      chartXml(
        `<c:barChart><c:barDir val="col"/>${ser(0, 'a', [-5, 10])}<c:axId val="1"/><c:axId val="2"/></c:barChart>${axes}`,
      )
    const low = AXES.replace(
      '<c:crossAx val="2"/>',
      '<c:tickLblPos val="low"/><c:crossAx val="2"/>',
    )
    const edge = layoutChart(resolved(bars(low)), 300, 200, SETTINGS)
    const inner = layoutChart(resolved(bars(AXES)), 300, 200, SETTINGS)
    expect(edge.plot.h).toBeLessThan(inner.plot.h - 10)
    const cat = edge.axes.find((a) => a.horizontal)!
    expect(cat.labels[0]!.y).toBeGreaterThan(edge.plot.y + edge.plot.h)
  })

  test('数值轴标题缺省旋转 −90° 并沿绘图区居中，占去左侧的宽度；空标题显示「坐标轴标题」', () => {
    const title =
      '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>金额</a:t></a:r></a:p></c:rich></c:tx></c:title>'
    const plain = layoutChart(resolved(chartXml(plotOf(''))), 580, 380, SETTINGS)
    const titled = layoutChart(resolved(chartXml(plotOf(title))), 580, 380, SETTINGS)
    const t = titled.axes.find((a) => !a.horizontal)!.title!
    expect(t.rotation).toBe(-90)
    expect(t.y - t.width / 2).toBeCloseTo(titled.plot.y + titled.plot.h / 2, 5)
    expect(titled.plot.x - plain.plot.x).toBeCloseTo(6.3 + t.height + 6, 5)
    const empty = resolved(chartXml(plotOf('<c:title/>')))
    const run = empty.plot.axes[1]!.title!.text.paragraphs[0]!.runs[0]!
    expect(run.kind === 'text' ? [run.text, run.style.bold] : null).toEqual(['坐标轴标题', true])
  })
})

describe('三维饼图', () => {
  const view = (rotX: number, perspective: number, heightPercent = 100) => ({
    rotX,
    rotY: 0,
    perspective,
    rightAngle: false,
    heightPercent,
  })
  // WPS 校准文件实测的底面直径：图表区宽高（无标题无图例）、倾角、透视、高度与直径。
  const CASES: [number, number, number, number, number, number][] = [
    [580, 380, 10, 0, 100, 478],
    [580, 380, 30, 0, 100, 476],
    [580, 380, 30, 0, 200, 426],
    [580, 280, 60, 0, 100, 264],
    [300, 280, 45, 0, 100, 270],
    [300, 280, 80, 0, 100, 250],
    [580, 200, 30, 0, 100, 232],
    [580, 380, 30, 30, 100, 466],
  ]
  for (const [w, h, rotX, p, hp, d] of CASES) {
    test(`${w}×${h}、rotX ${rotX}、透视 ${p}、高度 ${hp}%：直径约 ${d}`, () => {
      const g = pieGeometry(view(rotX, p, hp), 9.25, 9.25, w - 18.5, h - 18.5, 0, 0)
      expect(Math.abs(2 * g.r - d)).toBeLessThanOrEqual(4)
    })
  }

  test('正投影下顶面短半轴为 r × sin θ；透视 30 时前缘距圆心约为后缘的 1.1 倍', () => {
    const flat = pieGeometry(view(30, 0), 0, 0, 561.5, 361.5, 0, 0)
    expect(flat.cy - project(flat, 0, flat.r, 0).y).toBeCloseTo(flat.r / 2, 5)
    const g = pieGeometry(view(30, 30), 0, 0, 561.5, 361.5, 0, 0)
    const back = g.cy - project(g, 0, g.r, 0).y
    const front = project(g, Math.PI, g.r, 0).y - g.cy
    expect(front / back).toBeCloseTo(1.1, 1)
  })

  test('有 view3D 时按三维绘制，没有 view3D 时按平面饼图绘制', () => {
    const pie = (v: string) =>
      chartXml(
        `<c:pie3DChart><c:varyColors val="1"/>${ser(0, 'a', [8.2, 3.2, 1.4])}</c:pie3DChart>`,
        v,
      )
    const three = resolved(pie('<c:view3D><c:rotX val="30"/></c:view3D>'))
    expect(three.plot.groups[0]!.threeD).toBe(true)
    expect(three.view3D).toEqual(view(30, 30))
    expect(resolved(pie('')).view3D).toBeNull()
    const ctx = new RecordingContext()
    const frame = {
      x: 0,
      y: 0,
      width: 300 * 9525,
      height: 200 * 9525,
      rotation: 0,
      flipH: false,
      flipV: false,
    }
    const scene = {
      ctx,
      res: { image: () => null, createCanvas: canvasFactory().create },
      scale: 1,
      canvas: { width: 300, height: 200 },
      settings: SETTINGS,
    }
    paintChart(scene, three, frame, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    // 图表区、三个顶面与可见的侧面各有填充。
    expect(ctx.named('fill').length).toBeGreaterThanOrEqual(6)
  })
})

describe('垂直线与趋势线', () => {
  const trend = (body: string) => `<c:trendline>${body}</c:trendline>`
  const linear = '<c:trendlineType val="linear"/><c:dispRSqr val="0"/><c:dispEq val="0"/>'
  const blue =
    '<c:spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="0070C0"/></a:solidFill></a:ln></c:spPr>'
  const red =
    '<c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></c:spPr>'
  const line = (series: string, drop = '') =>
    chartXml(
      `<c:lineChart><c:grouping val="standard"/>${series}${drop}<c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`,
      '<c:legend><c:legendPos val="b"/></c:legend>',
    )

  test('垂直线与线性趋势线：未写出格式时为 0.75 磅 tx1；趋势线的图例项排在全部系列之后', () => {
    const chart = resolved(
      line(
        ser(0, '丙', [2, 3, 4], trend(linear)) +
          ser(1, '甲', [1, 2, 1], trend(`<c:name>趋势</c:name>${blue}${linear}`)),
        '<c:dropLines/>',
      ),
    )
    const g = chart.plot.groups[0]!
    expect(g.dropLines?.width).toBe(9525)
    expect(g.dropLines?.fill).toEqual({ kind: 'solid', color: parseHexColor('000000')! })
    const [a, b] = g.series
    expect(a!.trendlines.map((t) => t.name)).toEqual(['线性 (丙)'])
    expect(a!.trendlines[0]!.line?.width).toBe(9525)
    expect(b!.trendlines[0]!.name).toBe('趋势')
    expect(b!.trendlines[0]!.line?.width).toBe(25400)
    const legend = layoutChart(chart, 400, 300, SETTINGS).legend!
    expect(legend.entries.map((e) => e.text.layout.paragraphs[0]!.runs.length > 0)).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(legend.entries.map((e) => (e.trend === null ? e.series.name : e.trend.name))).toEqual([
      '丙',
      '甲',
      '线性 (丙)',
      '趋势',
    ])
  })

  test('线性以外的趋势线、显示公式或 R²、外推，以及散点图与堆积图的趋势线使整个图表不绘制', () => {
    const none = (series: string) => resolveChart(readChart(line(series), EMPTY_RELS), SCOPE)
    expect(
      none(ser(0, 'a', [1, 2], trend('<c:trendlineType val="poly"/><c:order val="2"/>'))),
    ).toBeNull()
    expect(
      none(ser(0, 'a', [1, 2], trend('<c:trendlineType val="linear"/><c:dispEq val="1"/>'))),
    ).toBeNull()
    expect(
      none(ser(0, 'a', [1, 2], trend('<c:trendlineType val="linear"/><c:forward val="1"/>'))),
    ).toBeNull()
    const stacked = line(ser(0, 'a', [1, 2], trend(linear))).replace(
      '<c:grouping val="standard"/>',
      '<c:grouping val="stacked"/>',
    )
    expect(resolveChart(readChart(stacked, EMPTY_RELS), SCOPE)).toBeNull()
  })

  test('垂直线每个分类一条，覆盖各系列的点与分类轴之间；趋势线按最小二乘拟合，画在系列之后', () => {
    const chart = resolved(
      line(
        ser(0, '丙', [2, 3, 4], trend(blue + linear)) + ser(1, '甲', [-1, 2, 1]),
        `<c:dropLines>${red}</c:dropLines>`,
      ),
    )
    const ctx = new RecordingContext()
    const frame = {
      x: 0,
      y: 0,
      width: 400 * 9525,
      height: 300 * 9525,
      rotation: 0,
      flipH: false,
      flipV: false,
    }
    const scene = {
      ctx,
      res: { image: () => null, createCanvas: canvasFactory().create },
      scale: 1,
      canvas: { width: 400, height: 300 },
      settings: SETTINGS,
    }
    paintChart(scene, chart, frame, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    const layout = layoutChart(chart, 400, 300, SETTINGS)
    const strokes = ctx.calls.filter((c) => c.name === 'stroke')
    const redStroke = strokes.findIndex(
      (c) =>
        String(c.strokeStyle).includes('255, 0, 0') ||
        String(c.strokeStyle).toLowerCase().includes('ff0000'),
    )
    const blueStrokes = strokes.filter(
      (c) =>
        String(c.strokeStyle).includes('0, 112, 192') ||
        String(c.strokeStyle).toLowerCase().includes('0070c0'),
    )
    expect(redStroke).toBeGreaterThanOrEqual(0)
    // 趋势线与其图例符号各一次。
    expect(blueStrokes.length).toBe(2)
    // 垂直线的路径：第二个分类的两个点（3 与 2）与分类轴（0）之间为 0–3，第一个分类为 −1–2。
    const vs = layout.axes.find((a) => a.scale !== null)!.scale!
    expect(vs.min).toBeLessThan(0)
    const plot = layout.plot
    const y = (v: number) => plot.y + plot.h - ((v - vs.min) / (vs.max - vs.min)) * plot.h
    const path = ctx.calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
    const vertical: [number, number][] = []
    path.forEach((c, i) => {
      const next = path[i + 1]
      if (c.name !== 'moveTo' || next?.name !== 'lineTo') return
      const [x0, y0] = c.args as number[]
      const [x1, y1] = next.args as number[]
      if (Math.abs(x0! - x1!) < 1e-9) vertical.push([y0!, y1!])
    })
    const has = (lo: number, hi: number) =>
      vertical.some(([a, b]) => Math.abs(a - y(lo)) < 1e-6 && Math.abs(b - y(hi)) < 1e-6)
    expect(has(2, -1)).toBe(true)
    expect(has(3, 0)).toBe(true)
  })
})

describe('图表文字的字体与字形', () => {
  test('主题的东亚字体为空时取简体中文的文种字体，与 c:lang 无关', () => {
    const plain = resolved(chartXml(barChart(ser(0, 'a', [1, 2]))))
    expect(plain.plot.axes[0]!.text.run.ea).toBe('等线')
    const english = resolved(chartXml(barChart(ser(0, 'a', [1, 2])), '', '<c:lang val="en-US"/>'))
    expect(english.plot.axes[0]!.text.run.ea).toBe('等线')
  })

  test('FaceCache 的 glyphs 只改变绘制：行高与基线同演示文稿，有点阵的字形按点阵画在整数坐标上', () => {
    const glyph = {
      width: 2,
      height: 2,
      bearingX: 0,
      bearingY: 2,
      advance: 2,
      pixels: new Uint8Array([1, 1, 1, 1]),
    }
    const bitmaps: ScreenText = {
      bitmap: (_f, cp) => (cp === 0x56fd ? { glyph, ascent: 14, descent: 2 } : null),
    }
    const source = {
      face: () => null,
      fallback: { face: fakeFace(), family: 'F', bold: false, italic: false },
    }
    const body = labelBody('国中', {
      ...resolved(chartXml(barChart(ser(0, 'a', [1])))).plot.axes[0]!.text.run,
      size: 12,
    })
    const plainFaces = new FaceCache(source)
    const drawn = new FaceCache(source, SINGLE_LINE, null, bitmaps)
    expect(drawn.screen).toBeNull()
    const a = layoutBody(body, 200, { faces: plainFaces, slideNumber: null })
    const b = layoutBody(body, 200, { faces: drawn, slideNumber: null })
    expect(b.paragraphs[0]!.block.lines[0]!.baseline).toBe(
      a.paragraphs[0]!.block.lines[0]!.baseline,
    )
    expect(b.height).toBe(a.height)
    const ctx = new RecordingContext()
    const target = {
      matrix: { a: 4 / 3, b: 0, c: 0, d: 4 / 3, e: 10.3, f: 20.4 },
      width: 150,
      height: 100,
      scale: 1,
    }
    const res = { image: () => null, createCanvas: canvasFactory().create }
    paintBody(ctx, b, target, drawn, res, { width: 400, height: 400 }, [])
    expect(ctx.named('fillRect').length).toBe(2)
    expect(ctx.named('fillText').map((c) => c.args[0])).toEqual(['中'])
  })
})

describe('数据标签的自定义文字与手动位置', () => {
  const LABELS_TXPR =
    '<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr></a:p></c:txPr><c:showVal val="1"/>'
  const label = (idx: number, inner: string) =>
    `<c:dLbl><c:idx val="${idx}"/>${inner}<c:showVal val="1"/></c:dLbl>`
  const rich = (runs: string) => `<c:tx><c:rich><a:bodyPr/><a:p>${runs}</a:p></c:rich></c:tx>`
  // 坐标轴删除：图中的文字只有数据标签。
  const withLabels = (points: string) =>
    chartXml(
      `<c:barChart><c:barDir val="col"/>${ser(0, 'a', [1, 2, 3], `<c:dLbls>${points}${LABELS_TXPR}</c:dLbls>`)}` +
        `<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES.replaceAll('<c:delete val="0"/>', '<c:delete val="1"/>')}`,
    )
  const frame = {
    x: 0,
    y: 0,
    width: 300 * 9525,
    height: 200 * 9525,
    rotation: 0,
    flipH: false,
    flipV: false,
  }
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  /** 各字的设备坐标。 */
  const drawn = (chart: Chart) => {
    const ctx = new RecordingContext()
    const scene = {
      ctx,
      res: { image: () => null, createCanvas: canvasFactory().create },
      scale: 1,
      canvas: { width: 300, height: 200 },
      settings: SETTINGS,
    }
    paintChart(scene, chart, frame, identity)
    return ctx.named('fillText').map((c) => {
      const [text, x, y] = c.args as [string, number, number]
      const m = c.matrix
      return { text, x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
    })
  }

  /** 原始失败形状：生物科技模板第 3 页的两个柱形图带单个标签的自定义文字，整个图表计入不支持而不绘制。 */
  test('自定义文字取代该点的数值，字段属性覆盖标签的 txPr，其余点仍为数值', () => {
    const chart = resolved(
      withLabels(label(1, rich('<a:r><a:rPr sz="1400" b="1"/><a:t>粗红</a:t></a:r>'))),
    )
    const s = chart.plot.groups[0]!.series[0]!
    const own = s.pointLabels.get(1)!.rich!.paragraphs[0]!.runs[0]!
    expect(own.kind === 'text' ? [own.text, own.style.size, own.style.bold] : null).toEqual([
      '粗红',
      14,
      true,
    ])
    expect(s.labels?.rich).toBeNull()
    const texts = drawn(chart).map((g) => g.text)
    expect(texts).toContain('粗')
    expect(texts).toContain('3')
    expect(texts).not.toContain('2')
  })

  test('自定义文字含字段时整个图表不绘制', () => {
    const field = rich('<a:fld id="{1}" type="VALUE"><a:rPr/><a:t>[值]</a:t></a:fld>')
    expect(resolveChart(readChart(withLabels(label(0, field)), EMPTY_RELS), SCOPE)).toBeNull()
  })

  /** 原始失败形状：`c:dLbl/c:layout` 不读取，移动过的标签画在自动位置。 */
  test('手动位置按图表区宽高的比例偏移自动位置', () => {
    const layout =
      '<c:layout><c:manualLayout><c:x val="0.1"/><c:y val="-0.1"/></c:manualLayout></c:layout>'
    const plain = drawn(resolved(withLabels(''))).find((g) => g.text === '1')!
    const moved = drawn(resolved(withLabels(label(0, layout)))).find((g) => g.text === '1')!
    expect(moved.x - plain.x).toBeCloseTo(30, 6)
    expect(moved.y - plain.y).toBeCloseTo(-20, 6)
  })
})
