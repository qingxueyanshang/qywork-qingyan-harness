/**
 * 公式校准：用 `@qywork/ooxml` 的公式排版处理构造文档中的每个公式，与 WPS 页面 EMF 中的绘制记录逐项比对。
 *
 *   bun run scripts/ooxml-fidelity/math-calibrate.ts <构造目录> <采集目录> [--only <文档名>…] [--json <输出文件>]
 *     [--render <输出目录>]
 *
 * 采集目录由 `math_probe.py` 写出（每页 EMF、`<文档名>.json` 的逐字坐标），其中的 EMF 先经 `math_emf.py` 整理为
 * `<文档名>-p<页>.items.json`。比对方法：
 * - 每个公式的 EMF 项取该公式所在页、所在行（逐字坐标的行顶至下一段行顶）中的数学字体文字、填充路径与折线。
 * - 显示公式段落（`m:oMathPara`）按 `layoutMathParagraph` 以版心宽度断行，逐行比对：第 k 行取该段公式字符的第 k 个行顶；
 *   另报告行左端与 WPS 的差（像素，`x`）。
 * - 本方字形与 EMF 字形按字形编号与字号（像素）配对，取使配对数最多的整体平移；再在 ±0.5 像素内搜索亚像素平移，
 *   使按四舍五入落到的像素与 EMF 一致的字形最多。报告配对数、像素一致数与最大偏差（像素）。
 * - 分数线与 EMF 折线比对端点、纵坐标与线宽；括号、根号与 EMF 填充路径比对外接框。
 * `--render`：以 WPS 的页面图为底，把每个配对成功的公式盒（上下各外扩 2 像素）涂白，再按配对得到的原点画出本方的公式
 * （`math-page.ts` 经 `math-shoot.mjs` 截图）；`math_score.py` 逐个公式裁出该区域（不足 11 像素的一边向两侧补足，
 * 补足部分两图相同）比较 SSIM，结果写入 `<输出目录>/scores.json`。
 * 字体取本机 Windows 字体目录：Cambria Math（cambria.ttc 第 2 个字体）、宋体、Times New Roman。按字体选择规则（含 `w:hint`）
 * 落在东亚字体中的字符取宋体。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractFace,
  type GlyphOutlines,
  readFaces,
  readGlyphOutlines,
  readMetrics,
  readVerticalMetrics,
} from '../../packages/ooxml/src/font/index.ts'
import {
  layoutMath,
  layoutMathParagraph,
  MATH_SETTINGS_DEFAULTS,
  type MathEnvironment,
  type MathItem,
  type MathLayout,
  type MathParagraph,
  type MathZone,
  readMath,
  readMathFont,
  readMathParagraph,
  readMathSettings,
} from '../../packages/ooxml/src/math/index.ts'
import { PartScanner } from '../../packages/ooxml/src/opc/index.ts'
import {
  DEFAULT_SLOT_CONTEXT,
  fontSlot,
  type TextFace,
} from '../../packages/ooxml/src/text/index.ts'
import { openZip } from '../../packages/ooxml/src/zip/index.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const SCALE = 4 / 3
const VERBOSE = process.argv.includes('--verbose')

export interface Props {
  size?: number
  ascii?: string
  eastAsia?: string
  /** `w:rFonts/@w:hint` 为 `eastAsia`。 */
  hint?: boolean
  bold?: boolean
  italic?: boolean
  color?: string
}

export function readProps(x: PartScanner): Props {
  const p: Props = {}
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start' || x.depth !== depth + 1) continue
    const v = x.attr('w:val')
    if (x.local === 'sz' && v !== null) p.size = Number(v) / 2
    else if (x.local === 'rFonts') {
      const a = x.attr('w:ascii')
      const e = x.attr('w:eastAsia')
      if (a !== null) p.ascii = a
      if (e !== null) p.eastAsia = e
      if (x.attr('w:hint') === 'eastAsia') p.hint = true
    } else if (x.local === 'b') p.bold = v === null || !(v === '0' || v === 'false')
    else if (x.local === 'i') p.italic = v === null || !(v === '0' || v === 'false')
    else if (x.local === 'color' && v !== null && v !== 'auto') p.color = `#${v}`
  }
  return p
}

