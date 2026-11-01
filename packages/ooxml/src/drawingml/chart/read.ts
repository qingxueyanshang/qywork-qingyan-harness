/**
 * 图表部件（`c:chartSpace`）的读取：只记录文档中出现的内容（规格），缺省值与颜色在 `resolve.ts` 中求值。
 *
 * - `AlternateContent` 不声明支持任何扩展命名空间，因此取 `Fallback`。`c:style` 不读取：未写出的格式一律按
 *   未写出 `c:style` 时的 WPS 显示求值（见 `resolve.ts`）。
 * - 布尔元素（`CT_Boolean`）的 `val` 缺省为真：`<c:delete/>` 即删除。
 * - 实现的图表类型见 `PLOT_TYPES`（三维图表只实现三维饼图）；其余类型（其他三维图表、面积图、雷达图、气泡图、股价图、曲面图、复合饼图），
 *   以及系列轴、对数刻度、显示单位、次要网格线与次要刻度线、数据表、趋势线、误差线、涨跌柱、
 *   高低点连线、垂直线与系列线、负值反色、图例项标示与单个数据标签的自定义文字，使整个图表不绘制：
 *   读取结果的 `unsupported` 为真。
 * - 缓存数据按 `pt/@idx` 放入数组，缺失的点为 `null`；`ptCount` 决定数组长度。多级分类只取最内层。
 *   引用（`c:f`）原文一并记录：有工作簿的格式按引用从单元格重新取值（见 `resolve.ts` 的 `ChartCells`）。
 */

import type { Relationships } from '../../opc/package.ts'
import { bool, eachChild, num, readText, type Scanner, skip } from '../../opc/read.ts'
import { PartScanner } from '../../opc/scanner.ts'
import type { EffectSpec, FillSpec, LineSpec } from '../fill.ts'
import { readShapeProps } from '../shape/read.ts'
import { type RawTextBody, readTextBody, type TextContext } from '../text/read.ts'
import type { ManualLayout, PlotType } from './model.ts'

export interface BoxSpec {
  readonly fill: FillSpec | null
  readonly line: LineSpec | null
  readonly effects: readonly EffectSpec[] | null
}

export const EMPTY_BOX: BoxSpec = { fill: null, line: null, effects: null }

export interface RawTitle {
  /** `c:tx/c:rich`；`null` 为自动标题（系列名）。 */
  readonly rich: RawTextBody | null
  /** `c:tx/c:strRef` 的缓存文字。 */
  readonly text: string | null
  readonly overlay: boolean
  readonly layout: ManualLayout | null
  readonly box: BoxSpec
  readonly txPr: RawTextBody | null
}

export interface RawMarker {
  readonly symbol: string | null
  readonly size: number | null
  readonly box: BoxSpec
}

export interface RawLabels {
  readonly deleted: boolean
  readonly showValue: boolean | null
  readonly showCategory: boolean | null
  readonly showSeries: boolean | null
  readonly showPercent: boolean | null
  readonly position: string | null
  readonly format: string | null
  readonly separator: string | null
  readonly box: BoxSpec
  readonly txPr: RawTextBody | null
  /** `c:dLbl`：按点下标的单独标签。 */
  readonly points: ReadonlyMap<number, RawLabels>
}

export interface RawPoint {
  readonly index: number
  readonly box: BoxSpec
  readonly marker: RawMarker | null
  readonly explosion: number | null
}

export interface RawData {
  /** 引用原文（`c:f`）；字面值（`numLit`、`strLit`）为 `null`。 */
  readonly ref: string | null
  /** 文字缓存（`strCache`、`strLit`、多级分类的最内层）；数值缓存时为 `null`。 */
  readonly strings: readonly (string | null)[] | null
  readonly numbers: readonly (number | null)[] | null
  /** 数值缓存的格式代码（`formatCode`），各点的 `formatCode` 属性覆盖它。 */
  readonly format: string
  readonly pointFormats: ReadonlyMap<number, string>
  /** 值为 `#N/A` 的点（只来自单元格）：不绘制，折线跨过该点连接。 */
  readonly missing: ReadonlySet<number>
}

