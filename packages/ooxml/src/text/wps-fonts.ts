/**
 * WPS 按自带度量排版的字体：主机没有这些字体名时，WPS 不按替代字体排版，而按自带的度量（行高与西文字符宽度）排版，
 * 字形取自其他字体。表中只有与宿主无关的内容（字体名、绘制所用的字体与度量），由宿主在替代规则之前查询：WPS 文字排在
 * `substitutes` 的各步之前（`../docx/layout.ts` 的 `ParagraphLayouter.face`）。数据取自 WPS 文字；WPS 演示中缺失的隶书
 * 同样以微软雅黑绘制，其余字体名与度量是否相同未实测。
 *
 * WPS 实测（构造文档 f1-fonts、f1-widths、f1-vert、f2-lh2、f2-lh3，页面 EMF 的段落底纹矩形、文字记录的参考点与前进宽度）：
 * - 行高与基线：上沿、下沿与字号成正比，行的位置连续累加、不按缇取整。上沿与下沿之和取 9–26 磅六行段落的行距按字号拟合的值
 *   （千分之一 em，误差约 0.1）；两者之比取 100 磅单行的测量值。西文字段与东亚字段分别测量；`eastAsia` 为 `null` 的字体只有
 *   西文由其排版，汉字为宋体。
 * - 西文字符（U+0020–U+007E）的宽度：28 磅每个字符 12 个为一组，取各组宽度之和除以 12（误差约 0.002 em）；空格为相邻两组
 *   之间的距离。与某个主机字体的宽度相差不超过 0.004 em 时记为该字体名。
 * - 其余字符（汉字、全角符号、“”—… 等）由 `other` 绘制，宽度为 `other` 的宽度。
 * - 西文字符的字形：页面 EMF 中为 WPS 自带的字体（`emf`，每种字形一个字体名，主机上没有），WPS 导出的 PDF 中嵌入的该字体的
 *   字形与主机字体都不相同。`asciiDraw` 为与之最接近的主机字体：PDF 中常规字形的 U+0021–U+007E 与 Windows 10 自带的常用字体
 *   （38 个字体族的常规字形）的同一字符逐字比对，原点对齐，按 1/100 em 栅格化并模糊后取重叠部分之比，取各字符平均值最高者
 *   （构造文档 f2-ksof；得分 0.44–0.73，最高与次高之差多在 0.01 以内）。粗体与斜体取该字体族的对应字形。真值回放时页面 EMF
 *   中的 `emf` 字体名改为 `asciiDraw`（`scripts/ooxml-fidelity/emf.py`，表由 `wpsEmfFaces` 导出），与本方绘制相同。
 *   华文楷体、华文中宋、华文宋体、方正楷体简体的西文与汉字在页面 EMF 中都是宋体；Source Han Sans CN Regular 的西文为 Segoe Print。
 * - 主机或文档中有该字体名的字体时（构造文档 f2-emb、f2-emb3、f2-emb4：Comic Sans MS 与等线改名后嵌入），字形与宽度取自该字体；
 *   `fixed` 的字体上下沿仍取数据表（`eastAsia`，为 `null` 时取 `latin`），其余取自该字体。实测方正小标宋简体、方正仿宋简体
 *   （西文与汉字段落都为 `eastAsia` 的值）、楷体_GB2312、华文中宋、思源黑体、Source Han Sans CN Regular 为前者，Helvetica、
 *   Arial Narrow、Helvetica Neue 为后者；其余 `eastAsia` 不为 `null` 的字体名未实测，按前者。Arial Unicode MS 嵌入 Comic Sans MS
 *   时行高为 1.540 em，与两者都不同，按后者。
 * - 不列入：DFKai-SB（汉字由 Microsoft JhengHei Light 绘制，msjhl.ttc 拆出的字体 Edge 的 `FontFace` 无法加载，列入后
 *   整份文档无法打开）。
 */

import type { FontMetrics } from '../font/metrics.ts'
import type { VerticalMetrics } from '../font/vertical.ts'
import type { TextFace } from './layout.ts'