interface LoadedFace {
  readonly face: TextFace
  readonly outlines: GlyphOutlines | null
}
const faces = new Map<string, LoadedFace>()
function loadFace(file: string, index = 0): LoadedFace {
  let face = faces.get(`${file}#${index}`)
  if (face === undefined) {
    const bytes = new Uint8Array(readFileSync(join(FONTS, file)))
    const f = readFaces(bytes)[index]!
    face = {
      face: { metrics: readMetrics(bytes, f), vertical: readVerticalMetrics(bytes, f) },
      outlines: readGlyphOutlines(bytes, f),
    }
    faces.set(`${file}#${index}`, face)
  }
  return face
}

/** Times New Roman 按粗体、斜体取对应的字体文件（WPS 使用真实的斜体与粗体字形，前进宽度与正体不同）。 */
export const TIMES_FILES = ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'] as const
function times(bold: boolean, italic: boolean): LoadedFace {
  return loadFace(TIMES_FILES[(bold ? 1 : 0) + (italic ? 2 : 0)]!)
}
export function timesFace(bold: boolean, italic: boolean): TextFace {
  return times(bold, italic).face
}

export type FontRef = 'Cambria Math' | '宋体' | 'Times New Roman'

let mathFont: ReturnType<typeof readMathFont<FontRef>> = null
export function loadEnvironment(defaultSize: number, settings = MATH_SETTINGS_DEFAULTS) {
  mathFont ??= readMathFont<FontRef>(
    new Uint8Array(readFileSync(join(FONTS, 'cambria.ttc'))),
    1,
    'Cambria Math',
  )
  const math = mathFont
  if (math === null) throw new Error('Cambria Math 没有 MATH 表')
  const song = loadFace('simsun.ttc')
  const env: MathEnvironment<Props, FontRef> = {
    font: math,
    settings,
    style: (p) => ({
      size: p?.size ?? defaultSize,
      color: p?.color ?? '#000000',
      bold: p?.bold ?? false,
      italic: p?.italic ?? false,
      textFace: (cp) => {
        const eastAsia =
          fontSlot(cp, { ...DEFAULT_SLOT_CONTEXT, eastAsiaHint: p?.hint === true }) === 'eastAsia'
        if (cp >= 0x2e80 || eastAsia) return { ...song, font: '宋体', eastAsia }
        if (p?.ascii === 'Cambria Math')
          return { face: math.face, outlines: math.outlines, font: 'Cambria Math', eastAsia }
        return {
          ...times(p?.bold ?? false, p?.italic ?? false),
          font: 'Times New Roman',
          eastAsia,
        }
      },
    }),
  }
  return env
}

export interface Zone {
  readonly zone: MathZone<Props>
  readonly display: boolean
  /** 显示公式所在的段落；同一段落的各 `m:oMath` 共用一个对象。 */
  readonly paragraph: MathParagraph<Props> | null
}

/** 文档中的公式，按出现顺序；同时返回文档设置、缺省字号与版心（最后一个 `w:sectPr`）的左边距与宽度（磅）。 */
export async function readDocx(path: string) {
  const zip = openZip(new Uint8Array(readFileSync(path)))
  if (!zip.ok) throw new Error(`${path} 无法打开`)
  const doc = await zip.value.text('word/document.xml')
  const styles = await zip.value.text('word/styles.xml')
  const settingsXml = await zip.value.text('word/settings.xml')
  if (!doc.ok || doc.value === null) throw new Error(`${path} 缺少正文`)
  const sz =
    styles.ok && styles.value ? /<w:rPrDefault>.*?<w:sz w:val="(\d+)"/s.exec(styles.value) : null
  const defaultSize = sz ? Number(sz[1]) / 2 : 10.5
  let settings = MATH_SETTINGS_DEFAULTS
  if (settingsXml.ok && settingsXml.value) {
    const s = new PartScanner(settingsXml.value)
    for (let t = s.next(); t !== null; t = s.next()) {
      if (t === 'start' && s.local === 'mathPr') {
        settings = readMathSettings(s)
        break
      }
    }
  }
  const zones: Zone[] = []
  const x = new PartScanner(doc.value)
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start') continue
    if (x.local === 'oMathPara') {
      const paragraph = readMathParagraph(x, readProps)
      for (const zone of paragraph.zones) zones.push({ zone, display: true, paragraph })
    } else if (x.local === 'oMath')
      zones.push({ zone: readMath(x, readProps), display: false, paragraph: null })
  }
  const twips = (name: string, fallback: number) => {
    const m = new RegExp(`<w:${name}\\b[^>]*`, 'g')
    const all = [...doc.value!.matchAll(m)].at(-1)?.[0] ?? ''
    return (key: string) => Number(new RegExp(`w:${key}="(\\d+)"`).exec(all)?.[1] ?? fallback) / 20
  }
  const page = twips('pgSz', 11906)('w')
  const margin = twips('pgMar', 1440)
  const left = margin('left')
  return { zones, defaultSize, settings, left, column: page - left - margin('right') }
}

