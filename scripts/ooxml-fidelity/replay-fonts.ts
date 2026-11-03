/**
 * docx 真值回放所需的字体（由 `emf.py` 的 `document_fonts` 调用）：页面 EMF 中 WPS 自带字体的字体名到回放所用的主机字体，
 * 以及须在回放进程中临时载入的文档嵌入字体。
 *
 *   bun run scripts/ooxml-fidelity/replay-fonts.ts <docx>
 *
 * 标准输出为 JSON：`{ faces: { 页面 EMF 中的字体名: 回放所用的字体名 }, fonts: [base64 字体字节] }`。
 * - WPS 自带的字体（`wpsEmfFaces`）：回放时改为数据表中的 `asciiDraw`，与本方绘制相同。
 * - 文档嵌入字体：WPS 按字体表的顺序给字体名不在主机上的条目中的每个嵌入字形编号（自 1 起），页面 EMF 中以
 *   `WPSEMBED<该条目第一个字形的编号>` 引用；字段以嵌入字体的家族名引用时页面 EMF 中为该家族名（WPS 实测：构造文档 f2-emb、
 *   f2-emb3，cn-docx-004）。每个嵌入字形输出 `name` 表改为该编号名称的副本，家族名不在主机上时另输出原字节（主机有该家族名时
 *   WPS 用主机字体，载入原字节会使回放取到嵌入字体）。
 * - 不要改为把页面 EMF 中的 `WPSEMBED<n>` 改写为家族名：家族名在 Windows 字体替换表中时（如 Helvetica），GDI 按替换表取
 *   Arial，不取载入的字体。
 * - 文件字节与嵌入字体是不可信数据，只经本方解析器读取；输出的字体字节已通过 sfnt 目录与 `name` 表的读取。
 */

import { readFileSync } from 'node:fs'
import { parseDocx } from '../../packages/ooxml/src/docx/index.ts'
import { readFaces, readFamilyNames, tableBytes } from '../../packages/ooxml/src/font/index.ts'
import { wpsEmfFaces } from '../../packages/ooxml/src/text/index.ts'
import { hostFamilies } from '../../packages/server/src/api/fonts.ts'

const WINDOWS = 3
const UNICODE_BMP = 1
const EN_US = 0x0409

/** 4 字节对齐后按大端 32 位字求和。 */
function checksum(bytes: Uint8Array): number {
  const padded = new Uint8Array((bytes.length + 3) & ~3)
  padded.set(bytes)
  const v = new DataView(padded.buffer)
  let sum = 0
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0
  return sum
}

/** 只有 Windows 平台 en-US 记录的 `name` 表：家族名、子族名、全名与 PostScript 名。 */
function nameTable(family: string, bold: boolean, italic: boolean): Uint8Array {
  const style = bold ? (italic ? 'Bold Italic' : 'Bold') : italic ? 'Italic' : 'Regular'
  const full = style === 'Regular' ? family : `${family} ${style}`
  const records: [number, string][] = [
    [1, family],
    [2, style],
    [3, full],
    [4, full],
    [5, 'Version 1.0'],
    [6, `${family}-${style.replace(' ', '')}`],
  ]
  const strings = records.map(([, s]) => {
    const out = new Uint8Array(2 * s.length)
    for (let i = 0; i < s.length; i++) {
      out[2 * i] = s.charCodeAt(i) >> 8
      out[2 * i + 1] = s.charCodeAt(i) & 0xff
    }
    return out
  })
  const head = 6 + 12 * records.length
  const out = new Uint8Array(head + strings.reduce((n, s) => n + s.length, 0))
  const v = new DataView(out.buffer)
  v.setUint16(2, records.length)
  v.setUint16(4, head)
  let at = 0
  records.forEach(([id], i) => {
    const r = 6 + 12 * i
    v.setUint16(r, WINDOWS)
    v.setUint16(r + 2, UNICODE_BMP)
    v.setUint16(r + 4, EN_US)
    v.setUint16(r + 6, id)
    v.setUint16(r + 8, strings[i]!.length)
    v.setUint16(r + 10, at)
    out.set(strings[i]!, head + at)
    at += strings[i]!.length
  })
  return out
}

/** sfnt 字节中的 `name` 表换为 `table`，其余表原样保留；重算表的校验和与 `head.checkSumAdjustment`。 */
function withNameTable(bytes: Uint8Array, table: Uint8Array): Uint8Array {
  const face = readFaces(bytes)[0]!
  const tags = [...face.tables.keys()].sort()
  const data = tags.map((tag) => {
    if (tag === 'name') return table
    const r = face.tables.get(tag)!
    return bytes.slice(r.offset, r.offset + r.length)
  })
  const dir = 12 + 16 * tags.length
  let size = dir
  const offsets = data.map((d) => {
    const at = size
    size += (d.length + 3) & ~3
    return at
  })
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, new DataView(bytes.buffer, bytes.byteOffset).getUint32(0))
  const power = 2 ** Math.floor(Math.log2(tags.length))
  v.setUint16(4, tags.length)
  v.setUint16(6, power * 16)
  v.setUint16(8, Math.log2(power))
  v.setUint16(10, tags.length * 16 - power * 16)
  tags.forEach((tag, i) => {
    const d = data[i]!
    if (tag === 'head' && d.length >= 12) new DataView(d.buffer, d.byteOffset).setUint32(8, 0)
    const r = 12 + 16 * i
    for (let k = 0; k < 4; k++) out[r + k] = tag.charCodeAt(k)
    v.setUint32(r + 4, checksum(d))
    v.setUint32(r + 8, offsets[i]!)
    v.setUint32(r + 12, d.length)
    out.set(d, offsets[i]!)
  })
  const head = tags.indexOf('head')
  if (head >= 0 && data[head]!.length >= 12)
    v.setUint32(offsets[head]! + 8, (0xb1b0afba - checksum(out)) >>> 0)
  return out
}

const path = process.argv[2]
if (!path) {
  console.error('用法：bun run scripts/ooxml-fidelity/replay-fonts.ts <docx>')
  process.exit(2)
}
const parsed = await parseDocx(new Uint8Array(readFileSync(path)))
if (!parsed.ok) {
  console.error(`解析失败：${JSON.stringify(parsed.failure)}`)
  process.exit(1)
}
const present = new Set((await hostFamilies()).names)
const fonts: string[] = []
let serial = 0
let alias = ''
let previous: string | null = null
for (const f of parsed.value.embeddedFonts) {
  if (present.has(f.name.trim().toLowerCase())) continue
  serial += 1
  if (f.name !== previous) alias = `WPSEMBED${serial}`
  previous = f.name
  const families = readFamilyNames(tableBytes(f.bytes, readFaces(f.bytes)[0]!, 'name'))
  if (!families.some((n) => present.has(n.trim().toLowerCase())))
    fonts.push(Buffer.from(f.bytes).toString('base64'))
  const copy = withNameTable(f.bytes, nameTable(alias, f.bold, f.italic))
  fonts.push(Buffer.from(copy).toString('base64'))
}
process.stdout.write(JSON.stringify({ faces: wpsEmfFaces(), fonts }))
