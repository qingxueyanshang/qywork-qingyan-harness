/**
 * OPC 包：内容类型、部件关系与目标路径解析。
 *
 * - 部件名以 `/` 开头，存储为 ZIP 成员名时去掉开头的 `/`。`[Content_Types].xml` 不是部件，不列入 `parts`。
 * - 部件名比较先做百分号解码，再把 `\` 视为 `/`，最后按 ASCII 不区分大小写：关系目标可能写成 `%E5%9B%BE.png`，
 *   而 ZIP 成员名可能是解码后的字符。百分号序列不合法时按原文比较。成员名中的 `\` 在 `parts` 中写为 `/`，
 *   内容类型部件同样按比较键查找（WPS 实测：成员名为 `xl\workbook.xml` 与小写 `[content_types].xml` 的文件正常打开）。
 * - 结果一律以 `OpcResult` 返回。ZIP 层的失败原样传出；缺少 `[Content_Types].xml` 为 `not-office`；
 *   内容类型或关系部件的 XML 无法解析为 `corrupt`。部件没有关系部件时关系表为空，不是失败。
 * - 关系条目缺少 `Id`、`Type` 或 `Target` 时跳过该条目，其余条目照常返回。
 */

import { XmlScanner, XmlSyntaxError } from '../xml/index.ts'
import { openZip, type ZipArchive, type ZipCorruptReason } from '../zip/index.ts'
import { relationshipKind } from './namespace.ts'

/** 在 ZIP 层原因之外：`content-types` 为内容类型部件无法解析，`relationships` 为关系部件无法解析。 */
export type OpcCorruptReason = ZipCorruptReason | 'content-types' | 'relationships'

/** 与 `ZipFailure` 同构，`ZipResult` 可直接作为 `OpcResult` 返回。界面只按 `kind` 显示。 */
export type OpcFailure =
  | { readonly kind: 'not-office' }
  | { readonly kind: 'encrypted' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'corrupt'; readonly reason: OpcCorruptReason }

export type OpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: OpcFailure }

export interface Relationship {
  readonly id: string
  /** `Type` 属性原文。 */
  readonly type: string
  /** `relationshipKind(type)`。 */
  readonly kind: string
  /** `Target` 属性原文。 */
  readonly target: string
  /** `TargetMode="External"`。 */
  readonly external: boolean
  /** 内部关系解析后的部件名（见 `resolveTarget`），外部关系为 `null`。该部件不一定存在于包中。 */
  readonly part: string | null
}

export interface Relationships {
  /** 源部件名；包关系为 `/`。 */
  readonly source: string
  /** 按关系部件中的顺序。 */
  readonly list: readonly Relationship[]
  /** `Id` 重复时取第一个。 */
  byId(id: string): Relationship | null
  /** `kind` 为 `relationshipKind` 的结果，内部与外部关系都列出。 */
  ofKind(kind: string): readonly Relationship[]
  /** 第一个该类型的内部关系的部件名；没有时为 `null`。 */
  part(kind: string): string | null
}

export interface OpcPackage {
  /** 全部部件名，按 ZIP 中央目录顺序，不含目录项。 */
  readonly parts: readonly string[]
  has(part: string): boolean
  /** 先按 `Override` 的部件名，再按 `Default` 的扩展名（不区分大小写）；都没有时为 `null`。 */
  contentType(part: string): string | null
  /** `source` 为部件名，包关系传 `/`。同一源部件的结果在包内缓存。 */
  relationships(source: string): Promise<OpcResult<Relationships>>
  /** 部件不存在时 `value` 为 `null`。 */
  bytes(part: string): Promise<OpcResult<Uint8Array | null>>
  /** 同 `bytes`，再按 UTF-8 解码。 */
  text(part: string): Promise<OpcResult<string | null>>
}

const CONTENT_TYPES = '/[Content_Types].xml'

function fail(failure: OpcFailure): { readonly ok: false; readonly failure: OpcFailure } {
  return { ok: false, failure }
}

function percentDecode(s: string): string {
  if (!s.includes('%')) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 部件名的比较键。只折叠 ASCII 字母：OPC 规定部件名按 ASCII 不区分大小写比较。 */
function partKey(part: string): string {
  return percentDecode(part)
    .replaceAll('\\', '/')
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/**
 * 按 URI 相对引用的规则，以源部件名为基准解析关系目标，返回百分号解码后的部件名。
 *
 * - 以 `/` 开头的目标是绝对路径；其余相对于源部件所在目录，包关系（源为 `/`）相对于根。`\` 与 `/` 同为分隔符。
 * - `#` 之后的片段不属于部件名，去掉；`.` 与 `..` 段按层消去，`..` 超出根时停在根。
 * - 只用于内部关系。外部关系的目标是任意 URI，不按部件名解析。
 */
export function resolveTarget(source: string, target: string): string {
  const hash = target.indexOf('#')
  const path = (hash < 0 ? target : target.slice(0, hash)).replaceAll('\\', '/')
  const joined = path.startsWith('/') ? path : source.slice(0, source.lastIndexOf('/') + 1) + path
  const out: string[] = []
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return percentDecode(`/${out.join('/')}`)
}

/** `/xl/workbook.xml` 的关系部件是 `/xl/_rels/workbook.xml.rels`；包关系是 `/_rels/.rels`。 */
function relationshipsPartOf(source: string): string {
  const slash = source.lastIndexOf('/')
  return `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`
}

interface ContentTypes {
  readonly defaults: ReadonlyMap<string, string>
  readonly overrides: ReadonlyMap<string, string>
}

/** 内容类型与关系部件都只读根元素的直接子元素，元素按本地名匹配，不限定前缀。 */
function parseContentTypes(xml: string): ContentTypes {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  const x = new XmlScanner(xml)
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2) continue
    const type = x.attr('ContentType')
    if (type === null) continue
    if (x.local === 'Default') {
      const ext = x.attr('Extension')
      if (ext !== null && !defaults.has(ext.toLowerCase())) defaults.set(ext.toLowerCase(), type)
    } else if (x.local === 'Override') {
      const part = x.attr('PartName')
      if (part !== null && !overrides.has(partKey(part))) overrides.set(partKey(part), type)
    }
  }
  return { defaults, overrides }
}

