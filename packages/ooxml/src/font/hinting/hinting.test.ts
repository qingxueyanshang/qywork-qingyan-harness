/**
 * TrueType 指令提示与单色光栅化。覆盖 `interpreter.ts`（取整、MDAP、IUP、DELTAP、各字形之间状态的隔离）、`raster.ts`（丢失控制）、
 * `glyph.ts` 与 `index.ts`（字形装入、幻影点、合成斜体），以及 `../bitmap.ts` 中点阵模式下没有点阵的字形。
 *
 * 本机字体的期望值取自 WPS 表格的屏幕显示（`Range.CopyPicture` 的位图）中宋体对应字号的字，裁到墨迹框；
 * 其他平台跳过这些用例。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BitmapGlyph } from '../bitmap.ts'
import { readEmbeddedBitmaps, readFaces, readMetrics } from '../index.ts'
import type { HintedOutline } from './glyph.ts'
import { readGlyphHinting } from './index.ts'
import { createZone, type FontPrograms, SizeHinter, TAG_ON } from './interpreter.ts'
import { rasterize } from './raster.ts'

function programs(prep: number[] = []): FontPrograms {
  return {
    unitsPerEm: 1024,
    fpgm: new Uint8Array(0),
    prep: Uint8Array.from(prep),
    cvt: new Int16Array(0),
    maxStorage: 0,
    maxStack: 16,
    maxTwilight: 0,
  }
}

/** 一个轮廓、3 个点加 4 个幻影点的字形区，点的 x 依次为 `xs`（26.6）。 */
function zone(xs: number[]) {
  const z = createZone(xs.length + 4, [xs.length - 1])
  xs.forEach((x, i) => {
    z.orusX[i] = x
    z.orgX[i] = z.curX[i] = x
    z.tags[i] = TAG_ON
  })
  return z
}

/** 点阵裁到墨迹框后按行转为 `#` 与 `.`。 */
function ink(g: BitmapGlyph): string[] {
  let x0 = g.width
  let x1 = -1
  let y0 = g.height
  let y1 = -1
  for (let y = 0; y < g.height; y++)
    for (let x = 0; x < g.width; x++)
      if (g.pixels[y * g.width + x]) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
  const out: string[] = []
  for (let y = y0; y <= y1; y++) {
    let r = ''
    for (let x = x0; x <= x1; x++) r += g.pixels[y * g.width + x] ? '#' : '.'
    out.push(r)
  }
  return out
}

describe('指令', () => {
  test('MDAP[1] 按当前取整方式把点取整到网格，IUP 按触及点平移同一轮廓中未触及的点', () => {
    const size = new SizeHinter(programs(), 12)
    const z = zone([100, 300, 500])
    // SVTCA[x]；PUSHB 0；MDAP[1]；IUP[x]
    size.hint(z, Uint8Array.from([0x01, 0xb0, 0, 0x2f, 0x31]), false)
    expect(Array.from(z.curX.subarray(0, 3))).toEqual([128, 328, 528])
  })

  test('DELTAP1 只在 ppem 等于 delta 基准加参数高 4 位时移动点', () => {
    // 参数 0x3f：ppem 9 + 3 = 12，低 4 位 0xf 为 +8 步，每步 1/8 像素。
    const code = Uint8Array.from([0x01, 0xb2, 0x3f, 0, 1, 0x5d])
    const at12 = zone([100, 300, 500])
    new SizeHinter(programs(), 12).hint(at12, code, false)
    expect(at12.curX[0]).toBe(164)
    const at13 = zone([100, 300, 500])
    new SizeHinter(programs(), 13).hint(at13, code, false)
    expect(at13.curX[0]).toBe(100)
  })

  test('prep 中未定义的指令使该字号不做提示', () => {
    expect(new SizeHinter(programs([0x28]), 12).ok).toBe(false)
    expect(new SizeHinter(programs([0xb0, 1, 0x8d]), 12).ok).toBe(true)
  })

  test('字形指令写入的存储区与 cvt 不带到下一个字形：每个字形从 prep 之后的状态开始', () => {
    const size = new SizeHinter({ ...programs(), maxStorage: 1, cvt: new Int16Array(1) }, 12)
    // PUSHB 0, 0；RS；SHPIX（点 0 按存储区 0 平移）；PUSHB 0, 0；RCVT；SHPIX（按 cvt 0 平移）；
    // PUSHB 0, 64；WS；PUSHB 0, 64；WCVTP（两者写入 64）。
    const code = Uint8Array.from([
      0xb1, 0, 0, 0x43, 0x38, 0xb1, 0, 0, 0x45, 0x38, 0xb1, 0, 64, 0x42, 0xb1, 0, 64, 0x44,
    ])
    const xs = [0, 1].map(() => {
      const z = zone([100, 300, 500])
      size.hint(z, code, false)
      return z.curX[0]
    })
    expect(xs).toEqual([100, 100])
  })
})

