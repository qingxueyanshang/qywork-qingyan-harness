/**
 * 排版用字体：宽度与行高一律取自字体文件，不调用 Canvas `measureText`（其取整方式随平台而变，
 * 同一段文字处在列宽边界上时，溢出与 `####` 的判定会随平台改变）。
 *
 * - 绘制：点阵模式的字号取单色字形（`LoadedFace.bitmaps`）；显示器使用 ClearType 时其余字号取 ClearType 字形
 *   （`LoadedFace.clearType`），见 `painter.ts`。旋转的文字、没有 TrueType 轮廓的字体与显示器不使用 ClearType 时的文字以
 *   `LoadedFace.family` 引用调用方在浏览器中注册的同名字体（`FontFace`）绘制，字体链的 CSS 族名列表与排版回退顺序一致：
 *   缺字时逐字回退到下一个字体。
 * - 主机上没有的字体按 `substituteFont` 替代（只用于单元格文字）：调用方取得文档字体后，对没有取得的字体名另行取得其替代字体。
 * - 粗体、斜体优先取对应字形的字体文件；没有时取常规字形，粗体按合成粗体排版（`syntheticBoldExtra`）与绘制（`painter.ts`），
 *   斜体以 ClearType 字形绘制时按合成斜体绘制，以浏览器字体绘制时由浏览器合成。
 * - 字号：磅按 96 dpi 换算为像素，1 pt = 4/3 px；WPS 经 GDI 按四舍五入后的整数像素字号（ppem）排版与绘制。
 * - 前进宽度：TrueType 字体取 ppem 下 GDI 的整数宽度（见 `readPixelAdvances`），没有 TrueType 轮廓的字体取 `px` 下的线性宽度。
 */

import {
  type EmbeddedBitmaps,
  type FontMetrics,
  type PixelVerticalMetrics,
  readEmbeddedBitmaps,
  readFaces,
  readHead,
  readMetrics,
  readPixelAdvances,
  readPixelVerticalMetrics,
  readVerticalMetrics,
  tableBytes,
} from '../../font/index.ts'
import { type ClearTypeGlyphs, readClearTypeGlyphs } from '../../glyph/cleartype/index.ts'
import type { TextFace } from '../../text/index.ts'
import type { Workbook } from '../model.ts'

export interface LoadedFace {
  /** 绘制时使用的 CSS 族名，与调用方注册的 `FontFace` 族名相同。 */
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
  readonly metrics: FontMetrics
  /** ppem 下的纵向度量，与 GDI `GetTextMetrics` 一致。 */
  readonly vertical: (ppem: number) => PixelVerticalMetrics
  /** ppem 下的整数前进宽度（像素）；字体没有 TrueType 轮廓时为 `null`。 */
  readonly pixelAdvance: (codePoint: number, ppem: number) => number | null
  /** 内嵌点阵；字体没有点阵时为 `null`。 */
  readonly bitmaps: EmbeddedBitmaps | null
  /** ClearType 字形；字体没有 TrueType 轮廓时为 `null`。 */
  readonly clearType: ClearTypeGlyphs | null
  /** 形状文字（`../../text/` 排版）所用的度量；同一字体始终为同一对象。 */
  readonly text: TextFace
}

/**
 * 缺字时依次尝试的字体：宋体，其后为主题的简体中文正文字体。西文字体（如 Arial、Calibri）没有汉字字形时，
 * 中文版 WPS 的屏幕显示以宋体绘制这些汉字；主机上没有宋体时取主题字体。
 */
export function fallbackFonts(wb: Workbook): string[] {
  const out = ['宋体']
  const ea = wb.minorFont?.eastAsian
  if (ea && ea !== '宋体') out.push(ea)
  return out
}

/**
 * Windows 字体替换表（注册表 `FontSubstitutes`）中 WPS 表格遵循的项，键为小写。只列出经 WPS 实测的项：
 * 替换目标为点阵字体的项（如 `Tms Rmn`、`Helv`）无法按字体文件排版，不列出。
 */
const WINDOWS_SUBSTITUTES: ReadonlyMap<string, string> = new Map([
  ['helvetica', 'Arial'],
  ['times', 'Times New Roman'],
  ['ms shell dlg 2', 'Tahoma'],
  ['fangsong_gb2312', '仿宋'],
  ['kaiti_gb2312', '楷体'],
])

/** 汉字、假名、谚文与全角字符。 */
const EAST_ASIAN_NAME = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}！-～]/u

