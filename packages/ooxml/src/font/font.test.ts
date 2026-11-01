/**
 * 字体表读取。覆盖 `sfnt.ts`（表目录、TTC 合集头、TTC 拆分）、`name.ts`（家族名）、
 * `cmap.ts`（格式 4 与 12）、`metrics.ts`（head、hhea、maxp、hmtx 与按字号换算）。
 *
 * 读取本机 Windows 字体目录中的真实文件：其他平台跳过（`skipIf`），Windows 上文件不存在时读取抛出，用例失败。
 * 期望的字形编号与前进宽度取自独立实现对同一文件的读取（`cmap` 按同一子表选用顺序），不由本模块计算。
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractFace,
  FontFormatError,
  readFaces,
  readFamilyNames,
  readHead,
  readMetrics,
  type SfntFace,
  tableBytes,
} from './index.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const load = (file: string) => new Uint8Array(readFileSync(join(FONTS, file)))

interface Expected {
  file: string
  face: number
  names: string[]
  unitsPerEm: number
  numGlyphs: number
  bold: boolean
  /** [码位, 字形编号, 前进宽度（字体单位）] */
  glyphs: [number, number, number][]
}

const EXPECTED: Expected[] = [
  {
    file: 'simsun.ttc',
    face: 0,
    names: ['SimSun', '宋体'],
    unitsPerEm: 256,
    numGlyphs: 28905,
    bold: false,
    glyphs: [
      [0x41, 36, 128],
      [0x69, 76, 128],
      [0x4e2d, 1117, 256],
      [0xff0c, 712, 256],
    ],
  },
  {
    file: 'simsun.ttc',
    face: 1,
    names: ['NSimSun', '新宋体'],
    unitsPerEm: 256,
    numGlyphs: 28905,
    bold: false,
    glyphs: [
      [0x20, 3, 128],
      [0x6587, 7095, 256],
      [0x3002, 452, 256],
    ],
  },
  {
    // numberOfHMetrics 为 855：汉字的字形编号大于它，宽度取 hmtx 最后一项。
    file: 'simhei.ttf',
    face: 0,
    names: ['SimHei', '黑体'],
    unitsPerEm: 256,
    numGlyphs: 28562,
    bold: false,
    glyphs: [
      [0x57, 58, 128],
      [0x4e2d, 1123, 256],
      [0x6587, 7101, 256],
      [0xff0c, 952, 256],
    ],
  },
  {
    file: 'arial.ttf',
    face: 0,
    names: ['Arial'],
    unitsPerEm: 2048,
    numGlyphs: 4503,
    bold: false,
    // 0x4E2D 不在 cmap 中：编号 0，宽度为 .notdef 的宽度。
    glyphs: [
      [0x20, 3, 569],
      [0x41, 36, 1366],
      [0x57, 58, 1933],
      [0x69, 76, 455],
      [0x4e2d, 0, 1536],
    ],
  },
  {
    file: 'arialbd.ttf',
    face: 0,
    names: ['Arial'],
    unitsPerEm: 2048,
    numGlyphs: 4503,
    bold: true,
    glyphs: [
      [0x41, 36, 1479],
      [0x69, 76, 569],
    ],
  },
  {
    // 带 (3,10) 格式 12 子表，按选用顺序优先于格式 4。
    file: 'msyh.ttc',
    face: 0,
    names: ['Microsoft YaHei', '微软雅黑'],
    unitsPerEm: 2048,
    numGlyphs: 30209,
    bold: false,
    glyphs: [
      [0x41, 39, 1441],
      [0x4e2d, 1048, 2048],
      [0x3002, 28574, 2048],
      [0x20000, 0, 1428],
    ],
  },
  {
    // 补充平面字符只在格式 12 中；numberOfHMetrics 为 99。
    file: 'simsunb.ttf',
    face: 0,
    names: ['SimSun-ExtB'],
    unitsPerEm: 256,
    numGlyphs: 60455,
    bold: false,
    glyphs: [
      [0x41, 35, 128],
      [0x20000, 98, 256],
      [0x2a6d6, 42808, 256],
      [0x4e2d, 0, 256],
    ],
  },
]

