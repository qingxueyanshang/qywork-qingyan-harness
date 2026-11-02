/**
 * ClearType 的子像素覆盖与混合。覆盖 `coverage.ts`（取样、滤波、纵向权重、合成粗体）与 `blend.ts`（伽马混合、覆盖相加、
 * 裁剪）。
 *
 * 覆盖的期望值取自 GDI 在本机的实测：构造字体中的矩形（ppem 16，没有指令）以 ClearType 绘制到内存位图，黑字白底、
 * 对比度 1000 时各子像素的亮度换算为 0–6。混合的期望值取自 WPS 表格的屏幕显示：对比度 1200 的取自对比基准（楷体 12 磅），
 * 对比度 1000 的取自 13 种文字颜色 × 11 种填充色的单元格（楷体 12 磅）。
 */

import { describe, expect, test } from 'bun:test'
import type { HintedOutline } from '../../font/index.ts'
import { type PixelData, paintGlyphRuns } from './blend.ts'
import { type CoverageGlyph, emboldenSamples, filterSamples, sampleOutline } from './coverage.ts'

/** 矩形轮廓（26.6，顺时针）。 */
function rect(x0: number, y0: number, x1: number, y1: number): HintedOutline {
  return {
    xs: Float64Array.from([x0, x0, x1, x1]),
    ys: Float64Array.from([y0, y1, y1, y0]),
    onCurve: Uint8Array.from([1, 1, 1, 1]),
    ends: [3],
    advance: 1024,
    scan: { scanControl: false, scanType: 0 },
  }
}

/** 覆盖第 `top − y` 行（基线以上 `y` 处的像素行）从 `fromX` 起的 `n` 个像素，每像素写为三位数字。 */
function row(g: CoverageGlyph, y: number, fromX: number, n: number): string {
  const r = g.bearingY - y
  const out: string[] = []
  for (let x = fromX; x < fromX + n; x++) {
    const c = x - g.bearingX
    if (r < 0 || r >= g.height || c < 0 || c >= g.width) {
      out.push('000')
      continue
    }
    const at = 3 * (r * g.width + c)
    out.push(`${g.coverage[at]}${g.coverage[at + 1]}${g.coverage[at + 2]}`)
  }
  return out.join(' ')
}

const coverage = (o: HintedOutline, rows: number) => filterSamples(sampleOutline(o, rows), rows)

describe('子像素覆盖', () => {
  test('横向每像素 6 个取样点，R、G、B 各取以子像素为中心、宽 1 像素的窗口', () => {
    // 竖条 x 2–3 像素：GDI 为 002 464 200。
    expect(row(coverage(rect(128, 0, 192, 640), 1), 5, 1, 3)).toBe('002 464 200')
    // 右边移到 3.125 像素，多覆盖 1 个取样点：465 310。
    expect(row(coverage(rect(128, 0, 200, 640), 1), 5, 1, 3)).toBe('002 465 310')
  })

  test('y 方向平滑时每像素纵向取 5 个点，按 1、2、3、2、1 加权', () => {
    // 宽条 x 2–6 像素，上边在 1 + f 像素：像素行 [1, 2) 的覆盖随 f 为 1、2、4、5（等权平均为 1、2、4、5 之外的值）。
    const at = (top: number) => row(coverage(rect(128, 0, 384, top), 5), 2, 3, 1)
    expect([at(64 + 13), at(64 + 26), at(64 + 32), at(64 + 46), at(64 + 58)]).toEqual([
      '111',
      '222',
      '444',
      '555',
      '666',
    ])
    // 左边恰在像素边界、上边覆盖 3 个纵向取样点：R 窗口 4 个取样点着墨，覆盖为 3（等权平均为 2）。
    expect(row(coverage(rect(128, 0, 384, 64 + 32), 5), 2, 2, 1)).toBe('344')
  })

  test('合成粗体：取样点阵与右移 1 像素的副本取并集', () => {
    const g = filterSamples(emboldenSamples(sampleOutline(rect(128, 0, 192, 640), 1)), 1)
    expect(row(g, 5, 1, 4)).toBe('002 466 664 200')
  })
})

