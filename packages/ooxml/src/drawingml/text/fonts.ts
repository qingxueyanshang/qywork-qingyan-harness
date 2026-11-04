/**
 * DrawingML 文字的绘制用字体：调用方按字体名提供字体文件的度量与浏览器中注册的族名（`FontSource`），本模块按字形缓存并处理仿粗体。
 *
 * - 排版宽度只取自字体文件（`../../text/`），绘制时以 `family` 引用调用方注册的同名 `FontFace`。
 * - 主机没有的符号字体名改用 `MISSING_SYMBOL` 中的字体；演示文稿另按 WPS 演示的替代规则（自带度量的字体与前缀匹配，见
 *   `FaceCache` 的 `presentation`）。其余主机没有的字体与空字体名改用 `fallback`，西文字体例外（`missingLatin`）；请求粗体
 *   而返回的不是粗体字形时按仿粗体排版（`emboldened`），绘制时由浏览器合成粗体。
 * - 每个绘制字形（字体文件、族名、请求的粗体与斜体）有自己的排版字体对象，`FaceCache.of` 按对象取回：合成斜体与正体的度量
 *   相同，共用一个对象时排版结果无法区分两者。
 * - 行高与字体无关：WPS 演示的单倍行高为字号的 `SINGLE_LINE` 倍（其他宿主由 `FaceCache` 的参数给出），
 *   字体的纵向中心位于行顶以下 `CENTER_OTHER`、`CENTER_EAST_ASIAN` 或 `slideCenterEastAsian` 倍字号。
 *   排版前把每个字体的纵向度量换算为满足这两点的上下沿（`lineFace`），排版模块的行高与基线即按此计算；
 *   中日韩字体不再乘 1.3，也不加外部行距。
 * - `collectTextFonts` 收集文本框用到的字体名（含按 `charset` 的西文替代字体）；调用方据此并加上 `MISSING_LATIN`
 *   预先取得字体，演示文稿另加 `presentationFontNames`。
 * - 屏幕显示的字形（`ScreenText`、`TextClearType`）由宿主提供：不平滑字号的单色字形与平滑字号的 ClearType 字形。
 */

import type { BitmapGlyph } from '../../font/index.ts'
import type { CoverageGlyph, GlyphRun, PixelCanvas } from '../../glyph/cleartype/index.ts'
import { MATH_SETTINGS_DEFAULTS, mathPropsOf } from '../../math/index.ts'
import {
  emboldened,
  type FontMatch,
  type FontSource,
  type HostFamilies,
  prefixFont,
  type TextFace,
  WPS_METRIC_FONTS,
  wpsMetricFontNames,
  wpsPresentationFace,
} from '../../text/index.ts'
import type { PaintContext } from '../paint/context.ts'
import type { Bullet, RunStyle, TextBody } from './model.ts'

/** 字体 `usWinAscent`、`usWinDescent` 与 `unitsPerEm` 之比，以及该字体的纵向中心系数（见 `lineFace`）。 */
export interface FaceLine {
  readonly ascent: number
  readonly descent: number
  readonly center: number
  /**
   * 竖排中直立的字在字框中转回直立时，旋转中心在基线以上的距离与字号之比：`OS/2` 的 `sTypoAscender` 与 `sTypoDescender`
   * 的中点。WPS 演示实测（`eaVert`，20、32、48 磅「国」的列位置）：Microsoft JhengHei、Yu Gothic、Noto Sans SC 的列中心与
   * typo 中点相差不超过 1 像素（与 win 中点相差 1–4 像素），微软雅黑与 Yu Gothic UI 与 typo 中点相差 1–3 像素（与 win 中点
   * 相差 3–9 像素）；`USE_TYPO_METRICS` 均未设置。宋体、MS Gothic、等线的两种中点相同。
   */
  readonly upright: number
  /**
   * 单倍行距时字体下沿距行顶的距离与字号之比：上下沿以纵向中心为中点，中心取 `CENTER_OTHER`，东亚字体取
   * `BOTTOM_CENTER_EAST_ASIAN`；设置了 `USE_TYPO_METRICS` 的字体按 typo 上下沿，其余按 win 上下沿。只用于锚定（见
   * `body.ts` 的 `anchorOverhang`）。
   */
  readonly bottom: number
}

