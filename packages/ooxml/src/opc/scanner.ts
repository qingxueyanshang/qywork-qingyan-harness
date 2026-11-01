/**
 * 部件 XML 的扫描：在 `XmlScanner` 之上解析命名空间前缀，并按标记兼容性规则展开 `mc:AlternateContent`。
 *
 * - 成员与 `XmlScanner` 同名同义，解析器可直接替换使用；另有 `namespace`、`resolve`、`attrNs` 按命名空间读取。
 *   返回的命名空间一律为规范形式（`canonicalNamespace`），Strict 与 Transitional 文档得到同一个 URI。
 * - `AlternateContent` 按命名空间 URI 识别，不依赖 `mc` 前缀。选择规则：依次检查 `Choice`，
 *   其 `Requires` 列出的每个前缀都解析为构造时传入的受支持命名空间时选中该分支；没有选中的 `Choice` 时取 `Fallback`；
 *   都不满足时整组不产出任何事件。`Requires` 缺失或含未声明的前缀时视为不支持。
 * - 选中分支的子节点作为 `AlternateContent` 父元素的子节点产出：`AlternateContent` 与分支元素本身不产出事件，
 *   `depth` 不计入这两层。未选中的分支整体跳过，其中的命名空间声明同样不生效。
 * - 不处理 `mc:Ignorable`、`mc:ProcessContent` 与 `mc:MustUnderstand`：解析器按本地名读取已知元素，
 *   可忽略命名空间中的元素与属性不会被读取。
 */

import { XmlScanner, type XmlToken } from '../xml/index.ts'
import { canonicalNamespace, NS } from './namespace.ts'

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

interface Declaration {
  /** 声明所在元素的原始层数。 */
  readonly depth: number
  readonly prefix: string
  /** 规范形式；`xmlns=""` 取消默认命名空间时为空串。 */
  readonly uri: string
}

interface Group {
  /** `AlternateContent` 的原始层数。 */
  readonly depth: number
  chosen: boolean
}

export class PartScanner {
  private readonly x: XmlScanner
  private readonly supported: ReadonlySet<string>
  private readonly declarations: Declaration[] = []
  /** 不产出事件的元素（`AlternateContent` 与选中的分支）的原始层数，自外向内。 */
  private readonly hidden: number[] = []
  private readonly groups: Group[] = []
  /** 上一个原始事件是 `end` 时为该元素的原始层数：其命名空间声明在下一个原始事件前失效。 */
  private closing = -1

  /** `supported` 为解析器支持的命名空间 URI，Strict 形式同样接受；只影响 `Choice` 的选择。 */
  constructor(xml: string, supported: Iterable<string> = []) {
    this.x = new XmlScanner(xml)
    this.supported = new Set(Array.from(supported, canonicalNamespace))
  }

  get name(): string {
    return this.x.name
  }

  get prefix(): string {
    return this.x.prefix
  }

  get local(): string {
    return this.x.local
  }

  /** 不计入被展开的 `AlternateContent` 与分支元素。 */
  get depth(): number {
    return this.x.depth - this.hidden.length
  }

  get text(): string {
    return this.x.text
  }

  get attrCount(): number {
    return this.x.attrCount
  }

  attrName(index: number): string {
    return this.x.attrName(index)
  }

  attrValue(index: number): string {
    return this.x.attrValue(index)
  }

  attr(name: string): string | null {
    return this.x.attr(name)
  }

  /** 当前元素的命名空间 URI；未声明或不是元素事件时为 `null`。 */
  get namespace(): string | null {
    return this.x.name === '' ? null : this.resolve(this.x.prefix)
  }

  /** 前缀在当前位置对应的命名空间 URI，空串表示默认命名空间；未声明时为 `null`。 */
  resolve(prefix: string): string | null {
    if (prefix === 'xml') return XML_NAMESPACE
    const list = this.declarations
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]!
      if (d.prefix === prefix) return d.uri === '' ? null : d.uri
    }
    return null
  }

  /** 按命名空间与本地名取属性值，`namespace` 为规范形式。不带前缀的属性不属于任何命名空间，不参与匹配。 */
  attrNs(namespace: string, local: string): string | null {
    const x = this.x
    for (let i = 0; i < x.attrCount; i++) {
      const name = x.attrName(i)
      const colon = name.indexOf(':')
      if (colon < 0 || name.length - colon - 1 !== local.length || !name.endsWith(local)) continue
      if (this.resolve(name.slice(0, colon)) === namespace) return x.attrValue(i)
    }
    return null
  }

  next(): XmlToken | null {
    const hidden = this.hidden
    const groups = this.groups
    for (;;) {
      const t = this.raw()
      if (t === null) return null
      const depth = this.x.depth
      if (t === 'end') {
        if (hidden.length === 0 || hidden[hidden.length - 1] !== depth) return 'end'
        hidden.pop()
        if (groups.length > 0 && groups[groups.length - 1]!.depth === depth) groups.pop()
        continue
      }
      const group = groups.length > 0 ? groups[groups.length - 1] : undefined
      if (group !== undefined && depth === group.depth + (t === 'text' ? 0 : 1)) {
        // 分支之间的文本只有空白；分支元素之外的子元素不属于任何分支。
        if (t === 'start' && !group.chosen && this.selects()) {
          group.chosen = true
          hidden.push(depth)
        } else if (t === 'start') {
          this.skip(depth)
        }
        continue
      }
      // 先比较缓存的限定名，避免每个开始标签都切出本地名。
      if (
        t === 'start' &&
        this.x.name.endsWith('AlternateContent') &&
        this.x.local === 'AlternateContent' &&
        this.isCompatibility()
      ) {
        groups.push({ depth, chosen: false })
        hidden.push(depth)
        continue
      }
      return t
    }
  }

  /** 读取一个原始事件并维护命名空间声明。 */
  private raw(): XmlToken | null {
    if (this.closing >= 0) {
      const list = this.declarations
      while (list.length > 0 && list[list.length - 1]!.depth >= this.closing) list.pop()
      this.closing = -1
    }
    const x = this.x
    const t = x.next()
    if (t === 'start') {
      for (let i = 0; i < x.attrCount; i++) {
        const name = x.attrName(i)
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue
        const uri = canonicalNamespace(x.attrValue(i))
        this.declarations.push({ depth: x.depth, prefix: name.slice(6), uri })
      }
    } else if (t === 'end') {
      this.closing = x.depth
    }
    return t
  }

  /** 跳过当前开始标签所在元素的全部内容，停在它的结束标签。 */
  private skip(depth: number): void {
    for (let t = this.raw(); t !== null; t = this.raw()) {
      if (t === 'end' && this.x.depth === depth) return
    }
  }

  private isCompatibility(): boolean {
    return this.resolve(this.x.prefix) === NS.markupCompatibility
  }

  /** 当前开始标签是可选中的分支：满足条件的 `Choice`，或 `Fallback`。 */
  private selects(): boolean {
    if (!this.isCompatibility()) return false
    const local = this.x.local
    if (local === 'Fallback') return true
    if (local !== 'Choice') return false
    const requires = this.x.attr('Requires')?.trim()
    if (!requires) return false
    for (const prefix of requires.split(/\s+/)) {
      const uri = this.resolve(prefix)
      if (uri === null || !this.supported.has(uri)) return false
    }
    return true
  }
}