interface EmfText {
  kind: 'text'
  x: number
  y: number
  dx: number[]
  face: string | null
  height: number | null
  weight?: number | null
  italic?: number | null
  glyphs?: number[]
  text?: string
}
interface EmfPath {
  kind: 'path'
  commands: (string | number)[][]
}
interface EmfPolyline {
  kind: 'polyline'
  points: number[][]
  width: number | null
}
type EmfItem = EmfText | EmfPath | EmfPolyline

interface CharInfo {
  pos: number
  text: string | null
  page: number
  x: number
  y: number
}

interface Probe {
  paragraphs: { start: number; end: number; chars: unknown[][] }[]
  omaths: { start: number; end: number; type: number }[]
}

/** EMF 字形：逐字展开，坐标换算为磅。比对数学字体与 Times New Roman（普通文字字段）的字形。 */
interface Placed {
  font: string
  glyph: number
  x: number
  y: number
  /** 字号像素。 */
  ppem: number
}

const PAIRED = new Set(['Cambria Math', 'Times New Roman'])

function expand(
  items: EmfItem[],
  glyphOf: (item: EmfText, cp: number) => number,
  top: number,
  bottom: number,
): Placed[] {
  const out: Placed[] = []
  for (const it of items) {
    if (it.kind !== 'text' || it.face === null || !PAIRED.has(it.face) || it.height === null)
      continue
    const face = it.face
    if (it.y / 20 < top || it.y / 20 >= bottom) continue
    const ids = it.glyphs ?? [...(it.text ?? '')].map((c) => glyphOf(it, c.codePointAt(0)!))
    let x = it.x
    ids.forEach((g, i) => {
      out.push({ font: face, glyph: g, x: x / 20, y: it.y / 20, ppem: it.height! / 15 })
      x += it.dx[i] ?? 0
    })
  }
  return out
}

function mine(items: readonly MathItem<FontRef>[]): Placed[] {
  return items
    .filter((it) => it.kind === 'glyph' && PAIRED.has(it.font))
    .map((it) => {
      const g = it as Extract<MathItem<FontRef>, { kind: 'glyph' }>
      return { font: g.font as string, glyph: g.glyph, x: g.x, y: g.y, ppem: g.size * SCALE }
    })
}

