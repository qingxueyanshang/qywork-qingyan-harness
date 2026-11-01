/**
 * 覆盖 `index.ts`（`openZip` 的 ZIP 部分与成员读取）、`crc32.ts`、`cp437.ts`。CFB 的分类见 `cfb.test.ts`。
 *
 * 夹具由测试内的 ZIP 写入函数生成：deflate 使用 `Bun.deflateSync`，CRC 使用 `Bun.hash.crc32`，
 * 与被测实现互相独立。失败用例在生成的字节上改写指定字段。
 */

import { describe, expect, test } from 'bun:test'
import { decodeCp437 } from './cp437.ts'
import { crc32 } from './crc32.ts'
import { openZip, type ZipArchive, type ZipResult } from './index.ts'

interface Member {
  name: string
  data: Uint8Array<ArrayBuffer>
  method?: 0 | 8
  /** 成员名的原始字节；给出时不设置 UTF-8 标志位。 */
  rawName?: Uint8Array
  /** 设置数据描述符标志，本地文件头中的 CRC 与长度写 0。 */
  descriptor?: boolean
  flags?: number
}

interface Built {
  bytes: Uint8Array<ArrayBuffer>
  view: DataView
  /** 每个成员的本地文件头、数据与中央目录记录的起点。 */
  offsets: { local: number; data: number; central: number }[]
  /** 中央目录结束记录的起点。 */
  end: number
}

const encoder = new TextEncoder()