export interface RawSeries {
  readonly index: number
  readonly order: number
  readonly name: string | null
  /** 系列名的引用原文（`c:tx/c:strRef/c:f`）。 */
  readonly nameRef: string | null
  readonly box: BoxSpec
  readonly marker: RawMarker | null
  readonly points: readonly RawPoint[]
  readonly labels: RawLabels | null
  readonly categories: RawData | null
  readonly values: RawData | null
  readonly smooth: boolean | null
  readonly explosion: number | null
}

export interface RawGroup {
  readonly type: PlotType
  readonly direction: 'col' | 'bar'
  readonly grouping: string | null
  readonly varyColors: boolean | null
  readonly gapWidth: number | null
  readonly overlap: number | null
  readonly series: readonly RawSeries[]
  readonly labels: RawLabels | null
  readonly axes: readonly number[]
  readonly firstSliceAngle: number | null
  readonly holeSize: number | null
  readonly scatterStyle: string | null
  /** 折线图的 `c:marker`（是否显示自动标记）。 */
  readonly markers: boolean | null
  /** `pie3DChart`。 */
  readonly threeD: boolean
}

/** `c:view3D`：未写出的项为 `null`。 */
export interface RawView3D {
  readonly rotX: number | null
  readonly rotY: number | null
  readonly perspective: number | null
  readonly rightAngle: boolean | null
  readonly heightPercent: number | null
}

export interface RawAxis {
  readonly id: number
  readonly kind: 'category' | 'value'
  /** `c:dateAx`。 */
  readonly date: boolean
  /** `c:auto`：分类轴按数据自动选择日期轴；未写出为 `null`。 */
  readonly auto: boolean | null
  readonly baseTimeUnit: string | null
  readonly majorTimeUnit: string | null
  readonly crossAx: number | null
  readonly title: RawTitle | null
  readonly position: string | null
  readonly deleted: boolean
  readonly orientation: string | null
  readonly min: number | null
  readonly max: number | null
  readonly majorUnit: number | null
  readonly crosses: string | null
  readonly crossesAt: number | null
  readonly crossBetween: string | null
  /** 元素出现时为线条规格（可能为空规格），未出现时为 `null`。 */
  readonly majorGridlines: BoxSpec | null
  readonly majorTickMark: string | null
  readonly tickLabelPosition: string | null
  readonly format: string | null
  readonly sourceLinked: boolean
  readonly box: BoxSpec
  readonly txPr: RawTextBody | null
  readonly labelSkip: number | null
}

export interface RawLegend {
  readonly position: string | null
  readonly overlay: boolean
  readonly layout: ManualLayout | null
  readonly box: BoxSpec
  readonly txPr: RawTextBody | null
  readonly hidden: readonly number[]
}

export interface RawChart {
  readonly date1904: boolean
  readonly roundedCorners: boolean | null
  readonly title: RawTitle | null
  readonly autoTitleDeleted: boolean | null
  readonly plotLayout: ManualLayout | null
  readonly plotBox: BoxSpec
  readonly groups: readonly RawGroup[]
  readonly axes: readonly RawAxis[]
  readonly legend: RawLegend | null
  readonly view3D: RawView3D | null
  readonly blanks: string | null
  /** `plotVisOnly`：为真时不取隐藏行列中的单元格；未写出时为真。 */
  readonly visibleOnly: boolean
  readonly box: BoxSpec
  readonly txPr: RawTextBody | null
  /** 含未实现的图表类型、数据表或三维视图以外的不支持内容时为真：整个图表不绘制。 */
  readonly unsupported: boolean
}

const PLOT_TYPES: Readonly<Record<string, PlotType>> = {
  barChart: 'bar',
  lineChart: 'line',
  scatterChart: 'scatter',
  pieChart: 'pie',
  doughnutChart: 'doughnut',
  pie3DChart: 'pie',
}

const OTHER_TYPES = new Set([
  'bar3DChart',
  'line3DChart',
  'areaChart',
  'area3DChart',
  'radarChart',
  'bubbleChart',
  'stockChart',
  'surfaceChart',
  'surface3DChart',
  'ofPieChart',
])