function parseRelationships(xml: string, source: string): Relationships {
  const list: Relationship[] = []
  const x = new XmlScanner(xml)
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2 || x.local !== 'Relationship') continue
    const id = x.attr('Id')
    const type = x.attr('Type')
    const target = x.attr('Target')
    if (id === null || type === null || target === null) continue
    const external = x.attr('TargetMode') === 'External'
    list.push({
      id,
      type,
      kind: relationshipKind(type),
      target,
      external,
      part: external ? null : resolveTarget(source, target),
    })
  }
  return new RelationshipList(source, list)
}

class RelationshipList implements Relationships {
  constructor(
    readonly source: string,
    readonly list: readonly Relationship[],
  ) {}

  byId(id: string): Relationship | null {
    return this.list.find((r) => r.id === id) ?? null
  }

  ofKind(kind: string): readonly Relationship[] {
    return this.list.filter((r) => r.kind === kind)
  }

  part(kind: string): string | null {
    return this.list.find((r) => r.kind === kind && !r.external)?.part ?? null
  }
}

class Package implements OpcPackage {
  private readonly rels = new Map<string, Promise<OpcResult<Relationships>>>()

  constructor(
    private readonly zip: ZipArchive,
    readonly parts: readonly string[],
    /** 部件比较键到 ZIP 成员名。 */
    private readonly members: ReadonlyMap<string, string>,
    private readonly types: ContentTypes,
  ) {}

  has(part: string): boolean {
    return this.members.has(partKey(part))
  }

  contentType(part: string): string | null {
    const override = this.types.overrides.get(partKey(part))
    if (override !== undefined) return override
    const name = part.slice(part.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    if (dot < 0) return null
    return this.types.defaults.get(name.slice(dot + 1).toLowerCase()) ?? null
  }

  relationships(source: string): Promise<OpcResult<Relationships>> {
    const key = partKey(source)
    let pending = this.rels.get(key)
    if (pending === undefined) {
      pending = this.readRelationships(source)
      this.rels.set(key, pending)
    }
    return pending
  }

  private async readRelationships(source: string): Promise<OpcResult<Relationships>> {
    const read = await this.text(relationshipsPartOf(source))
    if (!read.ok) return read
    if (read.value === null) return { ok: true, value: new RelationshipList(source, []) }
    try {
      return { ok: true, value: parseRelationships(read.value, source) }
    } catch (e) {
      if (e instanceof XmlSyntaxError) return fail({ kind: 'corrupt', reason: 'relationships' })
      throw e
    }
  }

  bytes(part: string): Promise<OpcResult<Uint8Array | null>> {
    const member = this.members.get(partKey(part))
    if (member === undefined) return Promise.resolve({ ok: true, value: null })
    return this.zip.bytes(member)
  }

  text(part: string): Promise<OpcResult<string | null>> {
    const member = this.members.get(partKey(part))
    if (member === undefined) return Promise.resolve({ ok: true, value: null })
    return this.zip.text(member)
  }
}

/** 打开 ZIP 并读取内容类型；关系部件在 `relationships` 调用时才读取。 */
export async function openPackage(data: Uint8Array<ArrayBuffer>): Promise<OpcResult<OpcPackage>> {
  const opened = openZip(data)
  if (!opened.ok) return opened
  const zip = opened.value
  const parts: string[] = []
  const members = new Map<string, string>()
  const typesKey = partKey(CONTENT_TYPES)
  let typesMember: string | null = null
  for (const path of zip.paths) {
    const part = `/${path.replaceAll('\\', '/')}`
    if (part.endsWith('/')) continue
    const key = partKey(part)
    if (key === typesKey) {
      typesMember ??= path
      continue
    }
    parts.push(part)
    if (!members.has(key)) members.set(key, path)
  }
  if (typesMember === null) return fail({ kind: 'not-office' })
  const read = await zip.text(typesMember)
  if (!read.ok) return read
  if (read.value === null) return fail({ kind: 'not-office' })
  let types: ContentTypes
  try {
    types = parseContentTypes(read.value)
  } catch (e) {
    if (e instanceof XmlSyntaxError) return fail({ kind: 'corrupt', reason: 'content-types' })
    throw e
  }
  return { ok: true, value: new Package(zip, parts, members, types) }
}