/**
 * ClearType 绘制的指令条件。期望值取自 GDI 在本机的实测：构造字体的字形指令把读数按 y 方向平移探针，由绘制结果读出。
 */
describe('ClearType 绘制的指令', () => {
  /** 执行 `code` 后点 0 的 y：读数经 SHPIX 写入（SVTCA[y]；PUSHB 0；读数；SHPIX）。 */
  const readout = (size: SizeHinter, value: number[]) => {
    const z = zone([0, 0, 0])
    size.hint(z, Uint8Array.from([0x00, 0xb0, 0, ...value, 0x38]), false)
    return z.curY[0]
  }

  test('GETINFO：版本号两种绘制均为 42，ClearType 只在 ClearType 绘制下回答，自然宽度方式不回答兼容宽度', () => {
    // PUSHB 选择子；GETINFO
    const getinfo = (sel: number) => [0xb0, sel, 0x88]
    expect(readout(new SizeHinter(programs(), 12), getinfo(1))).toBe(42)
    expect(readout(new SizeHinter(programs(), 12, true), getinfo(1))).toBe(42)
    expect(readout(new SizeHinter(programs(), 12), getinfo(64))).toBe(0)
    expect(readout(new SizeHinter(programs(), 12, true), getinfo(64))).toBe(0x2000)
    expect(readout(new SizeHinter(programs(), 12, true), getinfo(128))).toBe(0)
  })

  test('字形指令在 x 方向取整到 1/16 像素、最小距离取一半；y 方向与 prep 仍取整到整像素', () => {
    // SVTCA[x]；PUSHB 0；MDAP[1]：x = 505 取整为 504（单色为 512）。
    const mdap = Uint8Array.from([0x01, 0xb0, 0, 0x2f])
    const ct = zone([505, 0, 0])
    new SizeHinter(programs(), 16, true).hint(ct, mdap, false)
    expect(ct.curX[0]).toBe(504)
    const mono = zone([505, 0, 0])
    new SizeHinter(programs(), 16).hint(mono, mdap, false)
    expect(mono.curX[0]).toBe(512)
    // SVTCA[x]；PUSHB 0；MDAP[0]；PUSHB 1；MDRP[01000]（最小距离）：距离 5 取最小距离 32（单色为 64）。
    const mdrp = Uint8Array.from([0x01, 0xb0, 0, 0x2e, 0xb0, 1, 0xc8])
    const near = zone([500, 505, 0])
    new SizeHinter(programs(), 16, true).hint(near, mdrp, false)
    expect(near.curX[1]! - near.curX[0]!).toBe(32)
    // prep 中的 x 方向取整为整像素：prep 把 ROUND(37) 写入存储区，字形指令读出。
    const prep = [0x01, 0xb1, 0, 37, 0x68, 0x42]
    const fromPrep = new SizeHinter({ ...programs(prep), maxStorage: 1 }, 16, true)
    expect(readout(fromPrep, [0xb0, 0, 0x43])).toBe(64)
  })
})

