/**
 * 同一字体名下按粗体、斜体选用字体文件的规则，以及文档需要的字形样式的记录方式。Word 段落与 PPT 文本框的排版共用这一选用顺序
 * （`pickStyle`），调用方据各字体名需要的样式（`StyleMask`）只取得排版会选用的字体文件（`facesForStyles`）。
 */

/**
 * 字形样式的集合，按位记录：常规、斜体、粗体、粗斜体各占一位（`styleBit`）。`ALL_STYLES` 为四种都需要。
 */
export type StyleMask = number
export const ALL_STYLES: StyleMask = 0b1111

export function styleBit(bold: boolean, italic: boolean): StyleMask {
  return 1 << ((bold ? 2 : 0) + (italic ? 1 : 0))
}

/** `styles` 中 `name` 的样式加上 `mask`；`styles` 缺省时不记录。 */
export function addStyle(
  styles: Map<string, StyleMask> | undefined,
  name: string,
  mask: StyleMask,
): void {
  if (styles) styles.set(name, (styles.get(name) ?? 0) | mask)
}

/**
 * 同一字体名下按样式选用的字体：同粗斜体 → 同粗细 → 常规 → 第一个；列表为空时为 null。只取得各样式选中的字体并保持原顺序时，
 * 排版在其中选中的字体与全部取得时相同（`facesForStyles`）。
 */
export function pickStyle<T extends { readonly bold: boolean; readonly italic: boolean }>(
  list: readonly T[],
  bold: boolean,
  italic: boolean,
): T | null {
  return (
    list.find((f) => f.bold === bold && f.italic === italic) ??
    list.find((f) => f.bold === bold) ??
    list.find((f) => !f.bold && !f.italic) ??
    list[0] ??
    null
  )
}

/** `mask` 中各样式按 `pickStyle` 选中的字体，保持 `list` 中的顺序。 */
export function facesForStyles<T extends { readonly bold: boolean; readonly italic: boolean }>(
  list: readonly T[],
  mask: StyleMask,
): T[] {
  const chosen = new Set<T>()
  for (let bit = 0; bit < 4; bit++) {
    if (!(mask & (1 << bit))) continue
    const face = pickStyle(list, bit >= 2, bit % 2 === 1)
    if (face) chosen.add(face)
  }
  return list.filter((f) => chosen.has(f))
}
