/**
 * 覆盖 `xlsx/biff/` 的 `crypto.ts`、`records.ts`、`globals.ts`、`sheet.ts`、`drawing.ts`、`workbook.ts`、`formula.ts`、
 * `conditional.ts`、`chart.ts`，`officeart/` 的图片库与形状树，`xlsx/render/painter.ts` 中 `anchorRect` 的比例锚点，
 * 以及 `parseXlsx` 对 CFB 的分派：MD5 与 RC4、缺省密码解密与无法解密、WPS 私密文档、单元格各类型、跨 CONTINUE 的共享字符串与富文本、
 * XF 与 XFEXT 换算的样式、行列与工作表格式、合并与视图、工作表种类与能力边界计数、图片与组合内的图片、
 * 公式反编译、条件格式、嵌入图表与图表工作表。
 *
 * 夹具由 `test-helper.ts` 按记录生成。
 */

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { buildCfb } from '../../zip/test-helper.ts'
import type { Workbook, Worksheet } from '../model.ts'
import { parseXlsx } from '../parse/workbook.ts'
import { Axis } from '../render/axis.ts'
import { ConditionalFormats } from '../render/conditional.ts'
import { anchorRect } from '../render/painter.ts'
import { md5, rc4 } from './crypto.ts'
import { formulaText } from './formula.ts'
import { decodeRk } from './sheet.ts'
import {
  buildXls,
  cell,
  chars,
  encrypt,
  fields,
  font,
  join,
  NORMAL_STYLE,
  R,
  rec,
  sst,
  unicodeString,
  workbookStream,
  xfTable,
} from './test-helper.ts'

const FONTS = [font(), font(), font(), font()]

async function open(bytes: Uint8Array<ArrayBuffer>): Promise<Workbook> {
  const r = await parseXlsx(bytes)
  if (!r.ok) throw new Error(`解析失败：${JSON.stringify(r.failure)}`)
  return r.value
}

/** 第 `index` 个页面，须为工作表。 */
function worksheetAt(wb: Workbook, index: number): Worksheet {
  const s = wb.sheets[index]
  if (s?.kind !== 'worksheet') throw new Error(`第 ${index} 个页面不是工作表`)
  return s
}

function value(wb: Workbook, row: number, col: number, sheet = 0) {
  return worksheetAt(wb, sheet).cells.get(row)?.get(col)?.value
}

describe('MD5 与 RC4', () => {
  test('MD5 与 node:crypto 一致', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 336, 1000]) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255)
      expect(Buffer.from(md5(data)).toString('hex')).toBe(
        createHash('md5').update(data).digest('hex'),
      )
    }
  })

  test('RC4 的公开测试向量', () => {
    const key = new TextEncoder().encode('Key')
    const plain = new TextEncoder().encode('Plaintext')
    const ks = rc4(key, plain.length)
    expect(Buffer.from(plain.map((v, i) => v ^ ks[i]!)).toString('hex')).toBe('bbf316e8d940af0ad3')
  })

  test('RK 编码：整数、除以 100、双精度高 30 位', () => {
    expect(decodeRk((123 << 2) | 2)).toBe(123)
    expect(decodeRk((-5 << 2) | 2)).toBe(-5)
    expect(decodeRk((12345 << 2) | 3)).toBe(123.45)
    // 1.5 的双精度高 32 位为 0x3FF80000。
    expect(decodeRk(0x3ff80000)).toBe(1.5)
  })
})

/** 4 个字体、XF 0–15 与一个单元格 XF 16（样式 1）。 */
const basicGlobals = (...extra: Uint8Array[]) => [...FONTS, ...xfTable({}), NORMAL_STYLE, ...extra]

describe('分派与失败', () => {
  test('含 Workbook 流的 CFB 由 parseXlsx 解析为工作簿', async () => {
    const wb = await open(
      buildXls(basicGlobals(sst('甲')), [
        { name: '表一', records: [cell(R.LABELSST, 0, 0, 15, fields([4, 0]))] },
      ]),
    )
    expect(wb.sheets.map((s) => s.name)).toEqual(['表一'])
    expect(value(wb, 0, 0)).toEqual({ type: 'string', value: '甲', runs: null })
  })

  test('缺省密码加密的流解密后解析；其他密码判为已加密', async () => {
    const stream = workbookStream(basicGlobals(sst('机密')), [
      {
        name: 'S',
        records: [
          cell(R.LABELSST, 2, 3, 15, fields([4, 0])),
          cell(R.NUMBER, 3, 0, 15, fields([8, 2.5])),
        ],
      },
    ])
    const wb = await open(buildCfb({ Workbook: encrypt(stream) }))
    expect(value(wb, 2, 3)).toEqual({ type: 'string', value: '机密', runs: null })
    expect(value(wb, 3, 0)).toEqual({ type: 'number', value: 2.5 })
    expect(await parseXlsx(buildCfb({ Workbook: encrypt(stream, 'secret') }))).toEqual({
      ok: false,
      failure: { kind: 'encrypted' },
    })
  })

  test('XOR 混淆判为已加密', async () => {
    const stream = workbookStream(
      [rec(R.FILEPASS, fields([2, 0], [2, 0x1234], [2, 0x5678])), ...basicGlobals()],
      [{ name: 'S', records: [] }],
    )
    expect(await parseXlsx(buildCfb({ Workbook: stream }))).toEqual({
      ok: false,
      failure: { kind: 'encrypted' },
    })
  })

  test('WPS 私密文档判为已加密', async () => {
    const stream = workbookStream(basicGlobals(), [{ name: 'Sheet1', records: [] }])
    expect(
      await parseXlsx(
        buildCfb({
          Workbook: stream,
          WpsContent: new Uint8Array(5000),
          WpsExtData: new Uint8Array(10),
        }),
      ),
    ).toEqual({ ok: false, failure: { kind: 'encrypted' } })
  })

  test('不是 BIFF8 的 BOF 判为已损坏；扩展名为 .xls 而内容是 Word 文档判为已损坏', async () => {
    const biff5 = join(rec(R.BOF, fields([2, 0x0500], [2, 0x0005], [2, 0], [2, 0])), rec(R.EOF))
    expect(await parseXlsx(buildCfb({ Workbook: biff5 }))).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'biff' },
    })
    expect(await parseXlsx(buildCfb({ WordDocument: new Uint8Array(600) }))).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'cfb-format' },
    })
  })
})

