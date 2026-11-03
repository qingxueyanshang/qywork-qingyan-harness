/**
 * 公式。覆盖 `parse.ts`（OMML 读取、缺省值、修订、未实现结构、`mathPr`）、`chars.ts`（数学字母映射、原子类别与公式的文字）、
 * `table.ts`（`MATH` 表读取）、`../font/outline.ts`（字形墨迹框与轮廓）、`layout.ts`（字号层级、间距、分数、线性分数、
 * 上下标、n 元运算符、括号、根号、重音、上下极限、字段字体、行高、显示公式的断行与对齐、行内分段）与 `paint.ts`（不平滑填充、分数线、斜线、
 * 文字取整）。
 *
 * 排版与 `MATH` 表的用例读取本机 Windows 字体目录中的 Cambria Math（cambria.ttc 第 2 个字体）：其他平台跳过（`skipIf`）。
 * 期望值取自 WPS 12.1 只读打开构造文档后的页面 EMF 与逐字横坐标（Information(5)，0.05 磅精度），不由本模块计算。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type GlyphOutlines,
  readFaces,
  readGlyphOutlines,
  readMetrics,
  readVerticalMetrics,
} from '../font/index.ts'
import { PartScanner } from '../opc/index.ts'
import { DEFAULT_SLOT_CONTEXT, fontSlot, type TextFace } from '../text/index.ts'
import {
  atomClass,
  fillAliased,
  layoutMath,
  layoutMathParagraph,
  MATH_SETTINGS_DEFAULTS,
  type MathEnvironment,
  type MathFont,
  type MathItem,
  type MathLayout,
  type MathSettings,
  type MathZone,
  mathLetter,
  mathText,
  paintMath,
  readMath,
  readMathFont,
  readMathParagraph,
  readMathSettings,
} from './index.ts'

const NS =
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

interface Props {
  size?: number
  font?: string
  hint?: boolean
}

/** 读取 `w:rPr` 中的 `w:sz`（半磅）与 `w:rFonts` 的 `w:ascii`、`w:hint`。 */
function readProps(x: PartScanner): Props {
  const depth = x.depth
  const p: Props = {}
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t === 'start' && x.local === 'sz') p.size = Number(x.attr('w:val')) / 2
    if (t === 'start' && x.local === 'rFonts') {
      p.font = x.attr('w:ascii') ?? ''
      if (x.attr('w:hint') === 'eastAsia') p.hint = true
    }
  }
  return p
}

function scanTo(xml: string, local: string): PartScanner {
  const x = new PartScanner(`<root ${NS}>${xml}</root>`)
  for (let t = x.next(); t !== null; t = x.next()) if (t === 'start' && x.local === local) return x
  throw new Error(`没有 ${local}`)
}

function zone(inner: string): MathZone<Props> {
  return readMath(scanTo(`<m:oMath>${inner}</m:oMath>`, 'oMath'), readProps)
}

const r = (t: string, pr = '') => `<m:r>${pr}<m:t>${t}</m:t></m:r>`

describe('OMML 读取', () => {
  test('结构、参数与字符属性', () => {
    const z = zone(
      `<m:f><m:fPr><m:type m:val="noBar"/><m:ctrlPr><w:rPr><w:sz w:val="28"/></w:rPr></m:ctrlPr></m:fPr>` +
        `<m:num>${r('a', '<m:rPr><m:sty m:val="p"/></m:rPr><w:rPr><w:sz w:val="32"/></w:rPr>')}</m:num>` +
        `<m:den>${r('b')}</m:den></m:f>`,
    )
    expect(z.nodes).toHaveLength(1)
    const f = z.nodes[0]!
    if (f.kind !== 'f') throw new Error(f.kind)
    expect(f.type).toBe('noBar')
    expect(f.props).toEqual({ size: 14 })
    expect(f.num[0]).toEqual({
      kind: 'run',
      text: 'a',
      style: 'p',
      script: null,
      normal: false,
      literal: false,
      props: { size: 16 },
    })
    expect(f.den[0]).toMatchObject({ kind: 'run', text: 'b', props: null })
  })

  test('缺省值：n 元运算符为积分号、括号为圆括号与竖线分隔、重音为扬抑符、横线在下', () => {
    const z = zone(
      `<m:nary><m:sub/><m:sup/><m:e>${r('x')}</m:e></m:nary>` +
        `<m:d><m:e>${r('a')}</m:e><m:e>${r('b')}</m:e></m:d>` +
        `<m:acc><m:e>${r('y')}</m:e></m:acc><m:bar><m:e>${r('z')}</m:e></m:bar>`,
    )
    expect(z.nodes.map((n) => n.kind)).toEqual(['nary', 'd', 'acc', 'bar'])
    expect(z.nodes[0]).toMatchObject({ char: '\u222b', limits: null, grow: false })
    expect(z.nodes[1]).toMatchObject({ open: '(', close: ')', separator: '|', grow: true })
    expect(z.nodes[2]).toMatchObject({ char: '\u0302' })
    expect(z.nodes[3]).toMatchObject({ position: 'bot' })
  })

  test('空字符与无前缀的 val：`begChr` 为空串时不显示该侧括号', () => {
    const z = zone(
      `<m:d><m:dPr><m:begChr val=""/><m:endChr m:val="|"/></m:dPr><m:e>${r('x')}</m:e></m:d>`,
    )
    expect(z.nodes[0]).toMatchObject({ open: '', close: '|' })
  })

  test('修订：插入的内容保留，删除的内容丢弃；书签忽略', () => {
    const z = zone(`<w:ins>${r('a')}</w:ins><w:del>${r('b')}</w:del><w:bookmarkStart/>${r('c')}`)
    expect(z.nodes.map((n) => (n.kind === 'run' ? n.text : n.kind))).toEqual(['a', 'c'])
  })

  test('嵌套超过 256 层的结构记为 unsupported 节点，不溢出调用栈', () => {
    const z = zone(`${'<m:d><m:e>'.repeat(5000)}${r('x')}${'</m:e></m:d>'.repeat(5000)}`)
    const find = (nodes: MathZone<Props>['nodes']): boolean =>
      nodes.some((n) => n.kind === 'unsupported' || (n.kind === 'd' && find(n.items[0]!)))
    expect(find(z.nodes)).toBe(true)
  })

  test('未实现的结构记为 unsupported 节点', () => {
    const z = zone(`<m:m><m:mr><m:e>${r('a')}</m:e></m:mr></m:m><m:groupChr><m:e/></m:groupChr>`)
    expect(z.nodes).toEqual([
      { kind: 'unsupported', name: 'm' },
      { kind: 'unsupported', name: 'groupChr' },
    ])
  })

  test('oMathPara 的对齐与多个 oMath；mathPr 的设置', () => {
    const p = readMathParagraph(
      scanTo(
        `<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>${r('x')}</m:oMath>` +
          `<m:oMath>${r('y')}</m:oMath></m:oMathPara>`,
        'oMathPara',
      ),
      readProps,
    )
    expect(p.justification).toBe('left')
    expect(p.zones).toHaveLength(2)
    const s = readMathSettings(
      scanTo(
        '<m:mathPr><m:mathFont m:val="STIX Math"/><m:smallFrac m:val="1"/><m:lMargin m:val="1440"/>' +
          '<m:intLim m:val="undOvr"/><m:defJc m:val="center"/><m:brkBin m:val="repeat"/>' +
          '<m:wrapIndent m:val="720"/><m:wrapRight/></m:mathPr>',
        'mathPr',
      ),
    )
    expect(s).toEqual({
      ...MATH_SETTINGS_DEFAULTS,
      font: 'STIX Math',
      smallFraction: true,
      leftMargin: 72,
      integralLimits: 'undOvr',
      defaultJustification: 'center',
      breakBinary: 'after',
      wrapIndent: 36,
      wrapRight: true,
    })
  })
})