const AXES: Readonly<Record<string, RawAxis['kind']>> = {
  catAx: 'category',
  dateAx: 'category',
  valAx: 'value',
}

/** `CT_Boolean`：`val` 缺省为真。 */
function flag(x: Scanner): boolean {
  return bool(x, 'val') ?? true
}

function val(x: Scanner): string | null {
  return x.attr('val')
}

function numVal(x: Scanner): number | null {
  return num(x, 'val')
}

class Reader {
  /** 读取中遇到的未实现内容；为真时整个图表不绘制。 */
  unsupported = false

  constructor(
    private readonly x: Scanner,
    private readonly cx: TextContext,
  ) {}

  box(): BoxSpec {
    const p = readShapeProps(this.x, this.cx)
    return { fill: p.fill, line: p.line, effects: p.effects }
  }

  layout(): ManualLayout | null {
    const x = this.x
    let out: ManualLayout | null = null
    eachChild(x, (local) => {
      if (local !== 'manualLayout') return
      let target: ManualLayout['target'] = 'outer'
      let xMode: ManualLayout['xMode'] = 'factor'
      let yMode: ManualLayout['yMode'] = 'factor'
      const v: { x: number | null; y: number | null; w: number | null; h: number | null } = {
        x: null,
        y: null,
        w: null,
        h: null,
      }
      eachChild(x, (k) => {
        if (k === 'layoutTarget') target = val(x) === 'inner' ? 'inner' : 'outer'
        else if (k === 'xMode') xMode = val(x) === 'edge' ? 'edge' : 'factor'
        else if (k === 'yMode') yMode = val(x) === 'edge' ? 'edge' : 'factor'
        else if (k === 'x' || k === 'y' || k === 'w' || k === 'h') v[k] = numVal(x)
      })
      out = { target, xMode, yMode, ...v }
    })
    return out
  }

  /** `c:tx`：`rich` 或 `strRef`/`v` 的文字，`ref` 为 `strRef` 的引用原文。 */
  private tx(): { rich: RawTextBody | null; text: string | null; ref: string | null } {
    const x = this.x
    let rich: RawTextBody | null = null
    let text: string | null = null
    let ref: string | null = null
    eachChild(x, (local) => {
      if (local === 'rich') rich = readTextBody(x, this.cx)
      else if (local === 'v') text = readText(x)
      else if (local === 'strRef') {
        // 引用多个单元格时，缓存中的各点以空格连接。
        const parts: string[] = []
        eachChild(x, (child) => {
          if (child === 'f') {
            ref = readText(x)
            return
          }
          if (child !== 'strCache') return
          eachChild(x, (pt) => {
            if (pt !== 'pt') return
            eachChild(x, (v) => {
              if (v === 'v') parts.push(readText(x))
            })
          })
        })
        text = parts.join(' ')
      }
    })
    return { rich, text, ref }
  }

  title(): RawTitle {
    const x = this.x
    let rich: RawTextBody | null = null
    let text: string | null = null
    let overlay = false
    let layout: ManualLayout | null = null
    let box = EMPTY_BOX
    let txPr: RawTextBody | null = null
    eachChild(x, (local) => {
      if (local === 'tx') ({ rich, text } = this.tx())
      else if (local === 'overlay') overlay = flag(x)
      else if (local === 'layout') layout = this.layout()
      else if (local === 'spPr') box = this.box()
      else if (local === 'txPr') txPr = readTextBody(x, this.cx)
    })
    return { rich, text, overlay, layout, box, txPr }
  }

  marker(): RawMarker {
    const x = this.x
    let symbol: string | null = null
    let size: number | null = null
    let box = EMPTY_BOX
    eachChild(x, (local) => {
      if (local === 'symbol') symbol = val(x)
      else if (local === 'size') size = numVal(x)
      else if (local === 'spPr') box = this.box()
    })
    return { symbol, size, box }
  }