/** 排版与绘制共用的字形：`face` 已按仿粗体换算；`bold`、`italic` 为请求的字形，绘制时写入 `ctx.font`。 */
export interface PaintFace {
  readonly face: TextFace
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
  /** 换算前的纵向度量：多种字体同行时的基线按此求出（`body.ts` 的 `singleLine`）。 */
  readonly line: FaceLine
}

/**
 * 单倍行高与字号之比，与字体无关。实测：WPS 演示导出图中等线、等线 Light、黑体、宋体、微软雅黑、Arial 10–32 磅
 * 单倍、150%、80% 与 30 磅固定行距的逐行位置。不要按 `spAutoFit` 文本框保存的高度（约 1.21 倍字号）取值：
 * 按 1.21 计算时，16 磅以上的第 4 行低 1 像素。一行内字号或字体不同时取最大字号。
 */
export const SINGLE_LINE = 1.2
/**
 * 字体纵向中心（`usWinAscent` 与 `usWinDescent` 的中点）距行顶的距离与字号之比，按 `eastAsianCodePage` 分两组。
 * 经验拟合（机制未查明）：WPS 演示导出图与 WPS 表格形状文字的首行位置，Arial、Calibri、Times New Roman、Segoe UI、
 * Cambria、Verdana、Tahoma、Georgia 9–32 磅取 0.6012；东亚字体取 0.5825（屏幕显示时宋体、微软雅黑、等线 9–28 磅），
 * 演示文稿中上下沿较高的东亚字体见 `slideCenterEastAsian`。不要合为一个值：两组相差约 0.019 倍字号，
 * 11 磅以上西文字体的首行高 1 像素。
 */
const CENTER_EAST_ASIAN = 0.5825
const CENTER_OTHER = 0.6012
/**
 * 东亚字体按单倍行距的下沿（`FaceLine.bottom`）所用的纵向中心系数。经验拟合（机制未查明）：WPS 演示导出图中锚定底端与居中
 * 的单行，微软雅黑、Noto Sans SC、Microsoft JhengHei、Malgun Gothic、Yu Gothic 40 与 80 磅，下沿按 0.626 + H / 2
 * 计算时误差不超过 1 像素（H 为 win 上下沿之和与 em 之比）；西文字体（10 种，20–80 磅）为 `CENTER_OTHER` + H / 2。
 * 不要改为与基线相同的 `slideCenterEastAsian`：微软雅黑 80 磅锚定底端时文字低约 5 像素。
 */
const BOTTOM_CENTER_EAST_ASIAN = 0.626

/**
 * 演示文稿中代码页含中日韩的字体的纵向中心系数：0.5825 − 0.03 × max(0, H − 1.1)，H 为 `(usWinAscent + usWinDescent) /
 * unitsPerEm`。实测（WPS 演示导出图，10–32 磅单倍、150%、80% 与固定行距的逐行位置）：宋体、黑体、仿宋、楷体、MS Gothic
 * （H 为 1.00）、等线（1.04）、Yu Gothic（1.29）、微软雅黑（1.32）、Microsoft JhengHei 与 Malgun Gothic（1.33）、
 * Noto Sans SC（1.45）的 668 行中 667 行一致；取常数 0.5825 时 H 大于 1.2 的字体有 30 行低 1 像素。
 * 1.04 与 1.29 之间没有实测字体，转折点 1.1 取在其间。
 */
function slideCenterEastAsian(v: TextFace['vertical']): number {
  return CENTER_EAST_ASIAN - 0.03 * Math.max(0, (v.winAscent + v.winDescent) / v.unitsPerEm - 1.1)
}

/**
 * 主机没有西文字体、其 `charset` 不在 `MISSING_LATIN_BY_CHARSET` 中时，西文字符改用的字体；主机也没有该字体时用
 * `fallback`。实测：WPS 演示导出图中，11 个不存在的西文字体名（东亚字体为宋体、微软雅黑、楷体、黑体、仿宋或同样不存在，
 * 语言为中文或英文，`charset` 为 0 或未写）的西文字符一律以 Segoe Print 绘制，粗体取其粗体字形，均不取东亚字体；
 * `charset` 为 1（DEFAULT）与 2（SYMBOL）时同样为 Segoe Print。演示文稿中先于本规则的替代见 `FaceCache.latin`。
 */
export const MISSING_LATIN = 'Segoe Print'

