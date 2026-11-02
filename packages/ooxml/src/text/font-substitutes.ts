/**
 * 主机没有的字体名的替换：Windows 字体替换表与按主机字体族名的前缀匹配。
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

/** 主机字体的族名，由调用方取得（服务端 `/api/fonts/families`）。 */
export interface HostFamilies {
  /** 各字体按主机界面语言取的族名（没有该语言的名称时取英文名），区分大小写：前缀匹配只用这些名称。 */
  readonly local: readonly string[]
  /** 各字体全部语言的族名，小写并去掉首尾空白：主机有某个字体名，即该名称如此处理后在其中。 */
  readonly names: readonly string[]
}

/** 不知道主机字体时使用：不做前缀匹配，任何字体名都按主机没有处理。 */
export const NO_HOST_FAMILIES: HostFamilies = { local: [], names: [] }

/**
 * 按主机字体族名的前缀为主机没有的字体名取替代字体；没有时为 `null`。名称按空格分词，区分大小写，只用 `local` 中的族名：
 * 1. 名称的前若干词（不含全部）正好是主机字体名时，取词数最少的一个（`Calibri Light Fake` 取 Calibri，`Yu Gothic UI X`
 *    取 Yu Gothic，`等线 Fake` 取等线）；
 * 2. 否则取以「名称 + 空格」开头的主机字体中字母序（UTF-16 码元）第一个（`Courier` 取 Courier New，`Noto Serif CJK SC` 取
 *    Noto Serif CJK SC Medium，`Sitka` 取 Sitka Banner）。
 * WPS 文字实测（构造文档 w13 p1、q01–q18、w15 p1、p2，西文与东亚字段相同）：`Calibri  Fake`（两个空格）取 Calibri，
 * ` Calibri Fake`（以空格开头）、`calibri fake`、`Cour`、`SimHei Fake`（SimHei 是黑体的英文名）不匹配。
 * 与本规则不同的实测：`Microsoft` 取 Microsoft JhengHei，字母序第一个为 Microsoft Himalaya（主机中只有这一个前缀能区分，
 * 原因未查明）。
 */
export function prefixFont(name: string, local: readonly string[]): string | null {
  const words = name.split(' ')
  for (let k = 1; k < words.length; k++) {
    const head = words.slice(0, k).join(' ')
    if (local.includes(head)) return head
  }
  const start = `${name} `
  let first: string | null = null
  for (const family of local)
    if (family.startsWith(start) && (first === null || family < first)) first = family
  return first
}
