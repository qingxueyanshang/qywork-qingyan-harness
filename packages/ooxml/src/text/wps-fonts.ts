/**
 * WPS 按自带度量排版的字体：主机没有这些字体名时，WPS 不按替代字体排版，而按自带的度量（行高与西文字符宽度）排版，
 * 字形取自其他字体。每个字体名有 WPS 文字（`writer`）与 WPS 演示（`presentation`）各自的宽度与绘制字体，上沿与下沿共用；
 * 为 `null` 的宿主不按数据表排版该字体名。WPS 文字排在 `substitutes` 的各步之前（`../docx/layout.ts` 的
 * `ParagraphLayouter.face`），WPS 演示排在替代规则之前（`../drawingml/text/fonts.ts` 的 `FaceCache`）。
 *
 * WPS 文字实测（构造文档 f1-fonts、f1-widths、f1-vert、f2-lh2、f2-lh3，页面 EMF 的段落底纹矩形、文字记录的参考点与前进宽度）：
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
 *
 * WPS 演示实测（构造文件 p9-a、p9-b、p10-c、p10-d：导出图中红色竖线之间的距离、字形的上下边与逐字比对）：
 * - 西文字符的宽度：60 磅每组 3 个相同字符，每个字符的前进宽度按缇取整（误差 0.42/1000 em）。与 WPS 文字的数据表相同的只有
 *   取自主机字体的 Helvetica、楷体_GB2312、仿宋_GB2312、隶书；其余相差 2–13/1000 em（多为空格），另列宽度表。华文楷体、华文仿宋、
 *   华文宋体的宽度相同。Arial Narrow 的「11」「ff」有字距调整，本表不处理，「1」「f」取 WPS 文字的值。粗体：华文楷体与常规字形
 *   同宽，楷体_GB2312 每字加宽 5 缇（60 磅），与仿粗体（`emboldened`）相同。
 * - 东亚字段按 `other` 排版与绘制：40 磅「国」的上下边与该主机字体逐像素相同，不按数据表的上下沿；粗体不加宽。
 * - 西文字段的纵向位置：见 `wpsPresentationFace`。40 磅单行锚定顶端与锚定底端时 H 的底边与之相差不超过 0.55 像素。
 * - `charset`：英文名 STKaiti 等与华文新魏只在 `latin` 的 charset 为 GB2312 时按数据表排版，为 0 或未写时与主机没有的西文字体
 *   相同（Segoe Print）；其余字体名与 charset 无关。东亚字段与 charset 无关。
 * - 字形：导出图中 16 个西文字符与主机字体（Windows 自带字体的各字形）按同一原点与基线逐字比对，模糊后取相关系数，各字符
 *   平均值最高者为 `asciiDraw`（得分 0.57–0.82；主机有该字体时为 0.96）。与 WPS 文字的 `asciiDraw` 相差不超过 0.02 时取后者。
 *   Arial Unicode MS 与 Arial Narrow 的字形随 charset 变化，取 charset 为 GB2312 时的结果。
 * - Source Han Sans CN Regular 的 `presentation` 为 `null`：charset 为 GB2312 时另有自带度量（宽度与思源黑体相近，上下沿与之
 *   不同），未实现；为 0 时与主机没有的西文字体相同。
 * - 西文字段中 U+0080 起的字符按 `other` 本身排版与绘制（`FaceCache` 的 `hAnsi` 位置）。
 */

import type { FontMetrics } from '../font/metrics.ts'
import type { VerticalMetrics } from '../font/vertical.ts'
import type { TextFace } from './layout.ts'
import { EAST_ASIAN_FACTOR } from './line-height.ts'

/** 一个宿主按数据表排版该字体名时的宽度与绘制字体。 */
export interface WpsMetricHost {
  /** U+0020–U+007E 的宽度（千分之一 em，下标为码位减 0x20），或取其宽度的主机字体名。 */
  readonly ascii: readonly number[] | string
  /** 绘制 U+0020–U+007E 的主机字体。 */
  readonly asciiDraw: string
  /** 其余字符的主机字体：宽度与字形都取自它；东亚字段的字形同样取自它。 */
  readonly other: string
}

/** WPS 文字的排版方式。 */
export interface WpsWriterFont extends WpsMetricHost {
  /** 有同名字体时上下沿仍取数据表（`wpsExtentFace`）。 */
  readonly fixed: boolean
  /**
   * 页面 EMF 中西文字段的字体名，依次为常规、粗体、斜体、粗斜体；西文字段在页面 EMF 中为主机字体（`asciiDraw`）时为 `null`。
   */
  readonly emf: readonly [string, string, string, string] | null
}