/**
 * 主机没有西文字体时按其 `charset`（换算为 GDI 字符集的无符号值）改用的字体。WPS 演示实测（构造文件，不存在的西文字体名，
 * 东亚字体为宋体，20 磅，按各词起点与字形比对）：GB2312（-122，`pitchFamily` 为 18、34、49 时相同）为宋体，SHIFTJIS（-128）
 * 为 Yu Gothic，HANGUL（-127）为 Malgun Gothic，CHINESEBIG5（-120）为 MingLiU-ExtB。
 */
const MISSING_LATIN_BY_CHARSET: ReadonlyMap<number, string> = new Map([
  [134, '宋体'],
  [128, 'Yu Gothic'],
  [129, 'Malgun Gothic'],
  [136, 'MingLiU-ExtB'],
])

/**
 * 主机没有的符号字体名改用的字体，项目符号与字段相同。WPS 演示实测（构造文件，`pitchFamily` 为 18、`charset` 为 2）：
 * Wingdings 2 的 6 个常用项目符号字符（U+F097、U+00A1、U+F096、U+00DE、U+00DF、U+F09E）与字段文字都以 Wingdings 中
 * 同一码位的字形绘制，ZapfDingbats 与 Monotype Sorts 同样取 Wingdings；Wingdings 3 取 Symbol（U+F075 显示为 υ）。
 */
const MISSING_SYMBOL: ReadonlyMap<string, string> = new Map([
  ['Wingdings 2', 'Wingdings'],
  ['ZapfDingbats', 'Wingdings'],
  ['Monotype Sorts', 'Wingdings'],
  ['Wingdings 3', 'Symbol'],
])

/** `charset` 的 GB2312 字符集（无符号值）。 */
const GB2312_CHARSET = 134

/** `charset` 换算为 GDI 字符集的无符号值。 */
function unsignedCharset(charset: number): number {
  return ((charset % 256) + 256) % 256
}

/** 主机没有 `charset` 为该值的西文字体时，西文字符改用的字体名。 */
export function missingLatin(charset: number | undefined): string {
  if (charset === undefined) return MISSING_LATIN
  return MISSING_LATIN_BY_CHARSET.get(unsignedCharset(charset)) ?? MISSING_LATIN
}

/** WPS 演示的前缀匹配（`prefixFont`）：名称去掉首尾空白，不区分大小写。 */
function presentationPrefix(name: string, host: HostFamilies): string | null {
  return prefixFont(name.trim(), host.local, true)
}

/**
 * 主机没有 `name` 时 WPS 演示的替代规则可能用到的主机字体名：自带度量的字体所需的字体（`wpsMetricFontNames`）与前缀匹配的
 * 结果；主机有该字体名时为空。调用方据此预先取得字体。
 */
export function presentationFontNames(name: string, host: HostFamilies): string[] {
  if (host.names.includes(name.trim().toLowerCase())) return []
  const metric = WPS_METRIC_FONTS.get(name)?.presentation ?? null
  const names = metric === null ? [] : wpsMetricFontNames(metric)
  const prefix = presentationPrefix(name, host)
  if (prefix !== null) names.push(prefix)
  return names
}

/** 纵向度量换算为上沿、下沿之和为 `single` 倍字号、纵向中心距行顶 `center` 倍字号的度量。 */
export function lineFace(face: TextFace, single: number, center: number): TextFace {
  const v = face.vertical
  const u = v.unitsPerEm
  const ascent = u * center + (v.winAscent - v.winDescent) / 2
  const descent = u * single - ascent
  return {
    metrics: face.metrics,
    vertical: {
      ...v,
      winAscent: ascent,
      winDescent: descent,
      hheaAscender: ascent,
      hheaDescender: -descent,
      hheaLineGap: 0,
      eastAsianCodePage: false,
    },
  }
}

/** 单色字形与该字号的上下沿（GDI 的 `tmAscent`、`tmDescent`，超出的行不绘制）。 */
export interface ScreenGlyph {
  readonly glyph: BitmapGlyph
  readonly ascent: number
  readonly descent: number
}

/**
 * 按屏幕显示（GDI）排版与绘制的规则，WPS 表格的形状文字使用，演示文稿不使用（`FaceCache` 缺省为 `null`）。
 * 行高与基线见 `body.ts` 的 `hostBlock`；绘制时基线取整到设备像素，`bitmap` 返回单色字形的字按该字形逐像素绘制。
 * 只按屏幕显示绘制而不改变排版时作为 `FaceCache` 的 `glyphs` 传入（图表文字与演示文稿的全部文字）。
 */
