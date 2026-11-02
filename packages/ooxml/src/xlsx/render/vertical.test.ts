/**
 * 覆盖：`text.ts` 的 `LineBox.baseline`（行高中的 `2·extra` 在文字上下平分）、一行有多个字体时取行高最大者
 * （行高相同取先出现的）、`lineBoxOf`（以换行符结束的行计入换行符所在段的主字体）；`cell-text.ts` 的纵向定位
 * （靠上、靠下、居中向零取整、多行文字高于行高时居中改为靠上）；`shapes.ts` 的 `screenText` 接入，
 * `../../drawingml/text/fonts.ts` 屏幕显示的纵向中心（按代码页分两组），以及 `../../drawingml/text/body.ts` 的
 * `hostBlock`（小数字号的行高与基线、百分比与固定行距的基线）与屏幕显示绘制（点阵、基线取整）。
 * 期望值取自 WPS 屏幕显示的逐格实测（构造文件经 `Range.CopyPicture` 取得的对照图）。
 */

import { describe, expect, test } from 'bun:test'
import { canvasFactory, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { layoutBody, paintBody } from '../../drawingml/text/body.ts'
import { FaceCache, type ScreenText, type SlideFont } from '../../drawingml/text/fonts.ts'
import type { Paragraph, RunStyle, TextBody } from '../../drawingml/text/model.ts'
import type { FontMetrics, PixelVerticalMetrics } from '../../font/index.ts'
import type { CellStyle, FontStyle, Workbook } from '../model.ts'
import { type CellBox, cellContent, layoutCell } from './cell-text.ts'
import { FontSet, type LoadedFace } from './fonts.ts'
import { shapeFaces } from './shapes.ts'
import { lineBox, lineBoxOf, makeRun, wrapRuns } from './text.ts'

type Vertical = (ppem: number) => { ascent: number; descent: number; externalLeading: number }

/** 测试字体：ASCII 半角、汉字全角（`cjk` 为假时没有汉字字形），纵向度量由 `vertical` 给出。 */
function face(family: string, cjk: boolean, vertical: Vertical): LoadedFace {
  const has = (cp: number) => (cp < 0x2e80 ? cp >= 32 && cp < 0x7f : cjk)
  const unit = (cp: number) => (cp >= 0x2e80 ? 1 : 0.5)
  const metrics: FontMetrics = {
    unitsPerEm: 1000,
    numGlyphs: 100,
    glyphId: (cp) => (has(cp) ? (cp >= 0x2e80 ? 2 : 1) : 0),
    advanceWidth: (cp) => unit(cp) * 1000,
    advance: (cp, size) => unit(cp) * size,
  }
  return {
    family,
    bold: false,
    italic: false,
    metrics,
    vertical: (ppem): PixelVerticalMetrics => {
      const v = vertical(ppem)
      return {
        ...v,
        height: v.ascent + v.descent,
        internalLeading: v.ascent + v.descent - ppem,
      }
    },
    pixelAdvance: () => null,
    bitmaps: null,
    clearType: null,
    text: {
      metrics,
      vertical: {
        unitsPerEm: 1000,
        hheaAscender: 860,
        hheaDescender: -140,
        hheaLineGap: 0,
        winAscent: 860,
        winDescent: 140,
        averageWidth: 500,
        eastAsianCodePage: cjk,
        superscriptSize: 650,
        superscriptOffset: 350,
        subscriptSize: 650,
        subscriptOffset: 150,
      },
    },
  }
}

/** 宋体在 ppem 19（14 磅）、21（16 磅）下的 GDI 度量：外部行距 3，`extra` 为 1。 */
const song = face('宋体', true, (ppem) =>
  ppem >= 18
    ? { ascent: ppem - 3, descent: 3, externalLeading: 3 }
    : { ascent: ppem - 2, descent: 2, externalLeading: 2 },
)
/** 西文字体：上升不超过 ppem、没有外部行距，`extra` 为 0；ppem 21 时行高 27，与宋体相同。 */
const latin = face('西文', false, (ppem) =>
  ppem === 21
    ? { ascent: 19, descent: 5, externalLeading: 0 }
    : { ascent: ppem - 1, descent: 3, externalLeading: 0 },
)
const fonts = new FontSet([latin, song], ['宋体'])

const font = (name: string, size: number): FontStyle => ({
  name,
  size,
  bold: false,
  italic: false,
  underline: 'none',
  strike: false,
  color: null,
  vertAlign: 'baseline',
})

const workbook = { date1904: false, palette: [] } as unknown as Workbook

function baselines(
  text: string,
  f: FontStyle,
  vertical: CellStyle['alignment']['vertical'],
  height: number,
  wrap = false,
): number[] {
  const b: CellBox = {
    left: 0,
    right: 200,
    top: 0,
    bottom: height,
    col: 0,
    lastCol: 0,
    merged: false,
    colLeft: () => 0,
    colRight: () => 200,
    spillable: () => false,
  }
  const out = layoutCell(
    {
      content: cellContent({ type: 'string', value: text, runs: null }, 'General', workbook),
      alignment: {
        horizontal: 'left',
        vertical,
        wrap,
        shrink: false,
        indent: 0,
        rotation: 0,
      },
      font: f,
      colorOverride: null,
      fonts,
      indentUnit: 24,
    },
    b,
  )
  return out ? [...new Set(out.fragments.map((x) => x.y))] : []
}

describe('单元格文字的纵向位置', () => {
  test('行高中的 2·extra 在文字上下平分：宋体 14 磅靠下时基线在下网格线之上 3 + 1 像素', () => {
    const box = lineBox(song, 14)
    expect(box).toMatchObject({ height: 25, descent: 3, baseline: 21 })
    const f = font('宋体', 14)
    expect(baselines('国中', f, 'bottom', 25)).toEqual([21])
    expect(baselines('国中', f, 'bottom', 30)).toEqual([26])
    expect(baselines('国中', f, 'top', 30)).toEqual([21])
  })

  test('居中时偏移向零取整：文字高于行高的单行仍居中', () => {
    const f = font('宋体', 14)
    expect(baselines('国中', f, 'center', 26)).toEqual([21])
    expect(baselines('国中', f, 'center', 24)).toEqual([21])
    expect(baselines('国中', f, 'center', 23)).toEqual([20])
    expect(baselines('国中', f, 'center', 22)).toEqual([20])
  })

  test('多行文字高于行高时居中改为靠上，靠下仍按行底定位', () => {
    const f = font('宋体', 14)
    expect(baselines('国\n中', f, 'center', 46, true)).toEqual([21, 46])
    expect(baselines('国\n中', f, 'center', 54, true)).toEqual([23, 48])
    expect(baselines('国\n中', f, 'bottom', 46, true)).toEqual([17, 42])
  })

  test('西文字体单元格按实际使用的字体定位：行高相同时取先出现的字体，行高较大的字体优先', () => {
    // ppem 21：西文字体与宋体行高都是 27，基线距行顶分别为 22 与 23。
    const f = font('西文', 16)
    expect(baselines('Hg', f, 'top', 30)).toEqual([22])
    expect(baselines('国中', f, 'top', 30)).toEqual([23])
    expect(baselines('国H', f, 'top', 30)).toEqual([23])
    expect(baselines('H国', f, 'top', 30)).toEqual([22])
    // ppem 19：宋体行高 25 大于西文字体的 23，混排时一律按宋体。
    const g = font('西文', 14)
    expect(baselines('H国', g, 'bottom', 30)).toEqual([26])
  })
})

describe('换行符计入行高', () => {
  const f = font('西文', 9)
  // ppem 12：西文字体行高 16，宋体行高 15。
  const heights = (text: string, width: number) =>
    wrapRuns([makeRun(text, f, fonts)], width).map((l) => lineBoxOf(l).height)

  test('以换行符结束的行计入单元格字体，自动断行产生的行不计入', () => {
    expect(heights('国\n国', 200)).toEqual([16, 15])
    expect(heights('国国', 12)).toEqual([15, 15])
    expect(heights('国\n国\n国', 200)).toEqual([16, 16, 15])
  })

  test('两个换行符之间的空行取单元格字体的行高', () => {
    expect(heights('国\n\n国', 200)).toEqual([16, 16, 15])
  })
})

const style: RunStyle = {
  latin: '宋体',
  ea: '宋体',
  cs: '',
  sym: '',
  size: 10.5,
  bold: false,
  italic: false,
  underline: 'none',
  strike: 'noStrike',
  baseline: 0,
  caps: 'none',
  spacing: 0,
  kern: 0,
  fill: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
  highlight: null,
  outline: null,
  effects: [],
  lang: 'zh-CN',
}

function body(size: number, lineSpacing: Paragraph['lineSpacing'], count = 2): TextBody {
  const s = { ...style, size }
  const p: Paragraph = {
    level: 0,
    align: 'l',
    marginLeft: 0,
    marginRight: 0,
    indent: 0,
    rtl: false,
    defaultTabSize: 914400,
    tabs: [],
    lineSpacing,
    spaceBefore: { unit: 'points', value: 0 },
    spaceAfter: { unit: 'points', value: 0 },
    eaLineBreak: true,
    latinLineBreak: false,
    hangingPunctuation: false,
    fontAlign: 'auto',
    bullet: { kind: 'none' },
    runs: [{ kind: 'text', text: '国中', style: s, link: null }],
    end: s,
  }
  return {
    body: {
      rotation: 0,
      vertical: 'horz',
      wrap: true,
      insetLeft: 0,
      insetTop: 0,
      insetRight: 0,
      insetBottom: 0,
      anchor: 't',
      anchorCenter: false,
      columns: 1,
      columnSpacing: 0,
      rtlColumns: false,
      upright: false,
      autofit: { kind: 'none' },
    },
    paragraphs: Array.from({ length: count }, () => p),
  }
}

const slideFont: SlideFont = { face: song.text, family: '宋体', bold: false, italic: false }
const source = { face: () => slideFont, fallback: slideFont }
const none: ScreenText = { bitmap: () => null }
const single = { unit: 'percent', value: 1 } as const

describe('形状文字的屏幕显示', () => {
  test('工作表的形状文字按屏幕显示排版，演示文稿不使用', () => {
    expect(
      shapeFaces({ fontNames: ['宋体'], minorFont: null } as unknown as Workbook, fonts)?.screen,
    ).not.toBeNull()
    expect(new FaceCache(source).screen).toBeNull()
  })

  test('小数字号的行高按整数部分计算，基线与行高中线的距离按实际字号', () => {
    const first = (faces: FaceCache, size: number) =>
      layoutBody(body(size, single), 200, { faces, slideNumber: null }).paragraphs
    const pitch = (faces: FaceCache, size: number) => {
      const ps = first(faces, size)
      return ps[1]!.y - ps[0]!.y
    }
    const screen = new FaceCache(source, 1.296, none)
    expect(pitch(screen, 10.5)).toBeCloseTo(1.296 * 10, 6)
    expect(pitch(screen, 10)).toBeCloseTo(1.296 * 10, 6)
    expect(pitch(new FaceCache(source, 1.296), 10.5)).toBeCloseTo(1.296 * 10.5, 6)
    const offset = (size: number) => {
      const line = first(screen, size)[0]!.block.lines[0]!
      return line.baseline - line.height / 2
    }
    expect(offset(10.5)).toBeCloseTo(offset(10) * 1.05, 6)
  })

  test('纵向中心按代码页分两组，屏幕显示与演示文稿相同', () => {
    const western: SlideFont = { face: latin.text, family: '西文', bold: false, italic: false }
    const westernSource = { face: () => western, fallback: western }
    const baseline = (faces: FaceCache) =>
      layoutBody(body(12, single, 1), 200, { faces, slideNumber: null }).paragraphs[0]!.block
        .lines[0]!.baseline
    const shift = (screen: ScreenText | null) =>
      baseline(new FaceCache(westernSource, 1.296, screen)) -
      baseline(new FaceCache(source, 1.296, screen))
    // 两种测试字体的 `winAscent`、`winDescent` 相同，只有 `eastAsianCodePage` 不同。
    expect(shift(none)).toBeCloseTo((0.6012 - 0.5825) * 12, 6)
    expect(shift(null)).toBeCloseTo((0.6012 - 0.5825) * 12, 6)
  })

  test('百分比与固定行距：行高与单倍行高之差的 0.76 加在文字上方', () => {
    const first = (faces: FaceCache, spacing: Paragraph['lineSpacing']) =>
      layoutBody(body(12, spacing, 1), 200, { faces, slideNumber: null }).paragraphs[0]!.block
        .lines[0]!
    const screen = new FaceCache(source, 1.296, none)
    const one = first(screen, single)
    const wide = first(screen, { unit: 'percent', value: 1.5 })
    expect(wide.height).toBeCloseTo(one.height * 1.5, 6)
    expect(wide.baseline - one.baseline).toBeCloseTo(0.76 * (wide.height - one.height), 6)
    const fixed = first(screen, { unit: 'points', value: 30 })
    expect(fixed.height).toBeCloseTo(30, 6)
    expect(fixed.baseline - one.baseline).toBeCloseTo(0.76 * (30 - one.height), 6)
    const slide = new FaceCache(source, 1.296)
    const plainOne = first(slide, single)
    const plainWide = first(slide, { unit: 'percent', value: 1.5 })
    expect(plainWide.baseline - plainOne.baseline).toBeCloseTo((plainOne.height * 0.5) / 1.2, 6)
  })

  test('有点阵的字形以点阵画在取整后的设备坐标上，基线取整到设备像素', () => {
    const glyph = {
      width: 2,
      height: 2,
      bearingX: 0,
      bearingY: 2,
      advance: 2,
      pixels: new Uint8Array([1, 1, 1, 1]),
    }
    const bitmapFor: ScreenText = {
      bitmap: (_f, cp) => (cp === 0x56fd ? { glyph, ascent: 14, descent: 2 } : null),
    }
    const draw = (faces: FaceCache) => {
      const ctx = new RecordingContext()
      const layout = layoutBody(body(12, single, 1), 200, { faces, slideNumber: null })
      const matrix = { a: 4 / 3, b: 0, c: 0, d: 4 / 3, e: 10.3, f: 20.4 }
      paintBody(
        ctx,
        layout,
        { matrix, width: 150, height: 100, scale: 1 },
        faces,
        { image: () => null, createCanvas: canvasFactory().create },
        { width: 400, height: 400 },
        [],
      )
      return ctx
    }
    const screen = draw(new FaceCache(source, 1.296, bitmapFor))
    const rects = screen.named('fillRect')
    expect(rects.length).toBe(2)
    for (const r of rects) {
      expect(r.matrix).toMatchObject({ a: 1, d: 1, e: 0, f: 0 })
      expect((r.args as number[]).every((v) => Number.isInteger(v))).toBe(true)
    }
    const text = screen.named('fillText')
    expect(text.map((c) => c.args[0])).toEqual(['中'])
    const y = text[0]!.args[2] as number
    expect(Number.isInteger(y * (4 / 3) + 20.4)).toBe(true)
    const plain = draw(new FaceCache(source, 1.296))
    expect(plain.named('fillText').map((c) => c.args[0])).toEqual(['国', '中'])
    expect(plain.named('fillRect')).toHaveLength(0)
  })
})