/** WPS 演示的排版方式：东亚字段按 `other` 本身排版，只有西文字段按数据表排版（`wpsPresentationFace`）。 */
export interface WpsPresentationFont extends WpsMetricHost {
  /** `latin` 的 charset（换算为无符号）为该值时才按数据表排版；为 `null` 时与 charset 无关。 */
  readonly charset: number | null
  /** 自带字体的代码页含中日韩字符集：西文字段按中日韩字体的纵向位置排版（见 `wpsPresentationFace`）。 */
  readonly eastAsianCodePage: boolean
}

export interface WpsMetricFont {
  /**
   * 西文字段的上沿与下沿（千分之一 em），WPS 文字的测量值；`writer` 为 `null` 的字体名为按 WPS 演示的测量换算的值。
   */
  readonly latin: readonly [number, number]
  /** 东亚字段的上沿与下沿；`null` 时 WPS 文字不以该字体排版东亚字段，东亚字段按 `substitutes` 替代。 */
  readonly eastAsia: readonly [number, number] | null
  readonly writer: WpsWriterFont | null
  readonly presentation: WpsPresentationFont | null
}

/** 排版与绘制该字体所需的主机字体名，供调用方预先取得（WPS 文字为 `requiredFonts`）。 */
export function wpsMetricFontNames(host: WpsMetricHost): string[] {
  const names = [host.asciiDraw, host.other]
  if (typeof host.ascii === 'string') names.push(host.ascii)
  return [...new Set(names)]
}

const UNITS = 1000

/**
 * 按数据表排版的字体：U+0020–U+007E 的宽度取自 `host.ascii`（为字体名时为 `ascii` 的宽度），其余字符的宽度取自 `other`；
 * 上沿与下沿为 `vertical`（千分之一 em）。字形编号与绘制所用的字体一致：U+0020–U+007E 取自 `draw`（绘制该字段的字体），
 * 其余取自 `other`。不要一律取自 `other`：公式中的普通文字按字形编号取绘制字体的字形与轮廓（`../math/`），编号取自另一个
 * 字体时画出的是另一个字。
 */
function metricFace(
  host: WpsMetricHost,
  vertical: VerticalMetrics,
  other: TextFace,
  ascii: TextFace | null,
  draw: TextFace,
): TextFace {
  const om = other.metrics
  const dm = draw.metrics
  const table = typeof host.ascii === 'string' ? null : host.ascii
  const scaled = (m: FontMetrics, cp: number) => (m.advanceWidth(cp) * UNITS) / m.unitsPerEm
  const width = (cp: number): number => {
    if (cp < 0x20 || cp > 0x7e) return scaled(om, cp)
    if (table !== null) return table[cp - 0x20]!
    return ascii === null ? scaled(om, cp) : scaled(ascii.metrics, cp)
  }
  const metrics: FontMetrics = {
    unitsPerEm: UNITS,
    numGlyphs: om.numGlyphs,
    glyphId: (cp) => (cp < 0x20 || cp > 0x7e ? om : dm).glyphId(cp),
    advanceWidth: width,
    advance: (cp, size) => (width(cp) * size) / UNITS,
  }
  return { metrics, vertical }
}

/**
 * WPS 文字按数据表排版的字体：度量见 `metricFace`，上沿与下沿为 `part`（字段的西文或东亚部分），`draw` 为绘制该部分的字体
 * （西文部分为 `asciiDraw`，东亚部分为 `other`）。
 */
export function wpsMetricFace(
  host: WpsMetricHost,
  part: readonly [number, number],
  other: TextFace,
  ascii: TextFace | null,
  draw: TextFace,
): TextFace {
  return metricFace(host, extentVertical(part, other.vertical, false), other, ascii, draw)
}

/**
 * WPS 演示按数据表排版的西文字段：度量见 `metricFace`，`draw` 为 `asciiDraw`。自带字体的代码页含中日韩字符集时，上沿与下沿为 `latin` 去掉 WPS 文字
 * 给中日韩字体加的增量（单倍行高为 win 上下沿之和的 1.3 倍，上下各加一半，见 `faceExtent`），并标为中日韩字体，纵向位置按
 * 演示文稿中日韩字体的规则（`FaceCache`）；否则为 `latin` 本身，按西文字体。
 */
export function wpsPresentationFace(
  font: WpsMetricFont,
  host: WpsPresentationFont,
  other: TextFace,
  ascii: TextFace | null,
  draw: TextFace,
): TextFace {
  const [a, d] = font.latin
  const half = host.eastAsianCodePage ? ((a + d) * (1 - 1 / EAST_ASIAN_FACTOR)) / 2 : 0
  const vertical = extentVertical([a - half, d - half], other.vertical, host.eastAsianCodePage)
  return metricFace(host, vertical, other, ascii, draw)
}

