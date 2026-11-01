/**
 * 文字排版。覆盖 `classify.ts`（字体选择与字符类别）、`breaking.ts`（断点与禁则）、
 * `line-height.ts`（单倍行高、上下沿、行距规则、网格与基线）、`layout.ts`（断行、悬挂、中西文间距、对齐、制表符、行高与片段，
 * 上下标、字符间距、基线提升、`wordWrap` 关闭与单双字节宽度协调）、`punctuation.ts`（相邻标点压缩与压缩标点），
 * 以及 `../font/vertical.ts`（`hhea` 与 `OS/2` 纵向度量、上下标字号）。
 *
 * 读取本机 Windows 字体目录中的真实文件：其他平台跳过（`skipIf`），Windows 上文件不存在时读取抛出，用例失败。
 * 期望的断行位置、坐标与行高取自 WPS 只读打开同样内容的文档后逐字取得的结果（版心 415.3 磅，宋体 10.5 磅），
 * 不由本模块计算。
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFaces, readMetrics, readVerticalMetrics } from '../font/index.ts'
import {
  canBreakBetween,
  DEFAULT_NO_LINE_BREAK_AFTER,
  DEFAULT_NO_LINE_BREAK_BEFORE,
  DEFAULT_SLOT_CONTEXT,
  faceExtent,
  fontSlot,
  isEastAsian,
  isIdeographic,
  layoutParagraph,
  lineBox,
  PARAGRAPH_DEFAULTS,
  type ParagraphStyle,
  type RunFonts,
  singleLineHeight,
  type TextBlock,
  type TextFace,
  type TextRun,
} from './index.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const cache = new Map<string, TextFace>()
function face(file: string, index = 0): TextFace {
  const key = `${file}#${index}`
  let f = cache.get(key)
  if (!f) {
    const bytes = new Uint8Array(readFileSync(join(FONTS, file)))
    const sf = readFaces(bytes)[index]!
    f = { metrics: readMetrics(bytes, sf), vertical: readVerticalMetrics(bytes, sf) }
    cache.set(key, f)
  }
  return f
}

const hint = { ...DEFAULT_SLOT_CONTEXT, eastAsiaHint: true }

describe('字体选择', () => {
  test('基本拉丁用 ascii，其余拉丁用 hAnsi，汉字与全角标点用 eastAsia', () => {
    const d = DEFAULT_SLOT_CONTEXT
    expect(
      ['A', ' ', '1', 'é', 'ǎ', '“', '—', '…', 'α'].map((c) => fontSlot(c.codePointAt(0)!, d)),
    ).toEqual(['ascii', 'ascii', 'ascii', 'hAnsi', 'hAnsi', 'hAnsi', 'hAnsi', 'hAnsi', 'hAnsi'])
    expect(
      ['汉', '，', '（', 'あ', '한', '㎡', '①'].map((c) => fontSlot(c.codePointAt(0)!, d)),
    ).toEqual(['eastAsia', 'eastAsia', 'eastAsia', 'eastAsia', 'eastAsia', 'eastAsia', 'hAnsi'])
  })

  test('东亚提示使通用标点、希腊字母与 Latin-1 中的指定符号改用 eastAsia；拼音字母仍用 hAnsi', () => {
    for (const c of '“”‘’…—·°×÷αβ①') expect(fontSlot(c.codePointAt(0)!, hint)).toBe('eastAsia')
    for (const c of 'éüàǎǐ') expect(fontSlot(c.codePointAt(0)!, hint)).toBe('hAnsi')
  })

  test('Latin Extended-A 在提示为东亚且东亚字体字符集为中文时用 eastAsia，Extended-B 不受影响', () => {
    const ctx = { ...hint, chineseCharset: true }
    expect(fontSlot('ā'.codePointAt(0)!, ctx)).toBe('eastAsia')
    expect(fontSlot('ā'.codePointAt(0)!, hint)).toBe('hAnsi')
    expect(fontSlot('ā'.codePointAt(0)!, { ...DEFAULT_SLOT_CONTEXT, chineseCharset: true })).toBe(
      'hAnsi',
    )
    expect(fontSlot('ǎ'.codePointAt(0)!, ctx)).toBe('hAnsi')
  })

  test('希伯来文与阿拉伯文用 ascii；complexScript 使全部字符用 cs；补充平面用 eastAsia；表外码位用 hAnsi', () => {
    expect(fontSlot(0x05d0, DEFAULT_SLOT_CONTEXT)).toBe('ascii')
    expect(fontSlot(0x0627, DEFAULT_SLOT_CONTEXT)).toBe('ascii')
    expect(fontSlot(0xfb1d, DEFAULT_SLOT_CONTEXT)).toBe('ascii')
    const cs = { ...DEFAULT_SLOT_CONTEXT, complexScript: true }
    expect(fontSlot(0x41, cs)).toBe('cs')
    expect(fontSlot(0x6c49, cs)).toBe('cs')
    expect(fontSlot(0x20000, DEFAULT_SLOT_CONTEXT)).toBe('eastAsia')
    expect(fontSlot(0x0e01, DEFAULT_SLOT_CONTEXT)).toBe('hAnsi')
    expect(fontSlot(0x9fb0, DEFAULT_SLOT_CONTEXT)).toBe('hAnsi')
  })

  test('东亚类别含 CJK 标点，中西文间距的汉字类别不含', () => {
    expect(isEastAsian('，'.codePointAt(0)!)).toBe(true)
    expect(isIdeographic('，'.codePointAt(0)!)).toBe(false)
    expect(isIdeographic('汉'.codePointAt(0)!)).toBe(true)
    expect(isEastAsian('“'.codePointAt(0)!)).toBe(false)
  })
})

describe('断点', () => {
  const rules = {
    kinsoku: true,
    wordWrap: true,
    noLineBreakBefore: DEFAULT_NO_LINE_BREAK_BEFORE,
    noLineBreakAfter: DEFAULT_NO_LINE_BREAK_AFTER,
  }
  const can = (a: string, b: string, r = rules) =>
    canBreakBetween(a.codePointAt(0)!, b.codePointAt(0)!, r)

  test('汉字之间、汉字与西文之间可断；西文单词内部不断，wordWrap 关闭时可断', () => {
    expect(can('汉', '字')).toBe(true)
    expect(can('汉', 'A')).toBe(true)
    expect(can('A', '汉')).toBe(true)
    expect(can('a', 'b')).toBe(false)
    expect(can('a', 'b', { ...rules, wordWrap: false })).toBe(true)
  })

  test('空格之后可断、之前不断；制表符两侧可断；组合附加符号之前不断', () => {
    expect(can(' ', 'a')).toBe(true)
    expect(can('a', ' ')).toBe(false)
    expect(can('a', '\t')).toBe(true)
    expect(can('\t', 'a')).toBe(true)
    expect(can('e', '\u0301')).toBe(false)
  })

  test('行首禁则字符之前、行尾禁则字符之后不断；禁则关闭时可断', () => {
    for (const c of '，。？！%℃…') expect(can('汉', c)).toBe(false)
    for (const c of '（“《') expect(can(c, '汉')).toBe(false)
    expect(can('汉', '々')).toBe(true)
    expect(can('汉', '，', { ...rules, kinsoku: false })).toBe(true)
  })

  test('连字符与破折号之后可断、之前不断，两个长破折号之间可断', () => {
    expect(can('-', 'k')).toBe(true)
    expect(can('l', '-')).toBe(false)
    expect(can('汉', '—')).toBe(false)
    expect(can('—', '汉')).toBe(true)
    expect(can('—', '—')).toBe(true)
  })
})

describe.skipIf(process.platform !== 'win32')('本机字体', () => {
  let song: TextFace
  let times: TextFace
  let arial: TextFace
  let yahei: TextFace
  let SONG: RunFonts
  beforeAll(() => {
    song = face('simsun.ttc')
    times = face('times.ttf')
    arial = face('arial.ttf')
    yahei = face('msyh.ttc')
    SONG = { ascii: times, hAnsi: times, eastAsia: song, cs: times }
  })

  const style = (over: Partial<ParagraphStyle> = {}): ParagraphStyle => ({
    ...PARAGRAPH_DEFAULTS,
    width: 415.3,
    align: 'both',
    defaultTabStop: 21,
    noLineBreakBefore: DEFAULT_NO_LINE_BREAK_BEFORE,
    noLineBreakAfter: DEFAULT_NO_LINE_BREAK_AFTER,
    fallback: song,
    mark: { face: times, size: 10.5 },
    ...over,
  })
  const run = (text: string, over: Partial<TextRun> = {}): TextRun => ({
    text,
    fonts: SONG,
    size: 10.5,
    ...over,
  })
  /** 各行的字符数（UTF-16 码元）。 */
  const counts = (b: TextBlock) => b.lines.map((l) => l.end - l.start)
  const H = '汉'

  describe('纵向度量', () => {
    test('宋体与 Times New Roman 的 hhea、OS/2 字段', () => {
      expect(song.vertical).toEqual({
        unitsPerEm: 256,
        hheaAscender: 220,
        hheaDescender: -36,
        hheaLineGap: 36,
        winAscent: 220,
        winDescent: 36,
        averageWidth: 128,
        eastAsianCodePage: true,
        superscriptSize: 128,
        superscriptOffset: 128,
        subscriptSize: 128,
        subscriptOffset: 16,
      })
      expect(times.vertical).toMatchObject({
        winAscent: 1825,
        winDescent: 443,
        hheaLineGap: 87,
        eastAsianCodePage: false,
      })
    })
  })

  describe('行高', () => {
    test('中日韩字体为 Windows 上下沿之和乘 1.3 向下取整，其余字体加外部行距', () => {
      // WPS：宋体 10.5 磅行距 13.6/13.65 交替，16 磅 20.75；Times New Roman 10.5 磅 12.05；微软雅黑 10.5 磅 18.0。
      expect(singleLineHeight(song.vertical, 10.5)).toBeCloseTo((332 * 10.5) / 256, 10)
      expect(singleLineHeight(song.vertical, 16)).toBeCloseTo(20.75, 10)
      expect(singleLineHeight(times.vertical, 10.5)).toBeCloseTo((2355 * 10.5) / 2048, 10)
      expect(singleLineHeight(arial.vertical, 10.5)).toBeCloseTo((2355 * 10.5) / 2048, 10)
      expect(singleLineHeight(yahei.vertical, 10.5)).toBeCloseTo((3513 * 10.5) / 2048, 10)
    })

    test('中日韩字体的增量上下各半，外部行距在上沿之上', () => {
      const e = faceExtent(song.vertical, 10.5)
      expect(e.ascent).toBeCloseTo(((220 + 38) * 10.5) / 256, 10)
      expect(e.descent).toBeCloseTo(((36 + 38) * 10.5) / 256, 10)
      const t = faceExtent(times.vertical, 10.5)
      expect(t.ascent).toBeCloseTo(((1825 + 87) * 10.5) / 2048, 10)
      expect(t.descent).toBeCloseTo((443 * 10.5) / 2048, 10)
    })

    test('多倍：增加部分在文字下方；比例、DrawingML 固定与最小值：增加部分在文字上方；固定：基线在 80% 处', () => {
      const e = [faceExtent(song.vertical, 10.5)]
      const single = e[0]!.single
      const multi = lineBox(e, { rule: 'multiple', value: 1.5 }, null)
      expect(multi.height).toBeCloseTo(single * 1.5, 10)
      expect(multi.baseline).toBeCloseTo(e[0]!.ascent, 10)
      expect(lineBox(e, { rule: 'atLeast', value: 12 }, null).height).toBeCloseTo(single, 10)
      const least = lineBox(e, { rule: 'atLeast', value: 30 }, null)
      expect(least.height).toBe(30)
      expect(least.baseline).toBeCloseTo(30 - e[0]!.descent, 10)
      expect(lineBox(e, { rule: 'exact', value: 9 }, null)).toEqual({ height: 9, baseline: 7.2 })
      const proportional = lineBox(e, { rule: 'proportional', value: 1.5 }, 15.6)
      expect(proportional.height).toBeCloseTo(multi.height, 10)
      expect(proportional.baseline).toBeCloseTo(multi.baseline + multi.height - single, 10)
      // 两种字体的上下沿组合大于各自的单倍行高时，比例行距仍取最大单倍行高。
      const mixed = [faceExtent(song.vertical, 10.5), faceExtent(times.vertical, 10.5)]
      const largest = Math.max(mixed[0]!.single, mixed[1]!.single)
      expect(lineBox(mixed, { rule: 'proportional', value: 1 }, null).height).toBeCloseTo(
        largest,
        10,
      )
      const fixed = lineBox(e, { rule: 'fixed', value: 30 }, 15.6)
      expect(fixed.height).toBe(30)
      expect(fixed.baseline).toBeCloseTo(e[0]!.ascent + 30 - single, 10)
    })

    test('行网格：取整为网格行距的整数倍并与倍数 × 网格行距取大，文字上下居中；固定行高不受网格影响', () => {
      // WPS（网格行距 15.6）：宋体 10.5 磅单倍 15.6、1.5 倍 23.4；宋体 16 磅与微软雅黑 10.5 磅单倍 31.2。
      const song105 = [faceExtent(song.vertical, 10.5)]
      expect(lineBox(song105, { rule: 'multiple', value: 1 }, 15.6).height).toBeCloseTo(15.6, 10)
      expect(lineBox(song105, { rule: 'multiple', value: 1.5 }, 15.6).height).toBeCloseTo(23.4, 10)
      expect(
        lineBox([faceExtent(song.vertical, 16)], { rule: 'multiple', value: 1 }, 15.6).height,
      ).toBeCloseTo(31.2, 10)
      const yahei105 = [faceExtent(yahei.vertical, 10.5)]
      expect(lineBox(yahei105, { rule: 'multiple', value: 1.5 }, 15.6).height).toBeCloseTo(31.2, 10)
      const box = lineBox(song105, { rule: 'multiple', value: 1 }, 15.6)
      expect(box.baseline).toBeCloseTo(song105[0]!.ascent + (15.6 - song105[0]!.single) / 2, 10)
      expect(lineBox(song105, { rule: 'exact', value: 20 }, 15.6).height).toBe(20)
      expect(lineBox(song105, { rule: 'atLeast', value: 12 }, 15.6).height).toBeCloseTo(15.6, 10)
    })

    test('上沿与下沿分别取行内最大值：宋体与等线同行时行高大于两者各自的单倍行高', () => {
      // WPS：等线与楷体 10.5 磅同行，行距 14.65；等线 15 磅与楷体 15 磅同行 20.95。
      const deng = face('Deng.ttf')
      const mixed = lineBox(
        [faceExtent(deng.vertical, 10.5), faceExtent(song.vertical, 10.5)],
        { rule: 'multiple', value: 1 },
        null,
      )
      expect(mixed.height).toBeCloseTo(14.66, 2)
      const big = lineBox(
        [faceExtent(deng.vertical, 15), faceExtent(song.vertical, 15)],
        { rule: 'multiple', value: 1 },
        null,
      )
      expect(big.height).toBeCloseTo(20.94, 2)
      // 多倍行距的增量按行内最大的单倍行高计：WPS 中黑体与等线 14 磅、1.5 倍为 29.05。
      const hei = face('simhei.ttf')
      const multi = lineBox(
        [faceExtent(hei.vertical, 14), faceExtent(deng.vertical, 14)],
        { rule: 'multiple', value: 1.5 },
        null,
      )
      expect(multi.height).toBeCloseTo(29.03, 2)
    })

    test('一行取行内各字体单倍行高的最大值；段落标记只决定空行的行高', () => {
      const b = layoutParagraph(
        [run(H.repeat(20)), run(' Times ', { size: 16 }), run(H.repeat(60))],
        style({ mark: { face: song, size: 20 } }),
      )
      expect(b.lines[0]!.height).toBeCloseTo((2355 * 16) / 2048, 6)
      expect(b.lines[1]!.height).toBeCloseTo((332 * 10.5) / 256, 6)
      const empty = layoutParagraph([], style({ mark: { face: song, size: 20 } }))
      expect(empty.lines).toHaveLength(1)
      expect(empty.height).toBeCloseTo((332 * 20) / 256, 6)
    })

    test('各行顶部依次累加，片段的基线与所在行一致', () => {
      const b = layoutParagraph(
        [run(H.repeat(80))],
        style({ lineSpacing: { rule: 'exact', value: 20 } }),
      )
      expect(b.lines.map((l) => l.top)).toEqual([0, 20, 40])
      expect(b.lines[1]!.baseline).toBeCloseTo(36, 10)
      expect(b.lines[1]!.fragments[0]!.baseline).toBe(b.lines[1]!.baseline)
      expect(b.height).toBe(60)
    })
  })

  describe('断行与禁则', () => {
    test('39 个汉字排满一行，余量平均分配到 38 个字间，末行不分配', () => {
      const b = layoutParagraph([run(H.repeat(60))], style())
      expect(counts(b)).toEqual([39, 21])
      const adv = b.lines[0]!.fragments[0]!.advances
      expect(adv[0]).toBeCloseTo(10.5 + (415.3 - 409.5) / 38, 9)
      expect(adv[38]).toBeCloseTo(10.5, 9)
      expect(b.lines[0]!.width).toBeCloseTo(415.3, 9)
      expect(b.lines[1]!.fragments[0]!.advances.every((a) => a === 10.5)).toBe(true)
    })

    test('超出行宽的逗号悬挂在行尾，该行不分配余量；问号不悬挂，连同前一字移到下一行', () => {
      const comma = layoutParagraph([run(`${H.repeat(39)}，${H.repeat(20)}`)], style())
      expect(counts(comma)).toEqual([40, 20])
      const f = comma.lines[0]!.fragments[0]!
      expect(f.advances[38]).toBe(10.5)
      expect(f.x + f.advances.slice(0, 39).reduce((s, a) => s + a, 0)).toBeCloseTo(409.5, 9)
      expect(counts(layoutParagraph([run(`${H.repeat(39)}？${H.repeat(20)}`)], style()))).toEqual([
        38, 22,
      ])
    })

    test('悬挂后下一字仍不得位于行首时不悬挂；悬挂关闭时回退', () => {
      expect(counts(layoutParagraph([run(`${H.repeat(39)}。”${H.repeat(20)}`)], style()))).toEqual([
        38, 23,
      ])
      expect(counts(layoutParagraph([run(`${H.repeat(38)}！）${H.repeat(20)}`)], style()))).toEqual(
        [40, 20],
      )
      const off = layoutParagraph(
        [run(`${H.repeat(39)}，${H.repeat(20)}`)],
        style({ overflowPunct: false }),
      )
      expect(counts(off)).toEqual([38, 22])
    })

    test('行尾禁则字符移到下一行；省略号与破折号保持相连', () => {
      expect(counts(layoutParagraph([run(`${H.repeat(38)}（${H.repeat(20)}`)], style()))).toEqual([
        38, 21,
      ])
      expect(counts(layoutParagraph([run(`${H.repeat(38)}……${H.repeat(20)}`)], style()))).toEqual([
        37, 23,
      ])
      expect(counts(layoutParagraph([run(`${H.repeat(39)}——${H.repeat(20)}`)], style()))).toEqual([
        38, 23,
      ])
      expect(counts(layoutParagraph([run(`${H.repeat(38)}——${H.repeat(20)}`)], style()))).toEqual([
        39, 21,
      ])
    })

    test('行尾空格越过行宽且不计入内容宽度；超出行宽的西文单词整体移到下一行', () => {
      const b = layoutParagraph([run(`${H.repeat(37)} abc ${H.repeat(20)}`)], style())
      expect(counts(b)).toEqual([42, 20])
      const b2 = layoutParagraph([run(`${H.repeat(38)} abc ${H.repeat(20)}`)], style())
      expect(counts(b2)).toEqual([39, 24])
      expect(b2.lines[0]!.width).toBeCloseTo(415.3, 9)
    })

    test('超过一行的单词在超出行宽处断开；wordWrap 关闭时西文按字符断行', () => {
      const word = 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(3)
      const b = layoutParagraph([run(`${word} end`, { size: 12 })], style({ align: 'left' }))
      expect(b.lines.length).toBeGreaterThan(1)
      for (const l of b.lines.slice(0, -1)) expect(l.width).toBeLessThanOrEqual(415.3 + 1e-6)
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(4)
      const loose = layoutParagraph(
        [run(text, { size: 12 })],
        style({ align: 'left', wordWrap: false }),
      )
      const firstEnd = loose.lines[0]!.end
      expect(text[firstEnd - 1]).not.toBe(' ')
    })
  })

  describe('中西文间距', () => {
    const xs = (b: TextBlock) => {
      const out: number[] = []
      for (const l of b.lines)
        for (const f of l.fragments) {
          let x = f.x
          for (const a of f.advances) {
            out.push(Math.round(x * 100) / 100)
            x += a
          }
        }
      return out
    }

    test('汉字后接西文加东亚字体平均字宽的一半，西文后接汉字加西文字体平均字宽的一半', () => {
      // WPS 逐字横坐标减去版心左边 90 磅；WPS 的坐标按 0.05 磅舍入。
      const wps = [0, 10.5, 23.6, 30.0, 35.25, 40.5, 43.45, 46.35, 50.45, 57.8, 68.3]
      const ours = xs(layoutParagraph([run('中文English中文')], style({ align: 'left' })))
      expect(ours).toHaveLength(wps.length)
      for (const [i, x] of ours.entries()) expect(Math.abs(x - wps[i]!)).toBeLessThanOrEqual(0.05)
    })

    test('全角标点、括号、希腊字母与汉字相邻时不加间距；开关关闭时不加', () => {
      const plain = (t: string, over: Partial<ParagraphStyle> = {}) =>
        layoutParagraph([run(t)], style({ align: 'left', ...over })).lines[0]!.width
      expect(plain('汉字，abc')).toBeCloseTo(
        31.5 + times.metrics.advance(0x61, 10.5) * 2 + times.metrics.advance(0x62, 10.5),
        6,
      )
      expect(plain('年θ为')).toBeCloseTo(21 + times.metrics.advance(0x3b8, 10.5), 6)
      expect(plain('共24周', { autoSpaceDN: false })).toBeCloseTo(31.5, 6)
      expect(plain('共24周')).toBeCloseTo(
        31.5 + 2.625 + (times.vertical.averageWidth * 10.5) / 2048 / 2,
        6,
      )
    })
  })

  describe('对齐', () => {
    test('西文行的余量只分配给空格', () => {
      const text =
        'The quick brown fox jumps over the lazy dog while the committee reviews internationalization requirements'
      const b = layoutParagraph([run(text, { size: 12 })], style())
      const f = b.lines[0]!.fragments[0]!
      const line = text.slice(0, b.lines[0]!.end)
      const extra = [...line].map(
        (c, i) => f.advances[i]! - times.metrics.advance(c.codePointAt(0)!, 12),
      )
      const spaces = [...line.trimEnd()].map((c, i) => (c === ' ' ? i : -1)).filter((i) => i >= 0)
      for (let i = 0; i < line.trimEnd().length - 1; i++) {
        if (spaces.includes(i)) expect(extra[i]).toBeGreaterThan(1)
        else expect(extra[i]).toBeCloseTo(0, 9)
      }
    })

    test('混排行：汉字前后与空格之后的字间参与分配，西文字母之间不参与', () => {
      const b = layoutParagraph([run(`${H.repeat(36)} abc ${H.repeat(20)}`)], style())
      const adv = b.lines[0]!.fragments.flatMap((f) => f.advances)
      const share = adv[0]! - 10.5
      expect(share).toBeCloseTo((415.3 - (378 + 2 * 2.625 + 14.574 + 10.5)) / 38, 2)
      expect(adv[37]! - times.metrics.advance(0x61, 10.5)).toBeCloseTo(0, 9)
      expect(adv[36]! - 2.625).toBeCloseTo(share, 9)
    })

    test('分散对齐分配到全部字间，含末行；只有一个字时居中', () => {
      const b = layoutParagraph([run(H.repeat(41))], style({ align: 'distribute' }))
      expect(counts(b)).toEqual([39, 2])
      expect(b.lines[1]!.width).toBeCloseTo(415.3, 9)
      const one = layoutParagraph([run(H.repeat(40))], style({ align: 'distribute' }))
      expect(one.lines[1]!.left).toBeCloseTo((415.3 - 10.5) / 2, 9)
    })

    test('居中与右对齐按内容宽度偏移；justifiedPunctuation 时悬挂只用于两端对齐与分散对齐；悬挂标点使内容超宽时不向左偏移', () => {
      expect(
        layoutParagraph([run(H.repeat(34))], style({ align: 'center' })).lines[0]!.left,
      ).toBeCloseTo((415.3 - 357) / 2, 9)
      expect(
        layoutParagraph([run(H.repeat(34))], style({ align: 'right' })).lines[0]!.left,
      ).toBeCloseTo(415.3 - 357, 9)
      // WPS：兼容模式 15 时居中与右对齐的段落中越过行宽的逗号连同前一字移到下一行，兼容模式 14 时悬挂。
      const text = `${H.repeat(39)}，${H.repeat(5)}`
      const centered = layoutParagraph(
        [run(text)],
        style({ align: 'center', justifiedPunctuation: true }),
      )
      expect(counts(centered)).toEqual([38, 7])
      expect(centered.lines[0]!.left).toBeCloseTo((415.3 - 38 * 10.5) / 2, 9)
      const hung = layoutParagraph([run(text)], style({ align: 'center' }))
      expect(counts(hung)).toEqual([40, 5])
      expect(hung.lines[0]!.left).toBe(0)
      const spread = layoutParagraph(
        [run(text)],
        style({ align: 'distribute', justifiedPunctuation: true }),
      )
      expect(counts(spread)).toEqual([40, 5])
    })

    test('以强制换行结束的行参与两端对齐，expandLineBreak 关闭时不参与；段末强制换行之后有一个空行', () => {
      const text = `${H.repeat(30)}\n${H.repeat(50)}`
      const on = layoutParagraph([run(text)], style())
      expect(counts(on)).toEqual([31, 39, 11])
      expect(on.lines[0]!.forcedBreak).toBe(true)
      expect(on.lines[0]!.width).toBeCloseTo(415.3, 9)
      expect(
        layoutParagraph([run(text)], style({ expandLineBreak: false })).lines[0]!.width,
      ).toBeCloseTo(315, 9)
      const trailing = layoutParagraph(
        [run(`${H.repeat(5)}\n`)],
        style({ mark: { face: song, size: 20 } }),
      )
      expect(trailing.lines).toHaveLength(2)
      expect(trailing.lines[1]!.height).toBeCloseTo((332 * 20) / 256, 6)
    })
  })

  describe('制表符', () => {
    const tabX = (b: TextBlock) => b.lines[0]!.fragments.map((f) => Math.round(f.x * 100) / 100)

    test('默认制表位；恰在制表位上时跳到下一个', () => {
      // WPS：甲 90、乙 111、丙 132、戊 174（默认制表位 21 磅）。
      expect(tabX(layoutParagraph([run('甲\t乙\t丙丁\t戊')], style({ align: 'left' })))).toEqual([
        0, 21, 42, 84,
      ])
    })

    test('自定义居中与右对齐制表位', () => {
      const b = layoutParagraph(
        [run('左\t居中对齐的文字\t右对齐')],
        style({
          align: 'left',
          tabStops: [
            { position: 207.65, align: 'center' },
            { position: 415.3, align: 'right' },
          ],
        }),
      )
      expect(tabX(b)).toEqual([0, 170.9, 383.8])
    })

    test('悬挂缩进的首行以左缩进处为制表位；两端对齐只作用于最后一个制表符之后', () => {
      const b = layoutParagraph(
        [run(`第一章\t${H.repeat(60)}`)],
        style({ firstLineIndent: -42, width: 373.3, tabOrigin: -42 }),
      )
      const [head, body] = b.lines[0]!.fragments
      expect(head!.x).toBe(-42)
      expect(head!.advances).toEqual([10.5, 10.5, 10.5])
      expect(body!.x).toBeCloseTo(0, 9)
      expect(body!.advances[0]).toBeGreaterThan(10.5)
    })
  })

  describe('片段', () => {
    test('按字段与字体切分；制表符与强制换行不生成片段', () => {
      const b = layoutParagraph(
        [run('甲A乙'), run('\t乙\n', { size: 12 })],
        style({ align: 'left' }),
      )
      const fr = b.lines[0]!.fragments
      expect(
        fr.map((f) => [f.run, f.start, f.end, f.face === song ? '宋体' : 'Times New Roman']),
      ).toEqual([
        [0, 0, 1, '宋体'],
        [0, 1, 2, 'Times New Roman'],
        [0, 2, 3, '宋体'],
        [1, 1, 2, '宋体'],
      ])
      expect(fr[3]!.size).toBe(12)
    })

    test('所选字体缺字形时改用 fallback，不改用字段的东亚字体；fallback 为 null 时按 .notdef 宽度', () => {
      // WPS：Times New Roman 与微软雅黑组合时「★」宽 10.5 磅（宋体），微软雅黑的「★」为 8.57 磅。
      const fonts = { ...SONG, eastAsia: yahei }
      const f = layoutParagraph([run('★', { fonts })], style({ align: 'left' })).lines[0]!
        .fragments[0]!
      expect(f.face).toBe(song)
      expect(f.advances).toEqual([10.5])
      const none = layoutParagraph([run('★', { fonts })], style({ align: 'left', fallback: null }))
      expect(none.lines[0]!.fragments[0]!.advances[0]).toBe(times.metrics.advance(0x2605, 10.5))
    })
  })
  describe('上下标、字符间距与基线提升', () => {
    test('上标字号按各字所用字体的 OS/2 上标字号缩小并换算为缇后向下取整，宽度按缩小后的字号', () => {
      // WPS：Times New Roman 12 磅的上标数字每个 3.875 磅（7.75 磅），宋体 12 磅的上标汉字 6 磅，10.5 磅时为 6.8 磅。
      const b = layoutParagraph(
        [run('基', { size: 12 }), run('1234567890汉', { size: 12, script: 'superscript' })],
        style({ align: 'left' }),
      )
      const [digits, han] = b.lines[0]!.fragments.slice(1)
      expect(digits!.size).toBe(7.75)
      expect(digits!.advances.slice(0, 9)).toEqual(new Array(9).fill(3.875))
      expect(han!.size).toBe(6)
      const small = layoutParagraph([run('1', { script: 'subscript' })], style({ align: 'left' }))
      expect(small.lines[0]!.fragments[0]!.size).toBe(6.8)
    })

    test('上标的行高按原字号计算：12 磅宋体行内 24 磅的上标数字使行高为 Times New Roman 24 磅的单倍行高', () => {
      // WPS：相邻行纵坐标之差 27.6 磅；同样的数字不设上标时行高相同。
      const runs = (script?: 'superscript') => [
        run(H.repeat(10), { size: 12 }),
        run('123', script === undefined ? { size: 24 } : { size: 24, script }),
        run(H.repeat(40), { size: 12 }),
      ]
      const sup = layoutParagraph(runs('superscript'), style({ align: 'left' }))
      expect(sup.lines[0]!.height).toBeCloseTo(27.6, 1)
      expect(sup.lines[0]!.height).toBeCloseTo(
        layoutParagraph(runs(), style({ align: 'left' })).lines[0]!.height,
        9,
      )
    })

    test('字符间距加在每个字符之后并计入行宽：间距 0.5 磅、行宽 424.75 磅时一行 33 个 12 磅汉字', () => {
      const b = layoutParagraph(
        [run(H.repeat(60), { size: 12, spacing: 0.5 })],
        style({ width: 424.75 }),
      )
      expect(counts(b)[0]).toBe(33)
      const left = layoutParagraph(
        [run('汉 a', { size: 12, spacing: 1 })],
        style({ align: 'left' }),
      )
      expect(left.lines[0]!.fragments.flatMap((f) => f.advances)).toEqual([
        13,
        4,
        times.metrics.advance(0x61, 12) + 1,
      ])
    })

    test('基线提升使行高的上沿增加、降低使下沿增加；提升的字段下沿相应减少', () => {
      // WPS：宋体 12 磅行内提升或降低 6 磅时行距为 21.55 与 21.6 磅；18 磅字段提升 3 磅时为 24.6 磅。
      const line = (over: Partial<TextRun>) =>
        layoutParagraph(
          [
            run(H.repeat(10), { size: 12 }),
            run('提升', { size: 12, ...over }),
            run(H.repeat(40), { size: 12 }),
          ],
          style({ align: 'left' }),
        ).lines[0]!
      expect(line({ raise: 6 }).height).toBeCloseTo(21.56, 2)
      expect(line({ raise: -6 }).height).toBeCloseTo(21.56, 2)
      expect(line({ raise: 3, size: 18 }).height).toBeCloseTo(24.6, 1)
      const raised = line({ raise: 6 })
      expect(raised.fragments[1]!.baseline).toBeCloseTo(raised.baseline - 6, 9)
    })
  })

  describe('标点挤压', () => {
    const adv = (b: TextBlock, line = 0) => b.lines[line]!.fragments.flatMap((f) => f.advances)
    const kerned = (text: string, over: Partial<TextRun> = {}) =>
      layoutParagraph(
        [run(text, { size: 12, kern: 1, slots: hint, ...over })],
        style({ align: 'left' }),
      )

    test('字距调整开启时相邻标点压缩：闭合类标点后接标点时去掉右半，开启类标点相连时后一字去掉左半', () => {
      expect(adv(kerned('字）：字'))).toEqual([12, 6, 12, 12])
      expect(adv(kerned('字”、“字'))).toEqual([12, 6, 6, 12, 12])
      const open = kerned('“《字')
      expect(adv(open)).toEqual([12, 6, 12])
      expect(open.lines[0]!.fragments.flatMap((f) => f.offsets)).toEqual([0, -6, 0])
      expect(adv(kerned('字？（字'))).toEqual([12, 12, 12, 12])
    })

    test('字距调整关闭、字号小于最小字号或只有一侧开启时不压缩', () => {
      expect(adv(kerned('字）：字', { kern: 0 }))).toEqual([12, 12, 12, 12])
      expect(adv(kerned('字）：字', { kern: 15 }))).toEqual([12, 12, 12, 12])
      const half = layoutParagraph(
        [run('字）', { size: 12, kern: 1, slots: hint }), run('：字', { size: 12, slots: hint })],
        style({ align: 'left' }),
      )
      expect(adv(half)).toEqual([12, 12, 12, 12])
    })

    const squeeze = (text: string, width = 415.3, over: Partial<ParagraphStyle> = {}) =>
      layoutParagraph(
        [run(text, { size: 12, slots: hint })],
        style({ width, compressPunctuation: true, ...over }),
      )

    test('压缩标点：行宽不足时压缩标点容纳下一字，至多压缩一半', () => {
      // WPS：17 字、逗号、37 字，行宽 415.3 磅时首行 35 字、逗号 7.3 磅；超出 6.1 磅时首行 34 字。
      const fit = squeeze(`${H.repeat(17)}，${H.repeat(37)}`)
      expect(counts(fit)[0]).toBe(35)
      expect(adv(fit)[17]).toBeCloseTo(7.3, 9)
      expect(counts(squeeze(`${H.repeat(17)}，${H.repeat(37)}`, 413.9))[0]).toBe(34)
    })

    test('压缩标点：两个逗号时超出 7.75 磅容纳、8 磅不容纳；justifiedPunctuation 时左对齐不压缩', () => {
      const text = `${H.repeat(10)}，${H.repeat(10)}，${H.repeat(44)}`
      const yes = squeeze(text, 432 - 7.75)
      expect(counts(yes)[0]).toBe(36)
      expect(adv(yes)[10]).toBeCloseTo(8.125, 9)
      expect(counts(squeeze(text, 432 - 8))[0]).toBe(35)
      expect(
        counts(squeeze(text, 432 - 7.75, { align: 'left', justifiedPunctuation: true }))[0],
      ).toBe(35)
    })

    test('压缩标点：行尾标点先压缩；行首的开启类标点不压缩', () => {
      const end = squeeze(`${H.repeat(16)}，${H.repeat(17)}，${H.repeat(30)}`)
      expect(counts(end)[0]).toBe(35)
      expect(adv(end)[16]).toBe(12)
      expect(adv(end)[34]).toBeCloseTo(7.3, 9)
      const start = squeeze(`“${H.repeat(16)}，${H.repeat(30)}`)
      expect(counts(start)[0]).toBe(35)
      expect(adv(start)[0]).toBe(12)
      expect(adv(start)[17]).toBeCloseTo(7.3, 9)
    })

    test('justifiedPunctuation 时左对齐不悬挂；东亚语言不是中文时不悬挂', () => {
      // WPS：34 字之后的逗号越过行宽 0.5 磅时，兼容模式 15 的左对齐段落与没有东亚语言的段落均把前一字连同逗号移到下一行。
      const text = `${H.repeat(34)}，${H.repeat(20)}`
      const at = (over: Partial<TextRun>, align: ParagraphStyle['align']) =>
        counts(
          layoutParagraph(
            [run(text, { size: 12, ...over })],
            style({ width: 408.5, align, justifiedPunctuation: true }),
          ),
        )[0]
      expect(at({}, 'both')).toBe(35)
      expect(at({}, 'left')).toBe(33)
      expect(at({ eastAsiaLanguage: '' }, 'both')).toBe(33)
      expect(at({ eastAsiaLanguage: 'zh-CN' }, 'both')).toBe(35)
    })
  })

  describe('wordWrap 关闭与单双字节宽度协调', () => {
    test('wordWrap 关闭时空格是普通字符：可以位于行首，余量分配到全部字间', () => {
      // WPS：「abcdefghij 」重复 40 次，Times New Roman 12 磅两端对齐，各行 84、85、85、84、85、17 字。
      const b = layoutParagraph(
        [run('abcdefghij '.repeat(40), { size: 12 })],
        style({ wordWrap: false }),
      )
      expect(counts(b)).toEqual([84, 85, 85, 84, 85, 17])
      const multi = layoutParagraph(
        [run('abc  defgh   ijk '.repeat(30), { size: 12 })],
        style({ wordWrap: false }),
      )
      expect(counts(multi)).toEqual([93, 95, 93, 95, 94, 40])
      const last = multi.lines[5]!
      expect(last.start).toBe(93 + 95 + 93 + 95 + 94)
      expect('abc  defgh   ijk '.repeat(30)[last.start]).toBe(' ')
      expect(multi.lines[4]!.width).toBeCloseTo(415.3, 9)
    })

    test('单双字节宽度协调：一侧为东亚字符的空格为字号的一半，中西文间距为前一字字号的四分之一', () => {
      // WPS：Times New Roman 与宋体 12 磅，「汉1汉 汉1 汉a b」各字步进如下。
      const b = layoutParagraph(
        [run('汉1汉 汉1 汉a b', { size: 12 })],
        style({ align: 'left', balanceSingleByte: true }),
      )
      expect(b.lines[0]!.fragments.flatMap((f) => f.advances)).toEqual([
        15,
        9,
        12,
        6,
        15,
        6,
        6,
        15,
        times.metrics.advance(0x61, 12),
        3,
        6,
      ])
    })
  })
})
