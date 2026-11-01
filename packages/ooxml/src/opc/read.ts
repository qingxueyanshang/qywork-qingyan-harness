/**
 * 部件扫描的公共读取：逐个子元素访问、跳过元素、数值与布尔属性、关系引用属性。DrawingML 与 PresentationML 的读取共用。
 *
 * - `eachChild` 的回调可以读到子元素的结束标签为止，也可以不前进；只前进一部分时其余内容被跳过。
 * - 布尔属性按 XML Schema 的 `xsd:boolean`：`1`、`true` 为真，`0`、`false` 为假。
 */

import { NS } from './namespace.ts'
import type { PartScanner } from './scanner.ts'

export type Scanner = PartScanner

export function eachChild(x: Scanner, visit: (local: string) => void): void {
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) return
    if (t === 'start' && x.depth === depth + 1) visit(x.local)
  }
}

/** 读到当前元素的结束标签为止。 */
export function skip(x: Scanner): void {
  eachChild(x, () => {})
}

export function num(x: Scanner, name: string): number | null {
  const v = x.attr(name)
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function int(x: Scanner, name: string, fallback: number): number {
  return num(x, name) ?? fallback
}

export function bool(x: Scanner, name: string): boolean | null {
  const v = x.attr(name)
  if (v === '1' || v === 'true') return true
  if (v === '0' || v === 'false') return false
  return null
}

/** `r:id`、`r:embed` 等关系引用属性，按关系命名空间匹配。 */
export function relAttr(x: Scanner, local: string): string | null {
  return x.attrNs(NS.relationships, local)
}

/** 当前元素内的全部文本，返回时位于其结束标签。 */
export function readText(x: Scanner): string {
  const depth = x.depth
  let out = ''
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t === 'text') out += x.text
  }
  return out
}
