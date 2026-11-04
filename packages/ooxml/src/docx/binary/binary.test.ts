/**
 * 覆盖 `docx/binary/` 的 `fib.ts`、`text.ts`、`sprm.ts`、`styles.ts`、`table.ts`、`picture.ts`、`drawing.ts`、`document.ts`，以及
 * `parseDocx` 对 CFB 的分派：正文与字符、段落属性，隐藏段落标记的接排，样式继承与切换属性，快速保存的片段表，表格（单元格、行高、
 * 边框、纵向合并），节与页面设置，编号，域，页眉页脚，嵌入式图片，浮动对象与文本框，能力边界计数，已加密与已损坏。
 *
 * 夹具由 `test-helper.ts` 按段落与字段生成。
 */

import { describe, expect, test } from 'bun:test'
import { buildCfb } from '../../zip/test-helper.ts'
import { parseDocx } from '../load.ts'
import type { Block, DocxDocument, Paragraph, TableBlock } from '../model.ts'
import { buildDoc, type DocOptions, le16, le32, type Std, sprm, utf16 } from './test-helper.ts'

async function open(o: DocOptions): Promise<DocxDocument> {
  const r = await parseDocx(buildDoc(o))
  if (!r.ok) throw new Error(`解析失败：${JSON.stringify(r.failure)}`)
  return r.value
}

function paragraph(b: Block | undefined): Paragraph {
  if (b?.kind !== 'paragraph') throw new Error('不是段落')
  return b
}

function text(b: Block | undefined): string {
  return paragraph(b)
    .runs.map((r) => r.text)
    .join('')
}

const s16 = (v: number) => le16(v & 0xffff)

describe('.doc 正文', () => {
  test('文字、字符属性与段落属性', async () => {
    const doc = await open({
      paragraphs: [
        {
          runs: [
            { text: '普通' },
            { text: '粗体', chpx: sprm(0x0835, 1) },
            {
              text: '大号',
              chpx: [...sprm(0x4a43, ...le16(32)), ...sprm(0x6870, 0x12, 0x34, 0x56, 0)],
            },
          ],
          papx: [...sprm(0x2461, 1), ...sprm(0x845e, ...le16(480)), ...sprm(0x8460, ...s16(-240))],
        },
        { runs: [{ text: 'A\tB\u000bC' }] },
      ],
    })
    const p = paragraph(doc.body[0])
    expect(p.runs.map((r) => r.text)).toEqual(['普通', '粗体', '大号'])
    expect(p.runs[0]!.props.size).toBe(10)
    expect(p.runs[0]!.props.fonts.ascii).toBe('Times New Roman')
    expect(p.runs[0]!.props.fonts.eastAsia).toBe('宋体')
    expect(p.runs[1]!.props.bold).toBe(true)
    expect(p.runs[2]!.props.size).toBe(16)
    expect(p.runs[2]!.props.color).toBe('#123456')
    expect(p.props.align).toBe('center')
    expect(p.props.left).toBe(24)
    expect(p.props.firstLine).toBe(-12)
    expect(text(doc.body[1])).toBe('A\tB\nC')
    expect(doc.settings.defaultTabStop).toBe(21)
  })

  test('快速保存的文件按片段表取得文字，压缩的片段按单字节读取', async () => {
    const doc = await open({
      paragraphs: [{ runs: [{ text: '第一段' }] }, { runs: [{ text: 'second' }] }],
      pieces: [
        { start: 4, end: 11, compressed: true },
        { start: 0, end: 4 },
      ],
    })
    expect(doc.body.map(text)).toEqual(['第一段', 'second'])
  })

  test('段落标记隐藏（sprmCFVanish 取样式中的值取反）的段落与下一段接排，段落属性取前一段', async () => {
    const doc = await open({
      paragraphs: [
        { runs: [{ text: '甲' }], markChpx: sprm(0x083c, 0x81), papx: sprm(0x2461, 1) },
        { runs: [{ text: '乙' }], papx: sprm(0x2461, 2) },
        { runs: [{ text: '丙' }] },
      ],
    })
    expect(doc.body.map(text)).toEqual(['甲乙', '丙'])
    expect(paragraph(doc.body[0]).props.align).toBe('center')
  })

  test('样式继承、字符样式与取反的切换属性', async () => {
    const styles: Std[] = [
      {
        istd: 0,
        sti: 0,
        stk: 1,
        base: 0x0fff,
        name: 'Normal',
        upx: [le16(0), sprm(0x4a43, ...le16(21))],
      },
      {
        istd: 1,
        sti: 1,
        stk: 1,
        base: 0,
        name: 'heading 1',
        upx: [[...le16(1), ...sprm(0x2406, 1)], sprm(0x0835, 1)],
      },
      { istd: 10, sti: 65, stk: 2, base: 0x0fff, name: 'Default Paragraph Font', upx: [[]] },
      {
        istd: 11,
        sti: 0x0ffe,
        stk: 2,
        base: 10,
        name: '强调',
        upx: [[...sprm(0x0836, 1), ...sprm(0x2a42, 6)]],
      },
    ]
    const doc = await open({
      styles,
      paragraphs: [
        {
          istd: 1,
          runs: [
            { text: 'A' },
            { text: 'B', chpx: sprm(0x4a30, ...le16(11)) },
            { text: 'C', chpx: sprm(0x0835, 0x81) },
          ],
        },
        { runs: [{ text: 'D' }] },
      ],
    })
    const p = paragraph(doc.body[0])
    expect(p.style).toBe('1')
    expect(p.props.keepNext).toBe(true)
    const [a, b, c] = p.runs
    expect(a!.props.bold).toBe(true)
    expect(a!.props.size).toBe(10.5)
    expect(b!.props.italic).toBe(true)
    expect(b!.props.color).toBe('#ff0000')
    expect(c!.props.bold).toBe(false)
    expect(paragraph(doc.body[1]).runs[0]!.props.bold).toBe(false)
  })
})