export interface WpsMetricFont {
  /** U+0020–U+007E 的宽度（千分之一 em，下标为码位减 0x20），或取其宽度的主机字体名。 */
  readonly ascii: readonly number[] | string
  /** 绘制 U+0020–U+007E 的主机字体。 */
  readonly asciiDraw: string
  /** 其余字符的主机字体：宽度与字形都取自它；东亚字段的字形同样取自它。 */
  readonly other: string
  /** 西文字段的上沿与下沿（千分之一 em）。 */
  readonly latin: readonly [number, number]
  /** 东亚字段的上沿与下沿；`null` 时 WPS 不以该字体排版东亚字段，东亚字段按 `substitutes` 替代。 */
  readonly eastAsia: readonly [number, number] | null
  /** 有同名字体时上下沿仍取数据表（`wpsExtentFace`）。 */
  readonly fixed: boolean
  /**
   * 页面 EMF 中西文字段的字体名，依次为常规、粗体、斜体、粗斜体；西文字段在页面 EMF 中为主机字体（`asciiDraw`）时为 `null`。
   */
  readonly emf: readonly [string, string, string, string] | null
}

/** 排版与绘制该字体所需的主机字体名，供调用方预先取得（WPS 文字为 `requiredFonts`）。 */
export function wpsMetricFontNames(font: WpsMetricFont): string[] {
  const names = [font.asciiDraw, font.other]
  if (typeof font.ascii === 'string') names.push(font.ascii)
  return [...new Set(names)]
}

const UNITS = 1000

/**
 * 按数据表排版的字体：度量取自 `font` 的 `part`（上沿与下沿），U+0020–U+007E 的宽度取自 `font.ascii`（为字体名时为
 * `ascii` 的宽度），其余字符的宽度、字形编号与其余纵向度量取自 `other`。
 */
export function wpsMetricFace(
  font: WpsMetricFont,
  part: readonly [number, number],
  other: TextFace,
  ascii: TextFace | null,
): TextFace {
  const om = other.metrics
  const table = typeof font.ascii === 'string' ? null : font.ascii
  const scaled = (m: FontMetrics, cp: number) => (m.advanceWidth(cp) * UNITS) / m.unitsPerEm
  const width = (cp: number): number => {
    if (cp < 0x20 || cp > 0x7e) return scaled(om, cp)
    if (table !== null) return table[cp - 0x20]!
    return ascii === null ? scaled(om, cp) : scaled(ascii.metrics, cp)
  }
  const metrics: FontMetrics = {
    unitsPerEm: UNITS,
    numGlyphs: om.numGlyphs,
    glyphId: (cp) => om.glyphId(cp),
    advanceWidth: width,
    advance: (cp, size) => (width(cp) * size) / UNITS,
  }
  return { metrics, vertical: extentVertical(part, other.vertical) }
}

/** 上沿与下沿为 `part`（千分之一 em）的纵向度量，其余取自 `base`。 */
function extentVertical(part: readonly [number, number], base: VerticalMetrics): VerticalMetrics {
  const s = UNITS / base.unitsPerEm
  const [ascent, descent] = part
  return {
    unitsPerEm: UNITS,
    hheaAscender: ascent,
    hheaDescender: -descent,
    hheaLineGap: 0,
    winAscent: ascent,
    winDescent: descent,
    useTypoMetrics: false,
    averageWidth: base.averageWidth * s,
    eastAsianCodePage: false,
    codePages: base.codePages ?? 0,
    superscriptSize: base.superscriptSize * s,
    superscriptOffset: base.superscriptOffset * s,
    subscriptSize: base.subscriptSize * s,
    subscriptOffset: base.subscriptOffset * s,
  }
}

/**
 * 有同名字体的 `fixed` 字体：宽度与字形取自 `face`，上下沿为数据表的 `eastAsia`（为 `null` 时为 `latin`）。
 */
export function wpsExtentFace(font: WpsMetricFont, face: TextFace): TextFace {
  return {
    metrics: face.metrics,
    vertical: extentVertical(font.eastAsia ?? font.latin, face.vertical),
  }
}

/** 页面 EMF 中 WPS 自带的字体名到真值回放所用的主机字体（`emf` 到 `asciiDraw`），供 `scripts/ooxml-fidelity/emf.py`。 */
export function wpsEmfFaces(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const font of WPS_METRIC_FONTS.values())
    for (const name of font.emf ?? []) out[name] = font.asciiDraw
  return out
}

