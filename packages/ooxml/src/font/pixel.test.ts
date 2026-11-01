/**
 * 按像素显示的字体数据。覆盖 `bitmap.ts`（EBLC/EBDT 读取、点阵模式的判定、粗体模拟）、
 * `pixel-metrics.ts`（按 ppem 的纵向度量，含 `VDMX` 选用）、`pixel-advance.ts`（整数前进宽度：`hdmx`、
 * 线性缩放字体的四舍五入与等宽字体的全角宽度），以及 `vertical.ts` 的 `codePageRange1`。
 *
 * 读取本机 Windows 字体目录中的真实文件：其他平台跳过（`skipIf`），Windows 上文件不存在时读取抛出，用例失败。
 * 期望值不由本模块计算：点阵取自独立实现对同一文件的读取；纵向度量、前进宽度、点阵模式与粗体结果取自 GDI
 * （`GetTextMetrics`、`GetCharWidth32`、ClearType 下 `ExtTextOut` 绘制到内存位图）在本机的实测。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BitmapGlyph,
  emboldenBitmap,
  FontFormatError,
  readEmbeddedBitmaps,
  readFaces,
  readPixelAdvances,
  readPixelVerticalMetrics,
  type SfntFace,
} from './index.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const load = (file: string) => new Uint8Array(readFileSync(join(FONTS, file)))

/** 点阵按行转为 `#`（着墨）与 `.`。 */
function rows(g: BitmapGlyph): string[] {
  return Array.from({ length: g.height }, (_, y) =>
    Array.from(g.pixels.subarray(y * g.width, (y + 1) * g.width), (p) => (p ? '#' : '.')).join(''),
  )
}

interface GlyphCase {
  name: string
  file: string
  face: number
  ppem: number
  glyph: number
  /** [宽, 高, bearingX, bearingY, 前进宽度] */
  metrics: [number, number, number, number, number]
  rows: string[]
}

// 本机字体中出现的每种「索引子表格式 / 图像格式」组合各取一个字形。
const GLYPHS: GlyphCase[] = [
  {
    name: '宋体「中」：索引格式 1，图像格式 7',
    file: 'simsun.ttc',
    face: 0,
    ppem: 12,
    glyph: 1117,
    metrics: [9, 12, 1, 10, 12],
    rows: [
      '....#....',
      '....#....',
      '....#....',
      '#########',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#########',
      '#...#...#',
      '....#....',
      '....#....',
      '....#....',
    ],
  },
  {
    name: '宋体「，」：索引格式 3，图像格式 7',
    file: 'simsun.ttc',
    face: 0,
    ppem: 12,
    glyph: 712,
    metrics: [2, 4, 2, 4, 12],
    rows: ['##', '##', '.#', '#.'],
  },
  {
    name: '宋体私用区字形：索引格式 2，图像格式 5（度量在索引子表中）',
    file: 'simsun.ttc',
    face: 0,
    ppem: 12,
    glyph: 21991,
    metrics: [11, 12, 0, 10, 12],
    rows: [
      '....#......',
      '....#......',
      '###########',
      '....#......',
      '...#.......',
      '...#.......',
      '...#.......',
      '..#........',
      '..#........',
      '.#.........',
      '#..........',
      '...........',
    ],
  },
  {
    name: 'SimSun-ExtB：索引格式 4，图像格式 1（逐行按字节对齐）',
    file: 'simsunb.ttf',
    face: 0,
    ppem: 12,
    glyph: 1752,
    metrics: [9, 11, 1, 9, 12],
    rows: [
      '..#####..',
      '.....#...',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#..##...#',
      '#.......#',
      '#########',
      '........#',
    ],
  },
  {
    name: 'SimSun-ExtB：索引格式 3，图像格式 1',
    file: 'simsunb.ttf',
    face: 0,
    ppem: 12,
    glyph: 47212,
    metrics: [10, 12, 0, 10, 12],
    rows: [
      '..#..#...#',
      '..#..#.#.#',
      '.#...#.#.#',
      '#..#.#.#.#',
      '####.#.#.#',
      '..#..#.#.#',
      '.#...#.#.#',
      '####.#.#.#',
      '.....#.#.#',
      '..##.#.#.#',
      '##...#...#',
      '....#....#',
    ],
  },
  {
    name: 'MS Gothic：索引格式 5，图像格式 5',
    file: 'msgothic.ttc',
    face: 0,
    ppem: 10,
    glyph: 645,
    metrics: [5, 10, 0, 8, 5],
    rows: [
      '.....',
      '#....',
      '###..',
      '#....',
      '###..',
      '#..#.',
      '#..#.',
      '#..#.',
      '..#..',
      '.....',
    ],
  },
  {
    name: 'MS Gothic：索引格式 2，图像格式 5',
    file: 'msgothic.ttc',
    face: 0,
    ppem: 10,
    glyph: 2101,
    metrics: [10, 10, 0, 8, 10],
    rows: [
      '..........',
      '..........',
      '....#.....',
      '..#####...',
      '....#.....',
      '...####...',
      '..##.#.#..',
      '..#.#..#..',
      '...#..#...',
      '..........',
    ],
  },
  {
    name: 'MS Gothic：索引格式 4，图像格式 7',
    file: 'msgothic.ttc',
    face: 0,
    ppem: 10,
    glyph: 16090,
    metrics: [1, 1, 1, 1, 2],
    rows: ['#'],
  },
  {
    name: 'Courier New：索引格式 3，图像格式 2（小度量，按位连续）',
    file: 'cour.ttf',
    face: 0,
    ppem: 10,
    glyph: 371,
    metrics: [4, 11, 1, 9, 6],
    rows: ['#..#', '....', '#..#', '....', '#..#', '....', '#..#', '....', '#..#', '....', '#..#'],
  },
]