/** 上沿与下沿为 `part`（千分之一 em）的纵向度量，其余取自 `base`。 */
function extentVertical(
  part: readonly [number, number],
  base: VerticalMetrics,
  eastAsianCodePage: boolean,
): VerticalMetrics {
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
    eastAsianCodePage,
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
    vertical: extentVertical(font.eastAsia ?? font.latin, face.vertical, false),
  }
}

/** 页面 EMF 中 WPS 自带的字体名到真值回放所用的主机字体（`emf` 到 `asciiDraw`），供 `scripts/ooxml-fidelity/emf.py`。 */
export function wpsEmfFaces(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { writer } of WPS_METRIC_FONTS.values())
    if (writer !== null) for (const name of writer.emf ?? []) out[name] = writer.asciiDraw
  return out
}

/** `charset` 的 GB2312 字符集（无符号值）。 */
const GB2312 = 134

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

/**
 * WPS 演示的西文字符宽度表（千分之一 em，U+0020–U+007E，60 磅的测量值取整）。名称取宽度相同的字体中第一个：华文楷体、华文仿宋、
 * 华文宋体与 STKaiti、STSong、STFangsong 的宽度相同，其余英文名与对应的中文名相同；方正小标宋简体与方正小标宋_GBK、
 * 方正仿宋_GB2312 与方正仿宋简体的宽度相同。Arial Unicode MS 除「_」外与 Arial 相同，思源黑体与本机的 yyb 字体相同。
 */
const PRESENTATION_ARIAL_UNICODE_MS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 500, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

const PRESENTATION_STKAITI = [
  250, 219, 406, 667, 448, 823, 729, 177, 292, 292, 427, 667, 219, 313, 219, 500, 469, 469, 469,
  469, 469, 469, 469, 469, 469, 469, 219, 219, 667, 667, 667, 365, 917, 677, 615, 635, 771, 656,
  563, 771, 760, 354, 333, 740, 573, 833, 771, 781, 563, 771, 625, 479, 615, 708, 677, 885, 698,
  656, 656, 271, 500, 271, 500, 500, 333, 406, 510, 417, 500, 417, 323, 448, 510, 229, 229, 469,
  229, 771, 510, 510, 510, 490, 333, 365, 292, 490, 469, 667, 458, 417, 427, 479, 500, 479, 667,
]

const PRESENTATION_ARIAL_NARROW = [
  228, 228, 291, 456, 456, 729, 547, 158, 273, 273, 319, 479, 228, 273, 228, 228, 456, 455, 456,
  456, 456, 456, 456, 456, 456, 456, 228, 228, 479, 479, 479, 456, 832, 547, 547, 592, 592, 547,
  501, 638, 592, 228, 410, 547, 456, 683, 592, 638, 547, 638, 592, 547, 501, 592, 547, 774, 547,
  547, 501, 228, 228, 228, 385, 456, 273, 456, 456, 410, 456, 456, 225, 456, 456, 182, 182, 410,
  182, 683, 456, 456, 456, 456, 273, 410, 228, 456, 410, 592, 410, 410, 410, 274, 212, 274, 479,
]

const PRESENTATION_STZHONGSONG = [
  320, 300, 380, 600, 620, 900, 800, 220, 300, 300, 440, 600, 320, 400, 320, 600, 620, 620, 620,
  620, 620, 620, 620, 620, 620, 620, 320, 320, 600, 600, 600, 540, 944, 680, 740, 740, 800, 720,
  640, 800, 800, 340, 600, 720, 600, 920, 740, 800, 620, 800, 720, 660, 620, 780, 700, 960, 720,
  640, 640, 300, 600, 300, 600, 500, 340, 580, 620, 520, 620, 520, 320, 540, 660, 300, 300, 620,
  300, 940, 660, 560, 620, 580, 440, 520, 380, 680, 520, 780, 560, 540, 480, 280, 600, 280, 600,
]

const PRESENTATION_HELVETICA_NEUE = [
  278, 259, 426, 556, 556, 1000, 630, 278, 259, 259, 352, 600, 278, 389, 278, 333, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 600, 600, 600, 556, 800, 648, 685, 722, 704, 611,
  574, 759, 722, 259, 519, 667, 556, 871, 722, 760, 648, 760, 685, 648, 574, 722, 611, 926, 611,
  648, 611, 259, 333, 259, 600, 500, 222, 537, 593, 537, 593, 537, 296, 574, 556, 222, 222, 519,
  222, 853, 556, 574, 593, 593, 333, 500, 315, 556, 500, 758, 518, 500, 480, 333, 222, 333, 600,
]