export interface ScreenText {
  /**
   * 字在 `ppem`（设备像素字号）下不平滑绘制时返回单色字形（点阵、提示后的轮廓或合成斜体的倾斜轮廓，见
   * `EmbeddedBitmaps.glyph`），否则为 `null`；合成粗体的加粗由实现方完成。
   */
  bitmap(face: PaintFace, codePoint: number, ppem: number): ScreenGlyph | null
}

/** ClearType 字形与该字号的上下沿（GDI 的 `tmAscent`、`tmDescent`，超出的行不绘制）。 */
export interface ClearTypeGlyph {
  readonly glyph: CoverageGlyph
  readonly ascent: number
  readonly descent: number
}

/**
 * 平滑字号按 ClearType 绘制（WPS 经 GDI 的屏幕显示，见 `../../glyph/cleartype/`）：`ScreenText.bitmap` 返回 `null` 的字
 * 按 `glyph` 的覆盖写入 `target` 的像素。只用于 `target`：画到图层（文字阴影、三维效果、带阴影的组合）上的文字以
 * `fillText` 绘制，图层透明，按底色混合的像素没有底色。
 * - 每段文字的字形段交给 `paint`；实现方可以暂存，在 `flush` 时一并混合：每次读写像素都要先完成此前的全部绘制，
 *   读写的次数决定绘制耗时。`paintBody` 在自己的非文字绘制（底纹、阴影、非纯色填充、轮廓、下划线）与
 *   `fillText`、点阵字形之前调用 `flush`；暂存的实现方须在其余非文字绘制之前调用 `flush`。
 */
export interface TextClearType {
  /** 不透明的目标画布的绘制上下文；像素按设备坐标读写，不受变换与裁剪路径影响。 */
  readonly target: PaintContext & PixelCanvas
  /**
   * 字在 `ppem`（设备像素字号）下的 ClearType 字形；字体没有 TrueType 轮廓或没有该字时为 `null`（以 `fillText` 绘制）。
   * 合成粗体与合成斜体由实现方完成。
   */
  glyph(face: PaintFace, codePoint: number, ppem: number): ClearTypeGlyph | null
  /** 混合（或暂存）一段文字的字形段，按顺序。 */
  paint(runs: readonly GlyphRun[]): void
  /** 混合暂存的字形段；没有时不读写像素。 */
  flush(): void
}

export class FaceCache {
  private readonly lines = new Map<TextFace, { readonly face: TextFace; readonly line: FaceLine }>()
  private readonly faces = new Map<string, PaintFace>()
  /** 换算后的字体文件 → 族名与请求的字形 → 绘制字形。 */
  private readonly variants = new Map<TextFace, Map<string, PaintFace>>()
  private readonly byFace = new Map<TextFace, PaintFace>()
  /** WPS 演示按数据表排版的西文字段（`metricLatin`），键为字体名与请求的字形。 */
  private readonly metrics = new Map<string, PaintFace | null>()
  readonly fallback: PaintFace

  /**
   * `single` 为单倍行高与字号之比，缺省为 `SINGLE_LINE`（演示文稿）；`screen` 见 `ScreenText`，同时决定排版与绘制。
   * `glyphs` 只决定绘制（基线取整与点阵），缺省与 `screen` 相同；`screen` 为 `null` 而 `glyphs` 不为 `null` 时
   * 行高、基线与纵向中心仍按演示文稿的规则。`clearType` 只决定绘制，`glyphs` 为 `null` 时不使用；缺省为 `null`
   * （平滑字号以 `fillText` 绘制）。`wholeSizeLine` 为真时单倍行高按行内最大字号的整数部分计算（见 `body.ts` 的
   * `singleLine`），缺省与是否按屏幕显示排版相同。`presentation` 为主机字体的族名时，主机没有的字体名按 WPS 演示的规则
   * 替代（见 `find`、`latin`）；缺省为 `null`，不做这些替代（WPS 表格与 WPS 文字的图形文字，未实测）。
   */
  constructor(
    private readonly source: FontSource,
    private readonly single = SINGLE_LINE,
    readonly screen: ScreenText | null = null,
    readonly glyphs: ScreenText | null = screen,
    readonly clearType: TextClearType | null = null,
    readonly wholeSizeLine: boolean = screen !== null,
    private readonly presentation: HostFamilies | null = null,
  ) {
    this.fallback = this.variant(source.fallback, false, false)
  }