/**
 * WPS 表格的单元格文字对主机上没有的字体使用的替代字体名（形状与图表文字另有规则，见 `../../drawingml/text/fonts.ts`）。
 * 实测（WPS 表格经 COM 读取行高并取屏幕图像，6–48 磅 21 个字号）：替代后的行高与显式指定替代字体逐字号一致，
 * 图像逐像素相同；与 `charset`、`family`、「常规」字体、主题字体无关。规则：
 * - `WINDOWS_SUBSTITUTES` 中的名称取替换后的字体；
 * - `Arial Unicode MS`（区分大小写，`arial unicode ms` 取 Arial）与含汉字、假名、谚文或全角字符的名称取宋体；
 * - 其余名称取 Arial，含西文中日韩字体名（`STSong`、`MS Mincho`、`PingFang SC`）与带附加符号的拉丁字母名称。
 * 未实现：含东亚字符的名称在 `charset` 为 128 时 WPS 取 MS Gothic（模型不保留 `charset`），本函数取宋体。
 */
export function substituteFont(name: string): string {
  const mapped = WINDOWS_SUBSTITUTES.get(key(name))
  if (mapped !== undefined) return mapped
  return name === 'Arial Unicode MS' || EAST_ASIAN_NAME.test(name) ? '宋体' : 'Arial'
}

/** 字号（磅）换算为像素。 */
export function pointsToPixels(pt: number): number {
  return (pt * 4) / 3
}

/** 磅换算为整数像素字号：Windows 按 `MulDiv(pt, 96, 72)` 四舍五入。 */
export function pixelSize(pt: number): number {
  return Math.round((pt * 4) / 3)
}

/**
 * 读取单个字体文件（或 TTC 中的第 `index` 个字体）。`family` 为注册到浏览器时使用的族名。
 * 字体结构不完整或缺少 `OS/2` 表时抛出 `FontFormatError`。
 */
export function loadFace(bytes: Uint8Array, family: string, index = 0): LoadedFace {
  const face = readFaces(bytes)[index]
  if (!face) throw new RangeError(`字体文件中没有第 ${index} 个字体`)
  const head = readHead(tableBytes(bytes, face, 'head'))
  const metrics = readMetrics(bytes, face)
  return {
    family,
    bold: head.bold,
    italic: head.italic,
    metrics,
    vertical: readPixelVerticalMetrics(bytes, face),
    pixelAdvance: readPixelAdvances(bytes, face),
    bitmaps: readEmbeddedBitmaps(bytes, face),
    clearType: readClearTypeGlyphs(bytes, face),
    text: { metrics, vertical: readVerticalMetrics(bytes, face) },
  }
}

/** 同一字体绘制的一段连续文字。 */
export interface FaceSegment {
  readonly text: string
  /** 绘制使用的族名（CSS 引号形式）；字体集为空时为 `sans-serif`。 */
  readonly css: string
  /** 每个字符额外的间距（像素）：该字体没有粗体字形而要求粗体时为合成粗体的加宽，否则为 0。 */
  readonly letterSpacing: number
  readonly width: number
  /** 绘制这一段的字体；字体集为空时为 `null`。 */
  readonly face: LoadedFace | null
}

export interface FaceChain {
  /** 第一个为本字体（或首个可用的回退字体），其后为回退字体；字体集为空时为空数组。 */
  readonly faces: readonly LoadedFace[]
  /** `ctx.font` 中的族名列表，如 `"Calibri", "宋体"`。 */
  readonly css: string
  /** 文字在 `px` 字号下的前进宽度之和，含合成粗体的加宽。 */
  width(text: string, px: number): number
  /** 单个字符的前进宽度，含合成粗体的加宽；与 `width` 逐字累加的结果相同。 */
  charWidth(codePoint: number, px: number): number
  /** 按逐字回退的结果把文字分为同一字体的连续段；绘制时逐段指定字体，位置与测宽一致。 */
  segments(text: string, px: number): FaceSegment[]
}

function key(name: string): string {
  return name.trim().toLowerCase()
}

function quote(family: string): string {
  return `"${family.replace(/["\\]/g, '')}"`
}

export class FontSet {
  private readonly byName = new Map<string, LoadedFace[]>()
  private readonly chains = new Map<string, FaceChain>()