describe.skipIf(process.platform !== 'win32')('本机字体', () => {
  describe('点阵字形', () => {
    test.each(GLYPHS)('$name', (c) => {
      const bytes = load(c.file)
      const g = readEmbeddedBitmaps(bytes, readFaces(bytes)[c.face]!)!.glyph(c.ppem, c.glyph)!
      expect([g.width, g.height, g.bearingX, g.bearingY, g.advance]).toEqual(c.metrics)
      expect(rows(g)).toEqual(c.rows)
    })

    test('strike 中没有的字形与没有 strike 的 ppem 返回 null', () => {
      const bytes = load('simsun.ttc')
      const bitmaps = readEmbeddedBitmaps(bytes, readFaces(bytes)[0]!)!
      // 宋体的 ASCII 字形没有点阵。
      expect(bitmaps.glyph(12, 36)).toBeNull()
      expect(bitmaps.glyph(18, 1117)).toBeNull()
      expect(bitmaps.glyph(12, 1117)).not.toBeNull()
    })

    test('没有 EBLC 的字体返回 null', () => {
      const bytes = load('simhei.ttf')
      expect(readEmbeddedBitmaps(bytes, readFaces(bytes)[0]!)).toBeNull()
    })

    test('EBLC 截断时抛出 FontFormatError', () => {
      const bytes = load('simsunb.ttf')
      const face = readFaces(bytes)[0]!
      const record = face.tables.get('EBLC')!
      const truncated: SfntFace = {
        version: face.version,
        tables: new Map([...face.tables, ['EBLC', { ...record, length: 40 }]]),
      }
      expect(() => readEmbeddedBitmaps(bytes, truncated)).toThrow(FontFormatError)
    })
  })

  describe('点阵模式：ClearType 下按代码页、strike 与斜体判定', () => {
    const cases: [string, number, number[], number[]][] = [
      // [文件, 字体序号, strike 的 ppem, ClearType 下使用点阵的 ppem]
      ['simsun.ttc', 0, [12, 13, 14, 15, 16, 17], [12, 13, 14, 15, 16, 17]],
      ['simsun.ttc', 1, [12, 13, 14, 15, 16, 17], [12, 13, 14, 15, 16, 17]],
      ['simsunb.ttf', 0, [12, 13, 14, 15], [12, 13, 14, 15]],
      // 代码页不含中日韩：有 strike，ClearType 下仍按轮廓绘制。
      ['calibri.ttf', 0, [12, 13, 15, 16, 17, 19], []],
      ['cour.ttf', 0, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], []],
    ]
    test.each(cases)('%s 第 %d 个字体', (file, index, sizes, screen) => {
      const bytes = load(file)
      const bitmaps = readEmbeddedBitmaps(bytes, readFaces(bytes)[index]!)!
      expect(bitmaps.sizes).toEqual(sizes)
      const used = Array.from({ length: 40 }, (_, p) => p).filter((p) =>
        bitmaps.screenMode(p, false),
      )
      expect(used).toEqual(screen)
      expect(sizes.some((p) => bitmaps.screenMode(p, true))).toBe(false)
    })
  })

  test('粗体：与 GDI 对宋体 12 像素「中」的粗体绘制结果一致，前进宽度加 1', () => {
    const bytes = load('simsun.ttc')
    const g = readEmbeddedBitmaps(bytes, readFaces(bytes)[0]!)!.glyph(12, 1117)!
    const bold = emboldenBitmap(g)
    expect([bold.width, bold.height, bold.bearingX, bold.bearingY, bold.advance]).toEqual([
      10, 12, 1, 10, 13,
    ])
    expect(rows(bold)).toEqual([
      '....##....',
      '....##....',
      '....##....',
      '##########',
      '##..##..##',
      '##..##..##',
      '##..##..##',
      '##########',
      '##..##..##',
      '....##....',
      '....##....',
      '....##....',
    ])
  })

  describe('按像素的纵向度量', () => {
    const cases: [string, string, number, number, number[]][] = [
      // [说明, 文件, 字体序号, ppem, [ascent, descent, height, internalLeading, externalLeading]]
      ['宋体 12', 'simsun.ttc', 0, 12, [10, 2, 12, 0, 2]],
      ['宋体 19：外部行距 36 × 19 / 256 = 2.67 取 3', 'simsun.ttc', 0, 19, [16, 3, 19, 0, 3]],
      ['新宋体 16', 'simsun.ttc', 1, 16, [14, 2, 16, 0, 2]],
      ['黑体 19', 'simhei.ttf', 0, 19, [16, 3, 19, 0, 3]],
      ['等线 15：没有 VDMX', 'Deng.ttf', 0, 15, [12, 3, 15, 0, 0]],
      ['Calibri 15：没有 VDMX', 'calibri.ttf', 0, 15, [14, 4, 18, 3, 0]],
      ['Arial 11：取 VDMX，缩放取整为 10 与 2', 'arial.ttf', 0, 11, [11, 3, 14, 3, 0]],
      ['Arial 16：取 VDMX，外部行距 1', 'arial.ttf', 0, 16, [15, 3, 18, 2, 1]],
      ['微软雅黑 13：取 VDMX，缩放取整为 14 与 3', 'msyh.ttc', 0, 13, [15, 4, 19, 6, 0]],
      ['Times New Roman 16', 'times.ttf', 0, 16, [15, 4, 19, 3, 1]],
      ['Tahoma 12：VDMX 只有 bCharSet 0 的记录组，不使用', 'tahoma.ttf', 0, 12, [12, 2, 14, 2, 0]],
      ['Tahoma 16', 'tahoma.ttf', 0, 16, [16, 3, 19, 3, 0]],
    ]
    test.each(cases)('%s', (_, file, index, ppem, expected) => {
      const bytes = load(file)
      const m = readPixelVerticalMetrics(bytes, readFaces(bytes)[index]!)(ppem)
      expect([m.ascent, m.descent, m.height, m.internalLeading, m.externalLeading]).toEqual(
        expected,
      )
    })
  })
})

