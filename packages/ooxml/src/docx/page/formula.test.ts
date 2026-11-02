/**
 * docx 中的公式。覆盖 `../parse/body.ts`（公式字段、显示公式的判定、删除的修订）、`../parse/settings.ts`（`m:mathPr`）、
 * `../layout.ts`（行内公式参与断行与行高、显示公式段落的行高与横向位置、不能排版的公式）、`build.ts`（`requiredFonts`
 * 中的数学字体、`PageParagraph.formulas` 与 `Page.hiddenMath`）、`../render/fonts.ts`（数学字体的读取与登记）与
 * `../render/paint.ts`（公式的绘制）。
 *
 * 期望值取自 WPS 12.1 只读打开构造文档 w7-ls、w7-lsgrid、w7-x、w7-xleft、w7-mark 后逐段取得的位置
 * （`Range.Information(5)`、`Information(6)`，0.05 磅精度）。排版用例读取本机 Windows 字体目录中的宋体、
 * Times New Roman 与 Cambria Math（cambria.ttc 第 2 个字体）：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { type DocxDocument, layoutDocument, type Paragraph, parseDocx } from '../index.ts'
import type { ParagraphLayout } from '../layout.ts'
import { DocxFonts, loadDocxFace } from '../render/fonts.ts'
import { paintPage } from '../render/paint.ts'
import { buildDocx, p, r } from '../test-helper.ts'
import { layoutPages, requiredFonts } from './build.ts'
import type { PageParagraph } from './model.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const HAS_FONTS = ['simsun.ttc', 'times.ttf', 'cambria.ttc'].every((f) =>
  existsSync(join(FONTS, f)),
)

const STYLES =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" ' +
  'w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr>' +
  '</w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
/** A4，四边距 72 磅：版心宽 451.3 磅。 */
const SECT = (grid = '') =>
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
  `w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/>${grid}</w:sectPr>`
const GRID = '<w:docGrid w:type="lines" w:linePitch="312"/>'

const mr = (t: string, rpr = '') =>
  `<m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/>${rpr}</w:rPr><m:t>${t}</m:t></m:r>`
const FRAC = `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>`
const omath = (z: string) => `<m:oMath>${z}</m:oMath>`
const para = (z: string, jc?: string) =>
  `<m:oMathPara>${jc ? `<m:oMathParaPr><m:jc m:val="${jc}"/></m:oMathParaPr>` : ''}${omath(z)}</m:oMathPara>`
const spacing = (line: number) => `<w:spacing w:line="${line}" w:lineRule="auto"/>`