  /**
   * `faces` 中同一族名的多个字形（常规、粗体、斜体）按 `bold`、`italic` 区分；`fallbacks` 为缺字时依次尝试的族名。
   * `aliases` 把文件中出现的字体名映射到已加载的族名（如 `SimSun` → `宋体`）。
   */
  constructor(
    faces: readonly LoadedFace[],
    private readonly fallbacks: readonly string[],
    private readonly aliases: ReadonlyMap<string, string> = new Map(),
  ) {
    for (const f of faces) {
      const list = this.byName.get(key(f.family)) ?? []
      list.push(f)
      this.byName.set(key(f.family), list)
    }
  }

  /** 按字体名（含别名）与字形取得最接近的字体；字体集中没有该字体时为 `null`。 */
  face(name: string, bold: boolean, italic: boolean): LoadedFace | null {
    const list = this.byName.get(key(this.aliases.get(key(name)) ?? name))
    if (!list || list.length === 0) return null
    return (
      list.find((f) => f.bold === bold && f.italic === italic) ??
      list.find((f) => f.bold === bold) ??
      list.find((f) => !f.bold && !f.italic) ??
      list[0]!
    )
  }

  /** 字体名在字体集中有对应字体。 */
  has(name: string): boolean {
    return this.face(name, false, false) !== null
  }

  /**
   * 单元格文字的字体链：本字体，字体集中没有时为 `substituteFont` 的替代字体，其后为回退字体。
   * 替代字体同样不在字体集中时从回退字体开始。
   */
  chain(name: string, bold: boolean, italic: boolean): FaceChain {
    const id = `${key(name)}|${bold ? 1 : 0}${italic ? 1 : 0}`
    let chain = this.chains.get(id)
    if (!chain) {
      const faces: LoadedFace[] = []
      for (const n of [this.has(name) ? name : substituteFont(name), ...this.fallbacks]) {
        const f = this.face(n, bold, italic)
        if (f && !faces.includes(f)) faces.push(f)
      }
      chain = makeChain(faces, bold)
      this.chains.set(id, chain)
    }
    return chain
  }
}

/**
 * 合成粗体每个字符增加的前进宽度（像素）：Windows 的粗体模拟在字号 24 像素以内加宽 1 像素，其上按比例增加。
 * WPS 按此排版，绘制时以 `letterSpacing` 施加同样的间距。
 */
export function syntheticBoldExtra(px: number): number {
  return Math.max(1, Math.round(px / 24))
}

function makeChain(faces: readonly LoadedFace[], bold: boolean): FaceChain {
  const families: string[] = []
  for (const f of faces) if (!families.includes(f.family)) families.push(f.family)
  const css = families.length > 0 ? families.map(quote).join(', ') : 'sans-serif'
  const faceFor = (cp: number): LoadedFace | undefined => {
    for (const f of faces) if (f.metrics.glyphId(cp) !== 0) return f
    return faces[0]
  }
  // 要求粗体而该字体没有粗体字形时按合成粗体逐字加宽。
  const extraOf = (face: LoadedFace | undefined, px: number) =>
    bold && face !== undefined && !face.bold ? syntheticBoldExtra(px) : 0
  const advance = (face: LoadedFace | undefined, cp: number, px: number) =>
    face
      ? (face.pixelAdvance(cp, Math.round(px)) ?? face.metrics.advance(cp, px)) + extraOf(face, px)
      : 0
  return {
    faces,
    css,
    width(text: string, px: number): number {
      let w = 0
      for (const ch of text) {
        const cp = ch.codePointAt(0)!
        if (cp >= 32) w += advance(faceFor(cp), cp, px)
      }
      return w
    },
    charWidth(codePoint: number, px: number): number {
      return codePoint >= 32 ? advance(faceFor(codePoint), codePoint, px) : 0
    },
    segments(text: string, px: number): FaceSegment[] {
      const out: FaceSegment[] = []
      let current: LoadedFace | undefined
      let buf = ''
      let width = 0
      const flush = () => {
        if (buf === '') return
        out.push({
          text: buf,
          css: current ? quote(current.family) : 'sans-serif',
          letterSpacing: extraOf(current, px),
          width,
          face: current ?? null,
        })
        buf = ''
        width = 0
      }
      for (const ch of text) {
        const cp = ch.codePointAt(0)!
        if (cp < 32) continue
        const face = faceFor(cp)
        if (face !== current) {
          flush()
          current = face
        }
        buf += ch
        width += advance(face, cp, px)
      }
      flush()
      return out
    },
  }
}
