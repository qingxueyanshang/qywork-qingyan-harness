/**
 * 覆盖范围：`ctf.ts`（简单字形的三元组与包围盒、组合字形、入栈数据的 HOP 码与 255SHORT、重新生成的入栈指令、
 * `loca` 长格式与 `head`、`maxp` 的修正、`cvt `、`hdmx` 的还原、长度为 0 的表与 `cmap` 语言字段、CFF 字体各表原样保留）、
 * `eot.ts`（文件头、家族名、异或与未压缩的字体数据）。
 *
 * LZCOMP（`lzcomp.ts`）由真实文件核对：语料中 2 份 pptx 的 24 个嵌入字体全部还原，字形数与 `name` 表一致，
 * 绘制结果与 WPS 导出图一致；仓库内没有 MicroType Express 的压缩端，不构造压缩数据。
 */

import { describe, expect, test } from 'bun:test'
import { readFaces, tableBytes } from '../sfnt.ts'
import { ctfToTrueType } from './ctf.ts'
import { readEmbeddedOpenType } from './eot.ts'

class Bytes {
  readonly out: number[] = []
  u8(...v: number[]): this {
    for (const x of v) this.out.push(x & 0xff)
    return this
  }
  u16(...v: number[]): this {
    for (const x of v) this.u8(x >> 8, x)
    return this
  }
  u32(v: number): this {
    return this.u16(v >>> 16, v & 0xffff)
  }
  get bytes(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}

/** 由表构造未排序的 sfnt（CTF 第一数据块的结构）。 */
function sfnt(version: number, tables: [string, Uint8Array][]): Uint8Array {
  const b = new Bytes().u32(version).u16(tables.length, 0, 0, 0)
  let offset = 12 + 16 * tables.length
  const placed = tables.map(([tag, data]) => {
    const at = offset
    offset += (data.length + 3) & ~3
    return { tag, data, at }
  })
  for (const t of placed) {
    b.u8(...[...t.tag].map((c) => c.charCodeAt(0)))
    b.u32(0)
      .u32(t.data.length === 0 ? 0 : t.at)
      .u32(t.data.length)
  }
  for (const t of placed) {
    b.u8(...t.data)
    while (b.out.length % 4) b.u8(0)
  }
  return b.bytes
}

function head(): Uint8Array {
  const b = new Bytes().u32(0x00010000).u32(0).u32(0).u32(0x5f0f3cf5).u16(0, 1000)
  while (b.out.length < 54) b.u8(0)
  return b.bytes
}

function maxp(numGlyphs: number): Uint8Array {
  const b = new Bytes().u32(0x00010000).u16(numGlyphs)
  while (b.out.length < 32) b.u8(0)
  return b.bytes
}

function hhea(metrics: number): Uint8Array {
  const b = new Bytes()
  while (b.out.length < 34) b.u8(0)
  return b.u16(metrics).bytes
}

/** TrueType 字形数据中的字段。 */
function glyph(font: Uint8Array, index: number): DataView {
  const face = readFaces(font)[0]!
  const loca = tableBytes(font, face, 'loca')
  const glyf = tableBytes(font, face, 'glyf')
  const lv = new DataView(loca.buffer, loca.byteOffset, loca.byteLength)
  const start = lv.getUint32(4 * index)
  const end = lv.getUint32(4 * index + 4)
  return new DataView(glyf.buffer, glyf.byteOffset + start, end - start)
}

describe('CTF 还原', () => {
  const glyf = new Bytes()
    // 0：空字形。
    .u16(0)
    // 1：一个轮廓、三个点，包围盒由坐标计算；入栈 5 项（含 HOP3），指令 2 字节。
    .u16(1)
    .u8(2)
    .u8(1, 11 | 0x80, 0)
    .u8(100, 50, 100)
    .u8(5, 2)
    // 2：组合字形，参数为字，带指令：入栈 1 项、指令 1 字节。
    .u16(0xffff)
    .u16(0, 0, 50, 100)
    .u16(0x0101, 1, 10, 20)
    .u8(1, 1).bytes
  const cvt = new Bytes().u16(3).u8(10, 248, 12, 239, 5).bytes
  // hdmx：1 个尺寸（10 ppem），按步进 500 预测为 5，差值依次为 +1、0、-1（位序低位在前：1,0,0,0,1,0,1）。
  const hdmx = new Bytes().u16(0, 1).u32(8).u8(10, 6).u8(0x51).bytes
  const hmtx = new Bytes().u16(500, 0, 500, 0, 500, 0).bytes
  const rest = sfnt(0x00010000, [
    ['head', head()],
    ['maxp', maxp(3)],
    ['hhea', hhea(3)],
    ['hmtx', hmtx],
    ['cvt ', cvt],
    ['hdmx', hdmx],
    ['loca', new Uint8Array()],
    ['glyf', glyf],
  ])
  const push = new Bytes().u8(1, 2, 251, 3).u8(255, 50).bytes
  const code = new Bytes().u8(0x2f, 0x30).u8(0x31).bytes
  const font = ctfToTrueType(rest, push, code)

  test('简单字形：三元组位移、是否在曲线上、包围盒与重新生成的入栈指令', () => {
    const g = glyph(font, 1)
    expect([g.getInt16(0), g.getInt16(2), g.getInt16(4), g.getInt16(6), g.getInt16(8)]).toEqual([
      1, 0, 0, 50, 100,
    ])
    expect(g.getUint16(10)).toBe(2)
    const n = g.getUint16(12)
    const instr = Array.from({ length: n }, (_, i) => g.getUint8(14 + i))
    expect(instr).toEqual([0xb4, 1, 2, 1, 3, 1, 0x2f, 0x30])
    const at = 14 + n
    expect([g.getUint8(at), g.getUint8(at + 1), g.getUint8(at + 2)]).toEqual([1, 0, 1])
    const xs = [0, 1, 2].map((i) => g.getInt16(at + 3 + 2 * i))
    const ys = [0, 1, 2].map((i) => g.getInt16(at + 9 + 2 * i))
    expect(xs).toEqual([0, 50, 0])
    expect(ys).toEqual([100, 0, -100])
  })

  test('空字形长度为 0；组合字形原样保留组件，指令以字入栈', () => {
    expect(glyph(font, 0).byteLength).toBe(0)
    const g = glyph(font, 2)
    expect(g.getInt16(0)).toBe(-1)
    expect([g.getUint16(10), g.getUint16(12), g.getInt16(14), g.getInt16(16)]).toEqual([
      0x0101, 1, 10, 20,
    ])
    expect(g.getUint16(18)).toBe(4)
    expect([g.getUint8(20), g.getUint8(21), g.getUint8(22), g.getUint8(23)]).toEqual([
      0xb8, 0x01, 0x2c, 0x31,
    ])
  })

  test('loca 为长格式；maxp 的最大指令长度不小于重新生成的指令；cvt 与 hdmx 还原', () => {
    const face = readFaces(font)[0]!
    const h = tableBytes(font, face, 'head')
    expect((h[50]! << 8) | h[51]!).toBe(1)
    const m = tableBytes(font, face, 'maxp')
    expect((m[26]! << 8) | m[27]!).toBe(8)
    const c = tableBytes(font, face, 'cvt ')
    const cv = new DataView(c.buffer, c.byteOffset, c.byteLength)
    expect([cv.getInt16(0), cv.getInt16(2), cv.getInt16(4)]).toEqual([10, 260, 255])
    const d = tableBytes(font, face, 'hdmx')
    expect(Array.from(d.subarray(8, 13))).toEqual([10, 6, 6, 5, 4])
  })

  /**
   * 原始失败形状：浏览器以「Invalid font data」拒绝还原出的字体。生物科技模板的腾讯体含长度为 0 的表，
   * 青学研上的等线子集在 `cmap` 格式 12 子表的语言字段写入非 0 的值，字体校验因此拒绝整个字体。
   */
  test('长度为 0 的表不写出；cmap 格式 12 子表的语言字段置 0，其他平台的子表不变', () => {
    const format12 = new Bytes()
      .u16(12, 0)
      .u32(28)
      .u32(0x5abbccdd)
      .u32(1)
      .u32(0x4e00)
      .u32(0x4e00)
      .u32(1).bytes
    const mac = new Bytes().u16(0, 262, 7).u8(...new Array(256).fill(0)).bytes
    const cmap = new Bytes()
      .u16(0, 2)
      .u16(3, 10)
      .u32(20)
      .u16(1, 0)
      .u32(20 + format12.length)
      .u8(...format12)
      .u8(...mac).bytes
    const out = ctfToTrueType(
      sfnt(0x00010000, [
        ['head', head()],
        ['maxp', new Bytes().u32(0x00005000).u16(1).bytes],
        ['cmap', cmap],
        ['cnrd', new Uint8Array()],
      ]),
      new Uint8Array(),
      new Uint8Array(),
    )
    const face = readFaces(out)[0]!
    expect(face.tables.has('cnrd')).toBe(false)
    const c = tableBytes(out, face, 'cmap')
    const v = new DataView(c.buffer, c.byteOffset, c.byteLength)
    expect(v.getUint32(20 + 8)).toBe(0)
    expect(v.getUint32(20 + 12)).toBe(1)
    expect(v.getUint16(20 + format12.length + 4)).toBe(7)
  })

  test('CFF 轮廓的字体没有 glyf，各表原样保留', () => {
    const cff = new Uint8Array([1, 2, 3, 4, 5])
    const out = ctfToTrueType(
      sfnt(0x4f54544f, [
        ['head', head()],
        ['maxp', new Bytes().u32(0x00005000).u16(1).bytes],
        ['CFF ', cff],
      ]),
      new Uint8Array(),
      new Uint8Array(),
    )
    const face = readFaces(out)[0]!
    expect(Array.from(tableBytes(out, face, 'CFF '))).toEqual([1, 2, 3, 4, 5])
    expect(face.tables.has('loca')).toBe(false)
  })
})

describe('EOT', () => {
  function eot(fontData: Uint8Array, flags: number): Uint8Array {
    const family = [...'测试'].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])
    const header: number[] = []
    const le32 = (v: number) => header.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24)
    const le16 = (v: number) => header.push(v & 0xff, v >> 8)
    le32(0)
    le32(fontData.length)
    le32(0x00020001)
    le32(flags)
    for (let i = 0; i < 10; i++) header.push(0)
    header.push(1, 1)
    le32(700)
    le16(0)
    le16(0x504c)
    while (header.length < 80) header.push(0)
    le16(0)
    le16(family.length + 2)
    header.push(...family, 0, 0)
    for (let i = 0; i < 4; i++) le16(0)
    le16(0)
    le16(0)
    const all = new Uint8Array(header.length + fontData.length)
    all.set(header)
    all.set(fontData, header.length)
    new DataView(all.buffer).setUint32(0, all.length, true)
    return all
  }

  test('文件头：家族名在 U+0000 处截止、字重与斜体；异或的字体数据按 0x50 还原', () => {
    const data = new Uint8Array([0x00, 0x01, 0x00, 0x00, 9, 8, 7])
    const plain = readEmbeddedOpenType(eot(data, 0x1))
    expect([plain.family, plain.weight, plain.italic, plain.subset]).toEqual([
      '测试',
      700,
      true,
      true,
    ])
    expect(Array.from(plain.font)).toEqual(Array.from(data))
    const xored = readEmbeddedOpenType(
      eot(
        data.map((b) => b ^ 0x50),
        0x10000000,
      ),
    )
    expect(Array.from(xored.font)).toEqual(Array.from(data))
  })

  test('标识不正确时抛出', () => {
    const bad = eot(new Uint8Array([1]), 0)
    bad[34] = 0
    expect(() => readEmbeddedOpenType(bad)).toThrow()
  })
})
