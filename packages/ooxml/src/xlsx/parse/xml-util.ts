/**
 * SpreadsheetML 部件扫描的公共读取：布尔属性、数值属性、带前缀的关系属性与 `_xHHHH_` 转义。
 */

import type { XmlScanner } from '../../xml/index.ts'

export type Scanner = Pick<
  XmlScanner,
  'next' | 'local' | 'depth' | 'attr' | 'text' | 'attrCount' | 'attrName' | 'attrValue'
>

/** `val` 属性缺失时为真（`<b/>`）；`0`、`false` 为假。 */
export function boolVal(x: Scanner, name = 'val'): boolean {
  const v = x.attr(name)
  return v === null || (v !== '0' && v !== 'false')
}

/** 属性为 `1` 或 `true` 时为真，缺失时取 `fallback`。 */
export function boolAttr(x: Scanner, name: string, fallback: boolean): boolean {
  const v = x.attr(name)
  if (v === null) return fallback
  return v === '1' || v === 'true'
}

export function numAttr(x: Scanner, name: string): number | null {
  const v = x.attr(name)
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 关系引用属性（`r:id`、`r:embed`）：按本地名匹配任意前缀的属性，前缀随文档而定。
 * 不带前缀的同名属性不参与匹配。
 */
export function relAttr(x: Scanner, local: string): string | null {
  for (let i = 0; i < x.attrCount; i++) {
    const name = x.attrName(i)
    const colon = name.indexOf(':')
    if (colon > 0 && name.slice(colon + 1) === local && !name.startsWith('xmlns')) {
      return x.attrValue(i)
    }
  }
  return null
}

/** `_xHHHH_` 表示 XML 无法直接书写的字符（如 `_x000D_` 为回车），`_x005F_` 转义下划线本身。 */
export function decodeEscapes(s: string): string {
  if (!s.includes('_x')) return s
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

/** 读取当前元素内的全部文本，返回时位于其结束标签。 */
export function readText(x: Scanner): string {
  const depth = x.depth
  let out = ''
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'text') out += x.text
    else if (t === 'end' && x.depth === depth) break
  }
  return out
}

/** 跳过当前元素，返回时位于其结束标签。 */
export function skipElement(x: Scanner): void {
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) return
  }
}
