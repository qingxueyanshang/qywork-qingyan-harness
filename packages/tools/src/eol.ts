/**
 * 行尾。
 *
 * 磁盘上的字节和模型看到的文本不是一回事：CRLF 文件按 `\n` 切出来的每一行都拖着
 * 一个 `\r`，而模型复述这段文本时必然把它丢掉。写操作若拿模型给的那份去做精确匹配，
 * 跨行的一律失配。**这不是边角情况**：agent 干活的仓库不归我们管，Windows 上的项目
 * 常年是 CRLF；本仓自己也有几个（`.gitattributes` 钉了 `eol=lf` 也没能钉住全部），
 * 其中还有一个是真混合的。
 *
 * 一条规矩贯穿全部文件工具：**交给模型的一律是 LF，落盘一律按文件自己的行尾。**
 */

function count(haystack: string, needle: string): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
    n++
  return n
}

/** 去掉 CR。给模型看的、以及行内比较用的都走这一份。 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * 这个文件按哪种行尾落盘。空文件与新文件按 LF。
 *
 * 判据是**哪种多**，不是「出现过 CRLF 就算 CRLF」：混合行尾的文件真实存在，
 * 按出现过判会把它的另一半一起重写掉。
 */
export function dominantEol(raw: string): '\r\n' | '\n' {
  const crlf = count(raw, '\r\n')
  return crlf * 2 > count(raw, '\n') ? '\r\n' : '\n'
}

/** 把 LF 文本按目标行尾编码。传进来的若已含 CRLF，先归一再编，不会叠成 `\r\r\n`。 */
export function fromLf(text: string, eol: '\r\n' | '\n'): string {
  const lf = toLf(text)
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n')
}

/**
 * 把一段字面量编成「行尾不敏感」的正则源：行内原样匹配，换行处 `\r?\n` 两可。
 *
 * **不要改成先把整个文件归一成 LF 再匹配。** 那样替换结果得整份写回，
 * 混合行尾的文件会被顺手重写掉没动过的那些行——一次单行编辑产生整份 diff，
 * 而 diff 里看不出哪一行是真改的。用它在**原文**上定位，只动命中的那一段。
 */
export function eolInsensitivePattern(literal: string): string {
  return toLf(literal)
    .split('\n')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\r?\\n')
}