describe('单元格', () => {
  test('数值、RK、多值、空白、逻辑值、错误值与字符串', async () => {
    const wb = await open(
      buildXls(basicGlobals(), [
        {
          name: 'S',
          records: [
            cell(R.NUMBER, 0, 0, 15, fields([8, -0.25])),
            cell(R.RK, 0, 1, 15, fields([4, (77 << 2) | 2])),
            rec(
              R.MULRK,
              join(
                fields(
                  [2, 1],
                  [2, 2],
                  [2, 15],
                  [4, (1 << 2) | 2],
                  [2, 15],
                  [4, (250 << 2) | 3],
                  [2, 3],
                ),
              ),
            ),
            rec(R.MULBLANK, fields([2, 2], [2, 0], [2, 16], [2, 16], [2, 1])),
            cell(R.BLANK, 2, 5, 15),
            cell(R.BOOLERR, 3, 0, 15, fields([1, 1], [1, 0])),
            cell(R.BOOLERR, 3, 1, 15, fields([1, 0x07], [1, 1])),
            cell(R.LABEL, 4, 0, 15, unicodeString('中文 label')),
          ],
        },
      ]),
    )
    expect(value(wb, 0, 0)).toEqual({ type: 'number', value: -0.25 })
    expect(value(wb, 0, 1)).toEqual({ type: 'number', value: 77 })
    expect(value(wb, 1, 2)).toEqual({ type: 'number', value: 1 })
    expect(value(wb, 1, 3)).toEqual({ type: 'number', value: 2.5 })
    expect(worksheetAt(wb, 0).cells.get(2)?.get(1)).toEqual({ value: null, style: 1 })
    // XF 15 是第一个单元格 XF，即样式 0：没有值的样式 0 单元格不计入范围。
    expect(worksheetAt(wb, 0).cells.get(2)?.get(5)).toEqual({ value: null, style: 0 })
    expect(value(wb, 3, 0)).toEqual({ type: 'boolean', value: true })
    expect(value(wb, 3, 1)).toEqual({ type: 'error', value: '#DIV/0!' })
    expect(value(wb, 4, 0)).toEqual({ type: 'string', value: '中文 label', runs: null })
    expect(worksheetAt(wb, 0).maxRow).toBe(4)
    expect(worksheetAt(wb, 0).maxCol).toBe(3)
  })

  test('公式显示缓存值：数值、其后 STRING 中的字符串、逻辑值、错误值、空串', async () => {
    const special = (kind: number, v: number) =>
      fields([1, kind], [1, 0], [1, v], [1, 0], [2, 0], [2, 0xffff], [2, 0], [4, 0])
    const wb = await open(
      buildXls(basicGlobals(), [
        {
          name: 'S',
          records: [
            cell(R.FORMULA, 0, 0, 15, fields([8, 42], [2, 0], [4, 0])),
            cell(R.FORMULA, 1, 0, 15, special(0, 0)),
            rec(R.STRING, unicodeString('结果')),
            cell(R.FORMULA, 2, 0, 15, special(1, 1)),
            cell(R.FORMULA, 3, 0, 15, special(2, 0x2a)),
            cell(R.FORMULA, 4, 0, 15, special(3, 0)),
          ],
        },
      ]),
    )
    expect(value(wb, 0, 0)).toEqual({ type: 'number', value: 42 })
    expect(value(wb, 1, 0)).toEqual({ type: 'string', value: '结果', runs: null })
    expect(value(wb, 2, 0)).toEqual({ type: 'boolean', value: true })
    expect(value(wb, 3, 0)).toEqual({ type: 'error', value: '#N/A' })
    expect(value(wb, 4, 0)).toEqual({ type: 'string', value: '', runs: null })
  })

  test('共享字符串跨 CONTINUE：字符被截断处另起宽度标志，富文本段跨记录', async () => {
    const boldFont = font({ name: '黑体', bold: true })
    // 第一项「ab中文」的字符被截断：SST 中写出单字节的 ab，CONTINUE 以标志 1 起始写出 UTF-16 的「中文」。
    // 第二项为富文本，一个段（位置 1，字体序号 5 即第 5 个 FONT），段的两个字段分在两条 CONTINUE 中。
    const head = join(fields([4, 2], [4, 2]), fields([2, 4], [1, 0]), chars('ab', false))
    const cont1 = join(
      fields([1, 1]),
      chars('中文', true),
      fields([2, 3], [1, 0x08], [2, 1]),
      chars('xyz', false),
      fields([2, 1]),
    )
    const cont2 = fields([2, 5])
    const wb = await open(
      buildXls(
        [
          ...FONTS,
          boldFont,
          ...xfTable(),
          NORMAL_STYLE,
          rec(R.SST, head),
          rec(R.CONTINUE, cont1),
          rec(R.CONTINUE, cont2),
        ],
        [
          {
            name: 'S',
            records: [
              cell(R.LABELSST, 0, 0, 15, fields([4, 0])),
              cell(R.LABELSST, 1, 0, 15, fields([4, 1])),
            ],
          },
        ],
      ),
    )
    expect(value(wb, 0, 0)).toEqual({ type: 'string', value: 'ab中文', runs: null })
    const rich = value(wb, 1, 0)
    expect(rich?.type).toBe('string')
    if (rich?.type !== 'string') return
    expect(rich.value).toBe('xyz')
    expect(rich.runs?.map((r) => [r.text, r.font?.name ?? null, r.font?.bold ?? null])).toEqual([
      ['x', null, null],
      ['yz', '黑体', true],
    ])
  })
})

