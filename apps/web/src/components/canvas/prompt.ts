/**
 * 生成面板的提示词：存盘形态是带 `@[节点 id]` 的纯文本，编辑框里引用显示成缩略图加名字的标签。
 * 两个方向的转换都在这里，编辑框只认这两个函数。
 */

const MENTION_RE = /@\[([A-Za-z0-9_-]{1,64})\]/g

export type PromptPart = { text: string } | { id: string }

/** 存盘的提示词拆成文字段与引用段，顺序不变。 */
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
 * 编辑框的内容写回存盘形态：文字原样，带 `data-node` 的标签写回 `@[id]`，换行保留。
 * 回车在不同浏览器里产生 `<br>` 或 `<div>`，两种都按一个换行算。
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