describe.skipIf(process.platform !== 'win32')('本机字体', () => {
  test.each(EXPECTED)('$file 第 $face 个字体的家族名、字形编号与前进宽度', (e) => {
    const bytes = load(e.file)
    const face = readFaces(bytes)[e.face]!
    expect(readFamilyNames(tableBytes(bytes, face, 'name'))).toEqual(e.names)
    expect(readHead(tableBytes(bytes, face, 'head')).bold).toBe(e.bold)
    const m = readMetrics(bytes, face)
    expect(m.unitsPerEm).toBe(e.unitsPerEm)
    expect(m.numGlyphs).toBe(e.numGlyphs)
    // 实际值与期望值都带上码位，失败信息可直接指出是哪个字符。
    const actual = e.glyphs.map(([cp]) => [cp, m.glyphId(cp), m.advanceWidth(cp)])
    expect(actual).toEqual(e.glyphs)
  })

  test('按字号换算：宽度 = 字体单位 × 字号 / unitsPerEm', () => {
    const bytes = load('arial.ttf')
    const m = readMetrics(bytes, readFaces(bytes)[0]!)
    expect(m.advance(0x41, 2048)).toBe(1366)
    expect(m.advance(0x41, 12)).toBeCloseTo((1366 * 12) / 2048, 10)
    const simsun = load('simsun.ttc')
    expect(readMetrics(simsun, readFaces(simsun)[0]!).advance(0x4e2d, 10.5)).toBe(10.5)
  })

  describe('TTC 拆分', () => {
    let ttc = new Uint8Array()
    let faces: SfntFace[] = []
    let parts: Uint8Array[] = []
    beforeAll(() => {
      ttc = load('simsun.ttc')
      faces = readFaces(ttc)
      parts = faces.map((_, i) => extractFace(ttc, i))
    })

    const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
    const sum = (b: Uint8Array, offset: number, length: number) => {
      let s = 0
      for (let i = offset; i < offset + length; i += 4) s = (s + view(b).getUint32(i)) >>> 0
      return s
    }

    test('合集中的两个字体各拆为一个独立 sfnt，家族名与度量和合集中的原字体一致', () => {
      expect(faces).toHaveLength(2)
      parts.forEach((bytes, i) => {
        const own = readFaces(bytes)
        expect(own).toHaveLength(1)
        expect(view(bytes).getUint32(0)).toBe(0x00010000)
        const face = own[0]!
        expect(readFamilyNames(tableBytes(bytes, face, 'name'))).toEqual(
          readFamilyNames(tableBytes(ttc, faces[i]!, 'name')),
        )
        const a = readMetrics(bytes, face)
        const b = readMetrics(ttc, faces[i]!)
        for (const cp of [0x20, 0x41, 0x4e2d, 0x3002, 0xff0c]) {
          expect(a.advanceWidth(cp)).toBe(b.advanceWidth(cp))
        }
      })
    })

    test('各表字节与合集中相同（head 的 checkSumAdjustment 除外），表按标签升序且 4 字节对齐', () => {
      parts.forEach((bytes, i) => {
        const face = readFaces(bytes)[0]!
        const original = faces[i]!
        expect([...face.tables.keys()]).toEqual([...original.tables.keys()].sort())
        for (const record of face.tables.values()) {
          expect(record.offset % 4).toBe(0)
          const mine = tableBytes(bytes, face, record.tag)
          const theirs = tableBytes(ttc, original, record.tag)
          if (record.tag === 'head') {
            expect(mine.subarray(0, 8)).toEqual(theirs.subarray(0, 8))
            expect(mine.subarray(12)).toEqual(theirs.subarray(12))
          } else {
            expect(mine).toEqual(theirs)
          }
        }
      })
    })

    test('各表校验和与整个文件的校验和符合规范', () => {
      for (const bytes of parts) {
        const face = readFaces(bytes)[0]!
        for (const record of face.tables.values()) {
          const padded = (record.length + 3) & ~3
          let expected = sum(bytes, record.offset, padded)
          if (record.tag === 'head') {
            expected = (expected - view(bytes).getUint32(record.offset + 8)) >>> 0
          }
          expect(record.checksum).toBe(expected)
        }
        expect(bytes.byteLength % 4).toBe(0)
        expect(sum(bytes, 0, bytes.byteLength)).toBe(0xb1b0afba)
      }
    })

    test('单个字体文件原样返回；序号超出范围时抛出', () => {
      const arial = load('arial.ttf')
      expect(extractFace(arial, 0)).toBe(arial)
      expect(() => extractFace(arial, 1)).toThrow(FontFormatError)
      expect(() => extractFace(ttc, 2)).toThrow(FontFormatError)
    })
  })
})

