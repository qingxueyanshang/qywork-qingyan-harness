/**
 * 覆盖 `package.ts`（`openPackage`、内容类型、关系解析、`resolveTarget`）、`namespace.ts`（Strict 换算与关系类型简称）
 * 与 `scanner.ts`（`PartScanner` 的命名空间解析与 `AlternateContent` 选择）。
 *
 * 夹具由测试内的 ZIP 写入函数生成：成员按存储方式（不压缩）写入，CRC 使用 `Bun.hash.crc32`，与被测实现互相独立。
 */

import { describe, expect, test } from 'bun:test'
import { canonicalNamespace, NS, relationshipKind } from './namespace.ts'
import { type OpcPackage, type OpcResult, openPackage, resolveTarget } from './package.ts'
import { PartScanner } from './scanner.ts'

const encoder = new TextEncoder()

/** 按存储方式写 ZIP；成员名一律设置 UTF-8 标志位。 */
function buildZip(members: Record<string, string>): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(members)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(text)
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

const T_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const S_REL = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

function rels(...items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`
}

function rel(id: string, type: string, target: string, external = false): string {
  return `<Relationship Id="${id}" Type="${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="XML" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/Worksheets/Sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`

function unwrap<T>(result: OpcResult<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际为 ${JSON.stringify(result.failure)}`)
  return result.value
}

async function open(members: Record<string, string>): Promise<OpcPackage> {
  return unwrap(await openPackage(buildZip(members)))
}

const WORKBOOK_PACKAGE = {
  '[Content_Types].xml': CONTENT_TYPES,
  '_rels/.rels': rels(
    rel('rId3', `${T_REL}/extended-properties`, 'docProps/app.xml'),
    rel(
      'rId2',
      'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
      'docProps/core.xml',
    ),
    rel('rId1', `${T_REL}/officeDocument`, 'xl/workbook.xml'),
  ),
  'xl/workbook.xml': '<workbook/>',
  'xl/_rels/workbook.xml.rels': rels(
    rel('rId1', `${T_REL}/worksheet`, 'worksheets/sheet1.xml'),
    rel('rId2', `${T_REL}/theme`, '/xl/theme/theme1.xml'),
    rel('rId3', `${T_REL}/styles`, './styles.xml'),
    rel('rId4', `${T_REL}/hyperlink`, 'https://example.com/a?b=1#c', true),
    rel('rId5', `${T_REL}/image`, '../xl/media/%E5%9B%BE%201.png'),
    '<Relationship Id="rId6" Type="x"/>',
  ),
  'xl/worksheets/sheet1.xml': '<worksheet/>',
  'xl/theme/theme1.xml': '<a:theme/>',
  'xl/styles.xml': '<styleSheet/>',
  'xl/media/图 1.png': 'png',
}

describe('内容类型', () => {
  test('Override 优先于 Default，部件名与扩展名都不区分大小写', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    expect(pkg.contentType('/xl/workbook.xml')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    )
    expect(pkg.contentType('/xl/worksheets/sheet1.xml')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    )
    expect(pkg.contentType('/xl/styles.xml')).toBe('application/xml')
    expect(pkg.contentType('/xl/media/图 1.PNG')).toBe('image/png')
    expect(pkg.contentType('/xl/media/data.bin')).toBeNull()
    expect(pkg.contentType('/xl/media/noext')).toBeNull()
  })

  test('元素带前缀时按本地名识别', async () => {
    const pkg = await open({
      '[Content_Types].xml':
        '<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<ct:Default Extension="xml" ContentType="application/xml"/></ct:Types>',
      'a.xml': '<a/>',
    })
    expect(pkg.contentType('/a.xml')).toBe('application/xml')
  })

  test('部件列表不含内容类型部件与目录项', async () => {
    const pkg = await open({ '[Content_Types].xml': CONTENT_TYPES, 'xl/': '', 'xl/a.xml': '<a/>' })
    expect(pkg.parts).toEqual(['/xl/a.xml'])
    expect(pkg.has('/[Content_Types].xml')).toBe(false)
  })

  test('成员名用反斜杠分隔、内容类型部件名为小写时照常打开（WPS 实测）', async () => {
    const pkg = await open({
      '[content_types].xml': CONTENT_TYPES,
      '_rels\\.rels': rels(rel('rId1', `${T_REL}/officeDocument`, '/xl/workbook.xml')),
      'xl\\workbook.xml': '<workbook/>',
      'xl\\_rels\\workbook.xml.rels': rels(
        rel('rId1', `${T_REL}/worksheet`, 'worksheets\\sheet1.xml'),
      ),
      'xl\\worksheets\\sheet1.xml': '<worksheet/>',
      'xl\\': '',
    })
    expect(pkg.parts).toEqual([
      '/_rels/.rels',
      '/xl/workbook.xml',
      '/xl/_rels/workbook.xml.rels',
      '/xl/worksheets/sheet1.xml',
    ])
    const main = unwrap(await pkg.relationships('/')).part('officeDocument')!
    expect(pkg.contentType(main)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    )
    const sheet = unwrap(await pkg.relationships(main)).part('worksheet')!
    expect(sheet).toBe('/xl/worksheets/sheet1.xml')
    expect(unwrap(await pkg.text(sheet))).toBe('<worksheet/>')
  })
})

describe('失败分类', () => {
  test('缺少内容类型部件为 not-office', async () => {
    expect(await openPackage(buildZip({ 'a.xml': '<a/>' }))).toEqual({
      ok: false,
      failure: { kind: 'not-office' },
    })
  })

  test('ZIP 层失败原样传出', async () => {
    const result = await openPackage(new Uint8Array([1, 2, 3, 4, 5]))
    expect(result).toEqual({ ok: false, failure: { kind: 'not-office' } })
  })

  test('内容类型 XML 无法解析为 corrupt', async () => {
    expect(await openPackage(buildZip({ '[Content_Types].xml': '<Types><Default>' }))).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'content-types' },
    })
  })

  test('关系部件 XML 无法解析为 corrupt，不影响其他部件的关系', async () => {
    const pkg = await open({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': '<Relationships><Relationship Id="a">',
      'a.xml': '<a/>',
      '_rels/a.xml.rels': rels(rel('r', `${T_REL}/theme`, 'b.xml')),
    })
    expect(await pkg.relationships('/')).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'relationships' },
    })
    expect(unwrap(await pkg.relationships('/a.xml')).part('theme')).toBe('/b.xml')
  })
})

describe('关系', () => {
  test('从包关系找到主文档，再从主文档找到主题与样式', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    const root = unwrap(await pkg.relationships('/'))
    const main = root.part('officeDocument')
    expect(main).toBe('/xl/workbook.xml')
    const wb = unwrap(await pkg.relationships(main!))
    expect(wb.source).toBe('/xl/workbook.xml')
    expect(wb.part('theme')).toBe('/xl/theme/theme1.xml')
    expect(wb.part('styles')).toBe('/xl/styles.xml')
    expect(wb.ofKind('worksheet').map((r) => r.part)).toEqual(['/xl/worksheets/sheet1.xml'])
    expect(unwrap(await pkg.text(wb.part('theme')!))).toBe('<a:theme/>')
  })

  test('包层关系类型保留完整 URI', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    const root = unwrap(await pkg.relationships('/'))
    expect(root.list.map((r) => r.kind)).toEqual([
      'extended-properties',
      'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
      'officeDocument',
    ])
  })

  test('外部关系不解析为部件，目标原样保留', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    const wb = unwrap(await pkg.relationships('/xl/workbook.xml'))
    expect(wb.byId('rId4')).toEqual({
      id: 'rId4',
      type: `${T_REL}/hyperlink`,
      kind: 'hyperlink',
      target: 'https://example.com/a?b=1#c',
      external: true,
      part: null,
    })
    expect(wb.part('hyperlink')).toBeNull()
    expect(wb.ofKind('hyperlink')).toHaveLength(1)
  })

  test('百分号编码的目标与 UTF-8 成员名匹配', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    const wb = unwrap(await pkg.relationships('/xl/workbook.xml'))
    const image = wb.part('image')!
    expect(image).toBe('/xl/media/图 1.png')
    expect(pkg.has(image)).toBe(true)
    expect(pkg.has('/xl/media/%E5%9B%BE%201.png')).toBe(true)
    expect(unwrap(await pkg.text(image))).toBe('png')
  })

  test('部件名不区分 ASCII 大小写', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    expect(pkg.has('/XL/Workbook.XML')).toBe(true)
    expect(unwrap(await pkg.text('/XL/Workbook.XML'))).toBe('<workbook/>')
    expect(unwrap(await pkg.relationships('/XL/WORKBOOK.xml')).part('theme')).toBe(
      '/xl/theme/theme1.xml',
    )
  })

  test('缺少属性的条目跳过，Id 重复时取第一个', async () => {
    const pkg = await open({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': rels(
        '<Relationship Id="a" Type="t"/>',
        rel('b', `${T_REL}/theme`, 'one.xml'),
        rel('b', `${T_REL}/theme`, 'two.xml'),
      ),
    })
    const root = unwrap(await pkg.relationships('/'))
    expect(root.list.map((r) => r.target)).toEqual(['one.xml', 'two.xml'])
    expect(root.byId('b')?.part).toBe('/one.xml')
    expect(root.byId('a')).toBeNull()
  })

  test('部件没有关系部件时关系表为空', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    const r = unwrap(await pkg.relationships('/xl/styles.xml'))
    expect(r.list).toEqual([])
    expect(r.part('theme')).toBeNull()
  })

  test('不存在的部件读取结果为 null', async () => {
    const pkg = await open(WORKBOOK_PACKAGE)
    expect(unwrap(await pkg.bytes('/xl/none.xml'))).toBeNull()
    expect(unwrap(await pkg.text('/xl/none.xml'))).toBeNull()
  })

  test('Strict 关系类型与 Transitional 得到同一简称', async () => {
    const pkg = await open({
      '[Content_Types].xml': CONTENT_TYPES,
      '_rels/.rels': rels(rel('rId1', `${S_REL}/officeDocument`, 'xl/workbook.xml')),
      'xl/workbook.xml': '<workbook/>',
      'xl/_rels/workbook.xml.rels': rels(rel('rId1', `${S_REL}/theme`, 'theme/theme1.xml')),
    })
    const main = unwrap(await pkg.relationships('/')).part('officeDocument')
    expect(main).toBe('/xl/workbook.xml')
    expect(unwrap(await pkg.relationships(main!)).part('theme')).toBe('/xl/theme/theme1.xml')
  })
})

describe('resolveTarget', () => {
  test('相对于源部件所在目录，包关系相对于根', () => {
    expect(resolveTarget('/xl/workbook.xml', 'worksheets/sheet1.xml')).toBe(
      '/xl/worksheets/sheet1.xml',
    )
    expect(resolveTarget('/', 'word/document.xml')).toBe('/word/document.xml')
    expect(resolveTarget('/xl/drawings/drawing1.xml', '../media/image1.png')).toBe(
      '/xl/media/image1.png',
    )
  })

  test('绝对路径、点段、超出根的上级段与片段', () => {
    expect(resolveTarget('/xl/workbook.xml', '/xl/styles.xml')).toBe('/xl/styles.xml')
    expect(resolveTarget('/ppt/slides/slide1.xml', './../media/./a.png')).toBe('/ppt/media/a.png')
    expect(resolveTarget('/a.xml', '../../b.xml')).toBe('/b.xml')
    expect(resolveTarget('/ppt/slides/slide1.xml', 'slide2.xml#frag')).toBe(
      '/ppt/slides/slide2.xml',
    )
  })

  test('百分号解码；序列不合法时保留原文', () => {
    expect(resolveTarget('/word/document.xml', 'media/a%20b.png')).toBe('/word/media/a b.png')
    expect(resolveTarget('/word/document.xml', 'media/a%zz.png')).toBe('/word/media/a%zz.png')
  })
})

describe('命名空间', () => {
  test('Strict 命名空间与关系类型换算为 Transitional', () => {
    expect(canonicalNamespace('http://purl.oclc.org/ooxml/spreadsheetml/main')).toBe(
      'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    )
    expect(canonicalNamespace('http://purl.oclc.org/ooxml/drawingml/main')).toBe(
      'http://schemas.openxmlformats.org/drawingml/2006/main',
    )
    expect(canonicalNamespace(S_REL)).toBe(NS.relationships)
    expect(
      canonicalNamespace('http://purl.oclc.org/ooxml/officeDocument/extended-properties'),
    ).toBe('http://schemas.openxmlformats.org/officeDocument/2006/extended-properties')
    expect(canonicalNamespace(MC)).toBe(MC)
    expect(canonicalNamespace('urn:schemas-microsoft-com:vml')).toBe(
      'urn:schemas-microsoft-com:vml',
    )
  })

  test('关系类型简称', () => {
    expect(relationshipKind(`${T_REL}/officeDocument`)).toBe('officeDocument')
    expect(relationshipKind(`${S_REL}/officeDocument`)).toBe('officeDocument')
    expect(relationshipKind(`${S_REL}/sharedStrings`)).toBe('sharedStrings')
    const ext = 'http://schemas.microsoft.com/office/2007/relationships/hdphoto'
    expect(relationshipKind(ext)).toBe(ext)
  })
})

/** 展开全部事件：开始与结束带层数，文本取内容。 */
function events(scanner: PartScanner): string[] {
  const out: string[] = []
  for (let t = scanner.next(); t !== null; t = scanner.next()) {
    if (t === 'text') out.push(`text:${scanner.text}`)
    else out.push(`${t}:${scanner.local}@${scanner.depth}`)
  }
  return out
}

const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main'

describe('PartScanner 命名空间', () => {
  test('前缀、默认命名空间与内层重新声明', () => {
    const x = new PartScanner(
      `<root xmlns="urn:d" xmlns:a="urn:a"><a:b><c xmlns="urn:e"/><a:d xmlns:a="urn:f"/></a:b><g/></root>`,
    )
    const seen: string[] = []
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'start') seen.push(`${x.local}=${x.namespace}`)
    }
    expect(seen).toEqual(['root=urn:d', 'b=urn:a', 'c=urn:e', 'd=urn:f', 'g=urn:d'])
  })

  test('未声明的前缀为 null，xml 前缀固定', () => {
    const x = new PartScanner('<p:a xml:space="preserve"/>')
    x.next()
    expect(x.namespace).toBeNull()
    expect(x.resolve('xml')).toBe('http://www.w3.org/XML/1998/namespace')
  })

  test('Strict 命名空间返回规范形式，前缀声明与默认命名空间相同', () => {
    for (const xml of [
      '<x:worksheet xmlns:x="http://purl.oclc.org/ooxml/spreadsheetml/main"/>',
      '<worksheet xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"/>',
    ]) {
      const x = new PartScanner(xml)
      x.next()
      expect(x.namespace).toBe('http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    }
  })

  test('attrNs 按命名空间取属性，不依赖前缀', () => {
    const x = new PartScanner(
      `<a:blip xmlns:a="urn:a" xmlns:rel="${S_REL}" xmlns:o="urn:other" o:embed="x" rel:embed="rId7" embed="y"/>`,
    )
    x.next()
    expect(x.attrNs(NS.relationships, 'embed')).toBe('rId7')
    expect(x.attrNs(NS.relationships, 'link')).toBeNull()
    expect(x.attr('embed')).toBe('y')
  })
})

describe('PartScanner AlternateContent', () => {
  const group = (choices: string) =>
    `<root xmlns:mc="${MC}" xmlns:x14="${X14}" xmlns:a14="${A14}"><before/>` +
    `<mc:AlternateContent>${choices}</mc:AlternateContent><after/></root>`

  test('支持的 Choice 被选中，子节点作为父元素的子节点产出', () => {
    const xml = group(
      '\n  <mc:Choice Requires="x14"><new><deep/></new></mc:Choice>\n  <mc:Fallback><old/></mc:Fallback>\n',
    )
    expect(events(new PartScanner(xml, [X14]))).toEqual([
      'start:root@1',
      'start:before@2',
      'end:before@2',
      'start:new@2',
      'start:deep@3',
      'end:deep@3',
      'end:new@2',
      'start:after@2',
      'end:after@2',
      'end:root@1',
    ])
  })

  test('不支持时取 Fallback', () => {
    const xml = group(
      '<mc:Choice Requires="x14"><new/></mc:Choice><mc:Fallback><old/></mc:Fallback>',
    )
    expect(events(new PartScanner(xml)).filter((e) => e.startsWith('start'))).toEqual([
      'start:root@1',
      'start:before@2',
      'start:old@2',
      'start:after@2',
    ])
  })

  test('取第一个支持的 Choice；Requires 须全部支持', () => {
    const xml = group(
      '<mc:Choice Requires="x14 a14"><both/></mc:Choice>' +
        '<mc:Choice Requires="a14"><first/></mc:Choice>' +
        '<mc:Choice Requires="a14"><second/></mc:Choice><mc:Fallback><old/></mc:Fallback>',
    )
    const starts = events(new PartScanner(xml, [A14])).filter((e) => e.startsWith('start'))
    expect(starts).toEqual(['start:root@1', 'start:before@2', 'start:first@2', 'start:after@2'])
  })

  test('没有可选分支时整组不产出事件', () => {
    const xml = group('<mc:Choice Requires="x14"><new/></mc:Choice>')
    expect(events(new PartScanner(xml)).filter((e) => e.startsWith('start'))).toEqual([
      'start:root@1',
      'start:before@2',
      'start:after@2',
    ])
  })

  test('Requires 缺失或含未声明的前缀视为不支持', () => {
    const xml = group(
      '<mc:Choice><none/></mc:Choice><mc:Choice Requires="zz"><undeclared/></mc:Choice>' +
        '<mc:Fallback><old/></mc:Fallback>',
    )
    const starts = events(new PartScanner(xml, [X14])).filter((e) => e.startsWith('start'))
    expect(starts).toContain('start:old@2')
    expect(starts).not.toContain('start:none@2')
    expect(starts).not.toContain('start:undeclared@2')
  })

  test('按命名空间识别，不依赖 mc 前缀；支持列表接受 Strict 形式', () => {
    const xml =
      `<root xmlns:compat="${MC}" xmlns:s="http://purl.oclc.org/ooxml/drawingml/main">` +
      '<compat:AlternateContent><compat:Choice Requires="s"><yes/></compat:Choice>' +
      '<compat:Fallback><no/></compat:Fallback></compat:AlternateContent></root>'
    const starts = events(new PartScanner(xml, ['http://purl.oclc.org/ooxml/drawingml/main']))
    expect(starts).toContain('start:yes@2')
    expect(starts).not.toContain('start:no@2')
  })

  test('mc 前缀未绑定到标记兼容性命名空间时按普通元素产出', () => {
    const xml =
      '<root xmlns:mc="urn:other"><mc:AlternateContent><mc:Fallback/></mc:AlternateContent></root>'
    expect(events(new PartScanner(xml))).toEqual([
      'start:root@1',
      'start:AlternateContent@2',
      'start:Fallback@3',
      'end:Fallback@3',
      'end:AlternateContent@2',
      'end:root@1',
    ])
  })

  test('命名空间声明在 AlternateContent 与 Choice 上同样生效', () => {
    const xml =
      `<root><mc:AlternateContent xmlns:mc="${MC}">` +
      `<mc:Choice xmlns:v="${X14}" Requires="v"><v:a/></mc:Choice><mc:Fallback><b/></mc:Fallback>` +
      '</mc:AlternateContent></root>'
    const x = new PartScanner(xml, [X14])
    const seen: string[] = []
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'start') seen.push(`${x.local}@${x.depth}=${x.namespace}`)
    }
    expect(seen).toEqual(['root@1=null', `a@2=${X14}`])
  })

  test('跳过的分支中的命名空间声明不生效', () => {
    const xml =
      `<root xmlns:p="urn:outer" xmlns:mc="${MC}"><mc:AlternateContent>` +
      '<mc:Choice Requires="p"><p:x xmlns:p="urn:inner"/></mc:Choice><mc:Fallback/>' +
      '</mc:AlternateContent><p:after/></root>'
    const x = new PartScanner(xml)
    const seen: string[] = []
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'start') seen.push(`${x.local}=${x.namespace}`)
    }
    expect(seen).toEqual(['root=null', 'after=urn:outer'])
  })

  test('嵌套的 AlternateContent 逐层展开', () => {
    const xml = group(
      '<mc:Choice Requires="x14"><outer>' +
        '<mc:AlternateContent><mc:Choice Requires="a14"><inner14/></mc:Choice>' +
        '<mc:Fallback><innerOld>t</innerOld></mc:Fallback></mc:AlternateContent>' +
        '</outer></mc:Choice><mc:Fallback/>',
    )
    expect(events(new PartScanner(xml, [X14])).slice(3, 9)).toEqual([
      'start:outer@2',
      'start:innerOld@3',
      'text:t',
      'end:innerOld@3',
      'end:outer@2',
      'start:after@2',
    ])
  })

  test('选中分支内的文本保留，分支之间的空白丢弃', () => {
    const xml = group(
      '\n <mc:Choice Requires="x14">a<b/>c</mc:Choice>\n <mc:Fallback>z</mc:Fallback>\n',
    )
    expect(events(new PartScanner(xml, [X14])).slice(3, 7)).toEqual([
      'text:a',
      'start:b@2',
      'end:b@2',
      'text:c',
    ])
  })
})
