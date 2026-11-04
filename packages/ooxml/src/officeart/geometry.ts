/**
 * OfficeArt 形状几何换算为 DrawingML 几何。
 *
 * - 有顶点属性（`pVertices`，0x0145）的形状按顶点与路径段（`pSegmentInfo`，0x0146）生成自定义几何，与形状类型无关：
 *   编辑过顶点的预设形状与 DrawingML 中没有对应预设的形状（如类型 100）都以顶点写出。
 *   坐标系为 `geoLeft`–`geoRight`、`geoTop`–`geoBottom`（0x0140–0x0143，缺省 0–21600）。
 * - 路径段：高 3 位为种类（直线、三次曲线、移动、闭合、结束、转义），低 13 位为个数；直线与曲线每段分别取 1 与 3 个顶点。
 *   转义段只实现不填充（0x0A）、不描边（0x0B）与只影响编辑方式的自动直线、自动曲线（0x0C、0x0D）；结束段之后为新的子路径，
 *   不填充与不描边作用于所在子路径。没有路径段时按 `shapePath`（0x0144）把全部顶点连为折线或曲线。
 * - 不支持（返回 `null`）：其他转义段（弧线、象限、二次曲线）、引用公式的顶点（8 字节元素中高 16 位为 0x8000 的值）、
 *   没有对应预设的形状类型。
 * - 预设形状的调整值在 21600 的形状坐标系中，横向按宽、纵向按高缩放；DrawingML 的调整值多以短边为基准，
 *   因此换算与形状尺寸有关（`ADJUST`）。表中没有的形状按 DrawingML 的缺省调整值绘制。
 */

import type { Geometry, GeometryPath, Guide, PathCommand } from '../drawingml/geometry/model.ts'
import { type ArtProperties, arrayElementSize } from './records.ts'

const PROP_GEO_LEFT = 0x0140
const PROP_GEO_TOP = 0x0141
const PROP_GEO_RIGHT = 0x0142
const PROP_GEO_BOTTOM = 0x0143
const PROP_SHAPE_PATH = 0x0144
const PROP_VERTICES = 0x0145
const PROP_SEGMENTS = 0x0146
const PROP_ADJUST = 0x0147