  /** `c:dLbls` 与 `c:dLbl`：`dLbl` 另有 `idx`，经 `onIndex` 报告。 */
  labels(onIndex: (index: number) => void = () => {}): RawLabels {
    const x = this.x
    const out = {
      deleted: false,
      showValue: null as boolean | null,
      showCategory: null as boolean | null,
      showSeries: null as boolean | null,
      showPercent: null as boolean | null,
      position: null as string | null,
      format: null as string | null,
      separator: null as string | null,
      box: EMPTY_BOX,
      txPr: null as RawTextBody | null,
    }
    const points = new Map<number, RawLabels>()
    eachChild(x, (local) => {
      if (local === 'dLbl') {
        let index = -1
        const label = this.labels((i) => {
          index = i
        })
        if (index >= 0) points.set(index, label)
      } else if (local === 'idx') onIndex(numVal(x) ?? -1)
      else if (local === 'delete') out.deleted = flag(x)
      else if (local === 'showVal') out.showValue = flag(x)
      else if (local === 'showCatName') out.showCategory = flag(x)
      else if (local === 'showSerName') out.showSeries = flag(x)
      else if (local === 'showPercent') out.showPercent = flag(x)
      else if (local === 'showLegendKey') this.unsupported ||= flag(x)
      else if (local === 'tx') {
        // 单个标签的自定义文字未实现。
        this.unsupported = true
        skip(x)
      } else if (local === 'dLblPos') out.position = val(x)
      else if (local === 'numFmt') {
        if (bool(x, 'sourceLinked') !== true) out.format = x.attr('formatCode')
      } else if (local === 'separator') out.separator = readText(x)
      else if (local === 'spPr') out.box = this.box()
      else if (local === 'txPr') out.txPr = readTextBody(x, this.cx)
    })
    return { ...out, points }
  }

  /** `numRef`、`strRef`、`numLit`、`strLit`、`multiLvlStrRef` 及其缓存。 */
  data(): RawData {
    const x = this.x
    let strings: (string | null)[] | null = null
    let numbers: (number | null)[] | null = null
    let format = 'General'
    let ref: string | null = null
    const pointFormats = new Map<number, string>()
    const cache = (kind: 'str' | 'num') => {
      const list: (string | null)[] = []
      eachChild(x, (local) => {
        if (local === 'ptCount') list.length = Math.max(0, Math.min(numVal(x) ?? 0, 1 << 20))
        else if (local === 'formatCode') format = readText(x) || 'General'
        else if (local === 'pt') {
          const idx = num(x, 'idx')
          const own = x.attr('formatCode')
          let v: string | null = null
          eachChild(x, (c) => {
            if (c === 'v') v = readText(x)
          })
          if (idx === null || idx < 0 || idx >= 1 << 20) return
          if (idx >= list.length) list.length = idx + 1
          list[idx] = v
          if (own !== null && kind === 'num') pointFormats.set(idx, own)
        } else if (local === 'lvl') {
          // 多级分类：第一个 `lvl` 为最内层。
          if (strings === null) strings = cache('str') as (string | null)[]
          else skip(x)
        }
      })
      for (let i = 0; i < list.length; i++) if (list[i] === undefined) list[i] = null
      return list
    }
    eachChild(x, (local) => {
      if (local === 'numRef' || local === 'strRef' || local === 'multiLvlStrRef') {
        eachChild(x, (c) => {
          if (c === 'f') ref = readText(x)
          else if (c === 'numCache') numbers = toNumbers(cache('num'))
          else if (c === 'strCache') strings = cache('str')
          else if (c === 'multiLvlStrCache') {
            const own = cache('str')
            strings ??= own
          }
        })
      } else if (local === 'numLit') numbers = toNumbers(cache('num'))
      else if (local === 'strLit') strings = cache('str')
    })
    return { ref, strings, numbers, format, pointFormats, missing: NO_POINTS }
  }

  point(): RawPoint {
    const x = this.x
    let index = -1
    let box = EMPTY_BOX
    let marker: RawMarker | null = null
    let explosion: number | null = null
    eachChild(x, (local) => {
      if (local === 'idx') index = numVal(x) ?? -1
      else if (local === 'spPr') box = this.box()
      else if (local === 'marker') marker = this.marker()
      else if (local === 'explosion') explosion = numVal(x)
    })
    return { index, box, marker, explosion }
  }