async function parse(body: string, settings?: string): Promise<DocxDocument> {
  const parts = { styles: STYLES, body }
  const result = await parseDocx(buildDocx(settings === undefined ? parts : { ...parts, settings }))
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

function paragraphs(doc: DocxDocument): Paragraph[] {
  return doc.body.filter((b): b is Paragraph => b.kind === 'paragraph')
}

/** 各字段：显示公式为对齐方式，行内公式为 `inline`，文字为其内容。 */
function kinds(pg: Paragraph): string[] {
  return pg.runs.map((x) => (x.math === undefined ? x.text : (x.math.display ?? 'inline')))
}

describe('公式字段与显示公式的判定', () => {
  test('只含一个 oMathPara 或若干个 oMath 的段落为显示公式；另有文字或两种混合时为行内公式；删除的修订不显示', async () => {
    const doc = await parse(
      p(para(FRAC)) +
        p(para(FRAC, 'left')) +
        p(omath(FRAC) + omath(mr('x'))) +
        p(para(FRAC) + r('（1）')) +
        p(r('设') + omath(mr('x'))) +
        p(para(FRAC) + omath(mr('x'))) +
        p(`<w:del w:id="1" w:author="a">${omath(mr('x'))}</w:del>${r('a')}`) +
        SECT(),
    )
    expect(paragraphs(doc).map(kinds)).toEqual([
      ['centerGroup'],
      ['left'],
      ['centerGroup', 'centerGroup'],
      ['inline', '（1）'],
      ['设', 'inline'],
      ['inline', 'inline'],
      ['a'],
    ])
    // \u516C\u5F0F\u5B57\u6BB5\u7684\u6587\u5B57\u4E3A\u7A7A\u4E32\uFF1A\u9875\u7709 STYLEREF \u53D6\u6BB5\u843D\u6587\u5B57\u65F6\u4E0D\u51FA\u73B0\u5360\u4F4D\u5B57\u7B26\u3002
    const first = paragraphs(doc)[0]!.runs[0]!
    expect(first.text).toBe('')
    expect(doc.unsupported).toEqual({ revision: 1 })
  })

  test('mathPr：defJc 决定没有 jc 的显示公式；数学字体名计入所需字体，没有公式的文档不计入', async () => {
    const settings =
      '<m:mathPr><m:mathFont m:val="STIX Two Math"/><m:defJc m:val="left"/></m:mathPr>'
    const doc = await parse(
      p(para(FRAC)) + p(omath(FRAC)) + p(para(FRAC, 'center')) + SECT(),
      settings,
    )
    expect(doc.settings.math.defaultJustification).toBe('left')
    expect(paragraphs(doc).map(kinds)).toEqual([['left'], ['left'], ['center']])
    expect(requiredFonts(doc)).toContain('STIX Two Math')
    const plain = await parse(p(r('a')) + SECT(), settings)
    expect(requiredFonts(plain)).not.toContain('STIX Two Math')
  })
})

describe.skipIf(!HAS_FONTS)('公式的排版与分页', () => {
  const load = (file: string, family: string, index = 0) =>
    loadDocxFace(new Uint8Array(readFileSync(join(FONTS, file))), family, index)
  let all: DocxFonts | null = null
  const fonts = (): DocxFonts => {
    all ??= new DocxFonts(
      [
        load('simsun.ttc', '宋体'),
        load('times.ttf', 'Times New Roman'),
        load('cambria.ttc', 'Cambria Math', 1),
      ],
      '宋体',
    )
    return all
  }
  /** 没有数学字体的字体集。 */
  const textOnly = () =>
    new DocxFonts([load('simsun.ttc', '宋体'), load('times.ttf', 'Times New Roman')], '宋体')
  const layouts = (doc: DocxDocument) => layoutDocument(doc, fonts().source).paragraphs
  const bodyOf = (doc: DocxDocument, f = fonts()) =>
    layoutPages(doc, f).pages.pages[0]!.body.filter(
      (it): it is PageParagraph => it.kind === 'paragraph',
    )

  test('Cambria Math 读取为数学字体，其余字体不是', () => {
    expect(load('cambria.ttc', 'Cambria Math', 1).math).not.toBeNull()
    expect(load('cambria.ttc', 'Cambria', 0).math).toBeNull()
    expect(fonts().source.math('Cambria Math')).not.toBeNull()
    expect(fonts().source.math('宋体')).toBeNull()
  })

  test('显示公式段落：行高为公式行的上下沿之和，多倍行距增加的部分按段落标记的单倍行高计，不对齐行网格', async () => {
    const body =
      p(para(FRAC)) +
      p(para(FRAC), spacing(276)) +
      p(para(FRAC), spacing(360)) +
      p(para(FRAC), `${spacing(276)}<w:rPr><w:sz w:val="32"/></w:rPr>`) +
      p(r('文字') + omath(FRAC) + r('文字'))
    const heights = (doc: DocxDocument) => layouts(doc).map((l) => l.text.lines[0]!.height)
    const plain = heights(await parse(body + SECT()))
    // WPS：21.55、23.35、27.6，段落标记 16 磅时 24.3；行内公式的段落 16.55。
    const wps = [21.55, 23.35, 27.6, 24.3, 16.55]
    for (const [i, h] of plain.entries()) expect(Math.abs(h - wps[i]!)).toBeLessThan(0.1)
    // 有行网格（15.6 磅）时显示公式的行高不变，行内公式的段落占两格。
    const grid = heights(await parse(body + SECT(GRID)))
    expect(grid.slice(0, 4)).toEqual(plain.slice(0, 4))
    expect(grid[4]).toBeCloseTo(31.2, 6)
  })

  test('显示公式的横向位置：在缩进之间按 jc 与 defJc 对齐，不按段落的对齐方式与首行缩进', async () => {
    const doc = await parse(
      p(para(FRAC)) +
        p(para(FRAC), '<w:ind w:firstLine="480"/>') +
        p(para(FRAC), '<w:ind w:left="720"/>') +
        p(para(FRAC), '<w:ind w:right="1440"/>') +
        p(para(FRAC), '<w:jc w:val="right"/>') +
        p(para(FRAC, 'left')) +
        p(para(FRAC, 'right')) +
        p(omath(FRAC), '<w:jc w:val="left"/><w:ind w:firstLine="480"/>') +
        SECT(),
    )
    const xs = bodyOf(doc).map((it) => it.formulas[0]!.x)
    const wps = [294.75, 294.75, 312.75, 258.75, 294.75, 72, 517.5, 294.75]
    for (const [i, x] of xs.entries()) expect(Math.abs(x - wps[i]!)).toBeLessThan(0.1)
  })

  test('行内公式参与断行：其后的文字从公式右端开始；排不下时与公式前的汉字之间断开', async () => {
    const wide = omath(mr('x+y+z'))
    const doc = await parse(
      p(r('文字') + omath(FRAC) + r('字')) + p(r('汉'.repeat(43)) + wide) + SECT(),
    )
    const [first, second] = layouts(doc)
    const line = first!.text.lines[0]!
    const formula = first!.formulas[0]!
    expect(formula.layout).not.toBeNull()
    const after = line.fragments.find((f) => first!.runs[f.run] === 2)!
    expect(formula.x).toBeCloseTo(21, 6)
    expect(after.x).toBeCloseTo(21 + formula.layout!.width, 6)
    expect(second!.text.lines).toHaveLength(2)
    expect(second!.formulas[0]).toMatchObject({ line: 1 })
  })

  test('行内公式在运算符后的段间断行：下一行的段自行首开始；两端对齐不在段间加距；公式在段落文字中不占位置', async () => {
    const body = (jc: string) =>
      p(r('汉'.repeat(38)) + omath(mr('a+b+c+d+e+f')), `<w:jc w:val="${jc}"/>`)
    const [lay, left] = layouts(await parse(body('both') + body('left') + SECT()))
    const lines = lay!.text.lines
    expect(lines).toHaveLength(2)
    expect(lines[0]!.end).toBe(38)
    expect(lines[1]!.start).toBe(38)
    expect(lines[1]!.end).toBe(38)
    expect(lines.map((l) => l.fragments.length)).toEqual([1, 0])
    const onLine = (l: ParagraphLayout, k: number) => l.formulas.filter((f) => f.line === k)
    expect(onLine(lay!, 0).length).toBeGreaterThan(1)
    expect(onLine(lay!, 1).length).toBeGreaterThan(0)
    expect(onLine(lay!, 1)[0]!.x).toBeCloseTo(0, 6)
    const gaps = (l: ParagraphLayout) =>
      onLine(l, 0)
        .slice(1)
        .map((f, k) => f.x - onLine(l, 0)[k]!.x)
    gaps(lay!).forEach((g, k) => {
      expect(g).toBeCloseTo(gaps(left!)[k]!, 6)
    })
  })

  test('含公式的文字行：多倍行距增加的部分按文字字体的单倍行高计，不计公式（WPS：w7-ls 行内分数 2 倍行距 30.20 磅、1.5 倍 23.35 磅）', async () => {
    const line = (h: number) =>
      p(r('文字') + omath(FRAC) + r('文字'), `${spacing(h)}<w:jc w:val="left"/>`)
    const heights = layouts(await parse(line(480) + line(360) + SECT())).map(
      (l) => l.text.lines[0]!.height,
    )
    expect(Math.abs(heights[0]! - 30.2)).toBeLessThan(0.1)
    expect(Math.abs(heights[1]! - 23.35)).toBeLessThan(0.1)
  })

  test('行尾的公式段按其宽度对齐：右对齐时最后一段的右端位于行的右端，运算符之后的间距不计', async () => {
    const doc = await parse(
      p(r('汉'.repeat(40)) + omath(mr('a+b+c+d')), '<w:jc w:val="right"/>') + SECT(),
    )
    const [lay] = layouts(doc)
    const first = lay!.formulas.filter((f) => f.line === 0)
    const last = first.at(-1)!
    expect(last.x + last.layout!.width).toBeCloseTo(lay!.text.lines[0]!.limit, 6)
  })

  test('主机没有数学字体或公式含未实现的结构时不绘制，计入 hiddenMath；行内公式宽度为 0', async () => {
    const doc = await parse(
      p(r('文字') + omath(FRAC) + r('字')) + p(para(FRAC)) + p(omath('<m:foo/>')) + SECT(),
    )
    const missing = layoutPages(doc, textOnly()).pages.pages[0]!
    expect(missing.hiddenMath).toBe(3)
    const items = missing.body.filter((it): it is PageParagraph => it.kind === 'paragraph')
    expect(items.every((it) => it.formulas.length === 0)).toBe(true)
    const frags = items[0]!.lines[0]!.fragments
    expect(frags.map((f) => f.text)).toEqual(['文字', '字'])
    expect(frags[1]!.x).toBeCloseTo(frags[0]!.x + 21, 6)
    const drawn = layoutPages(doc, fonts()).pages.pages[0]!
    expect(drawn.hiddenMath).toBe(1)
  })

  test('绘制：公式的字形以数学字体的族名绘制，分数线以填充矩形绘制，不生成文字片段', async () => {
    const doc = await parse(p(para(FRAC)) + SECT())
    const f = fonts()
    const { pages } = layoutPages(doc, f)
    const page = pages.pages[0]!
    const item = page.body[0] as PageParagraph
    expect(item.lines[0]!.fragments).toEqual([])
    expect(item.formulas).toHaveLength(1)
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      page,
      { faces: pages.faces, draw: (ref) => f.draw(ref) },
      { images: [], parts: [], createCanvas: () => new RecordingCanvas(1, 1) },
    )
    const glyphs = ctx.named('fillText').filter((c) => c.font.includes('"Cambria Math"'))
    expect(glyphs.map((c) => c.args[0])).toEqual(['𝑎', '𝑏'])
    expect(ctx.named('fillRect').length).toBeGreaterThan(1)
  })
})