/**
 * 西文字符宽度表（千分之一 em，U+0020–U+007E）。名称取宽度相同的字体中第一个：方正小标宋简体与方正小标宋_GBK、方正黑体_GBK
 * 与方正黑体简体、方正仿宋_GB2312 与方正仿宋简体的宽度相同。
 */
const ARIAL_UNICODE_MS = [
  276, 277, 353, 558, 558, 888, 667, 190, 333, 330, 388, 585, 277, 330, 277, 277, 556, 558, 558,
  558, 558, 558, 558, 558, 558, 558, 277, 277, 585, 585, 585, 560, 1016, 667, 667, 723, 723, 667,
  612, 777, 723, 277, 500, 667, 558, 833, 723, 777, 667, 777, 723, 667, 612, 723, 667, 942, 667,
  667, 612, 277, 277, 277, 469, 500, 333, 558, 558, 500, 558, 558, 277, 558, 558, 221, 221, 500,
  221, 833, 556, 558, 558, 558, 333, 500, 277, 556, 500, 723, 500, 500, 500, 333, 261, 333, 585,
]

const ARIAL_NARROW = [
  237, 228, 292, 455, 455, 728, 547, 158, 272, 272, 319, 480, 228, 272, 228, 225, 455, 455, 455,
  455, 455, 455, 455, 455, 455, 455, 225, 228, 480, 480, 480, 455, 830, 547, 547, 592, 592, 545,
  502, 638, 592, 225, 408, 547, 455, 683, 589, 638, 547, 638, 592, 547, 502, 592, 545, 775, 547,
  547, 502, 228, 225, 228, 384, 455, 272, 455, 455, 408, 455, 455, 225, 455, 455, 183, 183, 408,
  183, 683, 455, 455, 455, 455, 272, 408, 228, 455, 408, 592, 408, 408, 408, 272, 214, 272, 480,
]

const STFANGSONG = [
  258, 219, 404, 667, 449, 821, 728, 179, 292, 292, 429, 667, 217, 317, 219, 500, 469, 469, 469,
  467, 469, 469, 467, 469, 469, 469, 219, 217, 667, 667, 667, 366, 915, 676, 616, 634, 772, 654,
  562, 772, 759, 353, 333, 739, 571, 833, 772, 779, 562, 772, 623, 480, 616, 708, 676, 884, 696,
  654, 654, 270, 500, 270, 500, 500, 330, 404, 509, 415, 500, 415, 321, 449, 509, 228, 228, 469,
  228, 772, 509, 509, 509, 489, 330, 366, 292, 489, 469, 667, 458, 415, 426, 480, 500, 480, 667,
]

const HELVETICA_NEUE = [
  279, 261, 426, 556, 558, 998, 627, 277, 261, 261, 350, 598, 277, 388, 277, 333, 558, 558, 558,
  558, 558, 558, 558, 558, 558, 558, 277, 277, 598, 598, 598, 558, 801, 647, 683, 723, 703, 612,
  574, 759, 723, 261, 518, 667, 558, 871, 723, 759, 647, 759, 683, 647, 574, 723, 612, 924, 612,
  647, 612, 261, 333, 261, 598, 500, 219, 536, 592, 536, 592, 536, 295, 574, 558, 221, 221, 518,
  221, 855, 558, 574, 592, 592, 333, 500, 317, 558, 500, 757, 516, 500, 482, 333, 219, 333, 598,
]

const FZ_DABIAOSONG = [
  339, 312, 549, 670, 478, 893, 750, 277, 350, 350, 518, 665, 312, 667, 312, 529, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 312, 312, 665, 665, 665, 362, 924, 737, 696, 737, 819, 643,
  594, 777, 830, 362, 344, 737, 600, 924, 812, 844, 643, 844, 768, 562, 725, 768, 750, 1000, 801,
  750, 750, 362, 529, 362, 330, 500, 330, 478, 569, 487, 569, 478, 321, 549, 562, 290, 277, 538,
  268, 924, 569, 569, 569, 569, 395, 375, 344, 569, 518, 777, 527, 518, 509, 395, 562, 395, 518,
]

const FZ_XIAOBIAOSONG = [
  256, 330, 556, 500, 500, 1000, 830, 277, 330, 330, 500, 565, 250, 565, 250, 277, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 330, 330, 565, 565, 565, 502, 929, 719, 665, 719, 719, 665,
  609, 777, 777, 384, 500, 777, 665, 940, 719, 777, 609, 777, 719, 556, 665, 719, 719, 1000, 719,
  719, 665, 330, 277, 330, 330, 500, 330, 500, 556, 440, 556, 440, 330, 500, 556, 277, 330, 556,
  277, 830, 556, 500, 556, 556, 440, 386, 330, 556, 500, 719, 500, 500, 440, 391, 219, 388, 518,
]