describe('.doc 表格', () => {
  /** sprmTDefTable：单元格边界与 TC80（标记、首选宽度、四边的 BRC80）。 */
  const defTable = (centers: number[], flags: number[]) => {
    const single = [4, 1, 1, 0]
    const tcs = flags.flatMap((f) => [
      ...le16(f),
      ...le16(0),
      ...single,
      ...single,
      ...single,
      ...single,
    ])
    const body = [centers.length - 1, ...centers.flatMap(s16), ...tcs]
    return [...le16(0xd608), ...le16(body.length + 1), ...body]
  }
  const cell = (t: string) => ({ runs: [{ text: t }], mark: '\u0007', papx: sprm(0x2416, 1) })
  const rowEnd = (tap: number[]) => ({
    runs: [],
    mark: '\u0007',
    papx: [...sprm(0x2416, 1), ...sprm(0x2417, 1), ...tap],
  })

  test('单元格、网格、行高、边框与纵向合并', async () => {
    const tap = (flags: number[]) => [
      ...sprm(0x9602, ...le16(108)),
      ...sprm(0x9407, ...s16(-400)),
      ...defTable([-108, 2000, 4000], flags),
    ]
    const doc = await open({
      paragraphs: [
        cell('甲'),
        cell('乙'),
        rowEnd(tap([0x60, 0])),
        cell(''),
        cell('丁'),
        rowEnd(tap([0x20, 0])),
        { runs: [{ text: '后' }] },
      ],
    })
    expect(doc.body).toHaveLength(2)
    const t = doc.body[0] as TableBlock
    expect(t.kind).toBe('table')
    expect(t.grid).toEqual([105.4, 100])
    expect(t.indent).toBe(0)
    expect(t.margins.left).toBe(5.4)
    expect(t.layout).toBe('fixed')
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0]!.height).toEqual({ rule: 'exact', value: 20 })
    expect(t.rows[0]!.cells.map((c) => text(c.content[0]))).toEqual(['甲', '乙'])
    expect(t.rows[0]!.cells[0]!.vMerge).toBe('restart')
    expect(t.rows[1]!.cells[0]!.vMerge).toBe('continue')
    expect(t.rows[0]!.cells[1]!.borders.top).toEqual({
      style: 'single',
      width: 0.5,
      color: '#000000',
      space: 0,
    })
    expect(text(t.rows[1]!.cells[1]!.content[0])).toBe('丁')
    expect(text(doc.body[1])).toBe('后')
  })
})

