/**
 * `edit_file` 定位原文时不区分直双引号与弯双引号。
 *
 * 模型复述中文正文时会把文件中的 `"` 写成 `“”`，也会反过来，按原样匹配时 old_string 无法定位。
 * 只处理双引号：单引号 `'` 在代码中大量出现，与 `‘’` 视为相同时，原本唯一的命中可能变为多处命中。
 */

const DOUBLE_QUOTES = /["“”]/g
const OPEN = '“'
const CLOSE = '”'

/** 把已转义的正则源中的双引号改为同时匹配三种写法的字符类。转义不产生引号，引号也不是正则元字符。 */
export function quoteInsensitive(source: string): string {
  return source.replace(DOUBLE_QUOTES, '["“”]')
}

/** 双引号一律改为直引号。长度不变，按下标比较的结果可以直接用于原文。 */
export function straightQuotes(text: string): string {
  return text.replace(DOUBLE_QUOTES, '"')
}

/**
 * 按命中原文的引号写法改写替换文本。`old` 与 `matched` 中的双引号逐个对应（由 `quoteInsensitive` 的匹配保证）。
 *
 * 两者写法相同时原样返回：模型写对了原文，替换文本中对引号的改动是有意的，不得改写。
 * 写法不同时按原文中占多数的写法改写：直引号时全部改为 `"`；弯引号时直引号按开闭交替改为 `“` `”`，
 * 起始状态取原文中第一个引号，它是 `”` 时替换起点位于一对引号之内。
 */
export function matchQuoteStyle(replacement: string, old: string, matched: string): string {
  const fileQuotes = matched.match(DOUBLE_QUOTES) ?? []
  if ((old.match(DOUBLE_QUOTES) ?? []).join('') === fileQuotes.join('')) return replacement
  const curly = fileQuotes.filter((q) => q !== '"').length
  if (curly * 2 < fileQuotes.length) return replacement.replace(/[“”]/g, '"')
  let inside = fileQuotes[0] === CLOSE
  return replacement.replace(DOUBLE_QUOTES, (q) => {
    const next = q === '"' ? (inside ? CLOSE : OPEN) : q
    inside = next === OPEN
    return next
  })
}
