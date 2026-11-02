/**
 * Windows 字体替换表（注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\FontSubstitutes`，中文版 Windows 10 的缺省内容）
 * 中目标为 TrueType 字体的项。WPS 对主机没有的字体名按此替换：WPS 文字实测（构造文档 w13 p2、p3、q18、q30）中 `MS Shell Dlg 2`
 * 取 Tahoma、`MS Shell Dlg` 取 Microsoft Sans Serif、`Arabic Transparent` 取 Arial、`Times` 取 Times New Roman，字体表的
 * `w:charset` 为中日韩字符集时同样替换；WPS 表格实测见 `../xlsx/render/fonts.ts`。
 *
 * - 名称区分大小写：`TIMES` 不替换（WPS 文字实测）。
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

/** 字体名在 Windows 字体替换表中的替换结果；表中没有该名称时为 `null`。 */
export function windowsFontSubstitute(name: string): string | null {
  return SUBSTITUTES.get(name) ?? null
}