/** OfficeArt 形状类型（MSOSPT）对应的 DrawingML 预设几何名。 */
const PRESETS: Readonly<Record<number, string>> = {
  1: 'rect',
  2: 'roundRect',
  3: 'ellipse',
  4: 'diamond',
  5: 'triangle',
  6: 'rtTriangle',
  7: 'parallelogram',
  9: 'hexagon',
  10: 'octagon',
  11: 'plus',
  12: 'star5',
  13: 'rightArrow',
  15: 'homePlate',
  16: 'cube',
  19: 'arc',
  20: 'line',
  21: 'plaque',
  22: 'can',
  23: 'donut',
  32: 'straightConnector1',
  33: 'bentConnector2',
  34: 'bentConnector3',
  35: 'bentConnector4',
  36: 'bentConnector5',
  37: 'curvedConnector2',
  38: 'curvedConnector3',
  39: 'curvedConnector4',
  40: 'curvedConnector5',
  41: 'callout1',
  42: 'callout2',
  43: 'callout3',
  44: 'accentCallout1',
  45: 'accentCallout2',
  46: 'accentCallout3',
  47: 'borderCallout1',
  48: 'borderCallout2',
  49: 'borderCallout3',
  50: 'accentBorderCallout1',
  51: 'accentBorderCallout2',
  52: 'accentBorderCallout3',
  53: 'ribbon',
  54: 'ribbon2',
  55: 'chevron',
  56: 'pentagon',
  57: 'noSmoking',
  58: 'star8',
  59: 'star16',
  60: 'star32',
  61: 'wedgeRectCallout',
  62: 'wedgeRoundRectCallout',
  63: 'wedgeEllipseCallout',
  64: 'wave',
  65: 'foldedCorner',
  66: 'leftArrow',
  67: 'downArrow',
  68: 'upArrow',
  69: 'leftRightArrow',
  70: 'upDownArrow',
  71: 'irregularSeal1',
  72: 'irregularSeal2',
  73: 'lightningBolt',
  74: 'heart',
  75: 'rect',
  76: 'quadArrow',
  77: 'leftArrowCallout',
  78: 'rightArrowCallout',
  79: 'upArrowCallout',
  80: 'downArrowCallout',
  81: 'leftRightArrowCallout',
  82: 'upDownArrowCallout',
  83: 'quadArrowCallout',
  84: 'bevel',
  85: 'leftBracket',
  86: 'rightBracket',
  87: 'leftBrace',
  88: 'rightBrace',
  89: 'leftUpArrow',
  90: 'bentUpArrow',
  91: 'bentArrow',
  92: 'star24',
  93: 'stripedRightArrow',
  94: 'notchedRightArrow',
  95: 'blockArc',
  96: 'smileyFace',
  97: 'verticalScroll',
  98: 'horizontalScroll',
  99: 'circularArrow',
  101: 'uturnArrow',
  102: 'curvedRightArrow',
  103: 'curvedLeftArrow',
  104: 'curvedUpArrow',
  105: 'curvedDownArrow',
  106: 'cloudCallout',
  107: 'ellipseRibbon',
  108: 'ellipseRibbon2',
  109: 'flowChartProcess',
  110: 'flowChartDecision',
  111: 'flowChartInputOutput',
  112: 'flowChartPredefinedProcess',
  113: 'flowChartInternalStorage',
  114: 'flowChartDocument',
  115: 'flowChartMultidocument',
  116: 'flowChartTerminator',
  117: 'flowChartPreparation',
  118: 'flowChartManualInput',
  119: 'flowChartManualOperation',
  120: 'flowChartConnector',
  121: 'flowChartPunchedCard',
  122: 'flowChartPunchedTape',
  123: 'flowChartSummingJunction',
  124: 'flowChartOr',
  125: 'flowChartCollate',
  126: 'flowChartSort',
  127: 'flowChartExtract',
  128: 'flowChartMerge',
  129: 'flowChartOfflineStorage',
  130: 'flowChartOnlineStorage',
  131: 'flowChartMagneticTape',
  132: 'flowChartMagneticDisk',
  133: 'flowChartMagneticDrum',
  134: 'flowChartDisplay',
  135: 'flowChartDelay',
  176: 'flowChartAlternateProcess',
  177: 'flowChartOffpageConnector',
  178: 'callout1',
  179: 'accentCallout1',
  180: 'borderCallout1',
  181: 'accentBorderCallout1',
  182: 'leftRightUpArrow',
  183: 'sun',
  184: 'moon',
  185: 'bracketPair',
  186: 'bracePair',
  187: 'star4',
  188: 'doubleWave',
  189: 'actionButtonBlank',
  190: 'actionButtonHome',
  191: 'actionButtonHelp',
  192: 'actionButtonInformation',
  193: 'actionButtonForwardNext',
  194: 'actionButtonBackPrevious',
  195: 'actionButtonEnd',
  196: 'actionButtonBeginning',
  197: 'actionButtonReturn',
  198: 'actionButtonDocument',
  199: 'actionButtonSound',
  200: 'actionButtonMovie',
  202: 'rect',
}

/** 形状尺寸（EMU）：调整值换算用。 */
interface Size {
  readonly w: number
  readonly h: number
}

const S = 21600
/** 21600 坐标系中的长度 `a`（沿宽为 `along` = w，沿高为 h）换算为以短边为基准的 DrawingML 比例（1 为 100000）。 */
const bySide = (a: number, along: number, size: Size) =>
  (a / S) * (along / Math.max(Math.min(size.w, size.h), 1)) * 100000
const byShape = (a: number) => (a / S) * 100000
const tip = (a: number) => (a / S - 0.5) * 100000
const starInner = (a: number) => ((10800 - a) / 10800) * 50000
/** 16.16 定点数的角度换算为 DrawingML 的六万分之一度，取 [0°, 360°)。 */
const angle = (a: number) => ((((a / 65536) % 360) + 360) % 360) * 60000

/**
 * 预设形状调整值的换算：参数为 OfficeArt 调整值（缺省值已代入）与形状尺寸，结果依次为 `adj`、`adj1`… 的取值。
 * 缺省调整值取自 OfficeArt 各形状的定义。
 */
const ADJUST: Readonly<
  Record<number, { readonly defaults: readonly number[]; convert(a: number[], s: Size): number[] }>