describe('.doc 节与编号', () => {
  test('页面尺寸、页边距、分节与行网格；没有 SEPX 项时为标准节属性', async () => {
    const page = [
      ...sprm(0xb01f, ...le16(11906)),
      ...sprm(0xb020, ...le16(16838)),
      ...sprm(0xb021, ...le16(1800)),
      ...sprm(0xb022, ...le16(1800)),
      ...sprm(0x9023, ...le16(1440)),
      ...sprm(0x9024, ...le16(1440)),
    ]
    const doc = await open({
      paragraphs: [{ runs: [{ text: '一' }], mark: '\u000c' }, { runs: [{ text: '二' }] }],
      sections: [
        { end: 2, sepx: page },
        {
          end: 4,
          sepx: [...sprm(0x3009, 0), ...sprm(0x5032, ...le16(2)), ...sprm(0x9031, ...le16(312))],
        },
      ],
    })
    expect(doc.sections).toHaveLength(2)
    const [a, b] = doc.sections
    expect(a!.pageWidth).toBeCloseTo(595.3)
    expect(a!.pageHeight).toBeCloseTo(841.9)
    expect(a!.marginLeft).toBe(90)
    expect(b!.pageWidth).toBe(612)
    expect(b!.start).toBe('continuous')
    expect(b!.gridType).toBe('lines')
    expect(b!.linePitch).toBe(15.6)
    expect(doc.body.map((x) => paragraph(x).section)).toEqual([0, 1])
    expect(doc.body.map(text)).toEqual(['一', '二'])
  })

  test('编号：LFO 引用 LST 的级别，编号文字中的占位符换算为级别计数', async () => {
    const papx = [...sprm(0x845e, ...le16(420)), ...sprm(0x8460, ...s16(-420))]
    const lvl = [
      ...le32(1),
      0,
      0,
      1,
      ...new Array(8).fill(0),
      0,
      ...le32(0),
      ...le32(0),
      0,
      papx.length,
      0,
      0,
      ...papx,
      ...le16(2),
      ...utf16('\u0000.'),
    ]
    const lstf = [
      ...le32(77),
      ...le32(0),
      ...new Array(9).fill(0).flatMap(() => le16(0x0fff)),
      1,
      0,
    ]
    const lst = [...le16(1), ...lstf, ...lvl]
    const lfo = [...le32(1), ...le32(77), ...le32(0), ...le32(0), 0, 0, 0, 0, ...le32(0)]
    const numbered = (t: string) => ({
      runs: [{ text: t }],
      papx: [...sprm(0x460b, ...le16(1)), ...sprm(0x260a, 0)],
    })
    const doc = await open({
      lists: { lst, lfo },
      paragraphs: [numbered('甲'), numbered('乙'), { runs: [{ text: '丙' }] }],
    })
    const [a, b, c] = doc.body.map(paragraph)
    expect(a!.numbering?.text).toBe('1.')
    expect(b!.numbering?.text).toBe('2.')
    expect(c!.numbering).toBeNull()
    expect(a!.props.left).toBe(21)
    expect(a!.props.firstLine).toBe(-21)
  })
})