const PRESENTATION_FZ_DABIAOSONG = [
  332, 312, 551, 668, 477, 894, 750, 278, 352, 352, 519, 664, 312, 664, 312, 528, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 312, 312, 664, 664, 664, 363, 926, 738, 695, 738, 820, 644,
  594, 778, 832, 363, 344, 738, 602, 926, 812, 844, 644, 844, 769, 562, 727, 769, 750, 1000, 801,
  750, 750, 363, 528, 363, 332, 500, 332, 477, 570, 488, 570, 477, 320, 551, 562, 289, 278, 539,
  269, 926, 570, 570, 570, 570, 394, 375, 344, 570, 519, 778, 528, 519, 508, 394, 562, 394, 519,
]

const PRESENTATION_FZ_XIAOBIAOSONG = [
  250, 332, 555, 500, 500, 1000, 832, 278, 332, 332, 500, 567, 250, 567, 250, 278, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 332, 332, 567, 567, 567, 500, 930, 719, 664, 719, 719, 664,
  609, 778, 778, 387, 500, 778, 664, 942, 719, 778, 609, 778, 719, 555, 664, 719, 719, 1000, 719,
  719, 664, 332, 278, 332, 332, 500, 332, 500, 555, 442, 555, 442, 332, 500, 555, 278, 332, 555,
  278, 832, 555, 500, 555, 555, 442, 387, 332, 555, 500, 719, 500, 500, 442, 391, 219, 391, 519,
]

const PRESENTATION_FZ_HEITI_GBK = [
  278, 278, 352, 555, 555, 887, 664, 188, 332, 332, 387, 582, 278, 582, 278, 278, 555, 555, 555,
  555, 555, 555, 555, 555, 555, 555, 278, 278, 582, 582, 582, 555, 1012, 664, 664, 719, 719, 664,
  609, 778, 719, 278, 500, 664, 555, 832, 719, 778, 664, 778, 719, 664, 609, 719, 664, 942, 664,
  664, 609, 278, 278, 278, 332, 555, 332, 555, 555, 500, 555, 555, 278, 555, 555, 219, 219, 500,
  219, 832, 555, 555, 555, 555, 332, 500, 278, 555, 500, 719, 500, 500, 500, 332, 258, 332, 582,
]

const PRESENTATION_FZ_HEITI = [
  278, 278, 352, 555, 555, 887, 664, 188, 328, 328, 387, 582, 278, 582, 278, 278, 555, 555, 555,
  555, 555, 555, 555, 555, 555, 555, 278, 278, 582, 582, 582, 555, 1012, 664, 664, 719, 719, 664,
  606, 778, 719, 278, 500, 664, 555, 828, 719, 778, 664, 778, 719, 664, 606, 719, 664, 942, 664,
  664, 606, 278, 278, 278, 328, 555, 328, 555, 555, 500, 555, 555, 278, 555, 555, 219, 219, 500,
  219, 828, 555, 555, 555, 555, 328, 500, 278, 555, 500, 719, 500, 500, 500, 332, 258, 332, 582,
]

const PRESENTATION_FZ_FANGSONG_GBK = [
  449, 282, 293, 602, 469, 535, 519, 152, 312, 312, 523, 644, 234, 644, 297, 285, 484, 481, 496,
  504, 539, 484, 484, 508, 519, 477, 297, 234, 516, 644, 516, 422, 695, 504, 504, 500, 512, 516,
  488, 516, 523, 391, 465, 500, 481, 582, 512, 512, 481, 516, 504, 492, 523, 519, 433, 472, 410,
  418, 488, 410, 285, 410, 269, 618, 242, 461, 516, 453, 516, 500, 453, 508, 484, 391, 442, 442,
  363, 625, 512, 484, 516, 516, 442, 410, 461, 512, 418, 512, 488, 512, 488, 344, 160, 344, 722,
]

const PRESENTATION_FZ_FANGSONG = [
  445, 282, 289, 598, 465, 535, 519, 152, 308, 308, 523, 644, 231, 644, 297, 285, 484, 481, 492,
  504, 539, 484, 481, 508, 519, 477, 297, 231, 516, 644, 516, 422, 695, 504, 504, 500, 512, 516,
  488, 516, 523, 391, 465, 500, 477, 582, 512, 512, 481, 516, 504, 492, 523, 519, 430, 472, 410,
  418, 484, 410, 285, 410, 269, 618, 242, 461, 516, 453, 516, 500, 453, 508, 484, 391, 442, 442,
  363, 625, 512, 484, 516, 516, 438, 410, 457, 512, 418, 512, 484, 512, 488, 340, 160, 340, 719,
]