> = {
  2: { defaults: [3600], convert: ([a], _) => [byShape(a!)] },
  5: { defaults: [10800], convert: ([a]) => [byShape(a!)] },
  7: { defaults: [5400], convert: ([a], s) => [bySide(a!, s.w, s)] },
  9: { defaults: [5400], convert: ([a], s) => [bySide(a!, s.w, s)] },
  13: {
    defaults: [16200, 5400],
    convert: ([a1, a2], s) => [((S - 2 * a2!) / S) * 100000, bySide(S - a1!, s.w, s)],
  },
  15: { defaults: [16200], convert: ([a], s) => [bySide(S - a!, s.w, s)] },
  19: { defaults: [-90 * 65536, 0], convert: ([a1, a2]) => [angle(a1!), angle(a2!)] },
  21: { defaults: [3600], convert: ([a]) => [byShape(a!)] },
  22: { defaults: [5400], convert: ([a], s) => [bySide(a!, s.h, s)] },
  23: { defaults: [5400], convert: ([a]) => [byShape(a!)] },
  55: { defaults: [16200], convert: ([a], s) => [bySide(S - a!, s.w, s)] },
  58: { defaults: [2538], convert: ([a]) => [starInner(a!)] },
  59: { defaults: [2700], convert: ([a]) => [starInner(a!)] },
  60: { defaults: [2700], convert: ([a]) => [starInner(a!)] },
  61: { defaults: [1350, 25920], convert: ([a1, a2]) => [tip(a1!), tip(a2!)] },
  62: { defaults: [1350, 25920], convert: ([a1, a2]) => [tip(a1!), tip(a2!), 16667] },
  63: { defaults: [1350, 25920], convert: ([a1, a2]) => [tip(a1!), tip(a2!)] },
  65: { defaults: [18900], convert: ([a]) => [byShape(S - a!)] },
  66: {
    defaults: [5400, 5400],
    convert: ([a1, a2], s) => [((S - 2 * a2!) / S) * 100000, bySide(a1!, s.w, s)],
  },
  67: {
    defaults: [16200, 5400],
    convert: ([a1, a2], s) => [((S - 2 * a2!) / S) * 100000, bySide(S - a1!, s.h, s)],
  },
  68: {
    defaults: [5400, 5400],
    convert: ([a1, a2], s) => [((S - 2 * a2!) / S) * 100000, bySide(a1!, s.h, s)],
  },
  69: {
    defaults: [4320, 5400],
    convert: ([a1, a2], s) => [((S - 2 * a2!) / S) * 100000, bySide(a1!, s.w, s)],
  },
  70: {
    defaults: [5400, 4320],
    convert: ([a1, a2], s) => [((S - 2 * a1!) / S) * 100000, bySide(a2!, s.h, s)],
  },
  84: { defaults: [2700], convert: ([a]) => [byShape(a!)] },
  85: { defaults: [1800], convert: ([a], s) => [bySide(a!, s.h, s)] },
  86: { defaults: [1800], convert: ([a], s) => [bySide(a!, s.h, s)] },
  87: {
    defaults: [1800, 10800],
    convert: ([a1, a2], s) => [bySide(a1!, s.h, s), byShape(a2!)],
  },
  88: {
    defaults: [1800, 10800],
    convert: ([a1, a2], s) => [bySide(a1!, s.h, s), byShape(a2!)],
  },
  92: { defaults: [2700], convert: ([a]) => [starInner(a!)] },
  97: { defaults: [2700], convert: ([a]) => [byShape(a!)] },
  98: { defaults: [2700], convert: ([a]) => [byShape(a!)] },
  106: { defaults: [1350, 25920], convert: ([a1, a2]) => [tip(a1!), tip(a2!)] },
  183: { defaults: [5400], convert: ([a]) => [byShape(a!)] },
  184: { defaults: [10800], convert: ([a], s) => [bySide(a!, s.w, s)] },
  185: { defaults: [3700], convert: ([a]) => [byShape(a!)] },
  186: { defaults: [1800], convert: ([a]) => [byShape(a!)] },
  187: { defaults: [8100], convert: ([a]) => [starInner(a!)] },
}

function adjustGuides(shapeType: number, props: ArtProperties, size: Size): Guide[] {
  const rule = ADJUST[shapeType]
  if (rule === undefined) return []
  const values = rule.defaults.map((d, i) => {
    const v = props.values.get(PROP_ADJUST + i)
    return v === undefined ? d : v | 0
  })
  const out = rule.convert(values, size)
  const names = out.length === 1 ? ['adj'] : out.map((_, i) => `adj${i + 1}`)
  return out.map((v, i) => ({ name: names[i]!, formula: `val ${Math.round(v)}` }))
}

interface ArtArray {
  readonly count: number
  readonly size: number
  readonly view: DataView
}

function readArray(data: Uint8Array | undefined): ArtArray | null {
  if (data === undefined || data.length < 6) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const size = arrayElementSize(view.getUint16(4, true))
  const count = Math.min(
    view.getUint16(0, true),
    size === 0 ? 0 : Math.floor((data.length - 6) / size),
  )
  return { count, size, view }
}