  series(): RawSeries {
    const x = this.x
    let index = 0
    let order = 0
    let name: string | null = null
    let nameRef: string | null = null
    let box = EMPTY_BOX
    let marker: RawMarker | null = null
    const points: RawPoint[] = []
    let labels: RawLabels | null = null
    let categories: RawData | null = null
    let values: RawData | null = null
    let smooth: boolean | null = null
    let explosion: number | null = null
    eachChild(x, (local) => {
      switch (local) {
        case 'idx':
          index = numVal(x) ?? 0
          return
        case 'order':
          order = numVal(x) ?? 0
          return
        case 'tx': {
          const t = this.tx()
          name = t.text ?? ''
          nameRef = t.ref
          return
        }
        case 'spPr':
          box = this.box()
          return
        case 'marker':
          marker = this.marker()
          return
        case 'dPt':
          points.push(this.point())
          return
        case 'dLbls':
          labels = this.labels()
          return
        case 'cat':
        case 'xVal':
          categories = this.data()
          return
        case 'val':
        case 'yVal':
          values = this.data()
          return
        case 'smooth':
          smooth = flag(x)
          return
        case 'invertIfNegative':
          this.unsupported ||= flag(x)
          return
        case 'explosion':
          explosion = numVal(x)
          return
        case 'bubbleSize':
        case 'trendline':
        case 'errBars':
          if (local !== 'bubbleSize') this.unsupported = true
          skip(x)
          return
      }
    })
    return {
      index,
      order,
      name,
      nameRef,
      box,
      marker,
      points,
      labels,
      categories,
      values,
      smooth,
      explosion,
    }
  }

  view3D(): RawView3D {
    const x = this.x
    const out = {
      rotX: null as number | null,
      rotY: null as number | null,
      perspective: null as number | null,
      rightAngle: null as boolean | null,
      heightPercent: null as number | null,
    }
    eachChild(x, (local) => {
      if (local === 'rotX') out.rotX = numVal(x)
      else if (local === 'rotY') out.rotY = numVal(x)
      else if (local === 'perspective') out.perspective = numVal(x)
      else if (local === 'rAngAx') out.rightAngle = flag(x)
      else if (local === 'hPercent') out.heightPercent = Number.parseFloat(val(x) ?? '') || null
    })
    return out
  }

  group(type: PlotType, threeD: boolean): RawGroup {
    const x = this.x
    let direction: RawGroup['direction'] = 'col'
    let grouping: string | null = null
    let varyColors: boolean | null = null
    let gapWidth: number | null = null
    let overlap: number | null = null
    const series: RawSeries[] = []
    let labels: RawLabels | null = null
    const axes: number[] = []
    let firstSliceAngle: number | null = null
    let holeSize: number | null = null
    let scatterStyle: string | null = null
    let markers: boolean | null = null
    eachChild(x, (local) => {
      switch (local) {
        case 'barDir':
          direction = val(x) === 'bar' ? 'bar' : 'col'
          return
        case 'grouping':
          grouping = val(x)
          return
        case 'varyColors':
          varyColors = flag(x)
          return
        case 'ser':
          series.push(this.series())
          return
        case 'dLbls':
          labels = this.labels()
          return
        case 'gapWidth':
          gapWidth = numVal(x)
          return
        case 'overlap':
          overlap = numVal(x)
          return
        case 'axId': {
          const id = numVal(x)
          if (id !== null) axes.push(id)
          return
        }
        case 'firstSliceAng':
          firstSliceAngle = numVal(x)
          return
        case 'holeSize':
          holeSize = numVal(x)
          return
        case 'scatterStyle':
          scatterStyle = val(x)
          return
        case 'marker':
          markers = flag(x)
          return
        case 'upDownBars':
        case 'hiLowLines':
        case 'dropLines':
        case 'serLines':
          this.unsupported = true
          skip(x)
          return
      }
    })
    series.sort((a, b) => a.order - b.order)
    return {
      type,
      direction,
      grouping,
      varyColors,
      gapWidth,
      overlap,
      series,
      labels,
      axes,
      firstSliceAngle,
      holeSize,
      scatterStyle,
      markers,
      threeD,
    }
  }