const PRESENTATION_FZ_KAITI_GBK = [
  278, 258, 402, 668, 457, 719, 727, 176, 301, 301, 508, 664, 258, 664, 258, 457, 488, 488, 488,
  488, 488, 488, 488, 488, 488, 488, 258, 258, 664, 664, 664, 352, 914, 676, 632, 727, 758, 594,
  528, 738, 789, 332, 301, 695, 551, 914, 812, 820, 562, 820, 801, 488, 676, 789, 688, 1000, 750,
  707, 676, 301, 457, 301, 332, 500, 332, 394, 500, 426, 500, 438, 269, 469, 519, 258, 250, 500,
  238, 789, 519, 519, 500, 500, 332, 301, 289, 519, 477, 738, 488, 469, 402, 477, 508, 477, 539,
]

const PRESENTATION_FZ_KAITI = [
  278, 258, 402, 664, 453, 715, 727, 176, 301, 301, 508, 664, 258, 664, 258, 453, 484, 484, 484,
  484, 484, 484, 484, 484, 484, 484, 258, 258, 664, 664, 664, 352, 914, 676, 632, 727, 758, 590,
  528, 734, 789, 328, 301, 695, 551, 914, 808, 820, 558, 820, 801, 484, 676, 789, 683, 1000, 750,
  703, 676, 301, 453, 301, 328, 500, 328, 394, 500, 426, 500, 433, 269, 465, 519, 258, 250, 500,
  234, 789, 519, 519, 500, 500, 328, 301, 289, 519, 477, 734, 484, 465, 402, 477, 508, 477, 539,
]

const PRESENTATION_STXINGKAI = [
  244, 344, 302, 608, 736, 688, 490, 219, 333, 333, 323, 667, 333, 510, 333, 281, 438, 271, 438,
  510, 427, 427, 417, 437, 448, 458, 333, 333, 667, 667, 667, 323, 1010, 635, 552, 604, 646, 615,
  563, 563, 646, 438, 375, 656, 594, 833, 573, 573, 625, 646, 656, 646, 573, 625, 427, 698, 604,
  552, 542, 292, 281, 365, 469, 500, 333, 406, 323, 292, 417, 292, 271, 385, 365, 229, 281, 365,
  229, 552, 365, 313, 406, 375, 292, 312, 250, 385, 323, 490, 292, 375, 302, 417, 542, 417, 667,
]

const PRESENTATION_SOURCE_HAN_SANS = [
  224, 323, 474, 555, 555, 921, 680, 278, 338, 338, 467, 555, 278, 347, 278, 392, 555, 555, 555,
  555, 555, 555, 555, 555, 555, 555, 278, 278, 555, 555, 555, 474, 946, 608, 657, 638, 688, 589,
  552, 689, 728, 293, 535, 646, 543, 812, 723, 742, 633, 742, 635, 596, 599, 721, 575, 878, 573,
  531, 603, 338, 392, 338, 555, 559, 606, 563, 618, 510, 620, 554, 325, 564, 607, 275, 275, 552,
  284, 926, 610, 606, 620, 620, 388, 468, 377, 607, 521, 802, 498, 521, 475, 338, 270, 338, 555,
]

const PRESENTATION_STLITI = [
  244, 280, 220, 680, 440, 680, 780, 160, 260, 264, 420, 520, 220, 280, 220, 340, 440, 440, 440,
  440, 440, 440, 440, 440, 440, 440, 260, 240, 520, 520, 520, 380, 700, 620, 600, 520, 700, 620,
  580, 620, 680, 380, 400, 660, 580, 840, 700, 600, 540, 600, 600, 460, 500, 740, 640, 880, 560,
  560, 620, 240, 480, 320, 520, 500, 220, 420, 420, 340, 440, 340, 320, 400, 440, 240, 220, 440,
  240, 620, 460, 400, 440, 400, 300, 320, 320, 460, 440, 680, 420, 400, 440, 240, 520, 240, 520,
]

const PRESENTATION_STXIHEI = [
  250, 295, 309, 720, 554, 775, 757, 198, 369, 369, 425, 606, 277, 332, 277, 437, 554, 554, 554,
  554, 554, 554, 554, 554, 554, 554, 277, 277, 606, 606, 606, 591, 867, 740, 574, 813, 744, 536,
  485, 872, 683, 226, 482, 591, 462, 919, 740, 869, 592, 871, 607, 498, 426, 655, 702, 960, 609,
  592, 480, 351, 605, 351, 672, 500, 378, 683, 682, 647, 685, 650, 314, 673, 610, 200, 203, 502,
  200, 938, 610, 655, 682, 682, 301, 388, 339, 608, 554, 831, 480, 536, 425, 351, 672, 351, 606,
]