  /** 同一字体文件只换算一次：排版模块按对象判定字体是否相同。 */
  private line(face: TextFace): { readonly face: TextFace; readonly line: FaceLine } {
    let out = this.lines.get(face)
    if (out === undefined) {
      const v = face.vertical
      const center = !v.eastAsianCodePage
        ? CENTER_OTHER
        : this.screen === null
          ? slideCenterEastAsian(v)
          : CENTER_EAST_ASIAN
      out = {
        face: lineFace(face, this.single, center),
        line: {
          ascent: v.winAscent / v.unitsPerEm,
          descent: v.winDescent / v.unitsPerEm,
          center,
          upright: (v.typoAscender + v.typoDescender) / 2 / v.unitsPerEm,
          bottom:
            (v.eastAsianCodePage ? BOTTOM_CENTER_EAST_ASIAN : CENTER_OTHER) +
            (v.useTypoMetrics ? v.typoAscender - v.typoDescender : v.winAscent + v.winDescent) /
              2 /
              v.unitsPerEm,
        },
      }
      this.lines.set(face, out)
    }
    return out
  }

  /**
   * 字体文件 `base` 按请求的粗体与斜体绘制时的绘制字形。每个绘制字形的 `face` 是新建的对象，`byFace` 中一个对象只登记一次：
   * 不要让两个绘制字形共用换算后的字体对象，`of` 按对象取回绘制字形。
   */
  private variant(base: FontMatch, bold: boolean, italic: boolean): PaintFace {
    const converted = this.line(base.face)
    let styles = this.variants.get(converted.face)
    if (styles === undefined) {
      styles = new Map()
      this.variants.set(converted.face, styles)
    }
    const key = `${bold ? 1 : 0}${italic ? 1 : 0}${base.family}`
    let f = styles.get(key)
    if (f === undefined) {
      const c = converted.face
      const face = bold && !base.bold ? emboldened(c) : { metrics: c.metrics, vertical: c.vertical }
      f = { face, family: base.family, bold, italic, line: converted.line }
      styles.set(key, f)
      this.byFace.set(face, f)
    }
    return f
  }

  /** 字体名对应的主机字体：主机没有时取 `MISSING_SYMBOL` 中的替代字体，都没有时为 `null`。 */
  private hostFont(name: string, bold: boolean, italic: boolean): FontMatch | null {
    if (name === '') return null
    const found = this.source.face(name, bold, italic)
    if (found !== null) return found
    const symbol = MISSING_SYMBOL.get(name)
    return symbol === undefined ? null : this.source.face(symbol, bold, italic)
  }

  /**
   * 字体名对应的字体（`hostFont`）。按 WPS 演示的规则时，主机没有该字体名再取自带度量的字体的 `other`（东亚字段按该字体
   * 本身排版，见 `WpsPresentationFont`），不是自带度量的字体名时取前缀匹配的主机字体。都没有时为 `null`。
   */
  private find(name: string, bold: boolean, italic: boolean): FontMatch | null {
    const found = this.hostFont(name, bold, italic)
    if (found !== null || this.presentation === null || name === '') return found
    const metric = WPS_METRIC_FONTS.get(name)?.presentation ?? null
    if (metric !== null) return this.hostFont(metric.other, bold, italic)
    const prefix = presentationPrefix(name, this.presentation)
    return prefix === null ? null : this.hostFont(prefix, bold, italic)
  }

  get(name: string, bold: boolean, italic: boolean): PaintFace {
    const key = `${name}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`
    let f = this.faces.get(key)
    if (f === undefined) {
      f = this.variant(this.find(name, bold, italic) ?? this.source.fallback, bold, italic)
      this.faces.set(key, f)
    }
    return f
  }

