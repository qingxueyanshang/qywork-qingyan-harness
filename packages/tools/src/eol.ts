/**
 * 行尾处理。
 *
 * 磁盘上的字节与模型看到的文本不同：CRLF 文件按 `\n` 切分后每一行都带有
 * 一个 `\r`，而模型复述这段文本时必然丢弃它。写操作若用模型提供的文本做精确匹配，
 * 跨行内容一律匹配失败。这种情况很常见：目标仓库的行尾不受本仓库控制，Windows 上的项目
 * 通常使用 CRLF；本仓库自身也有若干 CRLF 文件（`.gitattributes` 设置了 `eol=lf` 也未能覆盖全部），
 * 其中还有一个是混合行尾。
 *
 * 全部文件工具遵循同一条规则：交给模型的一律是 LF，落盘一律按文件自身的行尾。
 */

function count(haystack: string, needle: string): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
    n++
  return n
}

/** 去除 CRLF 中的 CR。交给模型的文本与行内比较都使用此函数。 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * 判定文件按哪种行尾落盘。空文件与新文件按 LF。
 *
 * 判据是哪种行尾占多数，不是出现过 CRLF 即视为 CRLF：混合行尾的文件确实存在，
 * 按是否出现判定会把另一种行尾的部分一并重写。
 */
export function dominantEol(raw: string): '\r\n' | '\n' {
  const crlf = count(raw, '\r\n')
  return crlf * 2 > count(raw, '\n') ? '\r\n' : '\n'
}

/** 把 LF 文本按目标行尾编码。输入若已含 CRLF，先归一再编码，不会产生 `\r\r\n`。 */
export function fromLf(text: string, eol: '\r\n' | '\n'): string {
  const lf = toLf(text)
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n')
}

/**
 * 把一段字面量编码为不区分行尾的正则源：行内原样匹配，换行处用 `\r?\n` 同时匹配两种行尾。
 *
 * 不要改为先把整个文件归一为 LF 再匹配：那样替换结果必须整份写回，
 * 混合行尾文件中未修改的行会被一并重写，一次单行编辑产生整份 diff，
 * 且 diff 中无法看出实际修改的行。应使用它在原文上定位，只修改命中的片段。
 */
export function eolInsensitivePattern(literal: string): string {
  return toLf(literal)
    .split('\n')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\r?\\n')
}