describe.skipIf(process.platform !== 'win32')('整数前进宽度', () => {
  const cases: [string, string, number, number, string, (number | null)[]][] = [
    // [说明, 文件, 字体序号, ppem, 字符, GDI 宽度（null 为无法确定）]
    ['Arial 15：取 hdmx', 'arial.ttf', 0, 15, 'AWi1', [9, 15, 3, 8]],
    ['Arial 9：hdmx 中没有该 ppem，指令可能改变宽度', 'arial.ttf', 0, 9, 'AW', [null, null]],
    ['Tahoma 9：取 hdmx', 'tahoma.ttf', 0, 9, 'Ai', [7, 2]],
    ['宋体 15：线性宽度四舍五入', 'simsun.ttc', 0, 15, 'Ai中', [8, 8, 15]],
    ['黑体 13：等宽字体的全角取半角的 2 倍', 'simhei.ttf', 0, 13, 'A中', [7, 14]],
    ['黑体 12', 'simhei.ttf', 0, 12, 'A中', [6, 12]],
    ['Consolas 13：西文等宽字体按线性宽度四舍五入', 'consola.ttf', 0, 13, 'Ai', [7, 7]],
    ['Calibri 15：没有 hdmx，指令可能改变宽度', 'calibri.ttf', 0, 15, 'A0', [null, null]],
  ]
  test.each(cases)('%s', (_, file, index, ppem, text, expected) => {
    const bytes = load(file)
    const advance = readPixelAdvances(bytes, readFaces(bytes)[index]!)
    expect([...text].map((c) => advance(c.codePointAt(0)!, ppem))).toEqual(expected)
  })
})

describe('粗体模拟', () => {
  test('每行着墨像素与其右侧 1 像素取并集；高度为 0 的字形没有像素，前进宽度同样加 1', () => {
    const g: BitmapGlyph = {
      width: 3,
      height: 2,
      bearingX: 1,
      bearingY: 2,
      advance: 4,
      pixels: new Uint8Array([1, 0, 1, 0, 1, 0]),
    }
    const bold = emboldenBitmap(g)
    expect(rows(bold)).toEqual(['####', '.##.'])
    expect([bold.width, bold.advance, bold.bearingX, bold.bearingY]).toEqual([4, 5, 1, 2])
    const empty = emboldenBitmap({ ...g, width: 0, height: 0, pixels: new Uint8Array() })
    expect([empty.height, empty.advance, empty.pixels.length]).toEqual([0, 5, 0])
  })
})