describe('数学字母与原子类别', () => {
  const cp = (s: string) => s.codePointAt(0)!
  test('缺省斜体：拉丁字母与希腊字母（含大写，WPS 实测），h 为 U+210E，数字不变', () => {
    expect(mathLetter(cp('x'), null, null)).toBe(0x1d465)
    expect(mathLetter(cp('h'), null, null)).toBe(0x210e)
    expect(mathLetter(cp('A'), null, null)).toBe(0x1d434)
    expect(mathLetter(cp('α'), null, null)).toBe(0x1d6fc)
    expect(mathLetter(cp('Δ'), null, null)).toBe(0x1d6e5)
    expect(mathLetter(cp('2'), null, null)).toBe(cp('2'))
    expect(mathLetter(cp('x'), 'p', null)).toBe(cp('x'))
  })

  test('字体变体与 BMP 中已有的字母', () => {
    expect(mathLetter(cp('R'), null, 'double-struck')).toBe(0x211d)
    expect(mathLetter(cp('A'), null, 'double-struck')).toBe(0x1d538)
    expect(mathLetter(cp('L'), null, 'script')).toBe(0x2112)
    expect(mathLetter(cp('b'), 'b', null)).toBe(0x1d41b)
    expect(mathLetter(cp('1'), 'b', null)).toBe(0x1d7cf)
  })

  test('类别：二元运算符、关系符、标点；· 与 / 为普通字符', () => {
    expect(['+', '−', '×', '⋅', '±'].map((c) => atomClass(cp(c)))).toEqual(Array(5).fill('bin'))
    expect(['=', '≤', '∈', '→', '⇒'].map((c) => atomClass(cp(c)))).toEqual(Array(5).fill('rel'))
    expect([',', ';', ':'].map((c) => atomClass(cp(c)))).toEqual(['punct', 'punct', 'punct'])
    expect(['·', '/', '.', 'x'].map((c) => atomClass(cp(c)))).toEqual(Array(4).fill('ord'))
  })

  test('公式的文字（WPS：STYLEREF 引用含公式的段落，构造文档 w10s）', () => {
    const sty = (v: string) => `<m:rPr><m:sty m:val="${v}"/></m:rPr>`
    const S = '\u001a'
    const E = '\u001b'
    expect(
      [
        r('AB=c'),
        r('ab', sty('b')),
        r('ab', '<m:rPr><m:nor/></m:rPr>'),
        `<m:sSubSup><m:e>${r('x')}</m:e><m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>`,
        `<m:d><m:dPr><m:begChr m:val="["/></m:dPr><m:e>${r('a')}</m:e><m:e>${r('b')}</m:e></m:d>`,
        `<m:nary><m:naryPr><m:chr m:val="∑"/><m:subHide m:val="1"/><m:supHide m:val="1"/></m:naryPr>` +
          `<m:sub/><m:sup/><m:e>${r('i')}</m:e></m:nary>`,
        `<m:sSup><m:e><m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f></m:e><m:sup>${r('2')}</m:sup></m:sSup>`,
        `<m:func><m:fName>${r('sin', sty('p'))}</m:fName><m:e>${r('x')}</m:e></m:func>`,
      ].map((x) => mathText(zone(x))),
    ).toEqual([
      '𝐴𝐵=𝑐',
      '𝐚𝐛',
      'ab',
      `${S}𝑥${E}𝑖${E}2${E}`,
      `${S}𝑎${E}𝑏${E}`,
      `${S}${E}${E}𝑖${E}`,
      `${S}${S}𝑎${E}𝑏${E}${E}2${E}`,
      `${S}sin${E}𝑥${E}`,
    ])
  })
})

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const windows = process.platform === 'win32'
let cached: MathFont<string> | null = null
function cambria(): MathFont<string> {
  if (cached === null) {
    const bytes = new Uint8Array(readFileSync(join(FONTS, 'cambria.ttc')))
    cached = readMathFont(bytes, 1, 'Cambria Math')
    if (cached === null) throw new Error('Cambria Math 没有 MATH 表')
  }
  return cached
}

function env(
  size: number,
  settings: MathSettings = MATH_SETTINGS_DEFAULTS,
): MathEnvironment<Props, string> {
  const font = cambria()
  return {
    font,
    settings,
    style: (p) => ({
      size: p?.size ?? size,
      color: '#000000',
      bold: false,
      italic: false,
      textFace: () => ({
        face: font.face,
        font: 'Cambria Math',
        outlines: font.outlines,
        eastAsia: false,
      }),
    }),
  }
}

const textFaces = new Map<string, { face: TextFace; outlines: GlyphOutlines | null }>()
function textFace(file: string) {
  let f = textFaces.get(file)
  if (f === undefined) {
    const bytes = new Uint8Array(readFileSync(join(FONTS, file)))
    const sfnt = readFaces(bytes)[0]!
    f = {
      face: { metrics: readMetrics(bytes, sfnt), vertical: readVerticalMetrics(bytes, sfnt) },
      outlines: readGlyphOutlines(bytes, sfnt),
    }
    textFaces.set(file, f)
  }
  return f
}

/**
 * 文字字体按字段的 `w:rFonts`：缺省为 Times New Roman，Cambria Math 为数学字体本身；按字体选择规则（含 `w:hint`）落在东亚字体中的
 * 字符取宋体。
 */
