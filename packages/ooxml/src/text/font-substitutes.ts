/**
 * 主机没有的字体名的替换：Windows 字体替换表、按主机字体族名的前缀匹配，以及图元文件字体对象按字符集与字体族的替代
 * （`metafileFontSubstitute`）。
 *
 * Windows 字体替换表（注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\FontSubstitutes`，中文版 Windows 10 的缺省内容）
 * 中目标为 TrueType 字体的项，WPS 文字与 WPS 表格共用，宿主之间只有名称是否区分大小写不同（`windowsFontSubstitute`）。
 * WPS 文字实测（构造文档 w13 p2、p3、q18、q30）中 `MS Shell Dlg 2` 取 Tahoma、`MS Shell Dlg` 取 Microsoft Sans Serif、
 * `Arabic Transparent` 取 Arial、`Times` 取 Times New Roman，字体表的 `w:charset` 为中日韩字符集时同样替换；
 * WPS 表格实测（构造文件 c6-subst：以表中各名称与其大小写变体写同一段文字，与已安装的替换目标逐像素相同）中各项同样成立。
 *
 * - 不列出目标为点阵字体的项（`Helv`、`Tms Rmn`）、目标不是字体族名的项（`Arabic Transparent Bold` 的 `Arial Bold`）与
 *   带字符集限定的项（如 `Arial CE,238`）。
 * - `Helvetica`：WPS 文字以自带的字体绘制，字宽与 Arial 相同、12 磅单倍行高 14.1 磅（Arial 为 13.8 磅），取 Arial。
 * - `FangSong_GB2312`、`KaiTi_GB2312`：WPS 文字的西文字符以自带的字体绘制，字宽与仿宋、楷体相同，东亚字符为仿宋、楷体。
 */

import { LANGUAGE_EN_US } from '../font/name.ts'

const SUBSTITUTES: ReadonlyMap<string, string> = new Map([
  ['Arabic Transparent', 'Arial'],
  ['Helvetica', 'Arial'],
  ['MS Shell Dlg', 'Microsoft Sans Serif'],
  ['MS Shell Dlg 2', 'Tahoma'],
  ['Tahoma Armenian', 'Tahoma'],
  ['Times', 'Times New Roman'],
  ['FangSong_GB2312', '仿宋'],
  ['KaiTi_GB2312', '楷体'],
])

/** `SUBSTITUTES` 按小写名称的索引，供不区分大小写的查找。 */
const SUBSTITUTES_IGNORING_CASE: ReadonlyMap<string, string> = new Map(
  [...SUBSTITUTES].map(([name, target]) => [name.toLowerCase(), target]),
)

/**
 * 字体名在 Windows 字体替换表中的替换结果；表中没有该名称时为 `null`。`ignoreCase` 由宿主给出：WPS 文字区分大小写
 * （`TIMES` 不替换），WPS 表格不区分（`TIMES`、`HELVETICA`、`ms shell dlg 2`、`KAITI_GB2312` 都替换）。
 */
export function windowsFontSubstitute(name: string, ignoreCase: boolean): string | null {
  return (
    (ignoreCase ? SUBSTITUTES_IGNORING_CASE.get(name.toLowerCase()) : SUBSTITUTES.get(name)) ?? null
  )
}

const DEFAULT_CHARSET = 1
const SYMBOL_CHARSET = 2
const SHIFTJIS_CHARSET = 128
const HANGUL_CHARSET = 129
const GB2312_CHARSET = 134
const CHINESEBIG5_CHARSET = 136
/** 已实测、规则相同的其余单字节字符集：希腊、西里尔、中欧与 OEM。 */
const SINGLE_BYTE_CHARSETS: ReadonlySet<number> = new Set([161, 204, 238, 255])
const FIXED_PITCH = 1
const VARIABLE_PITCH = 2
const FF_ROMAN = 0x10
const FF_SWISS = 0x20
const FF_MODERN = 0x30
const FF_SCRIPT = 0x40
const FF_DECORATIVE = 0x50

/**
 * 图元文件字体对象（`LOGFONT`）的字体名主机没有时所用的字体名；字符集未实测时为 `null`，由宿主取其回退字体。
 * WPS 文字与 WPS 演示的结果相同，与 GDI 的字体映射一致（构造文件 f1-wmf、f1-wmf2：缺失字体名在 11 种字符集与 7 种
 * `lfPitchAndFamily` 下的 77 种组合，语料中的 23 个缺失字体名，与已安装字体逐像素比对）：
 * 1. Windows 字体替换表中有该名称时取其目标，不区分大小写，与字符集和字体族无关（`times` 与 `HELVETICA` 同样替换，
 *    `Helvetica` 为 `FF_ROMAN` 时仍为 Arial）。目标为点阵字体的项（`Helv`、`Tms Rmn`）不在表中，按第 2 步。
 * 2. 按字符集与字体族：「等宽」为 `FIXED_PITCH`，或 `FF_MODERN` 而不是 `VARIABLE_PITCH`（`FF_MODERN | VARIABLE_PITCH` 按
 *    第三列）。
 *
 * | 字符集 | `FF_ROMAN` | 等宽 | 其余 |
 * |---|---|---|---|
 * | ANSI | Times New Roman | Courier New | Arial |
 * | 希腊、西里尔、中欧、OEM | Times New Roman | `FIXED_PITCH` 为 Consolas，否则 Courier New | `FF_SCRIPT` 为 Segoe Script，`FF_DECORATIVE` 为 Gabriola，否则 Arial |
 * | DEFAULT | Times New Roman | 新宋体 | 宋体 |
 * | SYMBOL | Symbol | `FIXED_PITCH` 为 Symbol，否则 Wingdings | Wingdings |
 * | GB2312 | MingLiU-ExtB | 新宋体 | 宋体 |
 * | SHIFTJIS | MingLiU-ExtB | MS Gothic | MS PGothic |
 * | HANGUL、BIG5 | MingLiU-ExtB | MS Gothic | `FF_SWISS` 为 Gadugi，否则 Ebrima |
 *
 * 字体名为主机字体的全名时 WPS 取该字形（`Calibri Bold` 为 Calibri 粗体），本函数不处理。主机有该字体而不支持所请求的字符集时
 * WPS 同样另取字体（Times New Roman 的 GB2312 为 MingLiU-ExtB，Wingdings 的 ANSI 为 Arial，而 Symbol 的 ANSI 仍为 Symbol），
 * 规则未查明，调用方照常使用该字体。
 */