describe('.doc 域与能力边界', () => {
  test('只显示域结果；没有结果的页码域补空字段；域代码不显示', async () => {
    const special = sprm(0x0855, 1)
    const doc = await open({
      paragraphs: [
        {
          runs: [
            { text: '第' },
            { text: '\u0013', chpx: special },
            { text: ' PAGE ' },
            { text: '\u0014', chpx: special },
            { text: '1' },
            { text: '\u0015', chpx: special },
            { text: '页' },
            { text: '\u0013 NUMPAGES \u0015', chpx: special },
            { text: '\u0013 TOC \u0015' },
          ],
        },
      ],
    })
    const runs = paragraph(doc.body[0]).runs
    expect(runs.map((r) => [r.text, r.field])).toEqual([
      ['第', null],
      ['1', 'PAGE'],
      ['页', null],
      ['', 'NUMPAGES'],
    ])
    expect(doc.unsupported.dynamicField).toBe(1)
  })

  test('没有 PICF 的图片、浮动对象与删除的修订计入能力边界', async () => {
    const special = sprm(0x0855, 1)
    const doc = await open({
      paragraphs: [
        {
          runs: [
            { text: '图' },
            { text: '\u0001', chpx: special },
            { text: '\u0008', chpx: special },
            { text: '删', chpx: sprm(0x0800, 1) },
            { text: '留' },
          ],
        },
      ],
    })
    expect(text(doc.body[0])).toBe('图留')
    expect(doc.unsupported).toEqual({ picture: 1, drawing: 1, revision: 1 })
  })

  test('已加密的文件与不是 Word 97 布局的 FIB', async () => {
    const encrypted = await parseDocx(buildDoc({ paragraphs: [], encrypted: true }))
    expect(encrypted).toEqual({ ok: false, failure: { kind: 'encrypted' } })
    const word = new Uint8Array(1024)
    word.set([0xec, 0xa5, 0x65, 0x00])
    const old = await parseDocx(buildCfb({ WordDocument: word, '1Table': new Uint8Array(16) }))
    expect(old).toEqual({ ok: false, failure: { kind: 'corrupt', reason: 'doc' } })
  })
})

describe('.doc 页眉页脚', () => {
  const special = sprm(0x0855, 1)
  // 页眉文字：奇数页页眉「页眉」与奇数页页脚「第 1」（PAGE 域），各以一个保护段落标记结束；其后为末尾的保护段。
  const header = {
    paragraphs: [
      { runs: [{ text: '页眉' }] },
      { runs: [] },
      {
        runs: [
          { text: '第' },
          { text: '\u0013', chpx: special },
          { text: ' PAGE ' },
          { text: '\u0014', chpx: special },
          { text: '1' },
          { text: '\u0015', chpx: special },
        ],
      },
      { runs: [] },
      { runs: [] },
    ],
    stories: [0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 15, 15, 15, 16],
  }

  test('PlcfHdd 的各部分为页眉页脚部件，去掉保护段落标记；页眉页脚中的页码域不计入能力边界', async () => {
    const doc = await open({ paragraphs: [{ runs: [{ text: '正文' }] }], header })
    const s = doc.sections[0]!
    expect(s.headers.even).toBeNull()
    expect(s.headers.first).toBeNull()
    expect(s.footers.even).toBeNull()
    const head = doc.parts[s.headers.default!]!
    const foot = doc.parts[s.footers.default!]!
    expect(head.map(text)).toEqual(['页眉'])
    expect(foot).toHaveLength(1)
    expect(paragraph(foot[0]).runs.map((r) => [r.text, r.field])).toEqual([
      ['第', null],
      ['1', 'PAGE'],
    ])
    expect(doc.unsupported).toEqual({})
    expect(doc.settings.evenAndOddHeaders).toBe(false)
  })

  test('页脚中的页码图文框（sprmPPc、sprmPDxaAbs 居中、sprmPDyaAbs、sprmPWr）换算为其后段落的浮动对象，不计入 frame', async () => {
    // 页脚：图文框段落「1」（PAGE 域）与其后的空段落，各部分以保护段落标记结束。
    const framed = [
      ...sprm(0x261b, 0x60),
      ...sprm(0x8418, ...le16(0xfffc)),
      ...sprm(0x8419, ...le16(1)),
      ...sprm(0x2423, 2),
      ...sprm(0x842f, ...le16(180)),
    ]
    const doc = await open({
      paragraphs: [{ runs: [{ text: '正文' }] }],
      header: {
        paragraphs: [
          { runs: [{ text: '页眉' }] },
          { runs: [] },
          {
            runs: [
              { text: '\u0013', chpx: special },
              { text: ' PAGE ' },
              { text: '\u0014', chpx: special },
              { text: '1' },
              { text: '\u0015', chpx: special },
            ],
            papx: framed,
          },
          { runs: [] },
          { runs: [] },
          { runs: [] },
        ],
        stories: [0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 17, 17, 17, 18],
      },
    })
    const foot = doc.parts[doc.sections[0]!.footers.default!]!
    expect(foot).toHaveLength(1)
    const host = paragraph(foot[0])
    expect(host.runs.map((r) => r.text).join('')).toBe('')
    expect(host.anchors).toHaveLength(1)
    const a = host.anchors[0]!
    expect([a.horizontal, a.vertical, a.wrap.type, a.wrap.distance.left]).toEqual([
      { from: 'margin', align: 'center', offset: 0 },
      { from: 'paragraph', align: null, offset: 0.05 },
      'square',
      9,
    ])
    expect(a.frame).toMatchObject({ width: 0, height: 0, rule: 'auto' })
    const box = a.drawing
    expect(
      box?.kind === 'shape'
        ? box.text?.content.map((b) => paragraph(b).runs.map((r) => [r.text, r.field]))
        : null,
    ).toEqual([[['1', 'PAGE']]])
    expect(doc.unsupported).toEqual({})
  })

  test('空部分沿用上一节；DOP 的 fFacingPages 为奇偶页不同', async () => {
    const dop = [1, ...new Array(9).fill(0), ...le16(420), ...new Array(500).fill(0)]
    const doc = await open({
      paragraphs: [{ runs: [{ text: '一' }] }, { runs: [{ text: '二' }] }],
      sections: [
        { end: 2, sepx: [] },
        { end: 4, sepx: [] },
      ],
      header: {
        ...header,
        stories: [...header.stories.slice(0, 12), 15, 15, 15, 15, 15, 15, 15, 16],
      },
      dop,
    })
    expect(doc.sections[0]!.headers.default).not.toBeNull()
    expect(doc.sections[1]!.headers).toEqual({ default: null, first: null, even: null })
    expect(doc.sections[1]!.footers).toEqual({ default: null, first: null, even: null })
    expect(doc.settings.evenAndOddHeaders).toBe(true)
  })
})

