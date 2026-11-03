/**
 * 测试夹具：按部件 XML 生成最小 docx。
 *
 * - ZIP 按存储方式（不压缩）写入，CRC 使用 `Bun.hash.crc32`，与被测的 ZIP 读取互相独立。
 * - `buildDocx` 的正文与各部件只写出参数给出的内容；未给出的部件不写入包中。
 */

const encoder = new TextEncoder()

const W_DECL =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml'

function buildZip(members: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(members)) {
    const nameBytes = encoder.encode(name)
    const data = typeof content === 'string' ? encoder.encode(content) : content
    const crc = Bun.hash.crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x800, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x800, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const directorySize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, directorySize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + directorySize + 22)
  let p = 0
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, p)
    p += chunk.length
  }
  return out
}

function rels(items: readonly (readonly [string, string, string])[]): string {
  const body = items
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
}

export interface DocxParts {
  /** `w:body` 的内容。 */
  readonly body: string
  /** `w:styles` 的内容（`docDefaults` 与样式）。 */
  readonly styles?: string
  /** `w:numbering` 的内容。 */
  readonly numbering?: string
  /** `w:settings` 的内容。 */
  readonly settings?: string
  /** `w:fonts` 的内容。 */
  readonly fonts?: string
  /** 字体表部件关系引用的部件（嵌入字体），按给出的关系标识登记为 `font` 关系，写在 `word/` 之下。 */
  readonly fontParts?: readonly {
    readonly id: string
    readonly name: string
    readonly content: Uint8Array
  }[]
  /** 完整的主题部件。 */
  readonly theme?: string
  /** `w:document` 中 `w:body` 之前的内容（如 `w:background`）。 */
  readonly before?: string
  /** 主文档的内容类型，缺省为 WordprocessingML 文档。 */
  readonly mainType?: string
  /** 主文档关系引用的其他部件（页眉页脚、图片），按给出的关系标识与类型登记，内容原样写入（字符串按 UTF-8）。 */
  readonly extra?: readonly {
    readonly id: string
    /** 关系类型的末段，如 `header`、`image`。 */
    readonly type: string
    /** `word/` 之下的部件名。 */
    readonly name: string
    readonly content: string | Uint8Array
    readonly contentType?: string
  }[]
}

const PARTS: readonly (readonly [keyof DocxParts, string, string, string])[] = [
  ['styles', 'styles.xml', 'styles', 'styles'],
  ['numbering', 'numbering.xml', 'numbering', 'numbering'],
  ['settings', 'settings.xml', 'settings', 'settings'],
  ['fonts', 'fontTable.xml', 'fontTable', 'fonts'],
]

export function buildDocx(parts: DocxParts): Uint8Array<ArrayBuffer> {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const members: Record<string, string | Uint8Array> = {}
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="${parts.mainType ?? `${CT}.document.main+xml`}"/>`,
  ]
  const docRels: [string, string, string][] = []
  for (const [key, file, type, root] of PARTS) {
    const content = parts[key]
    if (content === undefined) continue
    members[`word/${file}`] = `${head}<w:${root} ${W_DECL}>${content}</w:${root}>`
    const ct = type === 'fontTable' ? 'fontTable' : type
    overrides.push(`<Override PartName="/word/${file}" ContentType="${CT}.${ct}+xml"/>`)
    docRels.push([`rId${docRels.length + 1}`, type, file])
  }
  if (parts.theme !== undefined) {
    members['word/theme/theme1.xml'] = parts.theme
    overrides.push(
      '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    )
    docRels.push([`rId${docRels.length + 1}`, 'theme', 'theme/theme1.xml'])
  }
  if (parts.fontParts !== undefined) {
    for (const f of parts.fontParts) members[`word/${f.name}`] = f.content
    members['word/_rels/fontTable.xml.rels'] = rels(
      parts.fontParts.map((f) => [f.id, 'font', f.name] as const),
    )
  }
  for (const e of parts.extra ?? []) {
    members[`word/${e.name}`] = e.content
    if (e.contentType !== undefined)
      overrides.push(`<Override PartName="/word/${e.name}" ContentType="${e.contentType}"/>`)
    docRels.push([e.id, e.type, e.name])
  }
  members['[Content_Types].xml'] =
    `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    `<Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`
  members['_rels/.rels'] = rels([['rId1', 'officeDocument', 'word/document.xml']])
  members['word/_rels/document.xml.rels'] = rels(docRels)
  members['word/document.xml'] =
    `${head}<w:document ${W_DECL}>${parts.before ?? ''}<w:body>${parts.body}</w:body></w:document>`
  return buildZip(members)
}

/** 段落：`ppr` 为 `w:pPr` 的内容，`content` 为字段等段落内元素。 */
export function p(content: string, ppr = ''): string {
  return `<w:p>${ppr === '' ? '' : `<w:pPr>${ppr}</w:pPr>`}${content}</w:p>`
}

/** 字段：`rpr` 为 `w:rPr` 的内容。 */
export function r(text: string, rpr = ''): string {
  return `<w:r>${rpr === '' ? '' : `<w:rPr>${rpr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

export function style(
  type: 'paragraph' | 'character' | 'numbering',
  id: string,
  body: string,
  extra = '',
): string {
  return `<w:style w:type="${type}" w:styleId="${id}"${extra}><w:name w:val="${id}"/>${body}</w:style>`
}

export function numPr(numId: number, ilvl?: number): string {
  return `<w:numPr>${ilvl === undefined ? '' : `<w:ilvl w:val="${ilvl}"/>`}<w:numId w:val="${numId}"/></w:numPr>`
}

/** 单级编号：抽象编号与 `num` 使用同一标识。 */
export function singleLevel(id: number, level: string): string {
  return `<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0">${level}</w:lvl></w:abstractNum><w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`
}

export function theme(minor: string, major: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>' +
    `<a:fontScheme name="F"><a:majorFont>${major}</a:majorFont><a:minorFont>${minor}</a:minorFont></a:fontScheme>` +
    '</a:themeElements></a:theme>'
  )
}