export function metafileFontSubstitute(font: {
  readonly face: string
  readonly charset: number
  readonly pitchAndFamily: number
}): string | null {
  const windows = windowsFontSubstitute(font.face, true)
  if (windows !== null) return windows
  const family = font.pitchAndFamily & 0xf0
  const pitch = font.pitchAndFamily & 0x03
  const roman = family === FF_ROMAN
  const fixed = pitch === FIXED_PITCH || (family === FF_MODERN && pitch !== VARIABLE_PITCH)
  switch (font.charset) {
    case 0:
      return roman ? 'Times New Roman' : fixed ? 'Courier New' : 'Arial'
    case DEFAULT_CHARSET:
      return roman ? 'Times New Roman' : fixed ? '新宋体' : '宋体'
    case SYMBOL_CHARSET:
      return roman || pitch === FIXED_PITCH ? 'Symbol' : 'Wingdings'
    case GB2312_CHARSET:
      return roman ? 'MingLiU-ExtB' : fixed ? '新宋体' : '宋体'
    case SHIFTJIS_CHARSET:
      return roman ? 'MingLiU-ExtB' : fixed ? 'MS Gothic' : 'MS PGothic'
    case HANGUL_CHARSET:
    case CHINESEBIG5_CHARSET:
      return roman
        ? 'MingLiU-ExtB'
        : fixed
          ? 'MS Gothic'
          : family === FF_SWISS
            ? 'Gadugi'
            : 'Ebrima'
  }
  if (!SINGLE_BYTE_CHARSETS.has(font.charset)) return null
  if (roman) return 'Times New Roman'
  if (pitch === FIXED_PITCH) return 'Consolas'
  if (fixed) return 'Courier New'
  return family === FF_SCRIPT ? 'Segoe Script' : family === FF_DECORATIVE ? 'Gabriola' : 'Arial'
}

/** 主机字体的族名，由调用方取得（服务端 `/api/fonts/families`）。 */
export interface HostFamilies {
  /** 各字体按主机界面语言取的族名（没有该语言的名称时取英文名）：前缀匹配只用这些名称（`prefixFont`）。 */
  readonly local: readonly string[]
  /** 各字体全部语言的族名，小写并去掉首尾空白：主机有某个字体名，即该名称如此处理后在其中。 */
  readonly names: readonly string[]
  /** 主机界面语言的 Windows 语言标识（`local` 所按的语言）：文档嵌入的字体按它取家族名。 */
  readonly language: number
}

/** 不知道主机字体时使用：不做前缀匹配，任何字体名都按主机没有处理，界面语言按 en-US。 */
export const NO_HOST_FAMILIES: HostFamilies = { local: [], names: [], language: LANGUAGE_EN_US }

/**
 * 按主机字体族名的前缀为主机没有的字体名取替代字体；没有时为 `null`。名称按空格分词，只用 `local` 中的族名，返回该族名：
 * 1. 名称的前若干词（不含全部）正好是主机字体名时，取词数最少的一个（`Calibri Light Fake` 取 Calibri，`Yu Gothic UI X`
 *    取 Yu Gothic，`等线 Fake` 取等线）；
 * 2. 否则取以「名称 + 空格」开头的主机字体中字母序（UTF-16 码元）第一个（`Courier` 取 Courier New，`Noto Serif CJK SC` 取
 *    Noto Serif CJK SC Medium，`Sitka` 取 Sitka Banner）。
 * `ignoreCase` 由宿主给出：WPS 文字区分大小写，WPS 演示不区分（WPS 演示的调用方另去掉名称的首尾空白）。
 * WPS 文字实测（构造文档 w13 p1、q01–q18、w15 p1、p2，西文与东亚字段相同）：`Calibri  Fake`（两个空格）取 Calibri，
 * ` Calibri Fake`（以空格开头）、`calibri fake`、`Cour`、`SimHei Fake`（SimHei 是黑体的英文名）不匹配。
 * WPS 演示实测（构造文件 p10-d，charset 为 0 的西文字段与东亚字段，与参照行逐像素相同）：上述各例中只有 ` Calibri Fake` 与
 * `calibri fake` 不同，都取 Calibri。
 * 与本规则不同的实测：`Microsoft` 取 Microsoft JhengHei，字母序第一个为 Microsoft Himalaya（两个宿主相同；主机中只有这一个
 * 前缀能区分，原因未查明）。
 */
export function prefixFont(
  name: string,
  local: readonly string[],
  ignoreCase = false,
): string | null {
  const fold = (s: string) => (ignoreCase ? s.toLowerCase() : s)
  const folded = local.map(fold)
  const words = fold(name).split(' ')
  for (let k = 1; k < words.length; k++) {
    const i = folded.indexOf(words.slice(0, k).join(' '))
    if (i >= 0) return local[i]!
  }
  const start = `${fold(name)} `
  let first: string | null = null
  for (const [i, family] of local.entries())
    if (folded[i]!.startsWith(start) && (first === null || family < first)) first = family
  return first
}