/** 底色各分量为 `fill` 的 `w × h` 像素缓冲区，实现读写像素的接口。 */
function canvas(w: number, h: number, fill = 255) {
  const pixels = new Uint8ClampedArray(4 * w * h).fill(fill)
  return {
    pixels,
    getImageData(sx: number, sy: number, sw: number, sh: number): PixelData {
      const data = new Uint8ClampedArray(4 * sw * sh)
      for (let y = 0; y < sh; y++)
        data.set(pixels.subarray(4 * ((sy + y) * w + sx), 4 * ((sy + y) * w + sx + sw)), 4 * y * sw)
      return { data, width: sw, height: sh }
    },
    putImageData(img: PixelData, dx: number, dy: number): void {
      for (let y = 0; y < img.height; y++)
        pixels.set(
          img.data.subarray(4 * y * img.width, 4 * (y + 1) * img.width),
          4 * ((dy + y) * w + dx),
        )
    },
    rgb(x: number, y: number): number[] {
      return Array.from(pixels.subarray(4 * (y * w + x), 4 * (y * w + x) + 3))
    },
  }
}

/** 一行 1 像素高的字形，覆盖依次为 `ks`（每像素三个通道相同）。 */
function strip(ks: number[]): CoverageGlyph {
  return {
    width: ks.length,
    height: 1,
    bearingX: 0,
    bearingY: 1,
    coverage: Uint8Array.from(ks.flatMap((k) => [k, k, k])),
  }
}

const ALL: { left: number; top: number; right: number; bottom: number } = {
  left: 0,
  top: 0,
  right: 100,
  bottom: 100,
}

/** 底色为 `fill` 时以 `color` 混合覆盖 1–6，返回各级的 R 分量。 */
function levels(contrast: number, color: string, fill: number): number[] {
  const c = canvas(8, 2, fill)
  const glyphs = [{ glyph: strip([1, 2, 3, 4, 5, 6]), x: 0, baseline: 1 }]
  paintGlyphRuns(c, [{ glyphs, color, clip: ALL }], { contrast })
  return [0, 1, 2, 3, 4, 5].map((x) => c.rgb(x, 0)[0]!)
}

describe('混合', () => {
  test('黑字白底与灰字白底的各级亮度与 WPS 相同（对比度 1200）', () => {
    expect(levels(1200, '#000000', 255)).toEqual([219, 182, 144, 102, 58, 0])
    expect(levels(1200, '#262626', 255).slice(0, 5)).toEqual([222, 190, 156, 119, 81])
  })

  test('对比度 1000 时各级亮度与 WPS 相同：解码与编码为线性', () => {
    expect(levels(1000, '#000000', 255)).toEqual([212, 170, 128, 85, 43, 0])
    expect(levels(1000, '#ffffff', 0)).toEqual([43, 85, 127, 170, 212, 255])
    expect(levels(1000, '#808080', 217)).toEqual([202, 187, 173, 158, 143, 128])
    expect(levels(1000, '#ffffff', 128)).toEqual([149, 170, 191, 213, 234, 255])
  })

  test('同一段文字的覆盖先相加再混合，不同段依次混合；裁剪矩形之外的像素不改动', () => {
    // 覆盖 3 在白色上为 144，再以覆盖 3 混合到 144 上。
    const EXPECT_TWICE = (() => {
      const d = (v: number) => Math.round(16383 * (v / 255) ** 1.2)
      const x = (d(0) * 127 + d(144) * 128) / 255
      return Math.round(255 * (x / 16383) ** (1 / 1.2))
    })()
    const c = canvas(8, 2)
    // 两个字形在 x = 1 处重叠：覆盖 3 + 3 = 6，混合后为文字颜色。
    paintGlyphRuns(
      c,
      [
        {
          glyphs: [
            { glyph: strip([3, 3]), x: 0, baseline: 1 },
            { glyph: strip([3, 3]), x: 1, baseline: 1 },
          ],
          color: '#000000',
          clip: { left: 0, top: 0, right: 2, bottom: 2 },
        },
        // 第二段文字在第一段混合之后再混合：覆盖 3 的灰色叠在已混合的像素上。
        { glyphs: [{ glyph: strip([3]), x: 0, baseline: 1 }], color: '#000000', clip: ALL },
      ],
      { contrast: 1200 },
    )
    expect([c.rgb(0, 0), c.rgb(1, 0), c.rgb(2, 0)]).toEqual([
      [EXPECT_TWICE, EXPECT_TWICE, EXPECT_TWICE],
      [0, 0, 0],
      [255, 255, 255],
    ])
  })
})