describe('样式', () => {
  test('字体、数字格式、对齐、边框与填充；调色板与 XFEXT 的颜色', async () => {
    const palette = rec(
      R.PALETTE,
      join(
        fields([2, 56]),
        ...Array.from({ length: 56 }, (_, k) =>
          fields([1, k === 2 ? 0x12 : 0], [1, k === 2 ? 0x34 : 0], [1, k === 2 ? 0x56 : 0], [1, 0]),
        ),
      ),
    )
    const format = rec(R.FORMAT, join(fields([2, 200]), unicodeString('0.000"元"')))
    const xfext = rec(
      R.XFEXT,
      join(
        fields([2, R.XFEXT], [2, 0], [4, 0], [4, 0], [2, 0], [2, 17], [2, 0], [2, 2]),
        // 填充前景色：RGB AB CD EF。
        fields(
          [2, 4],
          [2, 20],
          [2, 2],
          [2, 0],
          [1, 0xab],
          [1, 0xcd],
          [1, 0xef],
          [1, 0],
          [4, 0],
          [4, 0],
        ),
        // 文字颜色：调色板 10 号（红）。
        fields([2, 13], [2, 20], [2, 1], [2, 0], [4, 10], [4, 0], [4, 0]),
      ),
    )
    const wb = await open(
      buildXls(
        [
          ...FONTS,
          font({ name: '宋体', size: 12, bold: true, italic: true, color: 10 }),
          format,
          ...xfTable(
            {
              font: 5,
              format: 200,
              horizontal: 2,
              vertical: 1,
              wrap: true,
              borders: [1, 2, 0, 6],
              borderColor: 10,
              fill: [1, 10, 65],
            },
            { fill: [17, 8, 65] },
          ),
          NORMAL_STYLE,
          palette,
          xfext,
        ],
        [
          {
            name: 'S',
            records: [
              cell(R.NUMBER, 0, 0, 16, fields([8, 1])),
              cell(R.NUMBER, 0, 1, 17, fields([8, 1])),
            ],
          },
        ],
      ),
    )
    expect(wb.defaultFont.name).toBe('Arial')
    const a = wb.styles[1]!
    expect(a.font).toEqual({
      name: '宋体',
      size: 12,
      bold: true,
      italic: true,
      underline: 'none',
      strike: false,
      color: '#123456',
      vertAlign: 'baseline',
    })
    expect(a.numFmt).toBe('0.000"元"')
    expect(a.alignment).toMatchObject({ horizontal: 'center', vertical: 'center', wrap: true })
    expect(a.border).toEqual({
      left: { style: 'thin', color: '#123456' },
      right: { style: 'medium', color: '#123456' },
      top: null,
      bottom: { style: 'double', color: '#123456' },
      diagonalUp: null,
      diagonalDown: null,
    })
    expect(a.fill).toEqual({ kind: 'pattern', pattern: 'solid', fg: '#123456', bg: '#123456' })
    const b = wb.styles[2]!
    expect(b.fill).toEqual({ kind: 'pattern', pattern: 'gray125', fg: '#abcdef', bg: '#ffffff' })
    expect(b.font.color).toBe('#123456')
    expect(worksheetAt(wb, 0).cells.get(0)?.get(1)?.style).toBe(2)
  })
})