/** OfficeArt 记录：版本、实例、类型与数据。 */
function record(ver: number, instance: number, type: number, data: number[]): number[] {
  return [...le16(ver | (instance << 4)), ...le16(type), ...le32(data.length), ...data]
}

/** 形状容器：FSP（类型、编号、标志）与属性表（属性编号与值）。 */
function shape(type: number, spid: number, flags: number, props: [number, number][]): number[] {
  return record(0xf, 0, 0xf004, [
    ...record(2, type, 0xf00a, [...le32(spid), ...le32(flags)]),
    ...record(
      3,
      props.length,
      0xf00b,
      props.flatMap(([id, v]) => [...le16(id), ...le32(v)]),
    ),
  ])
}

/** 内嵌 PNG 图片记录的 FBSE。 */
function fbse(png: number[], type = 0xf01e): number[] {
  const blip = record(0, 0x6e0, type, [...new Array(16).fill(0), 0xff, ...png])
  return record(2, 6, 0xf007, [
    ...[6, 6, ...new Array(16).fill(0)],
    ...le16(0xff),
    ...le32(blip.length),
    ...le32(1),
    ...le32(0),
    ...[0, 0, 0, 0],
    ...blip,
  ])
}

/** PICF 与其后的内联容器：形状容器（FSP 与带 `pib` 的 FOPT）与 `blips` 中的各个 FBSE（内嵌 PNG 图片记录）。 */
function picf(
  dxaGoal: number,
  dyaGoal: number,
  mx: number,
  my: number,
  blips: number[][],
): number[] {
  const tail = [...shape(75, 1025, 0xa00, [[0x4104, 7]]), ...blips.flatMap((b) => fbse(b))]
  const head = [...le32(68 + tail.length), ...le16(68), ...le16(0x64), ...new Array(20).fill(0)]
  head.push(...le16(dxaGoal), ...le16(dyaGoal), ...le16(mx), ...le16(my))
  while (head.length < 68) head.push(0)
  return [...head, ...tail]
}

