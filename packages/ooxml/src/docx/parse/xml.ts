/**
 * WordprocessingML 部件扫描的公共读取：逐个子元素访问、按命名空间读取属性、开关值与数值。
 *
 * - 元素按本地名匹配；属性先按元素自身的前缀取，取不到再按 WordprocessingML 命名空间匹配。
 * - 开关值（`ST_OnOff`）：缺少 `w:val` 为真；`true`、`1`、`on` 为真，`false`、`0`、`off` 为假。
 * - 元素嵌套超过 `MAX_DEPTH`（`../../xml/index.ts`）层时 `eachChild` 抛出 `NestingError`：正文与页眉页脚中由 `body.ts`
 *   截断，其余部件按结构错误处理（`../load.ts` 返回 `corrupt('xml')`）。
 */

import type { PartScanner } from '../../opc/scanner.ts'
import { MAX_DEPTH } from '../../xml/index.ts'

export type Scanner = PartScanner

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** 部件中的元素嵌套超过 `MAX_DEPTH` 层。 */
export class NestingError extends Error {
  constructor() {
    super(`元素嵌套超过 ${MAX_DEPTH} 层`)
    this.name = 'NestingError'
  }
}

/** 访问当前元素的每个子元素；回调可读到子元素的结束标签为止，也可不前进。 */
export function eachChild(x: Scanner, visit: (local: string) => void): void {
  const depth = x.depth
  if (depth >= MAX_DEPTH) throw new NestingError()
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) return
    if (t === 'start' && x.depth === depth + 1) visit(x.local)
  }
}

/** 读到当前元素的结束标签为止。 */
export function skip(x: Scanner): void {
  eachChild(x, () => {})
}

export function wAttr(x: Scanner, local: string): string | null {
  const prefix = x.prefix
  const v = x.attr(prefix === '' ? local : `${prefix}:${local}`)
  return v ?? x.attrNs(W_NS, local)
}

export function wNum(x: Scanner, local: string): number | null {
  const v = wAttr(x, local)
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function onOff(x: Scanner, local = 'val'): boolean {
  const v = wAttr(x, local)
  return v === null || !(v === 'false' || v === '0' || v === 'off')
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