function pathBox(p: EmfPath): [number, number, number, number] {
  const xs: number[] = []
  const ys: number[] = []
  for (const c of p.commands) {
    for (let i = 1; i < c.length; i += 2) {
      xs.push((c[i] as number) / 20)
      ys.push((c[i + 1] as number) / 20)
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/**
 * 本方的填充项外接框（磅，公式坐标）：轮廓项按字形墨迹框；矩形项紧跟在轮廓项之后且上沿相同时视为根号横线，
 * 与该轮廓项合并（WPS 把根号字形与横线合并为一条路径）。
 */
function shapeBoxes(
  items: readonly MathItem<FontRef>[],
  env: MathEnvironment<Props, FontRef>,
): [string, number[]][] {
  const boxes: [string, number[]][] = []
  for (const it of items) {
    if (it.kind === 'outline') {
      const b = env.font.outlines.bounds(it.glyph)!
      const u = it.size / env.font.outlines.unitsPerEm
      boxes.push([
        'outline',
        [it.x + b.xMin * u, it.y - b.yMax * u, it.x + b.xMax * u, it.y - b.yMin * u],
      ])
    } else if (it.kind === 'rect') {
      const box = [it.x, it.y, it.x + it.width, it.y + it.height]
      const prev = boxes[boxes.length - 1]
      if (prev && prev[0] === 'outline' && Math.abs(prev[1][1]! - box[1]!) < 1) {
        const p = prev[1]
        boxes[boxes.length - 1] = [
          'radical',
          [
            Math.min(p[0]!, box[0]!),
            Math.min(p[1]!, box[1]!),
            Math.max(p[2]!, box[2]!),
            Math.max(p[3]!, box[3]!),
          ],
        ]
      } else boxes.push(['rect', box])
    }
  }
  return boxes
}

export interface FormulaReport {
  doc: string
  index: number
  /** 断行后的第几行（自 0 起）。 */
  line: number
  /** 行左端减 WPS 的配对原点（像素）；只有显示公式段落有。 */
  x: number | null
  page: number
  /** 配对得到的原点（磅）与排版结果，供 `--render` 绘制。 */
  layout: MathLayoutOf | null
  display: boolean
  status: string
  glyphs: number
  matched: number
  exact: number
  maxError: number
  offset: [number, number] | null
  rules: string[]
  outlines: string[]
  width: number
  ascent: number
  descent: number
}

type MathLayoutOf = MathLayout<FontRef>

function compare(
  doc: string,
  index: number,
  page: number,
  r: MathLayout<FontRef> | { kind: 'unsupported'; names: readonly string[] },
  display: boolean,
  env: MathEnvironment<Props, FontRef>,
  emf: EmfItem[],
  top: number,
  bottom: number,
): FormulaReport {
  const base: FormulaReport = {
    doc,
    index,
    line: 0,
    x: null,
    page,
    layout: null,
    display,
    status: '',
    glyphs: 0,
    matched: 0,
    exact: 0,
    maxError: 0,
    offset: null,
    rules: [],
    outlines: [],
    width: 0,
    ascent: 0,
    descent: 0,
  }
  if ('kind' in r && r.kind === 'unsupported')
    return { ...base, status: `unsupported ${r.names.join(',')}` }
  if (!('items' in r)) return base
  const ours = mine(r.items)
  const theirs = expand(
    emf,
    (it, cp) =>
      (it.face === 'Cambria Math'
        ? env.font.face
        : timesFace((it.weight ?? 400) >= 600, Boolean(it.italic))
      ).metrics.glyphId(cp),
    top,
    bottom,
  )
  // 整体平移：以每一对同字形、同字号的配对为候选，取配对数最多者。
  let best: { dx: number; dy: number; n: number; err: number } | null = null
  for (const a of ours) {
    for (const b of theirs) {
      if (a.font !== b.font || a.glyph !== b.glyph || Math.abs(a.ppem - b.ppem) > 1) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      let n = 0
      let err = 0
      for (const c of ours) {
        const m = theirs.find(
          (d) =>
            d.font === c.font &&
            d.glyph === c.glyph &&
            Math.abs(c.x + dx - d.x) < 1.5 &&
            Math.abs(c.y + dy - d.y) < 1.5,
        )
        if (m) {
          n++
          err += Math.abs(c.x + dx - m.x) + Math.abs(c.y + dy - m.y)
        }
      }
      if (best === null || n > best.n || (n === best.n && err < best.err)) best = { dx, dy, n, err }
    }
  }
  if (best === null) return { ...base, status: 'no-match', glyphs: ours.length }
  // 亚像素：整体平移的像素部分固定，小数部分在 ±0.5 像素内按 0.05 像素搜索。
  const px = (v: number) => v * SCALE
  let sub = { fx: 0, fy: 0, exact: -1, max: 0 }
  const ties: [number, number][] = []
  const pairs = ours.map((c) => ({
    c,
    m: theirs.find(
      (d) =>
        d.font === c.font &&
        d.glyph === c.glyph &&
        Math.abs(c.x + best!.dx - d.x) < 1.5 &&
        Math.abs(c.y + best!.dy - d.y) < 1.5,
    ),
  }))
  for (let fx = -0.5; fx <= 0.5; fx += 0.05) {
    for (let fy = -0.5; fy <= 0.5; fy += 0.05) {
      let exact = 0
      let max = 0
      for (const { c, m } of pairs) {
        if (!m) continue
        const ex = Math.round(px(c.x + best.dx) + fx) - Math.round(px(m.x))
        const ey = Math.round(px(c.y + best.dy) + fy) - Math.round(px(m.y))
        if (ex === 0 && ey === 0) exact++
        max = Math.max(max, Math.abs(ex), Math.abs(ey))
      }
      if (exact > sub.exact) {
        sub = { fx, fy, exact, max }
        ties.length = 0
      }
      if (exact === sub.exact) ties.push([fx, fy])
    }
  }
  // 像素一致数相同的亚像素平移：有填充路径时取路径外接框偏差最小者（路径坐标未取整），否则取其中心。
  const shapes = shapeBoxes(r.items, env)
  const emfShapes = emf.filter((e): e is EmfPath => e.kind === 'path').map(pathBox)
  const shapeError = (fx: number, fy: number) => {
    let err = 0
    for (const [, box] of shapes) {
      const b = box.map((v, i) => v + (i % 2 === 0 ? best!.dx + fx / SCALE : best!.dy + fy / SCALE))
      const m = emfShapes.find((q) => Math.abs(q[0] - b[0]!) < 6 && Math.abs(q[1] - b[1]!) < 6)
      if (m) err += Math.abs(m[0] - b[0]!) + Math.abs(m[1] - b[1]!) + Math.abs(m[3] - b[3]!)
    }
    return err
  }
  if (shapes.length > 0) {
    let bestTie = ties[0]!
    for (const t of ties)
      if (shapeError(t[0], t[1]) < shapeError(bestTie[0], bestTie[1])) bestTie = t
    sub.fx = bestTie[0]
    sub.fy = bestTie[1]
  } else {
    sub.fx = ties.reduce((a, t) => a + t[0], 0) / ties.length
    sub.fy = ties.reduce((a, t) => a + t[1], 0) / ties.length
  }
  const dx = best.dx + sub.fx / SCALE
  const dy = best.dy + sub.fy / SCALE
  if (VERBOSE) {
    for (const { c, m } of pairs) {
      const at = `${Math.round(px(c.x + dx))},${Math.round(px(c.y + dy))}`
      const want = m ? `${Math.round(px(m.x))},${Math.round(px(m.y))}` : '—'
      console.log(`    g${c.glyph} ${c.ppem.toFixed(1)}px 本方 ${at} WPS ${want}`)
    }
    const used = new Set(pairs.map((p) => p.m))
    for (const t of theirs)
      if (!used.has(t))
        console.log(
          `    WPS 多出 g${t.glyph} ${t.ppem}px ${Math.round(px(t.x))},${Math.round(px(t.y))}`,
        )
  }
  const rules: string[] = []
  const polylines = emf.filter((e): e is EmfPolyline => e.kind === 'polyline')
  const level = (e: EmfPolyline) => e.points[0]![1] === e.points[e.points.length - 1]![1]
  const emfRules = polylines.filter(level)
  // 斜线：EMF 折线按下端（纵坐标大者）在前整理，比较两端点与线宽（像素）。
  const emfSlashes = polylines
    .filter((e) => !level(e))
    .map((e) => {
      const [a, b] = [e.points[0]!, e.points[e.points.length - 1]!]
      const [lo, hi] = a[1]! > b[1]! ? [a, b] : [b, a]
      return {
        lo: [lo[0]! / 20, lo[1]! / 20],
        hi: [hi[0]! / 20, hi[1]! / 20],
        width: (e.width ?? 0) / 20,
      }
    })
  for (const it of r.items) {
    if (it.kind !== 'slash') continue
    const x0 = it.x0 + dx
    const y0 = it.y0 + dy
    const m = emfSlashes.find((e) => Math.abs(e.lo[0]! - x0) < 3 && Math.abs(e.lo[1]! - y0) < 3)
    if (!m) {
      rules.push('line 未配对')
      continue
    }
    const e = (a: number, b: number) => Math.round(px(a)) - Math.round(px(b))
    rules.push(
      `line ${e(x0, m.lo[0]!)} ${e(y0, m.lo[1]!)} ${e(it.x1 + dx, m.hi[0]!)} ${e(it.y1 + dy, m.hi[1]!)} ` +
        `dt ${Math.round(px(it.thickness)) - Math.round(px(m.width))}`,
    )
  }
  for (const it of r.items) {
    if (it.kind !== 'rule') continue
    const x0 = it.x0 + dx
    const x1 = it.x1 + dx
    const y = it.y + dy
    const m = emfRules.find(
      (e) => Math.abs(e.points[0]![1]! / 20 - y) < 3 && Math.abs(e.points[0]![0]! / 20 - x0) < 3,
    )
    if (!m) {
      rules.push('rule 未配对')
      continue
    }
    const ex0 = Math.round(px(x0)) - Math.round(px(m.points[0]![0]! / 20))
    const ex1 = Math.round(px(x1)) - Math.round(px(m.points[1]![0]! / 20))
    const ey = Math.round(px(y)) - Math.round(px(m.points[0]![1]! / 20))
    const tw = Math.round(px(it.thickness)) - Math.round(px((m.width ?? 0) / 20))
    rules.push(`rule dx0 ${ex0} dx1 ${ex1} dy ${ey} dt ${tw}`)
  }
  const outlines: string[] = []
  const emfPaths = emfShapes
  const boxes = shapes.map(
    ([kind, b]) => [kind, [b[0]! + dx, b[1]! + dy, b[2]! + dx, b[3]! + dy]] as [string, number[]],
  )
  for (const [kind, box] of boxes) {
    const m = emfPaths.find(
      (p) =>
        Math.abs(p[0] - box[0]!) < 6 &&
        Math.abs(p[1] - box[1]!) < 6 &&
        p[0] < box[2]! &&
        p[2] > box[0]!,
    )
    if (!m) {
      outlines.push(`${kind} 未配对`)
      continue
    }
    const d = m.map((v, i) => Math.round((px(box[i]!) - px(v)) * 10) / 10)
    outlines.push(`${kind} ${d.join(' ')}`)
  }
  return {
    ...base,
    layout: r,
    status: 'ok',
    glyphs: ours.length,
    matched: best.n,
    exact: sub.exact,
    maxError: sub.max,
    offset: [Math.round(dx * 100) / 100, Math.round(dy * 100) / 100],
    rules,
    outlines,
    width: r.width,
    ascent: r.ascent,
    descent: r.descent,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const [docDir, capDir] = args
  if (!docDir || !capDir) {
    console.error(
      '用法：bun run math-calibrate.ts <构造目录> <采集目录> [--only <文档名>…] [--json <文件>]',
    )
    process.exit(2)
  }
  const only: string[] = []
  let jsonOut: string | null = null
  let renderDir: string | null = null
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--only')
      while (args[i + 1] && !args[i + 1]!.startsWith('--')) only.push(args[++i]!)
    else if (args[i] === '--json') jsonOut = args[++i] ?? null
    else if (args[i] === '--render') renderDir = args[++i] ?? null
  }
  const reports: FormulaReport[] = []
  const names = [...new Bun.Glob('*.docx').scanSync(docDir)]
    .map((f) => f.replace(/\.docx$/, ''))
    .sort()
  for (const name of names) {
    if (only.length > 0 && !only.includes(name)) continue
    let probe: Probe
    try {
      probe = JSON.parse(readFileSync(join(capDir, `${name}.json`), 'utf8'))
    } catch {
      continue
    }
    const { zones, defaultSize, settings, left, column } = await readDocx(
      join(docDir, `${name}.docx`),
    )
    const env = loadEnvironment(defaultSize, settings)
    const chars: CharInfo[] = probe.paragraphs.flatMap((p) =>
      p.chars.map((c) => ({
        pos: c[0] as number,
        text: c[1] as string | null,
        page: c[2] as number,
        x: c[3] as number,
        y: c[4] as number,
      })),
    )
    const pages = new Map<number, EmfItem[]>()
    const emfOf = (page: number) => {
      let v = pages.get(page)
      if (!v) {
        v = JSON.parse(
          readFileSync(join(capDir, `${name}-p${page}.items.json`), 'utf8'),
        ) as EmfItem[]
        pages.set(page, v)
      }
      return v
    }
    // WPS 的 OMaths 把同一段落（m:oMathPara）中的多个 m:oMath 计为一个，按段落依次对应。
    let next = 0
    zones.forEach((z, i) => {
      if (z.paragraph !== null && z.paragraph.zones[0] !== z.zone) return
      const om = probe.omaths[next++]
      const first = om ? chars.find((c) => c.pos >= om.start) : undefined
      if (!om || !first) {
        reports.push({ ...emptyReport(name, i, z.display), status: 'no-probe' })
        return
      }
      const band = (top: number, page: number) => {
        const after = chars.filter((c) => c.page === page && c.y > top + 1).map((c) => c.y)
        return after.length ? Math.min(...after) : 1e9
      }
      if (z.paragraph === null) {
        const top = Math.min(
          ...chars.filter((c) => c.pos >= om.start && c.pos < om.end).map((c) => c.y),
        )
        if (VERBOSE) console.log(`== ${name}#${i}`)
        const r = layoutMath(z.zone, env, z.display)
        reports.push(
          compare(
            name,
            i,
            first.page,
            r,
            false,
            env,
            emfOf(first.page),
            top,
            band(top, first.page),
          ),
        )
        return
      }
      // 段落中公式字符的行顶，按页与纵坐标排序：第 k 行对应第 k 个行顶。
      const tops = [
        ...new Map(
          chars
            .filter((c) => c.pos >= om.start && c.pos < om.end)
            .map((c) => [`${c.page}:${c.y}`, c] as const),
        ).values(),
      ].sort((a, b) => a.page - b.page || a.y - b.y)
      const result = layoutMathParagraph(z.paragraph, env, column)
      if (result.kind === 'unsupported') {
        reports.push(compare(name, i, first.page, result, true, env, [], 0, 0))
        return
      }
      result.lines.forEach((line, k) => {
        const at = tops[k]
        if (!at) {
          reports.push({ ...emptyReport(name, i, true), line: k, status: 'no-line' })
          return
        }
        if (VERBOSE) console.log(`== ${name}#${i}.${k}`)
        const rep = compare(
          name,
          i,
          at.page,
          line,
          true,
          env,
          emfOf(at.page),
          at.y,
          band(at.y, at.page),
        )
        const x =
          rep.offset === null ? null : Math.round((left + line.x - rep.offset[0]) * SCALE * 10) / 10
        reports.push({ ...rep, line: k, x })
      })
    })
  }
  for (const r of reports) {
    console.log(
      `${r.doc}#${r.index}${r.line > 0 || r.x !== null ? `.${r.line}` : ''} ${r.display ? 'D' : 'T'} ${r.status} ` +
        `字形 ${r.matched}/${r.glyphs} 像素一致 ${r.exact} 最大偏差 ${r.maxError}` +
        (r.x !== null ? ` 行左端 ${r.x}` : '') +
        (r.rules.length ? ` | ${r.rules.join('; ')}` : '') +
        (r.outlines.length ? ` | ${r.outlines.join('; ')}` : ''),
    )
  }
  if (renderDir) await render(reports, capDir, renderDir)
  if (jsonOut)
    writeFileSync(
      jsonOut,
      JSON.stringify(
        reports.map(({ layout: _, ...r }) => r),
        null,
        1,
      ),
    )
}

/** 按文档与页分组绘制配对成功的公式，截图后逐个公式比较 SSIM。 */
async function render(reports: FormulaReport[], capDir: string, outDir: string) {
  mkdirSync(outDir, { recursive: true })
  const groups = new Map<string, FormulaReport[]>()
  for (const r of reports) {
    if (r.status !== 'ok' || r.layout === null || r.offset === null) continue
    const key = `${r.doc}-p${r.page}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const keys = [...groups.keys()]
  const jobs = keys.map((key) => {
    const png = Bun.file(join(capDir, `${key}.png`))
    return { key, png }
  })
  const sizes = await Promise.all(
    jobs.map(async ({ png }) => {
      const b = new Uint8Array(await png.arrayBuffer())
      const v = new DataView(b.buffer)
      return { width: v.getUint32(16), height: v.getUint32(20) }
    }),
  )
  const boxOf = (r: FormulaReport): [number, number, number, number] => {
    const l = r.layout!
    const [ox, oy] = r.offset!
    return [
      Math.floor(ox * SCALE),
      Math.floor((oy - l.ascent) * SCALE) - 2,
      Math.ceil((ox + l.width) * SCALE),
      Math.ceil((oy + l.descent) * SCALE) + 2,
    ]
  }
  const pageJobs = keys.map((key, i) => ({
    ...sizes[i]!,
    background: `/truth/${encodeURIComponent(key)}`,
    erase: groups.get(key)!.map(boxOf),
    formulas: groups
      .get(key)!
      .map((r) => ({ x: r.offset![0], baseline: r.offset![1], layout: r.layout })),
  }))
  const bundleDir = join(outDir, 'bundle')
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'math-page.ts')],
    outdir: bundleDir,
    target: 'browser',
    format: 'esm',
    naming: 'page.js',
  })
  if (!built.success) {
    for (const log of built.logs) console.error(log)
    process.exit(1)
  }
  // 键为「族名」或「族名/粗斜体序号」（1 粗体、2 斜体、3 粗斜体），与 math-page.ts 的注册一致。
  const files: Record<string, [string, number]> = {
    'Cambria Math': ['cambria.ttc', 1],
    宋体: ['simsun.ttc', 0],
    ...Object.fromEntries(
      TIMES_FILES.map((f, i) => [i === 0 ? 'Times New Roman' : `Times New Roman/${i}`, [f, 0]]),
    ),
  }
  const html =
    '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">' +
    '<canvas id="page" style="display:block"></canvas><script type="module" src="/page.js"></script>'
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/')
        return new Response(html, { headers: { 'content-type': 'text/html' } })
      if (url.pathname === '/page.js') return new Response(Bun.file(join(bundleDir, 'page.js')))
      if (url.pathname === '/jobs') return Response.json(pageJobs)
      if (url.pathname.startsWith('/truth/'))
        return new Response(
          Bun.file(join(capDir, `${decodeURIComponent(url.pathname.slice(7))}.png`)),
        )
      if (url.pathname === '/font-file') {
        const f = files[url.searchParams.get('name') ?? '']
        if (!f) return new Response('', { status: 404 })
        const bytes = new Uint8Array(readFileSync(join(FONTS, f[0])))
        return new Response(extractFace(bytes, f[1]).slice())
      }
      return new Response('', { status: 404 })
    },
  })
  const node = Bun.spawn(
    [
      'node',
      join(import.meta.dir, 'math-shoot.mjs'),
      `http://127.0.0.1:${server.port}/`,
      String(keys.length),
      outDir,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  await node.exited
  server.stop(true)
  const crops = keys.flatMap((key, i) =>
    groups.get(key)!.map((r) => ({
      doc: r.doc,
      index: r.index,
      line: r.line,
      truth: join(capDir, `${key}.png`),
      candidate: join(outDir, `page-${i}.png`),
      box: boxOf(r),
    })),
  )
  writeFileSync(join(outDir, 'crops.json'), JSON.stringify(crops))
  const py = Bun.spawn(
    [
      'python',
      join(import.meta.dir, 'math_score.py'),
      join(outDir, 'crops.json'),
      join(outDir, 'scores.json'),
    ],
    {
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  await py.exited
}

function emptyReport(doc: string, index: number, display: boolean): FormulaReport {
  return {
    doc,
    index,
    line: 0,
    x: null,
    page: 0,
    layout: null,
    display,
    status: '',
    glyphs: 0,
    matched: 0,
    exact: 0,
    maxError: 0,
    offset: null,
    rules: [],
    outlines: [],
    width: 0,
    ascent: 0,
    descent: 0,
  }
}

if (import.meta.main) await main()
