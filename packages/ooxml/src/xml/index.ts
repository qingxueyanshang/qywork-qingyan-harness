/**
 * XML 拉取式扫描：每次 `next()` 产出一个开始标签、结束标签或文本，不建树。
 *
 * - 不依赖 DOM 接口，可在 Worker 与 Bun 中运行。输入是已解码的字符串，开头的字节序标记跳过。
 * - 自闭合标签依次产出 `start` 与 `end`。注释、处理指令与 XML 声明跳过，不产出事件。
 *   CDATA 作为 `text` 产出，内容不做实体解码。
 * - 不读取 DTD：遇到 `<!DOCTYPE` 抛出 `XmlSyntaxError`。OOXML 部件不允许包含 DTD，
 *   因此可用的实体只有五个预定义实体与数字字符引用。
 * - 命名空间不解析为 URI，只拆出前缀与本地名。
 * - 结构错误（标签未结束、结束标签不匹配、元素未闭合、缺少根元素）由 `next()` 抛出；
 *   文本与属性值在读取时才解码，其中的非法实体在读取时抛出，未读取的部分不检查。
 */

export type XmlToken = 'start' | 'end' | 'text'

export class XmlSyntaxError extends Error {
  /** 出错位置，按输入字符串的下标计。 */
  readonly offset: number

  constructor(message: string, offset: number) {
    super(`${message}（位置 ${offset}）`)
    this.name = 'XmlSyntaxError'
    this.offset = offset
  }
}

const LT = 60
const GT = 62
const SLASH = 47
const BANG = 33
const QUESTION = 63
const EQUALS = 61
const AMP = 38
const SEMICOLON = 59
const HASH = 35
const LOWER_X = 120
const QUOTE = 34
const APOS = 39
const TAB = 9
const LF = 10
const CR = 13
const SPACE = 32
const BOM = 0xfeff

function isSpace(c: number): boolean {
  return c === SPACE || c === LF || c === TAB || c === CR
}

export class XmlScanner {
  private readonly s: string
  private pos: number
  private readonly stack: string[] = []
  /** 上一个事件是 `end`：其元素在下一次 `next()` 开始时出栈，使 `end` 事件期间 `depth` 仍包含该元素。 */
  private popPending = false
  /** 上一个事件是自闭合标签的 `start`，下一次 `next()` 产出对应的 `end`。 */
  private endPending = false
  private sawRoot = false
  private tokenName = ''
  private textStart = 0
  private textEnd = 0
  private textIsCdata = false
  /** 当前开始标签的属性，每个属性占四项：名称起止、值起止（不含引号）。 */
  private readonly attrs: number[] = []
  private attrLength = 0

  constructor(xml: string) {
    this.s = xml
    this.pos = xml.charCodeAt(0) === BOM ? 1 : 0
  }

  /** 限定名，含前缀。只在 `start` 与 `end` 时有值，`text` 时为空串。 */
  get name(): string {
    return this.tokenName
  }

  /** 前缀，没有前缀时为空串。 */
  get prefix(): string {
    const i = this.tokenName.indexOf(':')
    return i < 0 ? '' : this.tokenName.slice(0, i)
  }

  get local(): string {
    const i = this.tokenName.indexOf(':')
    return i < 0 ? this.tokenName : this.tokenName.slice(i + 1)
  }

  /** 当前所在的元素层数。`start` 与 `end` 时包含该元素本身，根元素为 1。 */
  get depth(): number {
    return this.stack.length
  }

  /** 当前文本事件解码后的内容；不是文本事件时为空串。 */
  get text(): string {
    return decode(this.s, this.textStart, this.textEnd, false, this.textIsCdata)
  }

  /** 当前开始标签上的属性数；不是开始标签时为 0。 */
  get attrCount(): number {
    return this.attrLength / 4
  }

  /** `index` 须小于 `attrCount`，越界时结果无意义。 */
  attrName(index: number): string {
    return this.s.slice(this.attrs[index * 4]!, this.attrs[index * 4 + 1]!)
  }

  /** 解码后的属性值；`index` 的约束同 `attrName`。 */
  attrValue(index: number): string {
    return decode(this.s, this.attrs[index * 4 + 2]!, this.attrs[index * 4 + 3]!, true, false)
  }