const FZ_HEITI = [
  280, 277, 350, 556, 556, 886, 665, 188, 330, 330, 386, 583, 275, 583, 277, 275, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 277, 277, 583, 583, 583, 556, 1011, 665, 665, 719, 719, 665,
  609, 777, 719, 277, 500, 665, 556, 830, 719, 777, 665, 777, 719, 665, 609, 719, 665, 940, 665,
  665, 609, 277, 277, 275, 330, 556, 330, 556, 556, 500, 556, 556, 277, 556, 556, 217, 219, 500,
  219, 830, 556, 556, 556, 556, 330, 500, 277, 556, 500, 719, 500, 500, 500, 330, 259, 330, 583,
]

const FZ_FANGSONG_GBK = [
  456, 281, 292, 600, 469, 536, 518, 154, 312, 312, 522, 643, 234, 643, 297, 286, 484, 480, 493,
  504, 538, 484, 482, 509, 518, 478, 297, 234, 516, 643, 516, 424, 696, 504, 504, 500, 511, 516,
  487, 516, 522, 391, 464, 500, 480, 583, 511, 511, 482, 516, 504, 491, 522, 518, 433, 471, 408,
  417, 487, 408, 286, 408, 268, 616, 241, 460, 516, 453, 516, 500, 453, 509, 484, 391, 440, 440,
  362, 625, 509, 484, 513, 516, 440, 408, 460, 511, 417, 511, 487, 511, 487, 344, 161, 344, 723,
]

const FZ_FANGSONG = [
  450, 281, 290, 596, 464, 536, 518, 154, 308, 308, 522, 643, 232, 643, 297, 286, 484, 480, 491,
  504, 538, 484, 480, 509, 518, 478, 297, 230, 516, 643, 516, 424, 696, 504, 504, 500, 511, 513,
  487, 516, 522, 391, 462, 500, 478, 583, 511, 511, 482, 516, 504, 491, 522, 518, 429, 471, 408,
  417, 484, 408, 286, 408, 268, 616, 241, 460, 516, 453, 516, 500, 453, 509, 484, 388, 440, 440,
  362, 625, 509, 484, 513, 516, 435, 408, 455, 511, 417, 511, 482, 511, 487, 342, 161, 342, 719,
]

const FZ_KAITI_GBK = [
  288, 259, 402, 670, 455, 719, 728, 179, 301, 301, 509, 665, 259, 665, 259, 455, 487, 487, 487,
  487, 487, 487, 487, 487, 487, 487, 259, 259, 665, 665, 665, 348, 913, 674, 632, 725, 757, 594,
  529, 737, 788, 330, 299, 696, 549, 913, 812, 819, 562, 819, 801, 487, 674, 788, 688, 1000, 750,
  705, 674, 299, 455, 299, 330, 500, 330, 395, 500, 426, 500, 437, 268, 469, 518, 259, 248, 500,
  239, 788, 518, 518, 500, 500, 330, 299, 290, 518, 478, 737, 487, 469, 402, 478, 509, 478, 538,
]

const STXINGKAI = [
  257, 346, 301, 605, 734, 688, 489, 217, 330, 333, 321, 667, 330, 509, 333, 279, 435, 270, 437,
  509, 429, 429, 415, 435, 449, 458, 333, 330, 667, 667, 667, 321, 1009, 634, 549, 603, 645, 616,
  562, 562, 645, 437, 375, 654, 594, 833, 571, 571, 625, 645, 654, 645, 571, 623, 429, 696, 603,
  549, 540, 292, 279, 366, 469, 500, 333, 404, 321, 292, 415, 292, 270, 384, 366, 228, 279, 366,
  228, 551, 366, 315, 404, 375, 292, 312, 250, 384, 321, 489, 292, 375, 301, 415, 540, 415, 667,
]