function textEnv(size: number): MathEnvironment<Props, string> {
  const font = cambria()
  return {
    ...env(size),
    style: (p) => ({
      size: p?.size ?? size,
      color: '#000000',
      bold: false,
      italic: false,
      textFace: (cp) => {
        const eastAsia =
          fontSlot(cp, { ...DEFAULT_SLOT_CONTEXT, eastAsiaHint: p?.hint === true }) === 'eastAsia'
        if (eastAsia || p?.font === '宋体')
          return { ...textFace('simsun.ttc'), font: '宋体', eastAsia }
        if (p?.font === 'Cambria Math')
          return { face: font.face, outlines: font.outlines, font: 'Cambria Math', eastAsia }
        return { ...textFace('times.ttf'), font: 'Times New Roman', eastAsia }
      },
    }),
  }
}

function layout(inner: string, size: number, display = false): MathLayout<string> {
  const res = layoutMath(zone(inner), env(size), display)
  if (res.kind !== 'layout') throw new Error(res.names.join(','))
  return res
}

type Glyph = Extract<MathItem<string>, { kind: 'glyph' }>
const glyphs = (l: MathLayout<string>) => l.items.filter((i): i is Glyph => i.kind === 'glyph')

describe.skipIf(!windows)('MATH 表与字形轮廓（Cambria Math）', () => {
  test('常量、斜体校正与变体', () => {
    const t = cambria().table
    expect(t.constants.scriptPercentScaleDown).toBe(73)
    expect(t.constants.scriptScriptPercentScaleDown).toBe(60)
    expect(t.constants.axisHeight).toBe(585)
    expect(t.constants.fractionRuleThickness).toBe(133)
    expect(t.constants.radicalDegreeBottomRaisePercent).toBe(65)
    const face = cambria().face.metrics
    expect(t.italicCorrection(face.glyphId(0x1d465))).toBe(62)
    expect(t.vertical(face.glyphId(0x2211))!.variants.map((v) => v.glyph)).toEqual([
      963, 3532, 3533, 3534, 3535,
    ])
    expect(t.horizontal(face.glyphId(0x302))!.variants[1]!.glyph).toBe(3548)
    expect(t.vertical(face.glyphId(0x28))!.assembly!.parts).toHaveLength(3)
  })

  test('墨迹框与轮廓', () => {
    const o = cambria().outlines
    expect(o.bounds(958)).toEqual({ xMin: 35, yMin: -85, xMax: 1465, yMax: 1886 })
    expect(o.advance(3533)).toBe(2715)
    const cmds = o.outline(4666)
    expect(cmds[0]!.op).toBe('M')
    expect(cmds.filter((c) => c.op === 'Q').length).toBeGreaterThan(0)
    expect(cmds.at(-1)!.op).toBe('Z')
    expect(o.bounds(3)).toBeNull()
    const bytes = new Uint8Array(readFileSync(join(FONTS, 'cambria.ttc')))
    expect(readGlyphOutlines(bytes, readFaces(bytes)[1]!)!.numGlyphs).toBe(o.numGlyphs)
  })
})