  axis(kind: RawAxis['kind'], date: boolean): RawAxis {
    const x = this.x
    const out = {
      id: 0,
      kind,
      date,
      auto: null as boolean | null,
      baseTimeUnit: null as string | null,
      majorTimeUnit: null as string | null,
      crossAx: null as number | null,
      title: null as RawTitle | null,
      position: null as string | null,
      deleted: false,
      orientation: null as string | null,
      min: null as number | null,
      max: null as number | null,
      majorUnit: null as number | null,
      crosses: null as string | null,
      crossesAt: null as number | null,
      crossBetween: null as string | null,
      majorGridlines: null as BoxSpec | null,
      majorTickMark: null as string | null,
      tickLabelPosition: null as string | null,
      format: null as string | null,
      sourceLinked: true,
      box: EMPTY_BOX,
      txPr: null as RawTextBody | null,
      labelSkip: null as number | null,
    }
    const gridlines = (): BoxSpec => {
      let box = EMPTY_BOX
      eachChild(x, (local) => {
        if (local === 'spPr') box = this.box()
      })
      return box
    }
    eachChild(x, (local) => {
      switch (local) {
        case 'axId':
          out.id = numVal(x) ?? 0
          return
        case 'scaling':
          eachChild(x, (s) => {
            if (s === 'orientation') out.orientation = val(x)
            else if (s === 'min') out.min = numVal(x)
            else if (s === 'max') out.max = numVal(x)
            else if (s === 'logBase') this.unsupported = true
          })
          return
        case 'delete':
          out.deleted = flag(x)
          return
        case 'axPos':
          out.position = val(x)
          return
        case 'majorGridlines':
          out.majorGridlines = gridlines()
          return
        case 'minorGridlines':
          this.unsupported = true
          skip(x)
          return
        case 'title':
          out.title = this.title()
          return
        case 'auto':
          out.auto = flag(x)
          return
        case 'baseTimeUnit':
          out.baseTimeUnit = val(x)
          return
        case 'majorTimeUnit':
          out.majorTimeUnit = val(x)
          return
        case 'crossAx':
          out.crossAx = numVal(x)
          return
        case 'numFmt':
          out.format = x.attr('formatCode')
          out.sourceLinked = bool(x, 'sourceLinked') ?? false
          return
        case 'majorTickMark':
          out.majorTickMark = val(x)
          return
        case 'minorTickMark':
          this.unsupported ||= val(x) !== 'none'
          return
        case 'tickLblPos':
          out.tickLabelPosition = val(x)
          return
        case 'spPr':
          out.box = this.box()
          return
        case 'txPr':
          out.txPr = readTextBody(x, this.cx)
          return
        case 'crosses':
          out.crosses = val(x)
          return
        case 'crossesAt':
          out.crossesAt = numVal(x)
          return
        case 'crossBetween':
          out.crossBetween = val(x)
          return
        case 'majorUnit':
          out.majorUnit = numVal(x)
          return
        case 'tickLblSkip':
          out.labelSkip = numVal(x)
          return
        case 'dispUnits':
          this.unsupported = true
          skip(x)
          return
      }
    })
    return out
  }

  legend(): RawLegend {
    const x = this.x
    let position: string | null = null
    let overlay = false
    let layout: ManualLayout | null = null
    let box = EMPTY_BOX
    let txPr: RawTextBody | null = null
    const hidden: number[] = []
    eachChild(x, (local) => {
      if (local === 'legendPos') position = val(x)
      else if (local === 'overlay') overlay = flag(x)
      else if (local === 'layout') layout = this.layout()
      else if (local === 'spPr') box = this.box()
      else if (local === 'txPr') txPr = readTextBody(x, this.cx)
      else if (local === 'legendEntry') {
        let idx = -1
        let deleted = false
        eachChild(x, (e) => {
          if (e === 'idx') idx = numVal(x) ?? -1
          else if (e === 'delete') deleted = flag(x)
        })
        if (deleted && idx >= 0) hidden.push(idx)
      }
    })
    return { position, overlay, layout, box, txPr, hidden }
  }