const SOURCE_HAN_SANS = [
  233, 321, 475, 556, 556, 920, 679, 277, 339, 339, 464, 556, 277, 348, 277, 393, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 277, 277, 556, 556, 556, 475, 944, 607, 656, 638, 688, 589,
  551, 688, 728, 295, 536, 645, 542, 810, 723, 741, 632, 741, 634, 594, 598, 721, 574, 877, 571,
  531, 603, 339, 393, 339, 556, 560, 605, 562, 616, 509, 618, 554, 324, 562, 605, 275, 275, 549,
  286, 924, 612, 605, 618, 618, 386, 467, 375, 605, 518, 804, 496, 520, 475, 339, 268, 339, 556,
]

const STLITI = [
  252, 279, 219, 679, 440, 679, 779, 161, 261, 266, 422, 518, 219, 279, 219, 339, 440, 440, 440,
  440, 440, 440, 440, 440, 440, 440, 261, 241, 518, 518, 518, 379, 699, 618, 598, 518, 699, 618,
  578, 618, 679, 377, 402, 658, 578, 839, 699, 598, 538, 598, 598, 458, 500, 739, 641, 882, 560,
  560, 618, 241, 480, 321, 518, 500, 219, 422, 422, 339, 440, 342, 319, 402, 440, 241, 219, 440,
  241, 618, 460, 402, 440, 402, 299, 321, 321, 460, 440, 679, 420, 402, 440, 241, 518, 241, 518,
]

const STXIHEI = [
  263, 295, 308, 721, 554, 777, 757, 196, 371, 368, 426, 605, 275, 330, 277, 435, 554, 554, 554,
  554, 554, 554, 554, 554, 554, 554, 277, 277, 605, 605, 605, 589, 866, 739, 571, 812, 746, 536,
  484, 871, 681, 225, 482, 589, 460, 917, 739, 868, 589, 871, 605, 498, 426, 654, 701, 962, 609,
  592, 482, 350, 603, 350, 672, 500, 377, 681, 681, 645, 683, 650, 315, 672, 612, 199, 203, 502,
  199, 937, 612, 654, 681, 681, 299, 386, 339, 607, 551, 830, 480, 536, 426, 350, 670, 350, 605,
]

/**
 * 宋体、仿宋、楷体、黑体的上沿与下沿（`faceExtent`：Windows 上下沿 220、36 加 1.3 倍的增量，单位为 1/256 em）。
 * 楷体_GB2312、仿宋_GB2312、隶书的测量值（100 磅 2594–2595 缇）与之相差不超过 1 缇，取这一值：取测量值时上沿与下沿的
 * 测量误差使行的位置逐行偏离。
 */
const SONG_EXTENT: readonly [number, number] = [(258 / 256) * 1000, (74 / 256) * 1000]