describe.skipIf(!windows)('排版（与 WPS 实测比较）', () => {
  test('上下标字号按半磅向下取整：12 → 8.5，10.5 → 7.5，48 → 35；二级 12 → 7', () => {
    const size = (s: number) =>
      glyphs(layout(`<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`, s))[1]!.size
    expect([12, 10.5, 48, 8].map(size)).toEqual([8.5, 7.5, 35, 5.5])
    const deg = glyphs(
      layout(`<m:rad><m:deg>${r('3')}</m:deg><m:e>${r('y')}</m:e></m:rad>`, 12),
    )[0]!
    expect(deg.size).toBe(7)
  })

  test('运算符间距：x+y=z 在 12 磅下的逐字横坐标（WPS 为字框左端，0.05 磅舍入）', () => {
    const g = glyphs(layout(r('x+y=z'), 12))
    // WPS：+ 字框 6.35、y 20.75、= 字框 27.45、z 43.15；+ 与 = 的字形在字框左端加一侧间距。
    expect(g[1]!.x - 0.2255 * 12).toBeCloseTo(6.35, 1)
    expect(g[2]!.x).toBeCloseTo(20.75, 1)
    expect(g[3]!.x - 0.2803 * 12).toBeCloseTo(27.45, 1)
    expect(g[4]!.x).toBeCloseTo(43.15, 1)
  })

  test('一元运算符只在参数开头；关系符后的减号与其前不加间距、其后加二元间距', () => {
    const g = glyphs(layout(r('−a=−b'), 24))
    // WPS（24 磅）：a 17.9，= 字框 31.3，第二个减号 55.95，b 79.25（相对公式左端）。
    expect(g[1]!.x).toBeCloseTo(17.9, 1)
    expect(g[3]!.x).toBeCloseTo(55.95, 0)
    expect(g[4]!.x).toBeCloseTo(79.25, 0)
  })

  test('显示分数：分子分母居中、分数线在轴上且自分数左端至右端；行内分数的分子分母缩小一级', () => {
    const l = layout(`<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`, 48, true)
    const rule = l.items.find((i) => i.kind === 'rule')!
    expect(rule).toMatchObject({ x0: 0, y: -(585 * 48) / 2048 })
    expect(rule.kind === 'rule' && rule.x1).toBeCloseTo(l.width, 6)
    const [a, b] = glyphs(l)
    // WPS（48 磅）：分子基线高 36.75 磅、分母低 32.25 磅（均为像素取整后的值，±0.375）。
    expect(-a!.y).toBeCloseTo(36.75, 0)
    expect(b!.y).toBeCloseTo(32.25, 0)
    const inline = glyphs(layout(`<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`, 48))
    expect(inline[0]!.size).toBe(35)
  })

  test('显示公式中嵌套的分数不缩小字号；分子恰为分数时两侧留空白', () => {
    const inner = `<m:f><m:num>${r('1')}</m:num><m:den>${r('2')}</m:den></m:f>`
    const l = layout(`<m:f><m:num>${inner}</m:num><m:den>${r('3')}</m:den></m:f>`, 12, true)
    expect(glyphs(l).map((g) => g.size)).toEqual([12, 12, 12])
    const rules = l.items.filter((i) => i.kind === 'rule')
    expect(rules.length).toBe(2)
    const outer = rules[1]!
    expect(outer.kind === 'rule' && outer.x1 - outer.x0).toBeCloseTo(
      (1134 * 12) / 2048 + 2 * 0.11 * 12,
      6,
    )
  })

  test('上下标同时存在时间隙不足部分上下各分一半', () => {
    const l = layout(
      `<m:sSubSup><m:e>${r('x')}</m:e><m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>`,
      96,
    )
    const [, sup, sub] = glyphs(l)
    // WPS（96 磅）：上标基线高 38.25、下标低 22.5（像素取整，±0.375）。
    expect(-sup!.y).toBeCloseTo(38.25, 0)
    expect(sub!.y).toBeCloseTo(22.5, 0)
    expect(sub!.x).toBe(sup!.x)
  })

  test('n 元运算符：显示公式取第三个变体，下限距运算符墨迹 0.146 em；积分号的下限按原字形斜体校正左移', () => {
    const sum = layout(
      `<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub>${r('x')}</m:sub>` +
        `<m:sup>${r('n')}</m:sup><m:e>${r('x')}</m:e></m:nary>`,
      24,
      true,
    )
    const g = glyphs(sum)
    expect(g[0]!.glyph).toBe(3533)
    const op = g[0]!
    // WPS（24 磅）：下限 x 基线低于运算符基线 27.75 磅（±0.375）。
    expect(g[2]!.y - op.y).toBeCloseTo(27.75, 0)
    const int = layout(
      `<m:nary><m:sub>${r('0')}</m:sub><m:sup>${r('1')}</m:sup><m:e>${r('f')}</m:e></m:nary>`,
      24,
      true,
    )
    const [i, hi, lo] = glyphs(int)
    expect(i!.glyph).toBe(3505)
    // WPS（24 磅）：上限 19.35、下限 14.55 磅（Information(5)，相对积分号左端）。
    expect(hi!.x).toBeCloseTo(19.35, 1)
    expect(Math.abs(lo!.x - 14.55)).toBeLessThan(0.1)
    const inline = glyphs(
      layout(
        `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub/><m:sup/><m:e>${r('x')}</m:e></m:nary>`,
        24,
      ),
    )
    expect(inline[0]!.glyph).toBe(963)
  })

  test('括号：按轴居中，取不低于内容对称高度 0.82 倍的变体；不伸展时取原字形', () => {
    const frac = `<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`
    const outlines = (l: MathLayout<string>) =>
      l.items.flatMap((i) => (i.kind === 'outline' ? [i.glyph] : []))
    // WPS：显示公式中括住 a/b 的圆括号高 3379 单位（glyph04672 与 glyph04673），行内为同一变体。
    expect(outlines(layout(`<m:d><m:e>${frac}</m:e></m:d>`, 24, true))).toEqual([4672, 4673])
    expect(outlines(layout(`<m:d><m:e>${frac}</m:e></m:d>`, 24))).toEqual([4672, 4673])
    expect(
      outlines(layout(`<m:d><m:dPr><m:grow m:val="0"/></m:dPr><m:e>${frac}</m:e></m:d>`, 24)),
    ).toEqual([4666, 4667])
    const l = layout(`<m:d><m:e>${r('x')}</m:e></m:d>`, 96)
    const paren = l.items[0]!
    const b = cambria().outlines.bounds(4666)!
    const center = paren.kind === 'outline' ? paren.y - ((b.yMax + b.yMin) * 96) / 2048 / 2 : 0
    expect(center).toBeCloseTo(-(585 * 96) / 2048, 6)
  })

  test('根号：被开方式紧接根号字形的前进宽度，横线延伸到被开方式末端', () => {
    const l = layout(
      `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r('x')}</m:e></m:rad>`,
      96,
    )
    const sign = l.items.find((i) => i.kind === 'outline')!
    const bar = l.items.find((i) => i.kind === 'rect')!
    const x = glyphs(l)[0]!
    // WPS（96 磅）：被开方式在根号左端之后 63.0 磅，横线右端为被开方式末端，根号顶部高于基线 75.9 磅（±0.4）。
    expect(x.x).toBeCloseTo(63.05, 1)
    expect(bar.kind === 'rect' && bar.x + bar.width).toBeCloseTo(l.width, 6)
    expect(sign.kind === 'outline' && -(sign.y - (1886 * 96) / 2048)).toBeCloseTo(75.9, 0)
  })

  test('重音：取不宽于底式宽度的最宽变体，居中于底式宽度', () => {
    const l = layout(`<m:acc><m:e>${r('y')}</m:e></m:acc>`, 48)
    const [y, hat] = glyphs(l)
    expect(hat!.glyph).toBe(3548)
    expect(hat!.text).toBeNull()
    // WPS（48 磅）：扬抑符字形原点在 y 右侧 3.75 磅（像素取整）。
    expect(hat!.x - y!.x).toBeCloseTo(3.75, 0)
  })

  test('重音：底式高于 flattenedAccentBaseHeight 时取 GSUB flac 的扁平形式', () => {
    // WPS（Cambria Math 12 与 24 磅，页面 EMF 字形编号）：y、p 为 3548，ℎ 为 3552，V 与 A 为 3553，Δπ 与 x² 为 3554，xyz 为 3550。
    const hat = (inner: string) => {
      const g = glyphs(layout(`<m:acc><m:e>${inner}</m:e></m:acc>`, 12))
      return g[g.length - 1]!.glyph
    }
    expect(['y', 'p', 'h', 'V', 'A', 'Δπ', 'xyz'].map((t) => hat(r(t)))).toEqual([
      3548, 3548, 3552, 3553, 3553, 3554, 3550,
    ])
    expect(hat(`<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`)).toBe(3554)
  })

  test('行高：只含 x+y 的显示公式 12 磅为 14.05 磅（WPS），分数行顶为墨迹上沿减 mathLeading', () => {
    const l = layout(r('x+y'), 12, true)
    expect(l.lineAscent + l.lineDescent).toBeCloseTo(14.05, 1)
    const f = layout(`<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`, 12, true)
    expect(f.lineAscent).toBeCloseTo(f.ascent + (300 * 12) / 2048, 6)
    expect(f.lineAscent + f.lineDescent).toBeCloseTo(24.6, 0)
  })

  test('未实现的结构使整个公式不排版', () => {
    const res = layoutMath(
      zone(`${r('x')}<m:m><m:mr><m:e>${r('a')}</m:e></m:mr></m:m>`),
      env(12),
      false,
    )
    expect(res).toEqual({ kind: 'unsupported', names: ['m'] })
  })

  const lin = (num: string, den: string) =>
    `<m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num>${num}</m:num><m:den>${den}</m:den></m:f>`
  const advance = (g: Glyph) => (cambria().outlines.advance(g.glyph) * g.size) / 2048

  test('线性分数：分子、斜线、分母同一基线，斜线自墨迹下沿至上沿；分子分母中运算符不加间距', () => {
    const l = layout(lin(r('a'), r('b')), 12)
    const [a, b] = glyphs(l)
    const slash = l.items.find((i) => i.kind === 'slash')!
    if (slash.kind !== 'slash') throw new Error(slash.kind)
    const end = advance(a!)
    // WPS（12 磅）：分母起点在分子末端之后 6.90 磅（Information(5)）；斜线下端在其后 0.85 磅、上端 6.10 磅且高于基线
    // 8.25 磅，下端在基线上（页面 EMF，像素取整，±0.375）；画笔 17 缇。
    expect(b!.x - end).toBeCloseTo(6.9, 1)
    expect(Math.abs(slash.x0 - end - 0.85)).toBeLessThan(0.4)
    expect(Math.abs(slash.x1 - end - 6.1)).toBeLessThan(0.4)
    expect(Math.abs(slash.y1 + 8.25)).toBeLessThan(0.4)
    expect(Math.abs(slash.y0)).toBeLessThan(0.4)
    expect(slash.thickness).toBeCloseTo(0.85, 1)
    const t = glyphs(layout(lin(r('a+1'), r('2x')), 12))
    expect(t[1]!.x - t[0]!.x).toBeCloseTo(advance(t[0]!), 6)
  })

  const para = (inner: string, jc = '') =>
    readMathParagraph(
      scanTo(
        `<m:oMathPara>${jc ? `<m:oMathParaPr><m:jc m:val="${jc}"/></m:oMathParaPr>` : ''}` +
          `<m:oMath>${inner}</m:oMath></m:oMathPara>`,
        'oMathPara',
      ),
      readProps,
    )
  const lines = (inner: string, settings = MATH_SETTINGS_DEFAULTS, jc = '') => {
    const res = layoutMathParagraph(para(inner, jc), env(12, settings), 451.3)
    if (res.kind !== 'layout') throw new Error(res.names.join(','))
    return res.lines
  }
  const chain = (op: string, n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyz'[(from + i) % 26]).join(op)
  const count = (l: MathLayout<string>) => glyphs(l).length

  test('显示公式断行：运算符处断开，首行以外的各行缩进 wrapIndent，各行作为一组居中（WPS 12 磅，版心 451.3 磅）', () => {
    const before = lines(r(`y=${chain('+', 40)}`))
    expect(before.map(count)).toEqual([43, 36, 2])
    expect(glyphs(before[1]!)[0]!.text).toBe('+')
    expect(Math.abs(before[0]!.x - 4.2)).toBeLessThan(0.4)
    expect(before[1]!.x - before[0]!.x).toBeCloseTo(72, 6)
    const after = lines(r(`y=${chain('+', 40)}`), {
      ...MATH_SETTINGS_DEFAULTS,
      breakBinary: 'after',
    })
    expect(after.map(count)).toEqual([42, 36, 3])
    const relations = lines(r(`y=${chain('+', 15)}=${chain('+', 15, 3)}=${chain('+', 15, 7)}`))
    expect(relations.map(count)).toEqual([31, 30, 30])
    expect(Math.abs(relations[0]!.x - 35.8)).toBeLessThan(0.4)
    for (const [jc, x] of [
      ['left', 0],
      ['right', 11.55],
      ['center', 5.75],
    ] as const) {
      const l = lines(r(`y=${chain('+', 40)}`), MATH_SETTINGS_DEFAULTS, jc)
      expect(Math.abs(l[0]!.x - x)).toBeLessThan(0.4)
      expect(l[1]!.x).toBe(72)
    }
    const commas = lines(r(chain(',', 60)))
    expect(commas).toHaveLength(1)
    expect(commas[0]!.x).toBe(0)
  })

  test('行内公式分段：在二元运算符与关系符之后，段宽不含运算符后的间距', () => {
    const res = layoutMath(zone(r('a+b=c')), env(12), false)
    if (res.kind !== 'layout') throw new Error(res.names.join(','))
    expect(res.segments.map(count)).toEqual([2, 2, 1])
    expect(res.segments.reduce((w, s) => w + s.advance, 0)).toBeCloseTo(res.width, 6)
    expect(res.segments[0]!.advance - res.segments[0]!.width).toBeCloseTo(0.2255 * 12, 6)
  })

  test('括号：同种括号嵌套时外层取更大的变体；基本字形低于内容上沿时盒子按下一个变体', () => {
    const paren = cambria()
      .table.vertical(cambria().face.metrics.glyphId(0x28))!
      .variants.map((v) => v.glyph)
    const outlines = (l: MathLayout<string>) =>
      l.items.flatMap((i) => (i.kind === 'outline' ? [i.glyph] : []))
    const d = (inner: string, beg = '') =>
      `<m:d>${beg ? `<m:dPr><m:begChr m:val="${beg}"/></m:dPr>` : ''}<m:e>${inner}</m:e></m:d>`
    const frac = `<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`
    // WPS（12 磅显示公式，页面 EMF 路径高度）：((x)) 外层 2475 单位、内层为基本字形；((a/b)) 外层 4047、内层 3379；
    // ([a/b]) 外层 3379，不受内层方括号影响。
    expect(outlines(layout(d(d(r('x'))), 12, true)).slice(0, 2)).toEqual([paren[1]!, paren[0]!])
    expect(outlines(layout(d(d(frac)), 12, true)).slice(0, 2)).toEqual([paren[3]!, paren[2]!])
    expect(outlines(layout(d(d(frac, '[')), 12, true))[0]).toBe(paren[2])
    // (x²)：绘制基本字形，行高为 WPS 的 16.20 磅（按 2475 单位的变体）。
    const sq = layout(d(`<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`), 12, true)
    expect(outlines(sq)[0]).toBe(paren[0])
    expect(Math.abs(sq.lineAscent + sq.lineDescent - 16.2)).toBeLessThan(0.1)
  })

  test('上下标：底式为分数时按底式上沿下降；括住字母的括号与多字字段不下降', () => {
    const sup = (base: string) =>
      glyphs(layout(`<m:sSup><m:e>${base}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`, 12, true)).find(
        (g) => g.text === '2',
      )!
    // WPS（12 磅显示公式）：a/b 的上标基线高于公式基线 12.0 磅（16 像素，±0.375）。
    expect(
      Math.abs(-sup(`<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`).y - 12),
    ).toBeLessThan(0.4)
    expect(-sup(`<m:d><m:e>${r('x')}</m:e></m:d>`).y).toBeCloseTo((750 * 12) / 2048, 6)
    expect(-sup(r('xy')).y).toBeCloseTo((750 * 12) / 2048, 6)
  })

  test('全角形式的定界符按半角圆括号的字形绘制：左侧为「(」、右侧为「)」；「〈」不替代', () => {
    // WPS（Cambria Math 10.5 磅显示公式，页面 EMF）：「（」「）」「［」「］」「｛」「｝」「｜」与半角圆括号的轮廓、伸展与
    // 内容的位置相同；「〈」不按此绘制。
    const frac = `<m:f><m:num>${r('a')}</m:num><m:den>${r('b')}</m:den></m:f>`
    const d = (beg: string, end: string) =>
      `<m:d><m:dPr><m:begChr m:val="${beg}"/><m:endChr m:val="${end}"/></m:dPr><m:e>${frac}</m:e></m:d>`
    const ref = layout(d('(', ')'), 10.5, true)
    for (const [beg, end] of [
      ['（', '）'],
      ['［', '］'],
      ['｛', '｝'],
      ['｜', '｜'],
    ] as const)
      expect(layout(d(beg, end), 10.5, true)).toEqual(ref)
    expect(layoutMath(zone(d('〈', '〉')), env(10.5), true).kind).toBe('unsupported')
  })

  test('普通文字（m:nor）按字形墨迹取上下沿', () => {
    const l = layout(r('x', '<m:rPr><m:nor/></m:rPr>'), 12, true)
    const b = cambria().outlines.bounds(glyphs(l)[0]!.glyph)!
    expect(l.ascent).toBeCloseTo((b.yMax * 12) / 2048, 6)
  })

  const NOR = '<m:rPr><m:nor/><m:sty m:val="p"/></m:rPr>'
  const CM = '<w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr>'
  const height = (inner: string, size: number, zones = [inner]) => {
    const p = readMathParagraph(
      scanTo(
        `<m:oMathPara>${zones.map((z) => `<m:oMath>${z}</m:oMath>`).join('')}</m:oMathPara>`,
        'oMathPara',
      ),
      readProps,
    )
    const res = layoutMathParagraph(p, textEnv(size), 451.3)
    if (res.kind !== 'layout') throw new Error(res.names.join(','))
    return res.lines[0]!
  }
  const sum = (l: MathLayout<string>) => l.lineAscent + l.lineDescent

  test('行高按首个字符的字体：Times New Roman 的普通文字在前时为其单倍行高，数学字体在前时为数学字体的上下沿', () => {
    // WPS（10.5 磅显示公式，段落行顶之差）：普通文字 x 12.05；T 后接数学字体 x 12.05；数学字体 x 后接 T 12.30；
    // 带 ctrlPr（Cambria Math）的下标结构在前 12.30，没有 ctrlPr 的在前 12.05。
    const sub = (pr: string) =>
      `<m:sSub><m:sSubPr>${pr}</m:sSubPr><m:e>${r('L', NOR)}</m:e><m:sub>${r('t', NOR)}</m:sub></m:sSub>`
    expect(sum(height(r('x', NOR), 10.5))).toBeCloseTo(12.05, 1)
    expect(sum(height(r('T', NOR) + r('x', CM), 10.5))).toBeCloseTo(12.05, 1)
    expect(sum(height(r('x', CM) + r('T', NOR), 10.5))).toBeCloseTo(12.3, 1)
    expect(sum(height(sub(`<m:ctrlPr>${CM}</m:ctrlPr>`) + r('T', NOR), 10.5))).toBeCloseTo(12.3, 1)
    expect(sum(height(sub(''), 10.5))).toBeCloseTo(12.05, 1)
  })

  test('东亚字符取其字体的单倍行高上下沿：显示公式行高为宋体单倍行高加 mathLeading，宋体中的西文字符不计', () => {
    // WPS（显示公式）：x 后接宋体全角括号 10.5 磅 15.15、16 磅 23.05；x 后接宋体中的 x 10.5 磅 12.30。
    const paren = r('x', CM) + r('（', NOR)
    expect(sum(height(paren, 10.5))).toBeCloseTo(15.15, 1)
    expect(sum(height(paren, 16))).toBeCloseTo(23.05, 1)
    expect(
      sum(height(r('x', CM) + r('x', `${NOR}<w:rPr><w:rFonts w:ascii="宋体"/></w:rPr>`), 10.5)),
    ).toBeCloseTo(12.3, 1)
  })

  test('上下标：底式字段中按宋体单倍行高排版的字符使上标按其上沿、下标按其下沿下降；西文字符不下降', () => {
    // WPS（10.5 磅显示公式，页面 EMF 字形基线，±0.75）：「汉」「（1+i）」与括住「汉」的括号作底式时，上标基线高于底式基线
    // 8.25 磅；「汉」的下标低 4.5 磅；「x」的上标高 3.75 磅。
    const shift = (inner: string, script: string) => {
      const g = glyphs(height(inner, 10.5))
      return g.find((x) => x.text === script)!.y - g[0]!.y
    }
    const sup = (base: string, s: string) =>
      `<m:sSup><m:e>${base}</m:e><m:sup>${r(s)}</m:sup></m:sSup>`
    expect(Math.abs(-shift(sup(r('汉'), '2'), '2') - 8.25)).toBeLessThan(0.75)
    expect(Math.abs(-shift(sup(r('（') + r('1+i') + r('）'), '2'), '2') - 8.25)).toBeLessThan(0.75)
    expect(Math.abs(-shift(sup(`<m:d><m:e>${r('汉')}</m:e></m:d>`, '2'), '2') - 8.25)).toBeLessThan(
      0.75,
    )
    const sub = `<m:sSub><m:e>${r('汉')}</m:e><m:sub>${r('2')}</m:sub></m:sSub>`
    expect(Math.abs(shift(sub, '2') - 4.5)).toBeLessThan(0.75)
    expect(Math.abs(-shift(sup(r('x'), '汉'), '汉') - 3.75)).toBeLessThan(0.75)
  })

  test('没有 ctrlPr 的结构按前一个字段的字符属性，公式开头时按缺省字符属性', () => {
    // WPS（缺省 10.5 磅，字段 24 磅）：没有 ctrlPr 的 a/b 在开头时行高 36.45、分数线 10.5 磅（EMF 画笔 0.65 磅），
    // 在 24 磅的 y= 之后时行高 49.25、分数线 24 磅（1.55 磅），与带 24 磅 ctrlPr 的相同。
    const big = '<w:rPr><w:rFonts w:ascii="Cambria Math"/><w:sz w:val="48"/></w:rPr>'
    const frac = `<m:f><m:num>${r('a', big)}</m:num><m:den>${r('b', big)}</m:den></m:f>`
    const first = height(frac, 10.5)
    expect(Math.abs(sum(first) - 36.45)).toBeLessThan(0.1)
    const rule = first.items.find((i) => i.kind === 'rule')!
    expect(rule.kind === 'rule' && rule.thickness).toBeCloseTo((133 * 10.5) / 2048, 6)
    expect(Math.abs(sum(height(r('y=', big) + frac, 10.5)) - 49.25)).toBeLessThan(0.1)
  })

  test('同一段落中的多个 oMath 接成一个横向排列，相邻原子按类别加间距', () => {
    // WPS（24 磅，页面 EMF 字形原点，±0.375）：{a/b}{x+1} 中 x 在 a 之后 17.25 磅；{a}{+b} 中 b 在 a 之后 42.0 磅（+ 为二元运算符）。
    const frac = `<m:f><m:fPr><m:ctrlPr>${CM}</m:ctrlPr></m:fPr><m:num>${r('a', CM)}</m:num><m:den>${r('b', CM)}</m:den></m:f>`
    const g1 = glyphs(height('', 24, [frac, r('x+1', CM)]))
    expect(Math.abs(g1[2]!.x - g1[0]!.x - 17.25)).toBeLessThan(0.4)
    const g2 = glyphs(height('', 24, [r('a', CM), r('+b', CM)]))
    expect(Math.abs(g2[2]!.x - g2[0]!.x - 42)).toBeLessThan(0.4)
  })

  test('n 元运算符整体为大型运算符原子：与两侧的普通字符之间各加细间距', () => {
    // WPS（12 磅行内公式）：x∑ᵢyz 中 ∑ 的字形原点在 x 之后 8.25 磅（页面 EMF，±0.375），z 在 y 之后 8.75 磅（逐字横坐标）。
    const g = glyphs(
      layout(
        `${r('x')}<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="subSup"/><m:supHide m:val="1"/></m:naryPr>` +
          `<m:sub>${r('i')}</m:sub><m:sup/><m:e>${r('y')}</m:e></m:nary>${r('z')}`,
        12,
      ),
    )
    const [x, sum, , y, z] = g
    expect(Math.abs(sum!.x - x!.x - 8.25)).toBeLessThan(0.4)
    expect(z!.x - y!.x).toBeCloseTo(8.75, 1)
  })

  test('显示公式的根号：行高与变体选择按 0.127 em 的间隙', () => {
    // WPS（段落行顶之差）：24 磅 √x 的行高 29.75 磅；根号字号 10.5 磅、x 为 16 磅时取基本字形（glyph958）。
    const rad = (x: string, pr = '') =>
      `<m:rad><m:radPr><m:degHide m:val="1"/>${pr}</m:radPr><m:deg/><m:e>${x}</m:e></m:rad>`
    expect(Math.abs(sum(height(rad(r('x', CM)), 24)) - 29.75)).toBeLessThan(0.2)
    const small =
      '<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math"/><w:sz w:val="21"/></w:rPr></m:ctrlPr>'
    const big = '<w:rPr><w:rFonts w:ascii="Cambria Math"/><w:sz w:val="32"/></w:rPr>'
    const sign = height(rad(r('x', big), small), 10.5).items.find((i) => i.kind === 'outline')
    expect(sign?.kind === 'outline' && sign.glyph).toBe(958)
  })

  test('只有根号内的上标按紧缩移位：分母与重音中的上标按 superscriptShiftUp', () => {
    // WPS（48 磅显示公式，页面 EMF 基线，±0.375）：1/x² 中 2 的基线高于 x 17.25 磅，x̂² 中 18.0 磅，√(x²) 中 15.0 磅。
    const x2 = `<m:sSup><m:e>${r('x')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>`
    const shift = (inner: string) => {
      const g = glyphs(layout(inner, 48, true)).filter((q) => q.text === '𝑥' || q.text === '2')
      return g[0]!.y - g[1]!.y
    }
    expect(
      Math.abs(shift(`<m:f><m:num>${r('1')}</m:num><m:den>${x2}</m:den></m:f>`) - 17.25),
    ).toBeLessThan(0.5)
    expect(Math.abs(shift(`<m:acc><m:e>${x2}</m:e></m:acc>`) - 18)).toBeLessThan(0.5)
    expect(
      Math.abs(
        shift(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${x2}</m:e></m:rad>`) -
          15,
      ),
    ).toBeLessThan(0.75)
  })

  test('上下极限的内容右移前后间距之和的四分之一，其后的原子位置不变', () => {
    // WPS（48 磅，页面 EMF 字形原点，±0.375）：a+x̄ⁿ+b（limUpp）中 x 在第一个 + 之后 52.5 磅，第二个 + 在其后 83.25 磅。
    const lim = `<m:limUpp><m:e>${r('x')}</m:e><m:lim>${r('n')}</m:lim></m:limUpp>`
    const g = glyphs(layout(`${r('a+')}${lim}${r('+b')}`, 48, true))
    const plus = g.filter((q) => q.text === '+')
    const x = g.find((q) => q.text === '𝑥')!
    expect(Math.abs(x.x - plus[0]!.x - 52.5)).toBeLessThan(0.5)
    expect(Math.abs(plus[1]!.x - plus[0]!.x - 83.25)).toBeLessThan(0.5)
  })

  test('m:sty="p" 字段中的拉丁字符按字段字体排版，行高取该字体；希腊字母与 b、i 仍取数学字体', () => {
    // WPS（24 磅显示公式）：Times New Roman 的 P、max 行高 27.6 磅（其单倍行高），α 与 sty="b" 的 P 为 28.15 磅（Cambria Math）。
    const tnr = (t: string, sty: string) =>
      r(
        t,
        `<m:rPr><m:sty m:val="${sty}"/></m:rPr><w:rPr><w:rFonts w:ascii="Times New Roman"/></w:rPr>`,
      )
    const p = height(tnr('P', 'p'), 24)
    expect(glyphs(p)[0]!.font).toBe('Times New Roman')
    expect(sum(p)).toBeCloseTo(27.6, 1)
    expect(sum(height(tnr('max', 'p'), 24))).toBeCloseTo(27.6, 1)
    const alpha = height(tnr('α', 'p'), 24)
    expect(glyphs(alpha)[0]!.font).toBe('Cambria Math')
    expect(sum(alpha)).toBeCloseTo(28.15, 1)
    expect(glyphs(height(tnr('P', 'b'), 24))[0]!.font).toBe('Cambria Math')
  })

  test('m:sty 缺省或为 i 时数字与运算符按字段字体排版，为 b 时数字取数学字体', () => {
    // WPS（12 磅显示公式，字段字体 Times New Roman）：2、= 与 x2+(1) 中的 2+(1) 以 Times New Roman 绘制，2 的行高 13.8 磅；
    // m:sty="b" 的 2 映射为数学粗体数字，以 Cambria Math 绘制。
    const tnr = (t: string, sty = '') =>
      r(t, `${sty}<w:rPr><w:rFonts w:ascii="Times New Roman"/></w:rPr>`)
    const two = height(tnr('2'), 12)
    expect(glyphs(two)[0]!.font).toBe('Times New Roman')
    expect(sum(two)).toBeCloseTo(13.8, 1)
    expect(glyphs(height(tnr('x2+(1)'), 12)).map((g) => g.font)).toEqual([
      'Cambria Math',
      'Times New Roman',
      'Times New Roman',
      'Times New Roman',
      'Times New Roman',
      'Times New Roman',
    ])
    expect(glyphs(height(tnr('2', '<m:rPr><m:sty m:val="i"/></m:rPr>'), 12))[0]!.font).toBe(
      'Times New Roman',
    )
    expect(glyphs(height(tnr('2', '<m:rPr><m:sty m:val="b"/></m:rPr>'), 12))[0]!.font).toBe(
      'Cambria Math',
    )
  })

  test('东亚提示的希腊与西里尔字母落在东亚字体中：按该字体绘制，取其单倍行高上下沿', () => {
    // WPS（24 磅显示公式 x 后接东亚提示的字段，Times New Roman 与宋体）：m:sty="p" 的 α、μ、а 以宋体绘制，行高 34.6 磅；
    // · 与 “ 以 Cambria Math 绘制，行高 28.15 磅；m:sty 缺省的 α 映射为数学斜体、以 Cambria Math 绘制，а 以宋体绘制、34.6 磅；
    // m:nor 的 α 以宋体绘制、34.6 磅，· 以宋体绘制、28.15 磅。
    const HINT = '<w:rPr><w:rFonts w:hint="eastAsia" w:ascii="Times New Roman"/></w:rPr>'
    const STY = '<m:rPr><m:sty m:val="p"/></m:rPr>'
    const x = r('x', CM)
    const line = (ch: string, mp: string) => height(x + r(ch, mp + HINT), 24)
    for (const ch of ['α', 'μ', 'а']) {
      const l = line(ch, STY)
      expect(glyphs(l)[1]!.font).toBe('宋体')
      expect(sum(l)).toBeCloseTo(34.6, 1)
    }
    for (const ch of ['·', '“']) {
      const l = line(ch, STY)
      expect(glyphs(l)[1]!.font).toBe('Cambria Math')
      expect(sum(l)).toBeCloseTo(28.15, 1)
    }
    expect(glyphs(line('α', ''))[1]!.font).toBe('Cambria Math')
    const cyrillic = line('а', '')
    expect(glyphs(cyrillic)[1]!.font).toBe('宋体')
    expect(sum(cyrillic)).toBeCloseTo(34.6, 1)
    expect(sum(line('α', NOR))).toBeCloseTo(34.6, 1)
    const dot = line('·', NOR)
    expect(glyphs(dot)[1]!.font).toBe('宋体')
    expect(sum(dot)).toBeCloseTo(28.15, 1)
  })
})

describe.skipIf(!windows)('数学字体读取', () => {
  test('没有 MATH 表的字体不读取轮廓：loca 不完整时同样返回 null', () => {
    const bytes = new Uint8Array(readFileSync(join(FONTS, 'times.ttf')))
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = v.getUint16(4)
    for (let i = 0; i < count; i++) {
      const rec = 12 + 16 * i
      if (String.fromCharCode(...bytes.subarray(rec, rec + 4)) === 'loca') v.setUint32(rec + 12, 2)
    }
    expect(() => readGlyphOutlines(bytes, readFaces(bytes)[0]!)).toThrow()
    expect(readMathFont(bytes, 0, 'Times New Roman')).toBeNull()
  })
})

describe('绘制', () => {
  function recorder() {
    const rects: number[][] = []
    const texts: [string, string, number, number][] = []
    const ctx = {
      fillStyle: '' as unknown,
      font: '',
      fillRect: (x: number, y: number, w: number, h: number) => rects.push([x, y, w, h]),
      fillText: (t: string, x: number, y: number) => texts.push([t, ctx.font, x, y]),
      beginPath() {},
      moveTo() {},
      lineTo() {},
      quadraticCurveTo() {},
      closePath() {},
      fill() {},
    }
    return { ctx, rects, texts }
  }

  test('不平滑填充按像素左上角取样（GDI）：横线 [373.33, 374.4) 只填第 374 行，列 122–130（WPS 页面图）', () => {
    const { ctx, rects } = recorder()
    fillAliased(ctx, [
      [
        [121.47, 373.33],
        [131.0, 373.33],
        [131.0, 374.4],
        [121.47, 374.4],
      ],
    ])
    expect(rects).toEqual([[122, 374, 9, 1]])
  })

  test('分数线：1 像素时不延伸，4 像素时两端各延伸 2 像素、横向多 1 像素', () => {
    const one: MathLayout<string> = {
      width: 0,
      ascent: 0,
      descent: 0,
      lineAscent: 0,
      lineDescent: 0,
      items: [{ kind: 'rule', x0: 305.25, x1: 312, y: -3.75, thickness: 0.779, color: '#000' }],
    }
    const a = recorder()
    paintMath(a.ctx, one, 0, 104.25, { family: (f) => f, outlines: () => null })
    expect(a.rects).toEqual([[407, 134, 10, 1]])
    const four = {
      ...one,
      items: [{ ...one.items[0]!, x0: 328.5, x1: 354.75, y: -13.5, thickness: 3.117 }],
    }
    const b = recorder()
    paintMath(b.ctx, four as MathLayout<string>, 0, 395.25, {
      family: (f) => f,
      outlines: () => null,
    })
    expect(b.rects).toEqual([[436, 507, 40, 4]])
  })

  test('斜线：1 像素时按 Bresenham 画线且两端点着色（WPS 页面图，12 磅 a/b 的斜线自 (122, 112) 至 (129, 101)）', () => {
    const l: MathLayout<string> = {
      width: 0,
      ascent: 0,
      descent: 0,
      lineAscent: 0,
      lineDescent: 0,
      items: [
        { kind: 'slash', x0: 91.5, y0: 84, x1: 96.75, y1: 75.75, thickness: 0.85, color: '#000' },
      ],
    }
    const { ctx, rects } = recorder()
    paintMath(ctx, l, 0, 0, { family: (f) => f, outlines: () => null })
    const columns = [122, 123, 123, 124, 125, 125, 126, 126, 127, 128, 128, 129]
    expect(rects).toEqual(columns.map((x, i) => [x, 112 - i, 1, 1]))
  })

  test('文字：整数像素字号，原点四舍五入', () => {
    const l: MathLayout<string> = {
      width: 0,
      ascent: 0,
      descent: 0,
      lineAscent: 0,
      lineDescent: 0,
      items: [
        {
          kind: 'glyph',
          x: 9.0675,
          y: 0,
          size: 12,
          glyph: 3397,
          text: '+',
          font: 'Cambria Math',
          color: '#000',
          bold: false,
          italic: false,
        },
      ],
    }
    const { ctx, texts } = recorder()
    paintMath(ctx, l, 96, 84, { family: (f) => f, outlines: () => null })
    expect(texts).toEqual([['+', '16px "Cambria Math"', 140, 112]])
  })
})