/** 按 `name` 表格式 0 构造只含给定记录的表。 */
function nameTable(
  records: { platform: number; encoding: number; nameId: number; bytes: number[] }[],
) {
  const storage = 6 + 12 * records.length
  const data: number[] = []
  const head: number[] = []
  const u16 = (n: number) => [n >> 8, n & 0xff]
  for (const r of records) {
    head.push(...u16(r.platform), ...u16(r.encoding), ...u16(0), ...u16(r.nameId))
    head.push(...u16(r.bytes.length), ...u16(data.length))
    data.push(...r.bytes)
  }
  return new Uint8Array([...u16(0), ...u16(records.length), ...u16(storage), ...head, ...data])
}

const utf16 = (s: string) => [...s].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])

describe('家族名解码', () => {
  test('平台 1 按 Mac Roman 解码，平台 3 按 UTF-16BE 解码，只取 nameID 1，重复的名称只保留一个', () => {
    const table = nameTable([
      { platform: 1, encoding: 0, nameId: 1, bytes: [0x43, 0x61, 0x66, 0x8e] },
      { platform: 3, encoding: 1, nameId: 1, bytes: utf16('Café') },
      { platform: 3, encoding: 1, nameId: 1, bytes: utf16('宋体') },
      { platform: 3, encoding: 1, nameId: 16, bytes: utf16('Typographic') },
      // 平台 3 编码 3（GBK 双字节）不解码。
      { platform: 3, encoding: 3, nameId: 1, bytes: [0xcb, 0xce] },
    ])
    expect(readFamilyNames(table)).toEqual(['Café', '宋体'])
  })

  test('记录越过表尾时抛出 FontFormatError', () => {
    const table = nameTable([{ platform: 3, encoding: 1, nameId: 1, bytes: utf16('Arial') }])
    expect(() => readFamilyNames(table.subarray(0, table.byteLength - 2))).toThrow(FontFormatError)
  })
})

describe('结构校验', () => {
  test('不是字体的字节、截断的表目录、越界的表记录均抛出 FontFormatError', () => {
    expect(() => readFaces(new TextEncoder().encode('not a font, just text'))).toThrow(
      FontFormatError,
    )
    // sfnt 头声明 2 张表，表目录只有 1 条。
    const header = [0, 1, 0, 0, 0, 2, 0, 32, 0, 1, 0, 0]
    expect(() => readFaces(new Uint8Array([...header, ...new Array(16).fill(0)]))).toThrow(
      FontFormatError,
    )
    // 1 张表，偏移 + 长度超出文件。
    const one = [0, 1, 0, 0, 0, 1, 0, 16, 0, 0, 0, 0]
    const record = [0x68, 0x65, 0x61, 0x64, 0, 0, 0, 0, 0, 0, 0, 28, 0, 0, 0, 54]
    expect(() => readFaces(new Uint8Array([...one, ...record]))).toThrow(FontFormatError)
    // 合集头声明 0 个字体。
    const ttcf = [0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0, 0, 0, 0]
    expect(() => readFaces(new Uint8Array(ttcf))).toThrow(FontFormatError)
  })
})