function buildZip(members: Member[]): Built {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  const offsets: Built['offsets'] = []
  let offset = 0
  for (const m of members) {
    const method = m.method ?? 0
    const name = m.rawName ?? encoder.encode(m.name)
    const flags = (m.flags ?? 0) | (m.rawName ? 0 : 0x800) | (m.descriptor ? 0x8 : 0)
    const payload = method === 8 ? Bun.deflateSync(m.data) : m.data
    const crc = Bun.hash.crc32(m.data)

    const local = new Uint8Array(30 + name.length + payload.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint32(14, m.descriptor ? 0 : crc, true)
    lv.setUint32(18, m.descriptor ? 0 : payload.length, true)
    lv.setUint32(22, m.descriptor ? 0 : m.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(payload, 30 + name.length)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, payload.length, true)
    cv.setUint32(24, m.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    offsets.push({ local: offset, data: offset + 30 + name.length, central: 0 })
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const directoryStart = offset
  for (const [i, c] of centrals.entries()) {
    offsets[i]!.central = offset
    offset += c.length
  }
  const end = offset
  const bytes = new Uint8Array(end + 22)
  let p = 0
  for (const part of [...locals, ...centrals]) {
    bytes.set(part, p)
    p += part.length
  }
  const view = new DataView(bytes.buffer)
  view.setUint32(end, 0x06054b50, true)
  view.setUint16(end + 8, members.length, true)
  view.setUint16(end + 10, members.length, true)
  view.setUint32(end + 12, end - directoryStart, true)
  view.setUint32(end + 16, directoryStart, true)
  return { bytes, view, offsets, end }
}

/** 确定性伪随机字节，保证随机样本可复现。 */
function pseudoRandom(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length)
  let x = seed >>> 0 || 1
  for (let i = 0; i < length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

function archiveOf(bytes: Uint8Array<ArrayBuffer>): ZipArchive {
  const opened = openZip(bytes)
  if (!opened.ok) throw new Error(`期望打开成功，实际为 ${JSON.stringify(opened.failure)}`)
  return opened.value
}

function failureOf<T>(result: ZipResult<T>) {
  return result.ok ? null : result.failure
}

const SHEET = encoder.encode(
  `<?xml version="1.0" encoding="UTF-8"?><sheetData>${'<row><c r="A1"><v>1</v></c></row>'.repeat(200)}</sheetData>`,
)

describe('正常读取', () => {
  const built = buildZip([
    { name: '[Content_Types].xml', data: encoder.encode('<Types/>') },
    { name: 'xl/', data: new Uint8Array(0) },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET, method: 8 },
    { name: 'xl/empty.bin', data: new Uint8Array(0), method: 8 },
  ])

  test('存储与 deflate 成员逐字节一致', async () => {
    const zip = archiveOf(built.bytes)
    const stored = await zip.bytes('[Content_Types].xml')
    expect(stored).toEqual({ ok: true, value: encoder.encode('<Types/>') })
    const deflated = await zip.bytes('xl/worksheets/sheet1.xml')
    expect(deflated).toEqual({ ok: true, value: SHEET })
    expect(await zip.bytes('xl/empty.bin')).toEqual({ ok: true, value: new Uint8Array(0) })
    expect(await zip.bytes('xl/')).toEqual({ ok: true, value: new Uint8Array(0) })
  })

  test('成员名按中央目录顺序列出，包括目录成员', () => {
    expect(archiveOf(built.bytes).paths).toEqual([
      '[Content_Types].xml',
      'xl/',
      'xl/worksheets/sheet1.xml',
      'xl/empty.bin',
    ])
  })

  test('成员不存在时返回 null，查找区分大小写', async () => {
    const zip = archiveOf(built.bytes)
    expect(await zip.bytes('xl/sharedStrings.xml')).toEqual({ ok: true, value: null })
    expect(await zip.text('XL/worksheets/sheet1.xml')).toEqual({ ok: true, value: null })
  })

  test('按文本读取时解码 UTF-8 并去掉字节序标记', async () => {
    const zip = archiveOf(
      buildZip([
        { name: 'a.xml', data: encoder.encode('﻿<t>中文</t>'), method: 8 },
        { name: 'b.xml', data: encoder.encode('<t>文本</t>') },
      ]).bytes,
    )
    expect(await zip.text('a.xml')).toEqual({ ok: true, value: '<t>中文</t>' })
    expect(await zip.text('b.xml')).toEqual({ ok: true, value: '<t>文本</t>' })
  })

  test('按文本读取时以字节序标记识别 UTF-16LE 与 UTF-16BE，标记不计入结果', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><t>中文𠀀</t>'
    const utf16 = (bigEndian: boolean) => {
      const out = new Uint8Array(2 + xml.length * 2)
      const view = new DataView(out.buffer)
      view.setUint16(0, 0xfeff, !bigEndian)
      for (let i = 0; i < xml.length; i++) view.setUint16(2 + i * 2, xml.charCodeAt(i), !bigEndian)
      return out
    }
    const zip = archiveOf(
      buildZip([
        { name: 'le.xml', data: utf16(false), method: 8 },
        { name: 'be.xml', data: utf16(true) },
      ]).bytes,
    )
    expect(await zip.text('le.xml')).toEqual({ ok: true, value: xml })
    expect(await zip.text('be.xml')).toEqual({ ok: true, value: xml })
  })

  test('成员名按 UTF-8 标志位或 CP437 解码', async () => {
    const zip = archiveOf(
      buildZip([
        { name: '工作表/第一页.xml', data: encoder.encode('1') },
        {
          name: '',
          rawName: new Uint8Array([0x80, 0x81, 0x2e, 0x78, 0x6d, 0x6c]),
          data: encoder.encode('2'),
        },
      ]).bytes,
    )
    expect(zip.paths).toEqual(['工作表/第一页.xml', 'Çü.xml'])
    expect(await zip.text('Çü.xml')).toEqual({ ok: true, value: '2' })
  })

  test('设置数据描述符标志时按中央目录中的长度与 CRC 读取', async () => {
    const zip = archiveOf(
      buildZip([{ name: 's.xml', data: SHEET, method: 8, descriptor: true }]).bytes,
    )
    expect(await zip.bytes('s.xml')).toEqual({ ok: true, value: SHEET })
  })

  test('输入是更大缓冲区的视图时按视图起点解析', async () => {
    const inner = built.bytes
    const outer = new Uint8Array(inner.length + 16)
    outer.set(inner, 7)
    const zip = archiveOf(outer.subarray(7, 7 + inner.length))
    expect(await zip.bytes('xl/worksheets/sheet1.xml')).toEqual({ ok: true, value: SHEET })
  })
})

describe('失败分类', () => {
  test('成员设置加密标志位判为已加密', () => {
    const built = buildZip([
      { name: 'a.xml', data: encoder.encode('a') },
      { name: 'b.xml', data: encoder.encode('b'), flags: 0x1 },
    ])
    expect(failureOf(openZip(built.bytes))).toEqual({ kind: 'encrypted' })
  })

  test('随机字节、空数据与纯文本判为不是 Office 文件', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const bytes = pseudoRandom(2048, seed)
      bytes[0] = 0x00
      expect(failureOf(openZip(bytes))).toEqual({ kind: 'not-office' })
    }
    expect(failureOf(openZip(new Uint8Array(0)))).toEqual({ kind: 'not-office' })
    expect(failureOf(openZip(encoder.encode('PK')))).toEqual({ kind: 'not-office' })
    expect(failureOf(openZip(encoder.encode('<?xml version="1.0"?><a/>')))).toEqual({
      kind: 'not-office',
    })
  })

  test('截去末尾判为已损坏', () => {
    const { bytes } = buildZip([
      { name: 'a.xml', data: SHEET, method: 8 },
      { name: 'b.xml', data: SHEET },
    ])
    for (const cut of [1, 10, 22, 200, bytes.length >> 1, bytes.length - 4]) {
      expect(failureOf(openZip(bytes.slice(0, bytes.length - cut)))).toEqual({
        kind: 'corrupt',
        reason: 'end-record',
      })
    }
  })

  test('存储成员内容被改写时 CRC 不一致', async () => {
    const built = buildZip([{ name: 'a.xml', data: SHEET }])
    const at = built.offsets[0]!.data + 5
    built.bytes[at] = built.bytes[at]! ^ 0xff
    const zip = archiveOf(built.bytes)
    expect(failureOf(await zip.bytes('a.xml'))).toEqual({ kind: 'corrupt', reason: 'crc' })
  })

  test('中央目录记录的 CRC 与解压结果不一致', async () => {
    const built = buildZip([{ name: 'a.xml', data: SHEET, method: 8 }])
    built.view.setUint32(built.offsets[0]!.central + 16, 0x12345678, true)
    expect(failureOf(await archiveOf(built.bytes).bytes('a.xml'))).toEqual({
      kind: 'corrupt',
      reason: 'crc',
    })
  })

  test('解压长度与中央目录不一致', async () => {
    const built = buildZip([{ name: 'a.xml', data: SHEET, method: 8 }])
    built.view.setUint32(built.offsets[0]!.central + 24, SHEET.length + 1, true)
    expect(failureOf(await archiveOf(built.bytes).bytes('a.xml'))).toEqual({
      kind: 'corrupt',
      reason: 'size',
    })
  })

  test('deflate 数据无法解压', async () => {
    const built = buildZip([{ name: 'a.xml', data: SHEET, method: 8 }])
    const { data } = built.offsets[0]!
    built.bytes.fill(0xff, data, data + 16)
    expect(failureOf(await archiveOf(built.bytes).bytes('a.xml'))).toEqual({
      kind: 'corrupt',
      reason: 'inflate',
    })
  })

  test('deflate 数据被截短', async () => {
    const built = buildZip([{ name: 'a.xml', data: SHEET, method: 8 }])
    const compressed = built.view.getUint32(built.offsets[0]!.central + 20, true)
    built.view.setUint32(built.offsets[0]!.central + 20, compressed >> 1, true)
    expect(failureOf(await archiveOf(built.bytes).bytes('a.xml'))).toEqual({
      kind: 'corrupt',
      reason: 'inflate',
    })
  })

  test('不支持的压缩方法', async () => {
    const built = buildZip([{ name: 'a.xml', data: SHEET }])
    built.view.setUint16(built.offsets[0]!.central + 10, 12, true)
    expect(failureOf(await archiveOf(built.bytes).bytes('a.xml'))).toEqual({
      kind: 'corrupt',
      reason: 'method',
    })
  })

  test('中央目录超出范围或签名错误', () => {
    const outOfRange = buildZip([{ name: 'a.xml', data: SHEET }])
    outOfRange.view.setUint32(outOfRange.end + 16, outOfRange.end, true)
    expect(failureOf(openZip(outOfRange.bytes))).toEqual({
      kind: 'corrupt',
      reason: 'central-directory',
    })
    const badSignature = buildZip([{ name: 'a.xml', data: SHEET }])
    badSignature.view.setUint32(badSignature.offsets[0]!.central, 0, true)
    expect(failureOf(openZip(badSignature.bytes))).toEqual({
      kind: 'corrupt',
      reason: 'central-directory',
    })
    const tooMany = buildZip([{ name: 'a.xml', data: SHEET }])
    tooMany.view.setUint16(tooMany.end + 10, 2, true)
    expect(failureOf(openZip(tooMany.bytes))).toEqual({
      kind: 'corrupt',
      reason: 'central-directory',
    })
  })

  test('本地文件头签名错误或数据超出范围', async () => {
    const badSignature = buildZip([
      { name: 'a.xml', data: SHEET },
      { name: 'b.xml', data: SHEET },
    ])
    badSignature.view.setUint32(badSignature.offsets[1]!.local, 0, true)
    const zip = archiveOf(badSignature.bytes)
    expect(failureOf(await zip.bytes('b.xml'))).toEqual({ kind: 'corrupt', reason: 'local-header' })
    expect(await zip.bytes('a.xml')).toEqual({ ok: true, value: SHEET })

    const beyond = buildZip([{ name: 'a.xml', data: SHEET }])
    beyond.view.setUint32(beyond.offsets[0]!.central + 20, beyond.bytes.length, true)
    expect(failureOf(await archiveOf(beyond.bytes).bytes('a.xml'))).toEqual({
      kind: 'corrupt',
      reason: 'local-header',
    })
  })

  test('出现 ZIP64 标记值判为已损坏', () => {
    const count = buildZip([{ name: 'a.xml', data: SHEET }])
    count.view.setUint16(count.end + 10, 0xffff, true)
    expect(failureOf(openZip(count.bytes))).toEqual({ kind: 'corrupt', reason: 'zip64' })
    const size = buildZip([{ name: 'a.xml', data: SHEET }])
    size.view.setUint32(size.offsets[0]!.central + 24, 0xffffffff, true)
    expect(failureOf(openZip(size.bytes))).toEqual({ kind: 'corrupt', reason: 'zip64' })
  })

  test('按文本读取时没有字节序标记的内容不是合法 UTF-8，或 UTF-16 内容不完整', async () => {
    const zip = archiveOf(
      buildZip([
        // 没有标记的 UTF-16LE 按 UTF-8 判定，不按内容识别编码。
        { name: 'a.xml', data: new Uint8Array([0x3c, 0x00, 0xe4, 0xb8]) },
        // 标记之后的字节数为奇数。
        { name: 'b.xml', data: new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x61]) },
        // 孤立的高位代理。
        { name: 'c.xml', data: new Uint8Array([0xfe, 0xff, 0xd8, 0x00, 0x00, 0x61]) },
      ]).bytes,
    )
    for (const name of ['a.xml', 'b.xml', 'c.xml']) {
      expect(failureOf(await zip.text(name))).toEqual({ kind: 'corrupt', reason: 'encoding' })
    }
  })
})

describe('辅助实现', () => {
  test('CRC-32 与 Bun.hash.crc32 一致', () => {
    for (const length of [0, 1, 7, 1000, 65537]) {
      const data = pseudoRandom(length, length + 11)
      expect(crc32(data)).toBe(Bun.hash.crc32(data))
    }
  })

  test('CP437 高位字符', () => {
    const high = decodeCp437(Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i))
    expect(high.length).toBe(128)
    expect([high[0x00], high[0x1e], high[0x30], high[0x61], high[0x7f]]).toEqual([
      'Ç',
      '₧',
      '░',
      'ß',
      ' ',
    ])
    expect(decodeCp437(encoder.encode('docProps/app.xml'))).toBe('docProps/app.xml')
  })
})
