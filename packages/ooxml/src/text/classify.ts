/**
 * 字符分类：按码位选择字段的四种字体之一，并给出断行、两端对齐与中西文间距所用的字符类别。
 *
 * - 字体选择按 WordprocessingML `rFonts` 的码位表：表中未列出的码位使用 `hAnsi`；
 *   `w:cs` 或 `w:rtl` 使全部字符使用 `cs`。
 *   表中「提示为东亚且语言为中文」才使用 `eastAsia` 的条件不生效：WPS 对拼音字母（如 `é`、`ǎ`）
 *   在提示为东亚、语言为中文时仍使用 `hAnsi`。
 *   DrawingML 的 `latin` 同时作为 `ascii` 与 `hAnsi` 传入，`ea` 作为 `eastAsia`。
 * - 东亚类别（`isEastAsian`）取码位表中无条件使用 `eastAsia` 的范围，与提示无关，供断行判定使用。
 */

export type FontSlot = 'ascii' | 'hAnsi' | 'eastAsia' | 'cs'

export interface SlotContext {
  /** `w:rFonts/@w:hint` 为 `eastAsia`。 */
  readonly eastAsiaHint: boolean
  /** 字段带 `w:cs` 或 `w:rtl`：全部字符使用 `cs`。 */
  readonly complexScript: boolean
  /** 东亚字体的字符集为 GB2312 或 Big5。 */
  readonly chineseCharset: boolean
}

export const DEFAULT_SLOT_CONTEXT: SlotContext = {
  eastAsiaHint: false,
  complexScript: false,
  chineseCharset: false,
}

type Rule = (ctx: SlotContext, cp: number) => FontSlot

const ascii: Rule = () => 'ascii'
const eastAsia: Rule = () => 'eastAsia'
const hintEastAsia: Rule = (ctx) => (ctx.eastAsiaHint ? 'eastAsia' : 'hAnsi')
/**
 * Latin Extended-A：提示为东亚且东亚字体字符集为中文时用 `eastAsia`。
 * 码位表对 Latin Extended-B 与 IPA 扩展规定同样的条件，WPS 只对 Extended-A 生效（`ā` 用东亚字体，`ǎ` 不用）。
 */
const hintCharset: Rule = (ctx) => (ctx.eastAsiaHint && ctx.chineseCharset ? 'eastAsia' : 'hAnsi')
const hAnsi: Rule = () => 'hAnsi'

/** Latin-1 补充中提示为东亚时使用 `eastAsia` 的码位。 */
const LATIN1_HINT = new Set([
  0xa1, 0xa4, 0xa7, 0xa8, 0xaa, 0xad, 0xaf, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb6, 0xb7, 0xb8, 0xb9,
  0xba, 0xbc, 0xbd, 0xbe, 0xbf, 0xd7, 0xf7,
])
const latin1: Rule = (ctx, cp) => (ctx.eastAsiaHint && LATIN1_HINT.has(cp) ? 'eastAsia' : 'hAnsi')
const presentationForms: Rule = (ctx, cp) => (cp >= 0xfb1d ? 'ascii' : hintEastAsia(ctx, cp))

/** 按起点升序，`[起点, 终点（含）, 规则]`。不在任何区间内的码位使用 `hAnsi`。 */
const RANGES: readonly (readonly [number, number, Rule])[] = [
  [0x0000, 0x007f, ascii],
  [0x00a0, 0x00ff, latin1],
  [0x0100, 0x017f, hintCharset],
  [0x0180, 0x02af, hAnsi],
  [0x02b0, 0x03cf, hintEastAsia],
  [0x0400, 0x04ff, hintEastAsia],
  [0x0590, 0x07bf, ascii],
  [0x1100, 0x11ff, eastAsia],
  [0x1e00, 0x1eff, hAnsi],
  [0x2000, 0x27bf, hintEastAsia],
  [0x2e80, 0x2eff, hintEastAsia],
  [0x2f00, 0x2fdf, eastAsia],
  [0x2ff0, 0x319f, eastAsia],
  [0x3200, 0x4dbf, eastAsia],
  [0x4e00, 0x9faf, eastAsia],
  [0xa000, 0xa4cf, eastAsia],
  [0xac00, 0xd7af, eastAsia],
  [0xd800, 0xdfff, eastAsia],
  [0xe000, 0xf8ff, hintEastAsia],
  [0xf900, 0xfaff, eastAsia],
  [0xfb00, 0xfb4f, presentationForms],
  [0xfb50, 0xfdff, ascii],
  [0xfe30, 0xfe6f, eastAsia],
  [0xfe70, 0xfefe, ascii],
  [0xff00, 0xffef, eastAsia],
]

function findRange(cp: number): (typeof RANGES)[number] | undefined {
  let lo = 0
  let hi = RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = RANGES[mid]!
    if (cp < r[0]) hi = mid - 1
    else if (cp > r[1]) lo = mid + 1
    else return r
  }
  return undefined
}

/** 码位使用的字体。补充平面的字符按代理对所在范围使用 `eastAsia`。 */
export function fontSlot(cp: number, ctx: SlotContext): FontSlot {
  if (ctx.complexScript) return 'cs'
  if (cp > 0xffff) return 'eastAsia'
  const r = findRange(cp)
  return r ? r[2](ctx, cp) : 'hAnsi'
}

/** 无条件使用东亚字体的字符（汉字、假名、谚文、全角形式、CJK 标点与补充平面字符）。 */
export function isEastAsian(cp: number): boolean {
  return fontSlot(cp, DEFAULT_SLOT_CONTEXT) === 'eastAsia'
}

/** 希腊字母（希腊字母与科普特字母区）。 */
export function isGreek(cp: number): boolean {
  return cp >= 0x370 && cp <= 0x3ff
}

/**
 * 中西文自动间距中「东亚文字」一侧：汉字、假名、谚文字母。
 * CJK 标点与全角形式不在其内：全角逗号、括号与西文相邻时不加间距。
 */
export function isIdeographic(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x3ffff) ||
    (cp >= 0x3041 && cp <= 0x3096) ||
    (cp >= 0x30a1 && cp <= 0x30fa) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3131 && cp <= 0x318e)
  )
}