describe('.doc 嵌入式图片', () => {
  test('图片字符按 PICF 的显示尺寸与内联容器中的图片得到嵌入式对象与图片部件；没有图片数据的只占对象框，图片无法读取时计数', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]
    const first = picf(2000, 1000, 500, 1000, [png])
    const empty = picf(400, 400, 1000, 1000, [])
    // 第三个图片的 FBSE 内嵌 PICT 图片记录（不支持），PICF 的总长随之改写。
    const pict = [...empty, ...fbse([1, 2, 3], 0xf01c)]
    pict.splice(0, 4, ...le32(pict.length))
    const data = Uint8Array.from([...first, ...empty, ...pict])
    const pic = (at: number) => [...sprm(0x0855, 1), ...sprm(0x6a03, ...le32(at))]
    const doc = await open({
      paragraphs: [
        {
          runs: [
            { text: '前' },
            { text: '\u0001', chpx: pic(0) },
            { text: '后' },
            { text: '\u0001', chpx: pic(first.length) },
            { text: '\u0001', chpx: pic(first.length + empty.length) },
          ],
        },
      ],
      data,
    })
    const p = paragraph(doc.body[0])
    expect(p.runs.map((r) => r.text)).toEqual(['前', '后'])
    expect(p.images.map((im) => [im.run, im.media, im.width, im.height])).toEqual([
      [1, 0, 50, 50],
      [2, -1, 20, 20],
      [2, -1, 20, 20],
    ])
    expect(doc.media).toHaveLength(1)
    expect(doc.media[0]!.contentType).toBe('image/png')
    expect([...doc.media[0]!.bytes]).toEqual(png)
    expect(doc.unsupported).toEqual({ picture: 1 })
  })
})

describe('.doc 浮动对象', () => {
  test('锚点字符按 FSPA 与 OfficeArt 形状得到浮动对象：文本框的文字取自文本框文字，图片取自图片库', async () => {
    const special = sprm(0x0855, 1)
    const png = [0x89, 0x50, 0x4e, 0x47, 9]
    const group = record(0xf, 0, 0xf000, [...record(0xf, 1, 0xf001, fbse(png))])
    const drawing = record(0xf, 0, 0xf002, [
      ...record(0xf, 0, 0xf003, [
        ...shape(0, 1024, 0x5, []),
        ...shape(202, 1025, 0xa00, [[0x0080, 0x10000]]),
        ...shape(75, 1026, 0xa00, [[0x4104, 1]]),
      ]),
    ])
    // bx、by 为 2（栏、段落），wr 为 3（不环绕）；第二个另设衬于文字下方。
    const flags = (2 << 1) | (2 << 3) | (3 << 5)
    const doc = await open({
      paragraphs: [
        {
          runs: [
            { text: '前' },
            { text: '', chpx: special },
            { text: '后' },
            { text: '', chpx: special },
          ],
        },
      ],
      textbox: {
        paragraphs: [{ runs: [{ text: '框中' }] }, { runs: [] }, { runs: [] }],
        stories: [0, 4, 5],
        lids: [1025, 0],
      },
      art: {
        content: [...group, 0, ...drawing],
        anchors: [
          { cp: 1, spid: 1025, rect: [200, 100, 2200, 1100], flags },
          { cp: 3, spid: 1026, rect: [0, 0, 400, 400], flags: flags | 0x4000 },
        ],
      },
    })
    const p = paragraph(doc.body[0])
    expect(p.runs.map((r) => r.text)).toEqual(['前', '后'])
    expect(
      p.anchors.map((a) => [
        a.offset,
        a.horizontal,
        a.vertical,
        a.width,
        a.height,
        a.wrap.type,
        a.behind,
      ]),
    ).toEqual([
      [
        1,
        { from: 'column', align: null, offset: 10 },
        { from: 'paragraph', align: null, offset: 5 },
        100,
        50,
        'none',
        false,
      ],
      [
        2,
        { from: 'column', align: null, offset: 0 },
        { from: 'paragraph', align: null, offset: 0 },
        20,
        20,
        'none',
        true,
      ],
    ])
    const box = p.anchors[0]!.drawing
    expect(box?.kind === 'shape' && box.text?.content.map(text)).toEqual(['框中'])
    const picture = p.anchors[1]!.drawing
    expect(
      picture?.kind === 'shape' && picture.fill.kind === 'picture' && picture.fill.image.part,
    ).toBe('BStore/1')
    expect(doc.media.map((m) => [m.part, m.contentType, [...m.bytes]])).toEqual([
      ['BStore/1', 'image/png', png],
    ])
    expect(doc.unsupported).toEqual({})
  })
})