describe('行列、合并与视图', () => {
  test('行高、列宽、隐藏、缺省格式、合并、冻结窗格、网格线与缩放；没有 ROW 记录的行与网格尺寸', async () => {
    const window2 = rec(
      R.WINDOW2,
      fields([2, 0x0008 | 0x0020 | 0x0004], [2, 0], [2, 0], [2, 0], [2, 0], [2, 0], [2, 0], [4, 0]),
    )
    const wb = await open(
      buildXls(basicGlobals(), [
        {
          name: 'S',
          records: [
            rec(R.DEFCOLWIDTH, fields([2, 10])),
            rec(R.STANDARDWIDTH, fields([2, 9 * 256])),
            rec(R.DEFAULTROWHEIGHT, fields([2, 1], [2, 300])),
            rec(R.COLINFO, fields([2, 1], [2, 3], [2, 20 * 256 + 128], [2, 16], [2, 1], [2, 0])),
            rec(
              R.ROW,
              fields(
                [2, 4],
                [2, 0],
                [2, 1],
                [2, 600],
                [2, 0],
                [2, 0],
                [2, 0x40 | 0x20 | 0x80],
                [2, 16],
              ),
            ),
            rec(R.MERGECELLS, fields([2, 1], [2, 1], [2, 2], [2, 0], [2, 3])),
            window2,
            rec(R.PANE, fields([2, 1], [2, 2], [2, 5], [2, 7], [1, 0])),
            rec(R.SCL, fields([2, 3], [2, 2])),
            cell(R.NUMBER, 7, 0, 15, fields([8, 1])),
          ],
        },
      ]),
    )
    const s = worksheetAt(wb, 0)
    expect(s.format).toEqual({
      defaultRowHeight: 15,
      zeroHeight: false,
      customHeight: true,
      defaultColWidth: 9,
      baseColWidth: 10,
      declared: true,
    })
    expect(s.cols).toEqual([{ min: 1, max: 3, width: 20.5, hidden: true, style: 1 }])
    expect(s.rows.get(4)).toEqual({ height: 30, custom: true, hidden: true, style: 1 })
    // 有单元格而没有 ROW 记录的行按内容推算行高。
    expect(s.rows.get(7)).toEqual({ height: null, custom: false, hidden: false, style: null })
    expect(wb.gridSize).toEqual({ rows: 65_536, cols: 256 })
    expect(s.merges).toEqual([{ top: 1, bottom: 2, left: 0, right: 3 }])
    expect(s.view).toEqual({
      showGridLines: false,
      gridColor: null,
      zoom: 150,
      rightToLeft: false,
      frozenRows: 2,
      frozenCols: 1,
      topLeft: { row: 5, col: 7 },
    })
  })
})

describe('工作表种类与能力边界', () => {
  test('图表工作表按工作簿顺序列出，宏表计数，隐藏工作表与活动工作表；嵌入图表、控件、批注、图片、条件格式计数', async () => {
    const obj = (type: number, id: number) =>
      rec(
        R.OBJ,
        fields(
          [2, 0x15],
          [2, 0x12],
          [2, type],
          [2, id],
          [2, 0],
          [4, 0],
          [4, 0],
          [4, 0],
          [2, 0],
          [2, 0],
        ),
      )
    const embeddedChart = [
      obj(5, 1),
      join(
        rec(R.BOF, fields([2, 0x0600], [2, 0x0020], [2, 0], [2, 0], [4, 0], [4, 0])),
        cell(R.NUMBER, 0, 0, 15, fields([8, 9])),
        rec(R.EOF),
      ),
    ]
    const window1 = rec(
      R.WINDOW1,
      fields([2, 0], [2, 0], [2, 0], [2, 0], [2, 0], [2, 3], [2, 0], [2, 1], [2, 600]),
    )
    const wb = await open(
      buildXls(basicGlobals(window1), [
        { name: '图表', type: 2, bofType: 0x0020, records: [] },
        { name: '宏', type: 1, bofType: 0x0040, records: [] },
        {
          name: '甲',
          records: [
            ...embeddedChart,
            obj(7, 2),
            obj(8, 3),
            obj(2, 4),
            rec(R.NOTE, fields([2, 0], [2, 0], [2, 0], [2, 1])),
            rec(R.CF, fields([1, 1])),
          ],
        },
        { name: '乙', state: 1, records: [cell(R.NUMBER, 0, 0, 15, fields([8, 1]))] },
      ]),
    )
    expect(wb.sheets.map((s) => [s.kind, s.name, s.state])).toEqual([
      ['chartsheet', '图表', 'visible'],
      ['worksheet', '甲', 'visible'],
      ['worksheet', '乙', 'hidden'],
    ])
    expect(wb.activeSheet).toBe(2)
    // 没有 Chart 记录的图表工作表计入 chart。
    expect([wb.sheets[0]!.charts, wb.sheets[0]!.unsupported]).toEqual([[], { chart: 1 }])
    // 嵌入图表子流中的单元格记录不进入工作表。
    expect(worksheetAt(wb, 1).cells.size).toBe(0)
    expect(worksheetAt(wb, 1).unsupported).toEqual({
      chart: 1,
      control: 1,
      image: 1,
      graphic: 1,
      comment: 1,
      conditionalFormat: 1,
    })
    expect(wb.unsupported).toEqual({
      otherSheet: 1,
      chart: 2,
      control: 1,
      image: 1,
      graphic: 1,
      comment: 1,
      conditionalFormat: 1,
    })
  })
})