export const WPS_METRIC_FONTS: ReadonlyMap<string, WpsMetricFont> = new Map([
  [
    'Arial Unicode MS',
    {
      ascii: ARIAL_UNICODE_MS,
      asciiDraw: 'Microsoft Sans Serif',
      other: 'Arial',
      latin: [1266.33, 475.94],
      eastAsia: null,
      fixed: false,
      emf: ['KSOF6398537F', 'KSOF987E8EC0', 'KSOFCD64CA01', 'KSOF024B0542'],
    },
  ],
  [
    'Helvetica',
    {
      ascii: 'Arial',
      asciiDraw: 'Microsoft Sans Serif',
      other: 'Arial',
      latin: [953.33, 221.96],
      eastAsia: null,
      fixed: false,
      emf: ['KSOF7FC4CF2A', 'KSOFB4AB0A6B', 'KSOFE99145AC', 'KSOF1E7780ED'],
    },
  ],
  [
    '楷体_GB2312',
    {
      ascii: '宋体',
      asciiDraw: '黑体',
      other: '楷体',
      latin: SONG_EXTENT,
      eastAsia: SONG_EXTENT,
      fixed: true,
      emf: ['KSOFF9CBECC6', 'KSOFF9CC6125', 'KSOFF9CCD584', 'KSOFF9CD49E3'],
    },
  ],
  [
    '华文楷体',
    {
      ascii: '宋体',
      asciiDraw: '宋体',
      other: '宋体',
      latin: [1026.62, 429.34],
      eastAsia: [1026.62, 429.34],
      fixed: true,
      emf: null,
    },
  ],
  [
    'Arial Narrow',
    {
      ascii: ARIAL_NARROW,
      asciiDraw: 'Calibri',
      other: 'Arial',
      latin: [933.63, 213.91],
      eastAsia: null,
      fixed: false,
      emf: ['KSOF3D47F291', 'KSOF722E2DD2', 'KSOFA7146913', 'KSOFDBFAA454'],
    },
  ],
  [
    '仿宋_GB2312',
    {
      ascii: '宋体',
      asciiDraw: '宋体',
      other: '仿宋',
      latin: SONG_EXTENT,
      eastAsia: SONG_EXTENT,
      fixed: true,
      emf: ['KSOFE44F9426', 'KSOFE4500885', 'KSOFE4507CE4', 'KSOFE450F143'],
    },
  ],
  [
    '华文中宋',
    {
      ascii: '宋体',
      asciiDraw: '宋体',
      other: '宋体',
      latin: [1079.84, 399.1],
      eastAsia: [1079.84, 399.1],
      fixed: true,
      emf: null,
    },
  ],
  [
    '华文仿宋',
    {
      ascii: STFANGSONG,
      asciiDraw: 'Palatino Linotype',
      other: '仿宋',
      latin: [1025.64, 430.35],
      eastAsia: [1025.64, 430.35],
      fixed: true,
      emf: ['KSOF0B7949D1', 'KSOF0B79BE30', 'KSOF0B7A328F', 'KSOF0B7AA6EE'],
    },
  ],
  [
    'Helvetica Neue',
    {
      ascii: HELVETICA_NEUE,
      asciiDraw: 'Ebrima',
      other: 'Times New Roman',
      latin: [982.06, 210.91],
      eastAsia: null,
      fixed: false,
      emf: ['KSOFE816CA0F', 'KSOF38C0A810', 'KSOF896A8611', 'KSOFDA146412'],
    },
  ],
  [
    '方正大标宋简体',
    {
      ascii: FZ_DABIAOSONG,
      asciiDraw: 'Microsoft Sans Serif',
      other: '微软雅黑',
      latin: [1041.23, 443.03],
      eastAsia: [1041.23, 443.03],
      fixed: true,
      emf: ['KSOF5FA7FF03', 'KSOF615CD7A2', 'KSOF6311B041', 'KSOF64C688E0'],
    },
  ],
  [
    '隶书',
    {
      ascii: '宋体',
      asciiDraw: '黑体',
      other: '微软雅黑',
      latin: SONG_EXTENT,
      eastAsia: SONG_EXTENT,
      fixed: true,
      emf: ['KSOF4F9C2767', 'KSOF51510006', 'KSOF5305D8A5', 'KSOF54BAB144'],
    },
  ],
  [
    '方正小标宋简体',
    {
      ascii: FZ_XIAOBIAOSONG,
      asciiDraw: 'Microsoft Sans Serif',
      other: '黑体',
      latin: [1036.08, 487.31],
      eastAsia: [1036.08, 487.31],
      fixed: true,
      emf: ['KSOF439EEF50', 'KSOF439F63AF', 'KSOF439FD80E', 'KSOF43A04C6D'],
    },
  ],
  [
    '方正小标宋_GBK',
    {
      ascii: FZ_XIAOBIAOSONG,
      asciiDraw: 'Microsoft Sans Serif',
      other: '微软雅黑',
      latin: [1039.08, 484.31],
      eastAsia: [1039.08, 484.31],
      fixed: true,
      emf: ['KSOF8080F95D', 'KSOF8235D1FC', 'KSOF83EAAA9B', 'KSOF859F833A'],
    },
  ],
  [
    '方正黑体_GBK',
    {
      ascii: FZ_HEITI,
      asciiDraw: 'Microsoft Sans Serif',
      other: '微软雅黑',
      latin: [1058.13, 398.86],
      eastAsia: [1058.13, 398.86],
      fixed: true,
      emf: ['KSOFEC83043A', 'KSOFEE37DCD9', 'KSOFEFECB578', 'KSOFF1A18E17'],
    },
  ],
  [
    '方正仿宋_GBK',
    {
      ascii: FZ_FANGSONG_GBK,
      asciiDraw: 'Trebuchet MS',
      other: '微软雅黑',
      latin: [1025.33, 423.83],
      eastAsia: [1025.33, 423.83],
      fixed: true,
      emf: ['KSOFD8A28030', 'KSOFDA5758CF', 'KSOFDC0C316E', 'KSOFDDC10A0D'],
    },
  ],
  [
    '方正仿宋_GB2312',
    {
      ascii: FZ_FANGSONG,
      asciiDraw: '宋体',
      other: '仿宋',
      latin: [1026.31, 422.82],
      eastAsia: [1026.31, 422.82],
      fixed: true,
      emf: ['KSOFE8852770', 'KSOFE8859BCF', 'KSOFE886102E', 'KSOFE886848D'],
    },
  ],
  [
    '方正楷体_GBK',
    {
      ascii: FZ_KAITI_GBK,
      asciiDraw: 'Microsoft Sans Serif',
      other: '微软雅黑',
      latin: [1019.93, 401.87],
      eastAsia: [1019.93, 401.87],
      fixed: true,
      emf: ['KSOFF21A05E0', 'KSOFF3CEDE7F', 'KSOFF583B71E', 'KSOFF7388FBD'],
    },
  ],
  [
    '华文行楷',
    {
      ascii: STXINGKAI,
      asciiDraw: 'Trebuchet MS',
      other: '微软雅黑',
      latin: [917.89, 448.08],
      eastAsia: [917.89, 448.08],
      fixed: true,
      emf: ['KSOF22E28EF3', 'KSOF24976792', 'KSOF264C4031', 'KSOF280118D0'],
    },
  ],
  [
    '思源黑体',
    {
      ascii: SOURCE_HAN_SANS,
      asciiDraw: 'Malgun Gothic',
      other: '黑体',
      latin: [1376.87, 505.12],
      eastAsia: [1376.87, 505.12],
      fixed: true,
      emf: ['KSOF4CF9F437', 'KSOF4CFA6896', 'KSOF4CFADCF5', 'KSOF4CFB5154'],
    },
  ],
  [
    'Source Han Sans CN Regular',
    {
      ascii: 'Segoe Print',
      asciiDraw: 'Segoe Print',
      other: 'Segoe Print',
      latin: [1289.64, 303.41],
      eastAsia: null,
      fixed: true,
      emf: null,
    },
  ],
  [
    '华文隶书',
    {
      ascii: STLITI,
      asciiDraw: 'Franklin Gothic Medium',
      other: '微软雅黑',
      latin: [901.88, 413.07],
      eastAsia: [901.88, 413.07],
      fixed: true,
      emf: ['KSOF9F9B138E', 'KSOFA14FEC2D', 'KSOFA304C4CC', 'KSOFA4B99D6B'],
    },
  ],
  [
    '华文细黑',
    {
      ascii: STXIHEI,
      asciiDraw: 'Segoe UI',
      other: '微软雅黑',
      latin: [1033.84, 369.11],
      eastAsia: [1033.84, 369.11],
      fixed: true,
      emf: ['KSOF429D5CD3', 'KSOF44523572', 'KSOF46070E11', 'KSOF47BBE6B0'],
    },
  ],
  [
    '方正黑体简体',
    {
      ascii: FZ_HEITI,
      asciiDraw: 'Microsoft Sans Serif',
      other: '微软雅黑',
      latin: [1073.72, 453.63],
      eastAsia: [1073.72, 453.63],
      fixed: true,
      emf: ['KSOFD7C1B938', 'KSOFD97691D7', 'KSOFDB2B6A76', 'KSOFDCE04315'],
    },
  ],
  [
    '方正仿宋简体',
    {
      ascii: FZ_FANGSONG,
      asciiDraw: 'Trebuchet MS',
      other: '微软雅黑',
      latin: [1026.33, 422.93],
      eastAsia: [1049.95, 410.98],
      fixed: true,
      emf: ['KSOF025BBAAE', 'KSOF0410934D', 'KSOF05C56BEC', 'KSOF077A448B'],
    },
  ],
  [
    '方正楷体简体',
    {
      ascii: '宋体',
      asciiDraw: '宋体',
      other: '宋体',
      latin: [1022.4, 395.61],
      eastAsia: [1022.4, 395.61],
      fixed: true,
      emf: null,
    },
  ],
  [
    '华文宋体',
    {
      ascii: '宋体',
      asciiDraw: '宋体',
      other: '宋体',
      latin: [1023.52, 432.3],
      eastAsia: [1023.52, 432.3],
      fixed: true,
      emf: null,
    },
  ],
])