  /** 按限定名（含前缀）取属性值，不存在时返回 `null`。 */
  attr(name: string): string | null {
    const { s, attrs } = this
    for (let i = 0; i < this.attrLength; i += 4) {
      const start = attrs[i]!
      if (attrs[i + 1]! - start === name.length && s.startsWith(name, start)) {
        return decode(s, attrs[i + 2]!, attrs[i + 3]!, true, false)
      }
    }
    return null
  }

  /** 前进到下一个事件；输入结束时返回 `null`。 */
  next(): XmlToken | null {
    if (this.popPending) {
      this.stack.pop()
      this.popPending = false
    }
    this.attrLength = 0
    this.textStart = 0
    this.textEnd = 0
    if (this.endPending) {
      this.endPending = false
      this.popPending = true
      return 'end'
    }
    const s = this.s
    const length = s.length
    for (;;) {
      const at = this.pos
      if (at >= length) return this.finish()
      if (s.charCodeAt(at) !== LT) {
        let lt = s.indexOf('<', at)
        if (lt < 0) lt = length
        this.pos = lt
        if (this.stack.length === 0) {
          for (let i = at; i < lt; i++) {
            if (!isSpace(s.charCodeAt(i))) throw new XmlSyntaxError('根元素之外出现文本', i)
          }
          continue
        }
        return this.setText(at, lt, false)
      }
      const c = s.charCodeAt(at + 1)
      if (c === SLASH) return this.endTag(at)
      if (c === QUESTION) {
        this.pos = this.skipTo('?>', at + 2, '处理指令未结束', at)
        continue
      }
      if (c === BANG) {
        if (s.startsWith('<!--', at)) {
          this.pos = this.skipTo('-->', at + 4, '注释未结束', at)
          continue
        }
        if (s.startsWith('<![CDATA[', at)) {
          if (this.stack.length === 0) throw new XmlSyntaxError('根元素之外出现 CDATA', at)
          const close = s.indexOf(']]>', at + 9)
          if (close < 0) throw new XmlSyntaxError('CDATA 未结束', at)
          this.pos = close + 3
          return this.setText(at + 9, close, true)
        }
        throw new XmlSyntaxError('不支持 DTD 与其他 <! 声明', at)
      }
      return this.startTag(at)
    }
  }

  private finish(): null {
    const open = this.stack.at(-1)
    if (open !== undefined) throw new XmlSyntaxError(`元素 <${open}> 未闭合`, this.s.length)
    if (!this.sawRoot) throw new XmlSyntaxError('缺少根元素', this.s.length)
    return null
  }

  private setText(start: number, end: number, cdata: boolean): 'text' {
    this.tokenName = ''
    this.textStart = start
    this.textEnd = end
    this.textIsCdata = cdata
    return 'text'
  }

  private skipTo(close: string, from: number, message: string, at: number): number {
    const i = this.s.indexOf(close, from)
    if (i < 0) throw new XmlSyntaxError(message, at)
    return i + close.length
  }

  private startTag(at: number): 'start' {
    const s = this.s
    const length = s.length
    if (this.stack.length === 0 && this.sawRoot) throw new XmlSyntaxError('根元素之后出现元素', at)
    let p = at + 1
    while (p < length) {
      const c = s.charCodeAt(p)
      if (isSpace(c) || c === SLASH || c === GT) break
      p++
    }
    if (p === at + 1) throw new XmlSyntaxError('标签缺少名称', at)
    const name = s.slice(at + 1, p)

    const attrs = this.attrs
    let n = 0
    let selfClosing = false
    for (;;) {
      while (p < length && isSpace(s.charCodeAt(p))) p++
      if (p >= length) throw new XmlSyntaxError(`标签 <${name}> 未结束`, at)
      const c = s.charCodeAt(p)
      if (c === GT) {
        p++
        break
      }
      if (c === SLASH) {
        if (s.charCodeAt(p + 1) !== GT) throw new XmlSyntaxError(`标签 <${name}> 未结束`, at)
        p += 2
        selfClosing = true
        break
      }
      const nameStart = p
      while (p < length) {
        const d = s.charCodeAt(p)
        if (isSpace(d) || d === EQUALS || d === GT || d === SLASH) break
        p++
      }
      const nameEnd = p
      while (p < length && isSpace(s.charCodeAt(p))) p++
      if (nameEnd === nameStart || s.charCodeAt(p) !== EQUALS) {
        throw new XmlSyntaxError(`标签 <${name}> 的属性格式错误`, nameStart)
      }
      p++
      while (p < length && isSpace(s.charCodeAt(p))) p++
      const quote = s.charCodeAt(p)
      if (quote !== QUOTE && quote !== APOS) {
        throw new XmlSyntaxError(`标签 <${name}> 的属性值缺少引号`, p)
      }
      const valueEnd = s.indexOf(quote === QUOTE ? '"' : "'", p + 1)
      if (valueEnd < 0) throw new XmlSyntaxError(`标签 <${name}> 的属性值未结束`, p)
      attrs[n++] = nameStart
      attrs[n++] = nameEnd
      attrs[n++] = p + 1
      attrs[n++] = valueEnd
      p = valueEnd + 1
    }

    this.pos = p
    this.attrLength = n
    this.tokenName = name
    this.sawRoot = true
    this.stack.push(name)
    this.endPending = selfClosing
    return 'start'
  }