const PRESENTATION_STXINWEI = [
  244, 301, 331, 556, 569, 993, 701, 180, 352, 352, 500, 673, 285, 308, 285, 370, 588, 398, 569,
  569, 569, 569, 569, 569, 569, 569, 308, 308, 833, 833, 833, 396, 1000, 666, 588, 657, 729, 513,
  525, 734, 794, 294, 394, 623, 466, 951, 802, 838, 546, 838, 639, 431, 597, 752, 657, 1009, 657,
  595, 578, 352, 370, 352, 1000, 500, 500, 498, 558, 424, 579, 491, 310, 502, 551, 252, 264, 502,
  259, 851, 562, 600, 581, 567, 361, 343, 331, 546, 539, 822, 507, 522, 449, 352, 500, 352, 833,
]

/**
 * 华文新魏的上沿与下沿：WPS 演示 40 磅单行锚定顶端与锚定底端的基线位置只确定上沿与下沿之差（按中日韩字体换算后为
 * 0.5426 em），两者之和取 1.3 em（换算后为 1 em；换算后不超过 1.1 em 时排版结果相同）。
 */
const STXINWEI_EXTENT: readonly [number, number] = [921.28, 378.72]

export const WPS_METRIC_FONTS: ReadonlyMap<string, WpsMetricFont> = new Map<string, WpsMetricFont>([
  [
    'Arial Unicode MS',
    {
      latin: [1266.33, 475.94],
      eastAsia: null,
      writer: {
        ascii: ARIAL_UNICODE_MS,
        asciiDraw: 'Microsoft Sans Serif',
        other: 'Arial',
        fixed: false,
        emf: ['KSOF6398537F', 'KSOF987E8EC0', 'KSOFCD64CA01', 'KSOF024B0542'],
      },
      presentation: {
        ascii: PRESENTATION_ARIAL_UNICODE_MS,
        asciiDraw: 'Microsoft Sans Serif',
        other: '宋体',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'Helvetica',
    {
      latin: [953.33, 221.96],
      eastAsia: null,
      writer: {
        ascii: 'Arial',
        asciiDraw: 'Microsoft Sans Serif',
        other: 'Arial',
        fixed: false,
        emf: ['KSOF7FC4CF2A', 'KSOFB4AB0A6B', 'KSOFE99145AC', 'KSOF1E7780ED'],
      },
      presentation: {
        ascii: 'Arial',
        asciiDraw: 'Microsoft Sans Serif',
        other: '宋体',
        charset: null,
        eastAsianCodePage: false,
      },
    },
  ],
  [
    '楷体_GB2312',
    {
      latin: SONG_EXTENT,
      eastAsia: SONG_EXTENT,
      writer: {
        ascii: '宋体',
        asciiDraw: '黑体',
        other: '楷体',
        fixed: true,
        emf: ['KSOFF9CBECC6', 'KSOFF9CC6125', 'KSOFF9CCD584', 'KSOFF9CD49E3'],
      },
      presentation: {
        ascii: '宋体',
        asciiDraw: '宋体',
        other: '宋体',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '华文楷体',
    {
      latin: [1026.62, 429.34],
      eastAsia: [1026.62, 429.34],
      writer: {
        ascii: '宋体',
        asciiDraw: '宋体',
        other: '宋体',
        fixed: true,
        emf: null,
      },
      presentation: {
        ascii: PRESENTATION_STKAITI,
        asciiDraw: 'Yu Gothic UI',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'Arial Narrow',
    {
      latin: [933.63, 213.91],
      eastAsia: null,
      writer: {
        ascii: ARIAL_NARROW,
        asciiDraw: 'Calibri',
        other: 'Arial',
        fixed: false,
        emf: ['KSOF3D47F291', 'KSOF722E2DD2', 'KSOFA7146913', 'KSOFDBFAA454'],
      },
      presentation: {
        ascii: PRESENTATION_ARIAL_NARROW,
        asciiDraw: 'Calibri',
        other: '宋体',
        charset: null,
        eastAsianCodePage: false,
      },
    },
  ],
  [
    '仿宋_GB2312',
    {
      latin: SONG_EXTENT,
      eastAsia: SONG_EXTENT,
      writer: {
        ascii: '宋体',
        asciiDraw: '宋体',
        other: '仿宋',
        fixed: true,
        emf: ['KSOFE44F9426', 'KSOFE4500885', 'KSOFE4507CE4', 'KSOFE450F143'],
      },
      presentation: {
        ascii: '宋体',
        asciiDraw: '宋体',
        other: '仿宋',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '华文中宋',
    {
      latin: [1079.84, 399.1],
      eastAsia: [1079.84, 399.1],
      writer: {
        ascii: '宋体',
        asciiDraw: '宋体',
        other: '宋体',
        fixed: true,
        emf: null,
      },
      presentation: {
        ascii: PRESENTATION_STZHONGSONG,
        asciiDraw: 'Microsoft Sans Serif',
        other: '宋体',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '华文仿宋',
    {
      latin: [1025.64, 430.35],
      eastAsia: [1025.64, 430.35],
      writer: {
        ascii: STFANGSONG,
        asciiDraw: 'Palatino Linotype',
        other: '仿宋',
        fixed: true,
        emf: ['KSOF0B7949D1', 'KSOF0B79BE30', 'KSOF0B7A328F', 'KSOF0B7AA6EE'],
      },
      presentation: {
        ascii: PRESENTATION_STKAITI,
        asciiDraw: 'Cambria',
        other: '仿宋',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'Helvetica Neue',
    {
      latin: [982.06, 210.91],
      eastAsia: null,
      writer: {
        ascii: HELVETICA_NEUE,
        asciiDraw: 'Ebrima',
        other: 'Times New Roman',
        fixed: false,
        emf: ['KSOFE816CA0F', 'KSOF38C0A810', 'KSOF896A8611', 'KSOFDA146412'],
      },
      presentation: {
        ascii: PRESENTATION_HELVETICA_NEUE,
        asciiDraw: 'Ebrima',
        other: '宋体',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正大标宋简体',
    {
      latin: [1041.23, 443.03],
      eastAsia: [1041.23, 443.03],
      writer: {
        ascii: FZ_DABIAOSONG,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOF5FA7FF03', 'KSOF615CD7A2', 'KSOF6311B041', 'KSOF64C688E0'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_DABIAOSONG,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '隶书',
    {
      latin: SONG_EXTENT,
      eastAsia: SONG_EXTENT,
      writer: {
        ascii: '宋体',
        asciiDraw: '黑体',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOF4F9C2767', 'KSOF51510006', 'KSOF5305D8A5', 'KSOF54BAB144'],
      },
      presentation: {
        ascii: '宋体',
        asciiDraw: '黑体',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正小标宋简体',
    {
      latin: [1036.08, 487.31],
      eastAsia: [1036.08, 487.31],
      writer: {
        ascii: FZ_XIAOBIAOSONG,
        asciiDraw: 'Microsoft Sans Serif',
        other: '黑体',
        fixed: true,
        emf: ['KSOF439EEF50', 'KSOF439F63AF', 'KSOF439FD80E', 'KSOF43A04C6D'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_XIAOBIAOSONG,
        asciiDraw: 'Segoe UI Semibold',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正小标宋_GBK',
    {
      latin: [1039.08, 484.31],
      eastAsia: [1039.08, 484.31],
      writer: {
        ascii: FZ_XIAOBIAOSONG,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOF8080F95D', 'KSOF8235D1FC', 'KSOF83EAAA9B', 'KSOF859F833A'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_XIAOBIAOSONG,
        asciiDraw: 'Segoe UI Semibold',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正黑体_GBK',
    {
      latin: [1058.13, 398.86],
      eastAsia: [1058.13, 398.86],
      writer: {
        ascii: FZ_HEITI,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOFEC83043A', 'KSOFEE37DCD9', 'KSOFEFECB578', 'KSOFF1A18E17'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_HEITI_GBK,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正仿宋_GBK',
    {
      latin: [1025.33, 423.83],
      eastAsia: [1025.33, 423.83],
      writer: {
        ascii: FZ_FANGSONG_GBK,
        asciiDraw: 'Trebuchet MS',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOFD8A28030', 'KSOFDA5758CF', 'KSOFDC0C316E', 'KSOFDDC10A0D'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_FANGSONG_GBK,
        asciiDraw: '黑体',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正仿宋_GB2312',
    {
      latin: [1026.31, 422.82],
      eastAsia: [1026.31, 422.82],
      writer: {
        ascii: FZ_FANGSONG,
        asciiDraw: '宋体',
        other: '仿宋',
        fixed: true,
        emf: ['KSOFE8852770', 'KSOFE8859BCF', 'KSOFE886102E', 'KSOFE886848D'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_FANGSONG,
        asciiDraw: '宋体',
        other: '仿宋',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正楷体_GBK',
    {
      latin: [1019.93, 401.87],
      eastAsia: [1019.93, 401.87],
      writer: {
        ascii: FZ_KAITI_GBK,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOFF21A05E0', 'KSOFF3CEDE7F', 'KSOFF583B71E', 'KSOFF7388FBD'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_KAITI_GBK,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '华文行楷',
    {
      latin: [917.89, 448.08],
      eastAsia: [917.89, 448.08],
      writer: {
        ascii: STXINGKAI,
        asciiDraw: 'Trebuchet MS',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOF22E28EF3', 'KSOF24976792', 'KSOF264C4031', 'KSOF280118D0'],
      },
      presentation: {
        ascii: PRESENTATION_STXINGKAI,
        asciiDraw: 'MS UI Gothic',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '思源黑体',
    {
      latin: [1376.87, 505.12],
      eastAsia: [1376.87, 505.12],
      writer: {
        ascii: SOURCE_HAN_SANS,
        asciiDraw: 'Malgun Gothic',
        other: '黑体',
        fixed: true,
        emf: ['KSOF4CF9F437', 'KSOF4CFA6896', 'KSOF4CFADCF5', 'KSOF4CFB5154'],
      },
      presentation: {
        ascii: PRESENTATION_SOURCE_HAN_SANS,
        asciiDraw: 'Arial',
        other: '黑体',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'Source Han Sans CN Regular',
    {
      latin: [1289.64, 303.41],
      eastAsia: null,
      writer: {
        ascii: 'Segoe Print',
        asciiDraw: 'Segoe Print',
        other: 'Segoe Print',
        fixed: true,
        emf: null,
      },
      presentation: null,
    },
  ],
  [
    '华文隶书',
    {
      latin: [901.88, 413.07],
      eastAsia: [901.88, 413.07],
      writer: {
        ascii: STLITI,
        asciiDraw: 'Franklin Gothic Medium',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOF9F9B138E', 'KSOFA14FEC2D', 'KSOFA304C4CC', 'KSOFA4B99D6B'],
      },
      presentation: {
        ascii: PRESENTATION_STLITI,
        asciiDraw: 'Calibri',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '华文细黑',
    {
      latin: [1033.84, 369.11],
      eastAsia: [1033.84, 369.11],
      writer: {
        ascii: STXIHEI,
        asciiDraw: 'Segoe UI',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOF429D5CD3', 'KSOF44523572', 'KSOF46070E11', 'KSOF47BBE6B0'],
      },
      presentation: {
        ascii: PRESENTATION_STXIHEI,
        asciiDraw: 'Segoe UI Semibold',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正黑体简体',
    {
      latin: [1073.72, 453.63],
      eastAsia: [1073.72, 453.63],
      writer: {
        ascii: FZ_HEITI,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOFD7C1B938', 'KSOFD97691D7', 'KSOFDB2B6A76', 'KSOFDCE04315'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_HEITI,
        asciiDraw: 'Microsoft Sans Serif',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正仿宋简体',
    {
      latin: [1026.33, 422.93],
      eastAsia: [1049.95, 410.98],
      writer: {
        ascii: FZ_FANGSONG,
        asciiDraw: 'Trebuchet MS',
        other: '微软雅黑',
        fixed: true,
        emf: ['KSOF025BBAAE', 'KSOF0410934D', 'KSOF05C56BEC', 'KSOF077A448B'],
      },
      presentation: {
        ascii: PRESENTATION_FZ_FANGSONG,
        asciiDraw: '黑体',
        other: '微软雅黑',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '方正楷体简体',
    {
      latin: [1022.4, 395.61],
      eastAsia: [1022.4, 395.61],
      writer: {
        ascii: '宋体',
        asciiDraw: '宋体',
        other: '宋体',
        fixed: true,
        emf: null,
      },
      presentation: {
        ascii: PRESENTATION_FZ_KAITI,
        asciiDraw: 'Palatino Linotype',
        other: '宋体',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '华文宋体',
    {
      latin: [1023.52, 432.3],
      eastAsia: [1023.52, 432.3],
      writer: {
        ascii: '宋体',
        asciiDraw: '宋体',
        other: '宋体',
        fixed: true,
        emf: null,
      },
      presentation: {
        ascii: PRESENTATION_STKAITI,
        asciiDraw: 'Cambria',
        other: '宋体',
        charset: null,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'STKaiti',
    {
      latin: [1026.62, 429.34],
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STKAITI,
        asciiDraw: 'Cambria',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'STSong',
    {
      latin: [1023.52, 432.3],
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STKAITI,
        asciiDraw: 'Cambria',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'STFangsong',
    {
      latin: [1025.64, 430.35],
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STKAITI,
        asciiDraw: 'Cambria',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'STXihei',
    {
      latin: [1033.84, 369.11],
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STXIHEI,
        asciiDraw: 'Malgun Gothic',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'STZhongsong',
    {
      latin: [1079.84, 399.1],
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STZHONGSONG,
        asciiDraw: 'Microsoft Sans Serif',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'STXingkai',
    {
      latin: [917.89, 448.08],
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STXINGKAI,
        asciiDraw: 'Cambria',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    'STLiti',
    {
      latin: [901.88, 413.07],
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STLITI,
        asciiDraw: 'Cambria',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
  [
    '华文新魏',
    {
      latin: STXINWEI_EXTENT,
      eastAsia: null,
      writer: null,
      presentation: {
        ascii: PRESENTATION_STXINWEI,
        asciiDraw: 'Palatino Linotype',
        other: '宋体',
        charset: GB2312,
        eastAsianCodePage: true,
      },
    },
  ],
])