/** OfficeArt 记录：`verInst` 为版本与实例的合并值（容器版本为 0xF）。 */
function art(verInst: number, type: number, ...body: Uint8Array[]): Uint8Array {
  const data = join(...body)
  return join(fields([2, verInst], [2, type], [4, data.length]), data)
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** 图片库：一个内嵌 PNG 的 FBSE。 */
function drawingGroup(
  blips: readonly Uint8Array[] = [art(0x6e00, 0xf01e, new Uint8Array(16), fields([1, 0xff]), PNG)],
): Uint8Array {
  const entries = blips.map((blip) =>
    art(
      0x0062,
      0xf007,
      fields([1, 6], [1, 6]),
      new Uint8Array(16),
      fields([2, 0], [4, blip.length], [4, 1], [4, 0], [1, 0], [1, 0], [1, 0], [1, 0]),
      blip,
    ),
  )
  return art(0x000f, 0xf000, art(0x000f, 0xf001, ...entries))
}

/** 图片形状：类型 75，属性 pib 与左侧裁剪，客户锚点（B2 起，偏移为列宽 1/2、行高 1/4；至 D5）。 */
function pictureShape(pib: number): Uint8Array {
  const fopt = art(0x0023, 0xf00b, fields([2, 0x4104], [4, pib], [2, 0x0102], [4, 0x4000]))
  const anchor = art(
    0x0000,
    0xf010,
    fields([2, 0], [2, 1], [2, 512], [2, 1], [2, 64], [2, 3], [2, 0], [2, 4], [2, 0]),
  )
  return art(
    0x000f,
    0xf004,
    art(0x04b2, 0xf00a, fields([4, 1025], [4, 0xa00])),
    fopt,
    anchor,
    art(0, 0xf011),
  )
}

const patriarch = art(0x000f, 0xf004, art(0x0002, 0xf00a, fields([4, 1024], [4, 5])))
const objRecord = (type: number, id: number) =>
  rec(
    R.OBJ,
    fields(
      [2, 0x15],
      [2, 0x12],
      [2, type],
      [2, id],
      [2, 0],
      [4, 0],
      [4, 0],
      [4, 0],
      [2, 0],
      [2, 0],
    ),
  )

describe('图片', () => {
  test('顶层图片按 pib 取图、锚点为单元格比例；组合内的图片计入 image', async () => {
    const group = art(
      0x000f,
      0xf003,
      art(0x000f, 0xf004, art(0x0002, 0xf00a, fields([4, 1026], [4, 0x201])), art(0, 0xf011)),
      pictureShape(1),
    )
    const dg = art(0x000f, 0xf002, art(0x000f, 0xf003, patriarch, pictureShape(1), group))
    // 绘图容器分在两条 MSODRAWING 中，其间为对应形状的 OBJ。
    const cut = dg.length - group.length
    const wb = await open(
      buildXls(basicGlobals(rec(0x00eb, drawingGroup())), [
        {
          name: 'S',
          records: [
            rec(0x00ec, dg.subarray(0, cut)),
            objRecord(8, 1),
            rec(0x00ec, dg.subarray(cut)),
            objRecord(0, 2),
            objRecord(8, 3),
          ],
        },
      ]),
    )
    const sheet = worksheetAt(wb, 0)
    expect(sheet.images).toEqual([
      {
        anchor: {
          kind: 'cellRatio',
          from: { col: 1, colRatio: 0.5, row: 1, rowRatio: 0.25 },
          to: { col: 3, colRatio: 0, row: 4, rowRatio: 0 },
        },
        order: 0,
        contentType: 'image/png',
        bytes: PNG,
        crop: { left: 0.25, top: 0, right: 0, bottom: 0 },
      },
    ])
    expect(sheet.unsupported).toEqual({ image: 1 })
  })

  test('DIB 图片补 BMP 文件头后绘制；PICT 图片计入 image', async () => {
    const dib = join(
      fields(
        [4, 40],
        [4, 1],
        [4, 1],
        [2, 1],
        [2, 24],
        [4, 0],
        [4, 4],
        [4, 0],
        [4, 0],
        [4, 0],
        [4, 0],
      ),
      fields([1, 0], [1, 0], [1, 255], [1, 0]),
    )
    const blips = [
      art(0x7a80, 0xf01f, new Uint8Array(16), fields([1, 0xff]), dib),
      art(0x5420, 0xf01c, new Uint8Array(16), new Uint8Array(40)),
    ]
    const dg = art(0x000f, 0xf002, art(0x000f, 0xf003, patriarch, pictureShape(1), pictureShape(2)))
    const wb = await open(
      buildXls(basicGlobals(rec(0x00eb, drawingGroup(blips))), [
        { name: 'S', records: [rec(0x00ec, dg), objRecord(8, 1), objRecord(8, 2)] },
      ]),
    )
    const sheet = worksheetAt(wb, 0)
    expect(
      sheet.images.map((i) => [i.contentType, [...i.bytes.subarray(0, 2)], i.bytes.length]),
    ).toEqual([['image/bmp', [0x42, 0x4d], 14 + dib.length]])
    expect(sheet.unsupported).toEqual({ image: 1 })
  })

  test('比例锚点按所在列宽与行高换算', () => {
    const geometry = {
      cols: new Axis([64, 100], 64, [], 100),
      rows: new Axis([20, 40], 20, [], 100),
      mdw: 7,
    }
    expect(
      anchorRect(geometry, {
        kind: 'cellRatio',
        from: { col: 1, colRatio: 0.5, row: 1, rowRatio: 0.25 },
        to: { col: 2, colRatio: 0.25, row: 2, rowRatio: 0.5 },
      }),
    ).toEqual({ x: 114, y: 30, width: 66, height: 40 })
  })
})

describe('公式反编译', () => {
  const ctx = {
    sheetName: (ixti: number) => (ixti === 0 ? "表'一" : null),
    base: { row: 4, col: 2 },
  }
  const text = (...items: [1 | 2 | 4 | 8, number][]) => formulaText(fields(...items), ctx)

  test('引用：绝对与相对标志、相对引用记号按基准换算、三维区域加工作表名', () => {
    expect(text([1, 0x44], [2, 16], [2, 9])).toBe('$J$17')
    expect(text([1, 0x24], [2, 16], [2, 0xc009])).toBe('J17')
    expect(text([1, 0x4c], [2, 0xffff], [2, 0xc001])).toBe('D4')
    expect(text([1, 0x3b], [2, 0], [2, 1], [2, 14], [2, 0], [2, 0])).toBe("'表''一'!$A$2:$A$15")
    expect(text([1, 0x3b], [2, 1], [2, 1], [2, 14], [2, 0], [2, 0])).toBeNull()
  })

  test('常数、运算、括号与函数；名称等不支持的记号返回 null', () => {
    // IF(A1>1,"x",-2.5%)
    expect(
      formulaText(
        join(
          fields([1, 0x24], [2, 0], [2, 0xc000], [1, 0x1e], [2, 1], [1, 0x0d]),
          fields([1, 0x17], [1, 1], [1, 0]),
          chars('x'),
          fields([1, 0x1f], [8, 2.5], [1, 0x14], [1, 0x13], [1, 0x42], [1, 3], [2, 1]),
        ),
        ctx,
      ),
    ).toBe('IF(A1>1,"x",-2.5%)')
    // (1+2)*3 与 NOT(TRUE)，其间的空格属性记号不影响结果。
    expect(
      text(
        [1, 0x1e],
        [2, 1],
        [1, 0x1e],
        [2, 2],
        [1, 0x03],
        [1, 0x15],
        [1, 0x19],
        [1, 0x40],
        [2, 1],
        [1, 0x1e],
        [2, 3],
        [1, 0x05],
      ),
    ).toBe('(1+2)*3')
    expect(text([1, 0x1d], [1, 1], [1, 0x41], [2, 38])).toBe('NOT(TRUE)')
    expect(text([1, 0x23], [4, 1])).toBeNull()
    expect(text([1, 0x1e], [2, 1], [1, 0x03])).toBeNull()
  })
})

/** DXFN：只含字体（红色即调色板序号 10、粗体、不倾斜），其余项标记为不改变。 */
function fontDxf(): Uint8Array {
  return join(
    fields([4, 0x043fffff], [2, 0]),
    new Uint8Array(64),
    fields([4, -1], [4, 0], [2, 700], [2, 0xffff], [1, 0xff], [1, 0], [2, 0]),
    fields([4, 10], [4, 0], [4, 0x80], [4, 1], [4, 1], [4, 0], [4, 0], [4, 0], [4, 0], [2, 0]),
  )
}

describe('条件格式', () => {
  test('单元格值规则换算为 cellIs，差异样式取字体；求值命中时叠加；无法反编译的规则计入', async () => {
    const condfmt = rec(
      0x01b0,
      fields(
        [2, 2],
        [2, 3],
        [2, 0],
        [2, 0],
        [2, 1],
        [2, 1],
        [2, 1],
        [2, 0],
        [2, 0],
        [2, 1],
        [2, 1],
      ),
    )
    const lessThanA1 = rec(
      R.CF,
      join(fields([1, 1], [1, 6], [2, 5], [2, 0]), fontDxf(), fields([1, 0x44], [2, 0], [2, 0])),
    )
    const byName = rec(
      R.CF,
      join(fields([1, 2], [1, 0], [2, 5], [2, 0]), fontDxf(), fields([1, 0x23], [4, 1])),
    )
    const wb = await open(
      buildXls(basicGlobals(), [
        {
          name: 'S',
          records: [
            cell(R.NUMBER, 0, 0, 15, fields([8, 7])),
            cell(R.NUMBER, 0, 1, 15, fields([8, 6])),
            condfmt,
            lessThanA1,
            byName,
          ],
        },
      ]),
    )
    const sheet = worksheetAt(wb, 0)
    expect(sheet.conditionalFormats).toEqual([
      {
        ranges: [{ top: 0, bottom: 0, left: 1, right: 1 }],
        rules: [
          {
            type: 'cellIs',
            operator: 'lessThan',
            formulas: ['$A$1'],
            priority: 0,
            stopIfTrue: true,
            dxf: {
              bold: true,
              italic: false,
              strike: null,
              underline: null,
              color: '#ff0000',
              fill: null,
              border: null,
              numFmt: null,
            },
          },
        ],
      },
    ])
    expect(sheet.unsupported).toEqual({ conditionalFormat: 1 })
    const cf = new ConditionalFormats(wb, sheet)
    expect(cf.at(0, 1, value(wb, 0, 1) ?? null)).toMatchObject({ color: '#ff0000', bold: true })
  })
})

const CH = {
  CHART: 0x1002,
  SERIES: 0x1003,
  LINEFORMAT: 0x1007,
  AREAFORMAT: 0x100a,
  CHARTFORMAT: 0x1014,
  LEGEND: 0x1015,
  AREA: 0x101a,
  SCATTER: 0x101b,
  AXIS: 0x101d,
  VALUERANGE: 0x101f,
  AXISLINE: 0x1021,
  FRAME: 0x1032,
  BEGIN: 0x1033,
  END: 0x1034,
  PLOTAREA: 0x1035,
  AXISPARENT: 0x1041,
  SHTPROPS: 0x1044,
  SERTOCRT: 0x1045,
  POS: 0x104f,
  BRAI: 0x1051,
  CRTLAYOUT12A: 0x08a7,
} as const

/** 记录与其后 Begin/End 之间的子记录。 */
function block(head: Uint8Array, ...body: Uint8Array[]): Uint8Array {
  return join(head, rec(CH.BEGIN), ...body, rec(CH.END))
}

function lineFormat(rgb: [number, number, number], lns = 0, flags = 0): Uint8Array {
  return rec(
    CH.LINEFORMAT,
    fields(
      [1, rgb[0]],
      [1, rgb[1]],
      [1, rgb[2]],
      [1, 0],
      [2, lns],
      [2, 0xffff],
      [2, flags],
      [2, 8],
    ),
  )
}

function areaFormat(rgb: [number, number, number], fls = 1): Uint8Array {
  return rec(
    CH.AREAFORMAT,
    fields([1, rgb[0]], [1, rgb[1]], [1, rgb[2]], [1, 0], [4, 0], [2, fls], [2, 0], [2, 9], [2, 8]),
  )
}

/** 系列引用：工作表 0 中第 `col` 列的第 `first` 至 `last` 行（从 0 起）。 */
function brai(id: number, col: number, first = 1, last = 3): Uint8Array {
  return rec(
    CH.BRAI,
    fields(
      [1, id],
      [1, 2],
      [2, 0],
      [2, 0],
      [2, 11],
      [1, 0x3b],
      [2, 0],
      [2, first],
      [2, last],
      [2, col],
      [2, col],
    ),
  )
}

function valueRange(min: number, flags: number): Uint8Array {
  return rec(CH.VALUERANGE, fields([8, min], [8, 0], [8, 0], [8, 0], [8, 0], [2, flags]))
}

/**
 * 散点图子流：x 取 A2:A4、y 取 B 列的 `values` 行（缺省为 B2:B4）；`group` 为图表组的类型记录，`extra` 加在图表块末尾。
 */
function chartStream(
  group: Uint8Array,
  extra: Uint8Array[] = [],
  values: [number, number] = [1, 3],
): Uint8Array {
  return join(
    rec(R.BOF, fields([2, 0x0600], [2, 0x0020], [2, 0], [2, 0], [4, 0], [4, 0])),
    chartBody(group, extra, values),
    rec(R.EOF),
  )
}

/** 图表子流中 BOF 与 EOF 之间的部分，参数同 `chartStream`；图表区为 300×200 磅。 */
function chartBody(
  group: Uint8Array,
  extra: Uint8Array[] = [],
  values: [number, number] = [1, 3],
): Uint8Array {
  const zeros16: [4, number][] = [
    [4, 0],
    [4, 0],
    [4, 0],
    [4, 0],
  ]
  return block(
    rec(CH.CHART, fields([4, 0], [4, 0], [4, 300 << 16], [4, 200 << 16])),
    block(
      rec(CH.FRAME, fields([2, 0], [2, 2])),
      lineFormat([0, 0, 0]),
      areaFormat([255, 255, 255]),
    ),
    block(
      rec(CH.SERIES, fields([2, 1], [2, 1], [2, 3], [2, 3], [2, 1], [2, 0])),
      rec(CH.BRAI, fields([1, 0], [1, 1], [2, 0], [2, 0], [2, 0])),
      brai(1, 1, ...values),
      brai(2, 0),
      rec(CH.SERTOCRT, fields([2, 0])),
    ),
    rec(CH.SHTPROPS, fields([2, 0x0a], [1, 0], [1, 0])),
    block(
      rec(CH.AXISPARENT, fields([2, 0], ...zeros16)),
      rec(
        CH.POS,
        fields(
          [2, 2],
          [2, 2],
          [2, 400],
          [2, 0],
          [2, 200],
          [2, 0],
          [2, 3000],
          [2, 0],
          [2, 3600],
          [2, 0],
        ),
      ),
      block(rec(CH.AXIS, fields([2, 0], ...zeros16)), valueRange(10, 0x1e)),
      block(
        rec(CH.AXIS, fields([2, 1], ...zeros16)),
        valueRange(0, 0x1f),
        rec(CH.AXISLINE, fields([2, 1])),
        lineFormat([128, 128, 128]),
      ),
      rec(CH.PLOTAREA),
      block(
        rec(CH.FRAME, fields([2, 0], [2, 3])),
        lineFormat([0, 0, 0], 5),
        areaFormat([192, 192, 192]),
      ),
      block(
        rec(CH.CHARTFORMAT, fields(...zeros16, [2, 0], [2, 0])),
        group,
        block(
          rec(
            CH.LEGEND,
            fields([4, 3200], [4, 1600], [4, 400], [4, 300], [1, 7], [1, 1], [2, 0x12]),
          ),
        ),
      ),
    ),
    ...extra,
  )
}

function hex(c: { r: number; g: number; b: number }): string {
  return `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

describe('嵌入图表', () => {
  const globals = basicGlobals(
    rec(0x00eb, drawingGroup()),
    rec(0x01ae, fields([2, 1], [2, 0x0401])),
    rec(0x0017, fields([2, 1], [2, 0], [2, 0], [2, 0])),
  )
  const data = [1, 2, 3].flatMap((row) => [
    cell(R.NUMBER, row, 0, 15, fields([8, row * 10])),
    cell(R.NUMBER, row, 1, 15, fields([8, row])),
  ])
  const dg = art(0x000f, 0xf002, art(0x000f, 0xf003, patriarch, pictureShape(0), pictureShape(0)))
  const scatter = rec(CH.SCATTER, fields([2, 100], [2, 1], [2, 0]))

  test('散点图按引用从单元格取值；自动格式取调色板颜色；绘图区与图例按记录定位；面积图计入 chart', async () => {
    const wb = await open(
      buildXls(globals, [
        {
          name: 'S',
          records: [
            ...data,
            rec(0x00ec, dg),
            objRecord(5, 1),
            chartStream(scatter),
            objRecord(5, 2),
            chartStream(rec(CH.AREA, fields([2, 0]))),
          ],
        },
      ]),
    )
    const sheet = worksheetAt(wb, 0)
    expect(sheet.unsupported).toEqual({ chart: 1 })
    expect(sheet.charts.map((c) => c.order)).toEqual([0])
    const chart = sheet.charts[0]!.chart
    const series = chart.plot.groups[0]!.series[0]!
    expect(chart.plot.groups[0]!.type).toBe('scatter')
    expect(series.xValues).toEqual([10, 20, 30])
    expect(series.values).toEqual([1, 2, 3])
    expect(series.name).toBe('系列1')
    // 自动格式：线条与标记取调色板第 32 色（深蓝），标记为菱形。
    expect(series.box.line?.fill.kind === 'solid' && hex(series.box.line.fill.color)).toBe(
      '#000080',
    )
    expect(series.marker?.symbol).toBe('diamond')
    expect(series.marker?.box.fill.kind === 'solid' && hex(series.marker.box.fill.color)).toBe(
      '#000080',
    )
    expect(chart.plot.layout).toEqual({
      target: 'outer',
      xMode: 'edge',
      yMode: 'edge',
      x: 0.1,
      y: 0.05,
      w: 0.75,
      h: 0.9,
    })
    expect(chart.plot.box.fill.kind === 'solid' && hex(chart.plot.box.fill.color)).toBe('#c0c0c0')
    expect(chart.plot.box.line).toBeNull()
    expect(chart.legend?.layout).toMatchObject({ x: 0.8, y: 0.4 })
    // 图例没有边框记录：黑色细线边框。
    expect(chart.legend?.box.line?.width).toBe(9525)
    const [x, y] = chart.plot.axes
    expect([x!.kind, x!.position, x!.min, x!.majorGridlines]).toEqual(['value', 'b', 10, null])
    expect([y!.kind, y!.position, y!.min]).toEqual(['value', 'l', null])
    expect(y!.majorGridlines?.fill.kind === 'solid' && hex(y!.majorGridlines.fill.color)).toBe(
      '#808080',
    )
  })

  test('图表工作表：图表区为 Chart 记录的宽高各减 1 像素，缩放比例取图表块中的 SCL；不支持的图表计入 chart', async () => {
    const scl = rec(R.SCL, fields([2, 3], [2, 4]))
    const area = chartBody(rec(CH.AREA, fields([2, 0])))
    const wb = await open(
      buildXls(globals, [
        { name: 'S', records: data },
        { name: '图', type: 2, bofType: 0x0020, records: [chartBody(scatter, [scl])] },
        { name: '面积', type: 2, bofType: 0x0020, records: [area] },
      ]),
    )
    expect(wb.sheets.map((s) => [s.kind, s.name])).toEqual([
      ['worksheet', 'S'],
      ['chartsheet', '图'],
      ['chartsheet', '面积'],
    ])
    const sheet = wb.sheets[1]!
    expect(sheet.kind === 'chartsheet' && sheet.view.zoom).toBe(75)
    expect(sheet.charts.map((c) => c.anchor)).toEqual([
      { kind: 'absolute', x: 0, y: 0, width: 300 * 12700 - 9525, height: 200 * 12700 - 9525 },
    ])
    expect(sheet.charts[0]!.chart.plot.groups[0]!.series[0]!.values).toEqual([1, 2, 3])
    expect(sheet.unsupported).toEqual({})
    expect([wb.sheets[2]!.charts, wb.sheets[2]!.unsupported]).toEqual([[], { chart: 1 }])
    expect(wb.unsupported).toEqual({ chart: 1 })
  })

  test('CrtLayout12A 的内框优先于坐标轴组的 Pos', async () => {
    const layout = rec(
      CH.CRTLAYOUT12A,
      join(
        fields([2, CH.CRTLAYOUT12A], [2, 0], [4, 0], [4, 0], [4, 1], [2, 1]),
        fields([2, 0], [2, 0], [2, 0], [2, 0], [2, 2], [2, 2], [2, 1], [2, 1]),
        fields([8, 0.125], [8, 0.0625], [8, 0.5], [8, 0.75], [2, 0]),
      ),
    )
    const wb = await open(
      buildXls(globals, [
        {
          name: 'S',
          records: [...data, rec(0x00ec, dg), objRecord(5, 1), chartStream(scatter, [layout])],
        },
      ]),
    )
    expect(wb.sheets[0]!.charts[0]!.chart.plot.layout).toEqual({
      target: 'inner',
      xMode: 'edge',
      yMode: 'edge',
      x: 0.125,
      y: 0.0625,
      w: 0.5,
      h: 0.75,
    })
  })

  test('整列引用（到 65536 行）截到含内容的行', async () => {
    const wb = await open(
      buildXls(globals, [
        {
          name: 'S',
          records: [
            ...data,
            rec(0x00ec, dg),
            objRecord(5, 1),
            chartStream(scatter, [], [0, 65535]),
          ],
        },
      ]),
    )
    expect(wb.sheets[0]!.charts[0]!.chart.plot.groups[0]!.series[0]!.values).toEqual([
      null,
      1,
      2,
      3,
    ])
  })
})