  /**
   * 西文字符的字体，`slot` 为字段中的位置（`fontSlot` 的 `ascii` 或 `hAnsi`）。主机没有 `name`（及其替代的符号字体）时取
   * `missingLatin(charset)`；按 WPS 演示的规则时在此之前依次取按数据表的排版（`metricLatin`）与前缀匹配的主机字体（`charset`
   * 为 GB2312 时不做前缀匹配）。
   * WPS 演示实测（构造文件 p10-d，与参照行逐像素相同）：`charset` 为 0 或未写时 `Calibri Light Fake` 为 Calibri、`Courier`
   * 为 Courier New，为 GB2312 时两者都为宋体。名称含「黑」「楷」的字体名 WPS 演示另取黑体或宋体（`微软雅黑 Fake` 为黑体，
   * `华文楷体 Fake` 为宋体，先于前缀匹配），本方未实现。
   */
  latin(
    name: string,
    charset: number | undefined,
    bold: boolean,
    italic: boolean,
    slot: 'ascii' | 'hAnsi' = 'ascii',
  ): PaintFace {
    if (this.hostFont(name, false, false) !== null) return this.get(name, bold, italic)
    if (this.presentation === null) return this.get(missingLatin(charset), bold, italic)
    const metric = this.metricLatin(name, charset, bold, italic, slot)
    if (metric !== null) return metric
    const gb2312 = charset !== undefined && unsignedCharset(charset) === GB2312_CHARSET
    const prefix = gb2312 ? null : presentationPrefix(name, this.presentation)
    return this.get(prefix ?? missingLatin(charset), bold, italic)
  }

  /**
   * WPS 演示按数据表排版的西文字段：`ascii` 位置按 `wpsPresentationFace` 排版、以 `asciiDraw` 绘制；`hAnsi` 位置（U+0080 起
   * 的字符）按 `other` 本身排版与绘制，与东亚字段相同。该字体名不在数据表中、`charset` 不符或主机缺少所需的字体时为 `null`。
   * 不要让 `hAnsi` 位置取数据表的度量或 `asciiDraw`：真值中 STKaiti 字段的「“”……」与宋体的字形与位置逐像素相同，取数据表的
   * 上下沿时整行高 2 像素，以 `asciiDraw` 绘制时为西文省略号。
   */
  private metricLatin(
    name: string,
    charset: number | undefined,
    bold: boolean,
    italic: boolean,
    slot: 'ascii' | 'hAnsi',
  ): PaintFace | null {
    const font = WPS_METRIC_FONTS.get(name)
    const host = font?.presentation ?? null
    if (font === undefined || host === null) return null
    if (
      host.charset !== null &&
      (charset === undefined || unsignedCharset(charset) !== host.charset)
    )
      return null
    if (slot === 'hAnsi')
      return this.hostFont(host.other, bold, italic) === null
        ? null
        : this.get(host.other, bold, italic)
    const key = `${name}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`
    let f = this.metrics.get(key)
    if (f === undefined) {
      const draw = this.hostFont(host.asciiDraw, bold, italic)
      const other = this.hostFont(host.other, bold, italic)
      const ascii = typeof host.ascii === 'string' ? this.hostFont(host.ascii, bold, italic) : null
      f =
        draw === null || other === null || (typeof host.ascii === 'string' && ascii === null)
          ? null
          : this.variant(
              {
                face: wpsPresentationFace(font, host, other.face, ascii?.face ?? null, draw.face),
                family: draw.family,
                bold: draw.bold,
              },
              bold,
              italic,
            )
      this.metrics.set(key, f)
    }
    return f
  }

  /** 排版结果中的字形对应的绘制信息。 */
  of(face: TextFace): PaintFace {
    return this.byFace.get(face) ?? this.fallback
  }
}

/** 字体名及其替代的符号字体（`MISSING_SYMBOL`）加入 `out`，不含空串。 */
function addName(out: Set<string>, name: string): void {
  if (name === '') return
  out.add(name)
  const symbol = MISSING_SYMBOL.get(name)
  if (symbol !== undefined) out.add(symbol)
}

function addRun(out: Set<string>, s: RunStyle): void {
  for (const name of [s.latin, s.ea, s.cs, s.sym]) addName(out, name)
  if (s.latinCharset !== undefined) out.add(missingLatin(s.latinCharset))
}

function addBullet(out: Set<string>, b: Bullet): void {
  if (b.kind === 'char' || b.kind === 'number') addName(out, b.font)
}

/**
 * 文本框用到的字体名加入 `out`：各字段、段落结束符与项目符号的字体及其替代的符号字体，有公式时另加公式各字段的字体与数学字体，
 * 不含空串。
 */
export function collectTextFonts(out: Set<string>, t: TextBody): void {
  for (const p of t.paragraphs) {
    addBullet(out, p.bullet)
    addRun(out, p.end)
    for (const r of p.runs) {
      addRun(out, r.style)
      if (r.kind !== 'math') continue
      out.add(MATH_SETTINGS_DEFAULTS.font)
      for (const zone of r.zones) for (const s of mathPropsOf(zone)) addRun(out, s)
    }
  }
}