  plotArea(): { layout: ManualLayout | null; box: BoxSpec; groups: RawGroup[]; axes: RawAxis[] } {
    const x = this.x
    let layout: ManualLayout | null = null
    let box = EMPTY_BOX
    const groups: RawGroup[] = []
    const axes: RawAxis[] = []
    eachChild(x, (local) => {
      const type = PLOT_TYPES[local]
      const axis = AXES[local]
      if (type !== undefined) groups.push(this.group(type, local === 'pie3DChart'))
      else if (axis !== undefined) axes.push(this.axis(axis, local === 'dateAx'))
      else if (local === 'layout') layout = this.layout()
      else if (local === 'spPr') box = this.box()
      else if (OTHER_TYPES.has(local) || local === 'serAx' || local === 'dTable') {
        this.unsupported = true
        skip(x)
      }
    })
    return { layout, box, groups, axes }
  }
}

const NO_POINTS: ReadonlySet<number> = new Set()

function toNumbers(list: readonly (string | null)[]): (number | null)[] {
  return list.map((v) => {
    if (v === null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  })
}

/** 读取图表部件。`rels` 为图表部件的关系表（文字与填充中的图片引用）。 */
export function readChart(xml: string, rels: Relationships): RawChart {
  const x = new PartScanner(xml)
  const cx: TextContext = { rels, found: { push: () => 0 } }
  const r = new Reader(x, cx)
  let date1904 = false
  let roundedCorners: boolean | null = null
  let title: RawTitle | null = null
  let autoTitleDeleted: boolean | null = null
  let plot: ReturnType<Reader['plotArea']> = { layout: null, box: EMPTY_BOX, groups: [], axes: [] }
  let legend: RawLegend | null = null
  let view3D: RawView3D | null = null
  let blanks: string | null = null
  let visibleOnly = true
  let box = EMPTY_BOX
  let txPr: RawTextBody | null = null
  let root = false
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'start' && x.depth === 1) {
      root = x.local === 'chartSpace'
      break
    }
  }
  if (!root) return { ...EMPTY_CHART, unsupported: true }
  eachChild(x, (local) => {
    switch (local) {
      case 'date1904':
        date1904 = flag(x)
        return
      case 'roundedCorners':
        roundedCorners = flag(x)
        return
      case 'spPr':
        box = r.box()
        return
      case 'txPr':
        txPr = readTextBody(x, cx)
        return
      case 'chart':
        eachChild(x, (c) => {
          if (c === 'title') title = r.title()
          else if (c === 'autoTitleDeleted') autoTitleDeleted = flag(x)
          else if (c === 'plotArea') plot = r.plotArea()
          else if (c === 'legend') legend = r.legend()
          else if (c === 'dispBlanksAs') blanks = val(x)
          else if (c === 'plotVisOnly') visibleOnly = flag(x)
          else if (c === 'view3D') view3D = r.view3D()
          else if (c === 'floor' || c === 'sideWall' || c === 'backWall') skip(x)
        })
        return
    }
  })
  return {
    date1904,
    roundedCorners,
    title,
    autoTitleDeleted,
    plotLayout: plot.layout,
    plotBox: plot.box,
    groups: plot.groups,
    axes: plot.axes,
    legend,
    view3D,
    blanks,
    visibleOnly,
    box,
    txPr,
    unsupported: r.unsupported,
  }
}

const EMPTY_CHART: RawChart = {
  date1904: false,
  roundedCorners: null,
  title: null,
  autoTitleDeleted: null,
  plotLayout: null,
  plotBox: EMPTY_BOX,
  groups: [],
  axes: [],
  legend: null,
  view3D: null,
  blanks: null,
  visibleOnly: true,
  box: EMPTY_BOX,
  txPr: null,
  unsupported: false,
}