/** 顶点；有引用公式的顶点或元素大小无法识别时为 `null`。 */
function readVertices(data: Uint8Array | undefined): { x: number; y: number }[] | null {
  const a = readArray(data)
  if (a === null || (a.size !== 4 && a.size !== 8)) return null
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < a.count; i++) {
    const p = 6 + i * a.size
    if (a.size === 4) {
      out.push({ x: a.view.getInt16(p, true), y: a.view.getInt16(p + 2, true) })
      continue
    }
    const x = a.view.getUint32(p, true)
    const y = a.view.getUint32(p + 4, true)
    if (x >>> 16 === 0x8000 || y >>> 16 === 0x8000) return null
    out.push({ x: x | 0, y: y | 0 })
  }
  return out
}

const SEG_LINE = 0
const SEG_CURVE = 1
const SEG_MOVE = 2
const SEG_CLOSE = 3
const SEG_END = 4
const SEG_ESCAPE = 5
const ESC_NO_FILL = 0x0a
const ESC_NO_LINE = 0x0b
const ESC_AUTO_LINE = 0x0c
const ESC_AUTO_CURVE = 0x0d

/** 没有路径段时按 `shapePath` 生成：0、1 为折线（1 闭合），2、3 为曲线（3 闭合）。 */
function defaultSegments(count: number, shapePath: number): number[] {
  if (count === 0) return []
  const curves = shapePath === 2 || shapePath === 3
  const out = [(SEG_MOVE << 13) | 1]
  out.push(
    curves ? (SEG_CURVE << 13) | Math.floor((count - 1) / 3) : (SEG_LINE << 13) | (count - 1),
  )
  if (shapePath === 1 || shapePath === 3) out.push(SEG_CLOSE << 13)
  out.push(SEG_END << 13)
  return out
}

function customGeometry(props: ArtProperties): Geometry | null {
  const vertices = readVertices(props.complex.get(PROP_VERTICES))
  if (vertices === null) return null
  const left = (props.values.get(PROP_GEO_LEFT) ?? 0) | 0
  const top = (props.values.get(PROP_GEO_TOP) ?? 0) | 0
  const width = ((props.values.get(PROP_GEO_RIGHT) ?? S) | 0) - left
  const height = ((props.values.get(PROP_GEO_BOTTOM) ?? S) | 0) - top
  const array = readArray(props.complex.get(PROP_SEGMENTS))
  const segments =
    array === null || array.size !== 2
      ? defaultSegments(vertices.length, props.values.get(PROP_SHAPE_PATH) ?? 1)
      : Array.from({ length: array.count }, (_, i) => array.view.getUint16(6 + i * 2, true))

  const paths: GeometryPath[] = []
  let commands: PathCommand[] = []
  let fill = true
  let stroke = true
  let next = 0
  const point = () => {
    const v = vertices[next++]
    return v === undefined ? null : { x: v.x - left, y: v.y - top }
  }
  const finish = () => {
    if (commands.length > 0) {
      paths.push({ width, height, fill: fill ? 'norm' : 'none', stroke, commands })
    }
    commands = []
    fill = true
    stroke = true
  }
  for (const seg of segments) {
    const kind = seg >> 13
    const count = seg & 0x1fff
    if (kind === SEG_LINE || kind === SEG_MOVE) {
      for (let k = 0; k < Math.max(count, 1); k++) {
        const to = point()
        if (to === null) return null
        commands.push({ kind: kind === SEG_MOVE ? 'move' : 'line', to })
      }
    } else if (kind === SEG_CURVE) {
      for (let k = 0; k < Math.max(count, 1); k++) {
        const a = point()
        const b = point()
        const c = point()
        if (a === null || b === null || c === null) return null
        commands.push({ kind: 'cubic', points: [a, b, c] })
      }
    } else if (kind === SEG_CLOSE) {
      commands.push({ kind: 'close' })
    } else if (kind === SEG_END) {
      finish()
    } else if (kind === SEG_ESCAPE) {
      const code = (seg >> 8) & 0x1f
      if (code === ESC_NO_FILL) fill = false
      else if (code === ESC_NO_LINE) stroke = false
      else if (code !== ESC_AUTO_LINE && code !== ESC_AUTO_CURVE) return null
    } else {
      return null
    }
  }
  finish()
  return { kind: 'custom', adjust: [], guides: [], textRect: null, paths }
}

/**
 * 形状的几何；`size` 为形状框的宽高（EMU）。无法换算时为 `null`，由调用方计入能力边界。
 */
export function artGeometry(shapeType: number, props: ArtProperties, size: Size): Geometry | null {
  if (props.complex.has(PROP_VERTICES)) return customGeometry(props)
  const name = PRESETS[shapeType]
  if (name === undefined) return null
  return { kind: 'preset', name, adjust: adjustGuides(shapeType, props, size) }
}