  private endTag(at: number): 'end' {
    const s = this.s
    const length = s.length
    const nameStart = at + 2
    let p = nameStart
    while (p < length) {
      const c = s.charCodeAt(p)
      if (isSpace(c) || c === GT) break
      p++
    }
    const nameEnd = p
    while (p < length && isSpace(s.charCodeAt(p))) p++
    if (p >= length || s.charCodeAt(p) !== GT) throw new XmlSyntaxError('结束标签未结束', at)
    const open = this.stack.at(-1)
    if (
      open === undefined ||
      nameEnd - nameStart !== open.length ||
      !s.startsWith(open, nameStart)
    ) {
      const found = s.slice(nameStart, nameEnd)
      throw new XmlSyntaxError(
        open === undefined
          ? `结束标签 </${found}> 没有对应的开始标签`
          : `结束标签 </${found}> 与 <${open}> 不匹配`,
        at,
      )
    }
    this.pos = p + 1
    this.tokenName = open
    this.popPending = true
    return 'end'
  }
}

/**
 * 解码 `s[start, end)`：实体与字符引用替换为字符，换行规范化为 LF；属性值中的制表符与换行再替换为空格。
 * 字符引用产出的字符不参与规范化。没有需要替换的字符时直接返回切片。
 */
function decode(s: string, start: number, end: number, attribute: boolean, cdata: boolean): string {
  let out = ''
  let last = start
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i)
    if (c === AMP && !cdata) {
      let semi = i + 1
      while (semi < end && s.charCodeAt(semi) !== SEMICOLON) semi++
      if (semi === end) throw new XmlSyntaxError('实体缺少分号', i)
      out += s.slice(last, i) + entity(s, i + 1, semi)
      i = semi
      last = semi + 1
    } else if (c === CR) {
      out += s.slice(last, i) + (attribute ? ' ' : '\n')
      if (i + 1 < end && s.charCodeAt(i + 1) === LF) i++
      last = i + 1
    } else if (attribute && (c === LF || c === TAB)) {
      out += `${s.slice(last, i)} `
      last = i + 1
    }
  }
  return last === start ? s.slice(start, end) : out + s.slice(last, end)
}

function entity(s: string, start: number, end: number): string {
  if (s.charCodeAt(start) === HASH) {
    const hex = s.charCodeAt(start + 1) === LOWER_X
    const digits = s.slice(start + (hex ? 2 : 1), end)
    const code = (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)
      ? Number.parseInt(digits, hex ? 16 : 10)
      : -1
    if (!isXmlChar(code))
      throw new XmlSyntaxError(`非法字符引用 &${s.slice(start, end)};`, start - 1)
    return String.fromCodePoint(code)
  }
  const name = s.slice(start, end)
  switch (name) {
    case 'lt':
      return '<'
    case 'gt':
      return '>'
    case 'amp':
      return '&'
    case 'quot':
      return '"'
    case 'apos':
      return "'"
  }
  throw new XmlSyntaxError(`未定义的实体 &${name};`, start - 1)
}

/** XML 1.0 的 Char 产生式。 */
function isXmlChar(c: number): boolean {
  return (
    c === TAB ||
    c === LF ||
    c === CR ||
    (c >= 0x20 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd) ||
    (c >= 0x10000 && c <= 0x10ffff)
  )
}
