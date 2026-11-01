/**
 * DrawingML 文字的绘制用字体：调用方按字体名提供字体文件的度量与浏览器中注册的族名，本模块按字形缓存并处理仿粗体。
 *
 * - 排版宽度只取自字体文件（`../../text/`），绘制时以 `family` 引用调用方注册的同名 `FontFace`。
 * - 主机没有的字体与空字体名改用 `fallback`，西文字体例外（`MISSING_LATIN`）；请求粗体而返回的不是粗体字形时
 *   按仿粗体排版（`emboldened`），绘制时由浏览器合成粗体。
 * - 行高与字体无关：WPS 演示的单倍行高为字号的 `SINGLE_LINE` 倍（其他宿主由 `FaceCache` 的参数给出），
 *   字体的纵向中心位于行顶以下 `CENTER` 倍字号（屏幕显示时见 `SCREEN_CENTER_EAST_ASIAN`）。
 *   排版前把每个字体的纵向度量换算为满足这两点的上下沿（`lineFace`），排版模块的行高与基线即按此计算；
 *   中日韩字体不再乘 1.3，也不加外部行距。
 * - `collectTextFonts` 收集文本框用到的字体名；调用方据此并加上 `MISSING_LATIN` 预先取得字体。
 */

import type { BitmapGlyph } from '../../font/index.ts'
import { emboldened, type TextFace } from '../../text/index.ts'
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

/** 排版与绘制共用的字形：`face` 已按仿粗体换算；`bold`、`italic` 为请求的字形，绘制时写入 `ctx.font`。 */
export interface PaintFace {
  readonly face: TextFace
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
}

/**
 * 单倍行高与字号之比，与字体无关。实测：WPS 保存的 `spAutoFit` 文本框，宋体、黑体、微软雅黑、优设标题黑、
 * Noto Sans SC 16–36 磅单倍行距的文字区域高度均为行数 × 字号 × 1.210–1.212；120% 行距为 1.2 × 1.21 × 字号；
 * 一行内字号或字体不同时取最大字号，不因字体组合增高。
 */
export const SINGLE_LINE = 1.21
/**
 * 字体纵向中心（`usWinAscent` 与 `usWinDescent` 的中点）距行顶的距离与字号之比。实测：对照 WPS 导出图中
 * 13 种字体 16–166 磅单行文字的位置，各字体为 0.567–0.596，中位数 0.578。
 */
export const CENTER = 0.578
/**
 * 屏幕显示（`FaceCache.screen` 不为 `null`）时代替 `CENTER` 的比例，按 `eastAsianCodePage` 分两组。经验拟合（机制未查明）：
 * 对照 WPS 表格形状文字的首行位置，宋体、微软雅黑、等线 9–28 磅取 0.5825，Arial、Calibri、Times New Roman 9–28 磅取 0.6012，
 * 各字体的最佳值与所在组相差不超过 0.002。不要合为一个值：两组相差约 0.019 倍字号，11 磅以上西文字体的首行高 1 像素。
 */
const SCREEN_CENTER_EAST_ASIAN = 0.5825
const SCREEN_CENTER_OTHER = 0.6012

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
export function lineFace(face: TextFace, single = SINGLE_LINE, center = CENTER): TextFace {
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

/** 内嵌点阵字形与该字号的上下沿（GDI 的 `tmAscent`、`tmDescent`，超出的行不绘制）。 */
export interface ScreenGlyph {
  readonly glyph: BitmapGlyph
  readonly ascent: number
  readonly descent: number
}

/**
 * 按屏幕显示（GDI）排版与绘制的规则，WPS 表格的形状文字使用，演示文稿不使用（`FaceCache` 缺省为 `null`）。
 * 行高与基线见 `body.ts` 的 `screenBlock`；绘制时基线取整到设备像素，`bitmap` 返回点阵的字形按点阵绘制。
 */
export interface ScreenText {
  /** 字形在 `ppem`（设备像素字号）下按点阵绘制时返回点阵，否则为 `null`；合成粗体的点阵加粗由实现方完成。 */
  bitmap(face: PaintFace, codePoint: number, ppem: number): ScreenGlyph | null
}

export class FaceCache {
  private readonly lines = new Map<TextFace, TextFace>()
  private readonly faces = new Map<string, PaintFace>()
  private readonly byFace = new Map<TextFace, PaintFace>()
  readonly fallback: PaintFace

  /** `single` 为单倍行高与字号之比，缺省为 `SINGLE_LINE`（演示文稿）；`screen` 见 `ScreenText`。 */
  constructor(
    private readonly source: SlideFontSource,
    private readonly single = SINGLE_LINE,
    readonly screen: ScreenText | null = null,
  ) {
    this.fallback = this.register({
      face: this.line(source.fallback.face),
      family: source.fallback.family,
      bold: false,
      italic: false,
    })
  }

  /** 同一字体文件只换算一次：排版模块按对象判定字体是否相同。 */
  private line(face: TextFace): TextFace {
    let out = this.lines.get(face)
    if (out === undefined) {
      const center =
        this.screen === null
          ? CENTER
          : face.vertical.eastAsianCodePage
            ? SCREEN_CENTER_EAST_ASIAN
            : SCREEN_CENTER_OTHER
      out = lineFace(face, this.single, center)
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
      f = this.register({
        face: bold && !base.bold ? emboldened(this.line(base.face)) : this.line(base.face),
        family: base.family,
        bold,
        italic,
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
