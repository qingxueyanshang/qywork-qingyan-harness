/**
 * DrawingML 文字的绘制用字体：调用方按字体名提供字体文件的度量与浏览器中注册的族名，本模块按字形缓存并处理仿粗体。
 *
 * - 排版宽度只取自字体文件（`../../text/`），绘制时以 `family` 引用调用方注册的同名 `FontFace`。
 * - 主机没有的字体与空字体名改用 `fallback`，西文字体例外（`MISSING_LATIN`）；请求粗体而返回的不是粗体字形时
 *   按仿粗体排版（`emboldened`），绘制时由浏览器合成粗体。
 * - 行高与字体无关：WPS 演示的单倍行高为字号的 `SINGLE_LINE` 倍（其他宿主由 `FaceCache` 的参数给出），
 *   字体的纵向中心位于行顶以下 `CENTER_OTHER`、`CENTER_EAST_ASIAN` 或 `slideCenterEastAsian` 倍字号。
 *   排版前把每个字体的纵向度量换算为满足这两点的上下沿（`lineFace`），排版模块的行高与基线即按此计算；
 *   中日韩字体不再乘 1.3，也不加外部行距。
 * - `collectTextFonts` 收集文本框用到的字体名；调用方据此并加上 `MISSING_LATIN` 预先取得字体。
 * - 屏幕显示的字形（`ScreenText`、`TextClearType`）由宿主提供：不平滑字号的单色字形与平滑字号的 ClearType 字形。
 */

import type { BitmapGlyph } from '../../font/index.ts'
import type { CoverageGlyph, GlyphRun, PixelCanvas } from '../../glyph/cleartype/index.ts'
import { emboldened, type TextFace } from '../../text/index.ts'
import type { PaintContext } from '../paint/context.ts'
import type { Bullet, RunStyle, TextBody } from './model.ts'

export interface SlideFont {
  readonly face: TextFace
  /** CSS 族名，与调用方注册的 `FontFace` 族名相同。 */
  readonly family: string
  /** 返回的是粗体字形；请求粗体而该项为 `false` 时按仿粗体排版。 */
  readonly bold: boolean
  readonly italic: boolean
}

export interface SlideFontSource {
  /** 按字体名与字形取得最接近的字体；主机没有该字体时返回 `null`。 */
  face(name: string, bold: boolean, italic: boolean): SlideFont | null
  /** 缺少字体与缺少字形时使用的字体（常规字形）。 */
  readonly fallback: SlideFont
}

/** 字体 `usWinAscent`、`usWinDescent` 与 `unitsPerEm` 之比，以及该字体的纵向中心系数（见 `lineFace`）。 */
export interface FaceLine {
  readonly ascent: number
  readonly descent: number
  readonly center: number
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
 * 主机没有西文字体时，西文字符改用的字体；主机也没有该字体时用 `fallback`。实测：WPS 演示导出图中，11 个不存在的
 * 西文字体名（东亚字体为宋体、微软雅黑、楷体、黑体、仿宋或同样不存在，语言为中文或英文，`charset` 为 0 或未写）
 * 的西文字符一律以 Segoe Print 绘制，粗体取其粗体字形，均不取东亚字体。
 * 不符合本规则的情况：`charset="-122"` 的缺失字体 WPS 取宋体；名称包含已安装字体的家族名时
 * （如 `Calibri Fake`、`思源黑体 CN Fake`）WPS 取该字体；`Helvetica Neue` 等个别名称 WPS 取其他字体。
 * 模型不保留 `charset`，字体来源也不列出主机字体，这些情况按本规则处理。
 */
export const MISSING_LATIN = 'Segoe Print'

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
  private readonly byFace = new Map<TextFace, PaintFace>()
  readonly fallback: PaintFace

  /**
   * `single` 为单倍行高与字号之比，缺省为 `SINGLE_LINE`（演示文稿）；`screen` 见 `ScreenText`，同时决定排版与绘制。
   * `glyphs` 只决定绘制（基线取整与点阵），缺省与 `screen` 相同；`screen` 为 `null` 而 `glyphs` 不为 `null` 时
   * 行高、基线与纵向中心仍按演示文稿的规则。`clearType` 只决定绘制，`glyphs` 为 `null` 时不使用；缺省为 `null`
   * （平滑字号以 `fillText` 绘制）。`wholeSizeLine` 为真时单倍行高按行内最大字号的整数部分计算（见 `body.ts` 的
   * `singleLine`），缺省与是否按屏幕显示排版相同。
   */
  constructor(
    private readonly source: SlideFontSource,
    private readonly single = SINGLE_LINE,
    readonly screen: ScreenText | null = null,
    readonly glyphs: ScreenText | null = screen,
    readonly clearType: TextClearType | null = null,
    readonly wholeSizeLine: boolean = screen !== null,
  ) {
    const fallback = this.line(source.fallback.face)
    this.fallback = this.register({
      face: fallback.face,
      family: source.fallback.family,
      bold: false,
      italic: false,
      line: fallback.line,
    })
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
        },
      }
      this.lines.set(face, out)
    }
    return out
  }

  private register(f: PaintFace): PaintFace {
    this.byFace.set(f.face, f)
    return f
  }

  get(name: string, bold: boolean, italic: boolean): PaintFace {
    const key = `${name}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`
    let f = this.faces.get(key)
    if (f === undefined) {
      const found = name === '' ? null : this.source.face(name, bold, italic)
      const base = found ?? this.source.fallback
      const converted = this.line(base.face)
      f = this.register({
        face: bold && !base.bold ? emboldened(converted.face) : converted.face,
        family: base.family,
        bold,
        italic,
        line: converted.line,
      })
      this.faces.set(key, f)
    }
    return f
  }

  /** 西文字符的字体：主机没有 `name` 时取 `MISSING_LATIN`。 */
  latin(name: string, bold: boolean, italic: boolean): PaintFace {
    const found = name !== '' && this.source.face(name, false, false) !== null
    return this.get(found ? name : MISSING_LATIN, bold, italic)
  }

  /** 排版结果中的字形对应的绘制信息。 */
  of(face: TextFace): PaintFace {
    return this.byFace.get(face) ?? this.fallback
  }
}

function addRun(out: Set<string>, s: RunStyle): void {
  for (const name of [s.latin, s.ea, s.cs, s.sym]) if (name !== '') out.add(name)
}

function addBullet(out: Set<string>, b: Bullet): void {
  if ((b.kind === 'char' || b.kind === 'number') && b.font !== '') out.add(b.font)
}

/** 文本框用到的字体名加入 `out`：各字段、段落结束符与项目符号的字体，不含空串。 */
export function collectTextFonts(out: Set<string>, t: TextBody): void {
  for (const p of t.paragraphs) {
    addBullet(out, p.bullet)
    addRun(out, p.end)
    for (const r of p.runs) addRun(out, r.style)
  }
}