describe('扫描转换', () => {
  // 0.31 像素宽的竖条，x 为 100–120（26.6），其间没有像素中心。
  const bar = (scanType: number, scanControl: boolean): HintedOutline => ({
    xs: Float64Array.from([100, 100, 120, 120]),
    ys: Float64Array.from([0, 256, 256, 0]),
    onCurve: Uint8Array.from([1, 1, 1, 1]),
    ends: [3],
    advance: 384,
    scan: { scanControl, scanType },
  })

  test('智能丢失控制着墨中心离区间中点最近的一列', () => {
    const g = rasterize(bar(4, true))
    expect([g.bearingX, g.width, g.height]).toEqual([1, 1, 4])
    expect(ink(g)).toEqual(['#', '#', '#', '#'])
  })

  test('关闭丢失控制时细于一个像素的竖条不着墨', () => {
    expect(rasterize(bar(4, false)).pixels.every((p) => p === 0)).toBe(true)
    expect(rasterize(bar(2, true)).pixels.every((p) => p === 0)).toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('本机字体（宋体，与 WPS 表格的屏幕显示对照）', () => {
  const bytes = new Uint8Array(
    readFileSync(join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'simsun.ttc')),
  )
  const face = readFaces(bytes)[0]!
  const metrics = readMetrics(bytes, face)
  const hinting = readGlyphHinting(bytes, face)!
  const glyph = (ch: string, ppem: number, oblique = false) =>
    hinting.glyph(metrics.glyphId(ch.codePointAt(0)!), ppem, oblique)

  test.each([
    ['7', 12, ['####', '...#', '..#.', '..#.', '.#..', '.#..', '.#..', '.#..']],
    [
      'A',
      14,
      [
        '...#...',
        '...#...',
        '..#.#..',
        '..#.#..',
        '..#.#..',
        '..###..',
        '.#...#.',
        '.#...#.',
        '###.###',
      ],
    ],
    ['g', 14, ['.####', '#..#.', '#..#.', '.##..', '#....', '.###.', '#...#', '.###.']],
    [
      '@',
      16,
      [
        '..###..',
        '.#...#.',
        '.#.##.#',
        '#.#.#.#',
        '#.#.#.#',
        '#.#.#.#',
        '#.#.#.#',
        '#.#.#.#',
        '.#.###.',
        '.#....#',
        '..####.',
      ],
    ],
    [
      '$',
      17,
      [
        '...#...',
        '..####.',
        '.#.#..#',
        '#..#..#',
        '#..#...',
        '.#.#...',
        '..###..',
        '...#.#.',
        '...#..#',
        '#..#..#',
        '#..#..#',
        '#..#.#.',
        '.####..',
        '...#...',
        '...#...',
      ],
    ],
  ] as const)('「%s」%d 像素', (ch, ppem, expected) => {
    expect(ink(glyph(ch, ppem))).toEqual([...expected])
  })

  test('合成斜体：12 磅（16 像素）「ABab12」逐字倾斜后的整行与 WPS 一致', () => {
    const text = 'ABab12'
    const W = 64
    const H = 24
    const base = 18
    const canvas = new Uint8Array(W * H)
    let x = 0
    for (const ch of text) {
      const g = glyph(ch, 16, true)
      for (let r = 0; r < g.height; r++)
        for (let c = 0; c < g.width; c++)
          if (g.pixels[r * g.width + c])
            canvas[(base - g.bearingY + r) * W + x + 4 + g.bearingX + c] = 1
      x += g.advance
    }
    expect(x).toBe(48)
    expect(
      ink({ width: W, height: H, bearingX: 0, bearingY: 0, advance: 0, pixels: canvas }),
    ).toEqual([
      '.......#....#####............#..........#.....####',
      '......##....#...#..........##........###....##...#',
      '.....#.#....#...#...........#..........#....#....#',
      '.....#.#....#..#............#..........#....#...#.',
      '....#..#...####.....####...#.###......#.........#.',
      '....#..#...#...#...#...#...##..#......#........#..',
      '...#####...#...#......##...#...#......#......##...',
      '..#....#..#....#...####...#....#.....#......#.....',
      '..#....#..#....#..#...#...#....#.....#.....#...#..',
      '.#.....#..#...#...#..##...#...#.....##....#...#...',
      '###..#########....#####..#.###....#####..######...',
    ])
  })

  test('点阵模式下 strike 中没有的字形取提示后的轮廓，要求倾斜时汉字也不取点阵', () => {
    const bitmaps = readEmbeddedBitmaps(bytes, face)!
    const a = metrics.glyphId(0x41)
    expect(ink(bitmaps.glyph(14, a, false)!)).toEqual(ink(glyph('A', 14)))
    const han = metrics.glyphId(0x5b8b)
    expect(bitmaps.glyph(14, han, true)).toEqual(glyph('宋', 14, true))
    expect(bitmaps.glyph(14, han, false)).not.toEqual(glyph('宋', 14, false))
    expect(bitmaps.glyph(18, a, false)).toBeNull()
  })
})
