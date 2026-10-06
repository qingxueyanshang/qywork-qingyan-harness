/**
 * 生成面板的提示词：保存格式是带 `@[节点 id]` 的纯文本，编辑框中的引用显示为缩略图加名称的标签。
 * 两个方向的转换均在本文件中，编辑框只使用这两个函数。
 */

const MENTION_RE = /@\[([A-Za-z0-9_-]{1,64})\]/g

export type PromptPart = { text: string } | { id: string }

/** 保存的提示词拆分为文字段与引用段，顺序不变。 */
export function promptParts(prompt: string): PromptPart[] {
  const parts: PromptPart[] = []
  let last = 0
  for (const m of prompt.matchAll(MENTION_RE)) {
    if (m.index! > last) parts.push({ text: prompt.slice(last, m.index) })
    parts.push({ id: m[1]! })
    last = m.index! + m[0].length
  }
  if (last < prompt.length) parts.push({ text: prompt.slice(last) })
  return parts
}

/**
 * 编辑框的内容转换为保存格式：文字原样保留，带 `data-node` 的标签转换为 `@[id]`，保留换行。
 * 回车在不同浏览器中产生 `<br>` 或 `<div>`，两种均按一个换行计算。
 */
export function promptOfEditor(root: Node): string {
  let out = ''
  const walk = (node: Node, first: boolean) => {
    if (node.nodeType === 3) {
      out += node.textContent ?? ''
      return
    }
    if (node.nodeType !== 1) return
    const el = node as HTMLElement
    const id = el.dataset?.node
    if (id) {
      out += `@[${id}]`
      return
    }
    if (el.tagName === 'BR') {
      out += '\n'
      return
    }
    const block = el.tagName === 'DIV' || el.tagName === 'P'
    if (block && !first && !out.endsWith('\n')) out += '\n'
    for (const [i, child] of [...el.childNodes].entries()) walk(child, i === 0)
  }
  for (const [i, child] of [...root.childNodes].entries()) walk(child, i === 0)
  return out
}
