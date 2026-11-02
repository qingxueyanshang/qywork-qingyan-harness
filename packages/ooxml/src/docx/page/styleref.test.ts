/**
 * 页眉页脚中的 STYLEREF 域。覆盖 `../parse/styles.ts`（样式名与自定样式标记）、`../parse/body.ts`（结果字段的合并、
 * 样式参数的解析与无效参数的文字）、`build.ts`（按页求出的段落文字、页眉页脚缓存按域的取值区分）。
 *
 * 期望值取自 WPS 12.1 只读打开构造文档 w6-styleref、w6-styleref2、w6-styleref3、w10s 后各页 EMF 中的页眉文字。
 * 分页用例读取本机 Windows 字体目录中的宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DocxDocument, type Paragraph, parseDocx } from '../index.ts'
import { DocxFonts, loadDocxFace } from '../render/fonts.ts'
import { buildDocx, p, r } from '../test-helper.ts'
import { layoutPages } from './build.ts'
import type { PageItem } from './model.ts'

const STYLES =
  '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/></w:style>' +
  '<w:style w:type="paragraph" w:customStyle="1" w:styleId="X"><w:name w:val="自定标题"/><w:basedOn w:val="a"/></w:style>'

function field(instr: string, cached: string): string {
  return (
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${cached.slice(0, 1)}</w:t></w:r><w:r><w:t>${cached.slice(1)}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  )
}

const FIELDS: readonly (readonly [string, string])[] = [
  ['甲', 'STYLEREF "标题 1"'],
  ['乙', 'STYLEREF "heading 1"'],
  ['丙', 'STYLEREF 1 \\l'],
  ['丁', 'STYLEREF 自定标题'],
  ['戊', 'STYLEREF "标题 3"'],
  ['己', 'STYLEREF X'],
]

const HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  FIELDS.map(([k, instr]) => p(r(`${k}：`) + field(instr, `缓存${k}`))).join('') +
  '</w:hdr>'

const SECT =
  '<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'

async function parse(body: string): Promise<DocxDocument> {
  const result = await parseDocx(
    buildDocx({
      body: body + SECT,
      styles: STYLES,
      extra: [{ id: 'rIdHdr', type: 'header', name: 'header1.xml', content: HEADER }],
    }),
  )
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

const PAGE_BREAK = p('<w:r><w:br w:type="page"/></w:r>')
const heading = (text: string) => p(r(text), '<w:pStyle w:val="1"/>')

describe('STYLEREF 的解析', () => {
  test('页眉中的结果字段合并为一个字段；内置标题按「标题 N」与 N 引用，自定样式按样式名引用，其余参数显示错误文字', async () => {
    const doc = await parse(p(r('正文')))
    const runs = doc.parts.rIdHdr!.map((b) => (b as Paragraph).runs.slice(1))
    expect(runs.map((list) => list.length)).toEqual([1, 1, 1, 1, 1, 1])
    expect(runs.map((list) => list[0]!.text)).toEqual([
      '缓存甲',
      '错误！未定义样式。',
      '缓存丙',
      '缓存丁',
      '缓存戊',
      '错误！未定义样式。',
    ])
    expect(runs.map((list) => list[0]!.styleRef ?? null)).toEqual([
      { style: '1', last: false },
      null,
      { style: '1', last: true },
      { style: 'X', last: false },
      { style: null, last: false },
      null,
    ])
    expect(runs.every((list) => list[0]!.field === 'STYLEREF')).toBe(true)
  })

  test('正文中的 STYLEREF 显示缓存的结果，不合并字段', async () => {
    const doc = await parse(p(field('STYLEREF "标题 1"', '缓存')))
    const runs = (doc.body[0] as Paragraph).runs
    expect(runs.map((x) => x.text)).toEqual(['缓', '存'])
    expect(runs.every((x) => x.styleRef === undefined)).toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('STYLEREF 按页求出的文字（本机字体）', () => {
  const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  const fonts = () =>
    new DocxFonts(
      [loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)],
      '宋体',
    )
  const text = (items: readonly PageItem[]) =>
    items.flatMap((it) =>
      it.kind === 'table' ? [] : it.lines.map((l) => l.fragments.map((f) => f.text).join('')),
    )

  test('本页第一个（\\l 时最后一个）该样式的段落；本页没有时取之前最后一个，之前也没有时取之后第一个', async () => {
    const doc = await parse(
      p(r('第一页没有标题。')) +
        PAGE_BREAK +
        heading('甲章') +
        p(r('正文')) +
        heading('乙章') +
        PAGE_BREAK +
        p(r('第三页没有标题。')) +
        p(r('自定一'), '<w:pStyle w:val="X"/>') +
        PAGE_BREAK +
        heading('丙章'),
    )
    const pages = layoutPages(doc, fonts()).pages.pages
    expect(pages).toHaveLength(4)
    expect(pages.map((pg) => text(pg.header))).toEqual(
      [
        ['甲章', '甲章', '自定一'],
        ['甲章', '乙章', '自定一'],
        ['乙章', '乙章', '自定一'],
        ['丙章', '丙章', '自定一'],
      ].map(([a, c, d]) => [
        `甲：${a}`,
        '乙：错误！未定义样式。',
        `丙：${c}`,
        `丁：${d}`,
        '戊：文档中未找到关联章节样式',
        '己：错误！未定义样式。',
      ]),
    )
  })

  test('引用含公式的段落：字母为数学斜体，结构写为 U+001A 与各参数，每个参数之后加 U+001B', async () => {
    const mr = (t: string) =>
      `<m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t>${t}</m:t></m:r>`
    const frac = `<m:f><m:num>${mr('a+1')}</m:num><m:den>${mr('b')}</m:den></m:f>`
    const radical = `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mr('x')}</m:e></m:rad>`
    const doc = await parse(
      p(`${r('例')}<m:oMath>${mr('x+1')}</m:oMath>${r('尾')}`, '<w:pStyle w:val="1"/>') +
        PAGE_BREAK +
        p(`${r('例')}<m:oMath>${frac}${radical}</m:oMath>`, '<w:pStyle w:val="1"/>'),
    )
    const pages = layoutPages(doc, fonts()).pages.pages
    expect(pages.map((pg) => text(pg.header)[0])).toEqual([
      '甲：例𝑥+1尾',
      '甲：例\u001a𝑎+1\u001b𝑏\u001b\u001a\u001b𝑥\u001b',
    ])
  })
})
