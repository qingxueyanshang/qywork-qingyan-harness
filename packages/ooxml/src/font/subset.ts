/**
 * 按码位裁剪字体的字形数据，字形编号不变（`subsetFace`）。远程访问时 Office 预览只下发文档用到的字形：
 * 系统中文字体单个 10–20 MB，其中 `glyf` 与 `EBDT` 占九成以上。
 *
 * - 保留的字形：`.notdef`、码位在 `cmap` 中对应的字形、`GSUB` 单字 / 多字 / 候选 / 连字查找由已保留字形可得到的字形
 *   （不区分特性与文种，取全部查找的闭包）、复合字形的部件。其余字形在 `glyf` 中长度为 0，在 `EBLC` / `EBDT` 中不出现。
 * - 字形编号、`hmtx`、`GSUB`、`GPOS` 与其余表原样保留：排版度量与原字体相同。`EBLC` 中的 strike 全部保留
 *   （没有字形的 strike 只有空的索引），某字号是否以点阵绘制的判定不变。
 * - `cmap` 只含给定码位的映射（格式 4 与格式 12，平台 3），变体序列子表（格式 14）原样保留；含符号编码子表（平台 3 编码 0）
 *   的字体不改 `cmap`。`kern` 的格式 0 子表只保留左右字形都保留的字偶，其余子表原样保留。
 * - 原样返回、不裁剪：CFF 轮廓、含 `MATH` 表（数学排版按字形编号取尺寸变体与拼接部件）、没有 `glyf` / `loca` 的字体。
 * - `DSIG` 删除：内容改变后签名不再成立。
 */

import { readCmap } from './cmap.ts'
import { FontFormatError, isCffOutline, readFaces, tableBytes, writeSfnt } from './sfnt.ts'

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** `bytes` 为单个字体（TTC 先经 `extractFace` 拆分）。 */
export function subsetFace(bytes: Uint8Array, codePoints: Iterable<number>): Uint8Array {
  const faces = readFaces(bytes)
  if (faces.length !== 1) throw new FontFormatError('裁剪须针对单个字体')
  const face = faces[0]!
  const has = (tag: string) => face.tables.has(tag)
  if (isCffOutline(face) || has('MATH') || !has('glyf') || !has('loca')) return bytes

  const head = tableBytes(bytes, face, 'head')
  const longLoca = view(head).getInt16(50) === 1
  const numGlyphs = view(tableBytes(bytes, face, 'maxp')).getUint16(4)
  const loca = view(tableBytes(bytes, face, 'loca'))
  const glyf = tableBytes(bytes, face, 'glyf')
  const offset = (g: number) => (longLoca ? loca.getUint32(4 * g) : 2 * loca.getUint16(2 * g))

  const keep = new Set<number>([0])
  const cmap = tableBytes(bytes, face, 'cmap')
  const lookup = readCmap(cmap)
  const mapped: [number, number][] = []
  for (const c of new Set(codePoints)) {
    const g = lookup(c)
    if (g <= 0 || g >= numGlyphs) continue
    keep.add(g)
    mapped.push([c, g])
  }
  if (has('GSUB')) closeOverSubstitutions(tableBytes(bytes, face, 'GSUB'), keep, numGlyphs)
  closeOverComponents(glyf, offset, keep, numGlyphs)

  const tables: { tag: string; bytes: Uint8Array }[] = []
  const { glyf: nextGlyf, loca: nextLoca } = writeGlyphs(glyf, offset, keep, numGlyphs)
  const nextHead = head.slice()
  view(nextHead).setInt16(50, 1)
  const bitmaps =
    has('EBLC') && has('EBDT')
      ? subsetBitmaps(tableBytes(bytes, face, 'EBLC'), tableBytes(bytes, face, 'EBDT'), keep)
      : null
  for (const rec of face.tables.values()) {
    const replaced: Record<string, Uint8Array | undefined> = {
      glyf: nextGlyf,
      loca: nextLoca,
      head: nextHead,
      EBLC: bitmaps?.eblc,
      EBDT: bitmaps?.ebdt,
      cmap: subsetCmap(cmap, mapped),
      kern: has('kern') ? subsetKern(tableBytes(bytes, face, 'kern'), keep) : undefined,
    }
    if (rec.tag === 'DSIG') continue
    tables.push({ tag: rec.tag, bytes: replaced[rec.tag] ?? tableBytes(bytes, face, rec.tag) })
  }
  return writeSfnt(face.version, tables)
}

/** 保留字形的 `glyf` 与长格式 `loca`；未保留的字形长度为 0。每个字形按 4 字节对齐。 */
function writeGlyphs(
  glyf: Uint8Array,
  offset: (g: number) => number,
  keep: ReadonlySet<number>,
  numGlyphs: number,
): { glyf: Uint8Array; loca: Uint8Array } {
  let size = 0
  for (const g of keep) size += (offset(g + 1) - offset(g) + 3) & ~3
  const out = new Uint8Array(size)
  const loca = new Uint8Array(4 * (numGlyphs + 1))
  const lv = view(loca)
  let at = 0
  for (let g = 0; g < numGlyphs; g++) {
    lv.setUint32(4 * g, at)
    if (!keep.has(g)) continue
    const start = offset(g)
    const end = offset(g + 1)
    out.set(glyf.subarray(start, end), at)
    at += (end - start + 3) & ~3
  }
  lv.setUint32(4 * numGlyphs, at)
  return { glyf: out, loca }
}

/** 复合字形的部件加入 `keep`，部件本身是复合字形时继续展开。 */
function closeOverComponents(
  glyf: Uint8Array,
  offset: (g: number) => number,
  keep: Set<number>,
  numGlyphs: number,
): void {
  const v = view(glyf)
  const pending = [...keep]
  while (pending.length > 0) {
    const g = pending.pop()!
    const start = offset(g)
    const end = offset(g + 1)
    if (end - start < 10 || v.getInt16(start) >= 0) continue
    let p = start + 10
    for (;;) {
      if (p + 4 > end) break
      const flags = v.getUint16(p)
      const part = v.getUint16(p + 2)
      if (part < numGlyphs && !keep.has(part)) {
        keep.add(part)
        pending.push(part)
      }
      p += 4 + (flags & 0x0001 ? 4 : 2)
      if (flags & 0x0008) p += 2
      else if (flags & 0x0040) p += 4
      else if (flags & 0x0080) p += 8
      if (!(flags & 0x0020)) break
    }
  }
}

/** Coverage 表覆盖的字形，按覆盖序号排列。 */
function coveredGlyphs(v: DataView, at: number): number[] {
  const format = v.getUint16(at)
  const count = v.getUint16(at + 2)
  const out: number[] = []
  if (format === 1) {
    for (let i = 0; i < count; i++) out.push(v.getUint16(at + 4 + 2 * i))
    return out
  }
  if (format === 2) {
    for (let i = 0; i < count; i++) {
      const r = at + 4 + 6 * i
      const startIndex = v.getUint16(r + 4)
      for (let g = v.getUint16(r); g <= v.getUint16(r + 2); g++)
        out[startIndex + g - v.getUint16(r)] = g
    }
    return out
  }
  throw new FontFormatError(`不支持的 Coverage 格式 ${format}`)
}

/** 一个替换子表：给定已保留的字形，返回可由它们得到的字形。 */
type Reach = (keep: ReadonlySet<number>) => number[]

/** 读取一个替换子表（查找类型 1–4）；其他类型返回 null。上下文类查找引用的查找已在全部查找中，不另行展开。 */
function reachOf(v: DataView, type: number, at: number): Reach | null {
  if (type < 1 || type > 4) return null
  const format = v.getUint16(at)
  const covered = coveredGlyphs(v, at + v.getUint16(at + 2))
  /** 覆盖序号为 `i` 的字形保留时，偏移数组第 `i` 项指向的字形序列。 */
  const arrays = (countAt: number, offsetsAt: number) => {
    const out: number[][] = []
    for (let i = 0; i < v.getUint16(countAt); i++) {
      const p = at + v.getUint16(offsetsAt + 2 * i)
      const n = v.getUint16(p)
      out.push(Array.from({ length: n }, (_, k) => v.getUint16(p + 2 + 2 * k)))
    }
    return out
  }
  if (type === 1) {
    if (format === 1) {
      const delta = v.getInt16(at + 4)
      return (keep) => covered.filter((g) => keep.has(g)).map((g) => (g + delta) & 0xffff)
    }
    const subs = Array.from({ length: v.getUint16(at + 4) }, (_, i) => v.getUint16(at + 6 + 2 * i))
    return (keep) =>
      covered.flatMap((g, i) => (keep.has(g) && subs[i] !== undefined ? [subs[i]!] : []))
  }
  if (type === 2 || type === 3) {
    const lists = arrays(at + 4, at + 6)
    return (keep) => covered.flatMap((g, i) => (keep.has(g) ? (lists[i] ?? []) : []))
  }
  if (type === 4) {
    const sets: { glyph: number; components: number[] }[][] = []
    for (let i = 0; i < v.getUint16(at + 4); i++) {
      const set = at + v.getUint16(at + 6 + 2 * i)
      const ligatures: { glyph: number; components: number[] }[] = []
      for (let k = 0; k < v.getUint16(set); k++) {
        const lig = set + v.getUint16(set + 2 + 2 * k)
        const count = v.getUint16(lig + 2)
        ligatures.push({
          glyph: v.getUint16(lig),
          components: Array.from({ length: count - 1 }, (_, c) => v.getUint16(lig + 4 + 2 * c)),
        })
      }
      sets.push(ligatures)
    }
    return (keep) =>
      covered.flatMap((g, i) =>
        keep.has(g)
          ? (sets[i] ?? [])
              .filter((l) => l.components.every((c) => keep.has(c)))
              .map((l) => l.glyph)
          : [],
      )
  }
  return null
}

/** `GSUB` 全部查找的替换结果加入 `keep`，直到不再增加。 */
function closeOverSubstitutions(gsub: Uint8Array, keep: Set<number>, numGlyphs: number): void {
  if (gsub.byteLength < 10) throw new FontFormatError('GSUB 表长度不足')
  const v = view(gsub)
  const list = v.getUint16(8)
  const reaches: Reach[] = []
  for (let i = 0; i < v.getUint16(list); i++) {
    const at = list + v.getUint16(list + 2 + 2 * i)
    const type = v.getUint16(at)
    for (let k = 0; k < v.getUint16(at + 4); k++) {
      let sub = at + v.getUint16(at + 6 + 2 * k)
      let subType = type
      if (type === 7) {
        subType = v.getUint16(sub + 2)
        sub += v.getUint32(sub + 4)
      }
      const reach = reachOf(v, subType, sub)
      if (reach) reaches.push(reach)
    }
  }
  for (let added = true; added; ) {
    added = false
    for (const reach of reaches) {
      for (const g of reach(keep)) {
        if (g < numGlyphs && !keep.has(g)) {
          keep.add(g)
          added = true
        }
      }
    }
  }
}

/** 一个裁剪后的索引子表：字形范围与索引子表（表头 + 正文，已按 4 字节对齐）。 */
interface IndexOut {
  first: number
  last: number
  bytes: Uint8Array
}

/**
 * 只保留 `keep` 中字形的 `EBLC` 与 `EBDT`。可变度量的子表（索引格式 1、3、4）输出为格式 4（字形编号与偏移对）或格式 1
 * （偏移数组），取较小者：保留的字形分散在整个编号范围时偏移数组以 4 字节记录每个编号；格式 4 的偏移只有 16 位，
 * 图像总长超过 0xFFFF 时只用格式 1。固定度量的子表（格式 2、5）输出为格式 5。图像格式与图像字节不变。
 */
function subsetBitmaps(
  eblc: Uint8Array,
  ebdt: Uint8Array,
  keep: ReadonlySet<number>,
): { eblc: Uint8Array; ebdt: Uint8Array } {
  const v = view(eblc)
  const images: Uint8Array[] = []
  let imageAt = 4
  const take = (start: number, end: number) => {
    images.push(ebdt.subarray(start, end))
    imageAt += end - start
  }
  const strikes: { record: Uint8Array; subs: IndexOut[] }[] = []
  const numSizes = v.getUint32(4)
  for (let i = 0; i < numSizes; i++) {
    const rec = 8 + 48 * i
    const arrayAt = v.getUint32(rec)
    const subs: IndexOut[] = []
    for (let k = 0; k < v.getUint32(rec + 8); k++) {
      const entry = arrayAt + 8 * k
      const first = v.getUint16(entry)
      const last = v.getUint16(entry + 2)
      const header = arrayAt + v.getUint32(entry + 4)
      const indexFormat = v.getUint16(header)
      const imageFormat = v.getUint16(header + 2)
      const imageData = v.getUint32(header + 4)
      const body = header + 8
      const out = subsetIndex(
        v,
        { first, last, indexFormat, imageFormat, imageData, body },
        keep,
        () => imageAt,
        take,
      )
      if (out) subs.push(out)
    }
    strikes.push({ record: eblc.subarray(rec, rec + 48), subs })
  }

  let size = 8 + 48 * numSizes
  for (const s of strikes)
    size += 8 * s.subs.length + s.subs.reduce((n, x) => n + x.bytes.length, 0)
  const out = new Uint8Array(size)
  const ov = view(out)
  out.set(eblc.subarray(0, 4), 0)
  ov.setUint32(4, numSizes)
  let at = 8 + 48 * numSizes
  strikes.forEach((s, i) => {
    const rec = 8 + 48 * i
    out.set(s.record, rec)
    const arrayAt = at
    let sub = arrayAt + 8 * s.subs.length
    s.subs.forEach((x, k) => {
      ov.setUint16(arrayAt + 8 * k, x.first)
      ov.setUint16(arrayAt + 8 * k + 2, x.last)
      ov.setUint32(arrayAt + 8 * k + 4, sub - arrayAt)
      out.set(x.bytes, sub)
      sub += x.bytes.length
    })
    ov.setUint32(rec, arrayAt)
    ov.setUint32(rec + 4, sub - arrayAt)
    ov.setUint32(rec + 8, s.subs.length)
    ov.setUint16(rec + 40, s.subs.length ? Math.min(...s.subs.map((x) => x.first)) : 0)
    ov.setUint16(
      rec + 42,
      s.subs.reduce((n, x) => Math.max(n, x.last), 0),
    )
    at = sub
  })

  const data = new Uint8Array(imageAt)
  data.set(ebdt.subarray(0, 4), 0)
  let p = 4
  for (const im of images) {
    data.set(im, p)
    p += im.length
  }
  return { eblc: out, ebdt: data }
}

interface IndexIn {
  first: number
  last: number
  indexFormat: number
  imageFormat: number
  imageData: number
  body: number
}

/** 裁剪一个索引子表；没有保留的字形时返回 null。`take` 把图像字节追加到新的 `EBDT`，`next` 为下一段图像在其中的位置。 */
function subsetIndex(
  v: DataView,
  s: IndexIn,
  keep: ReadonlySet<number>,
  next: () => number,
  take: (start: number, end: number) => void,
): IndexOut | null {
  /** 保留字形及其图像在原 `EBDT` 中的范围，按字形编号升序。 */
  const kept: { glyph: number; start: number; end: number }[] = []
  let imageSize = 0
  let metrics: Uint8Array | null = null
  switch (s.indexFormat) {
    case 1:
    case 3: {
      const size = s.indexFormat === 1 ? 4 : 2
      const read = (p: number) => (size === 4 ? v.getUint32(p) : v.getUint16(p))
      for (let g = s.first; g <= s.last; g++) {
        const at = s.body + size * (g - s.first)
        const start = read(at)
        const end = read(at + size)
        if (keep.has(g) && end > start)
          kept.push({ glyph: g, start: s.imageData + start, end: s.imageData + end })
      }
      break
    }
    case 4: {
      const count = v.getUint32(s.body)
      const pairs = s.body + 4
      for (let i = 0; i < count; i++) {
        const g = v.getUint16(pairs + 4 * i)
        const start = v.getUint16(pairs + 4 * i + 2)
        const end = v.getUint16(pairs + 4 * i + 6)
        if (keep.has(g) && end > start)
          kept.push({ glyph: g, start: s.imageData + start, end: s.imageData + end })
      }
      break
    }
    case 2:
    case 5: {
      imageSize = v.getUint32(s.body)
      metrics = new Uint8Array(v.buffer, v.byteOffset + s.body + 4, 8)
      const glyphs =
        s.indexFormat === 2
          ? Array.from({ length: s.last - s.first + 1 }, (_, i) => s.first + i)
          : Array.from({ length: v.getUint32(s.body + 12) }, (_, i) =>
              v.getUint16(s.body + 16 + 2 * i),
            )
      glyphs.forEach((g, i) => {
        const start = s.imageData + imageSize * i
        if (keep.has(g)) kept.push({ glyph: g, start, end: start + imageSize })
      })
      break
    }
    default:
      return null
  }
  if (kept.length === 0) return null
  const first = kept[0]!.glyph
  const last = kept[kept.length - 1]!.glyph
  const dataAt = next()

  if (metrics !== null) {
    const length = (8 + 16 + 2 * kept.length + 3) & ~3
    const out = new Uint8Array(length)
    const ov = view(out)
    ov.setUint16(0, 5)
    ov.setUint16(2, s.imageFormat)
    ov.setUint32(4, dataAt)
    ov.setUint32(8, imageSize)
    out.set(metrics, 12)
    ov.setUint32(20, kept.length)
    kept.forEach((k, i) => {
      ov.setUint16(24 + 2 * i, k.glyph)
      take(k.start, k.end)
    })
    return { first, last, bytes: out }
  }

  const span = last - first + 1
  const total = kept.reduce((n, k) => n + k.end - k.start, 0)
  if (total <= 0xffff && 4 + 4 * (kept.length + 1) < 4 * (span + 1)) {
    const out = new Uint8Array((8 + 4 + 4 * (kept.length + 1) + 3) & ~3)
    const ov = view(out)
    ov.setUint16(0, 4)
    ov.setUint16(2, s.imageFormat)
    ov.setUint32(4, dataAt)
    ov.setUint32(8, kept.length)
    let at = 0
    kept.forEach((k, i) => {
      ov.setUint16(12 + 4 * i, k.glyph)
      ov.setUint16(14 + 4 * i, at)
      take(k.start, k.end)
      at += k.end - k.start
    })
    ov.setUint16(14 + 4 * kept.length, at)
    return { first, last, bytes: out }
  }
  const out = new Uint8Array(8 + 4 * (span + 1))
  const ov = view(out)
  ov.setUint16(0, 1)
  ov.setUint16(2, s.imageFormat)
  ov.setUint32(4, dataAt)
  let k = 0
  let offset = 0
  for (let g = first; g <= last; g++) {
    ov.setUint32(8 + 4 * (g - first), offset)
    const hit = kept[k]
    if (hit?.glyph === g) {
      take(hit.start, hit.end)
      offset += hit.end - hit.start
      k++
    }
  }
  ov.setUint32(8 + 4 * span, offset)
  return { first, last, bytes: out }
}

/**
 * 只含 `mapped`（码位 → 字形）的 `cmap`：平台 3 编码 1 的格式 4，有 BMP 以外的码位时另加平台 3 编码 10 的格式 12；
 * 原表中的变体序列子表（平台 0 编码 5，格式 14）原样保留。原表含符号编码子表（平台 3 编码 0）时原样返回：
 * 符号字体按 U+F000 加码位查询（`readCmap`），映射与码位不一一对应。
 */
function subsetCmap(cmap: Uint8Array, mapped: readonly [number, number][]): Uint8Array {
  const v = view(cmap)
  let variations: Uint8Array | null = null
  for (let i = 0; i < v.getUint16(2); i++) {
    const rec = 4 + 8 * i
    const platform = v.getUint16(rec)
    const encoding = v.getUint16(rec + 2)
    const at = v.getUint32(rec + 4)
    if (platform === 3 && encoding === 0) return cmap
    if (platform === 0 && encoding === 5 && v.getUint16(at) === 14) {
      variations = cmap.subarray(at, at + v.getUint32(at + 2))
    }
  }
  const sorted = [...mapped].sort((a, b) => a[0] - b[0])
  const bmp = sorted.filter(([c]) => c <= 0xffff)
  const subtables: [platform: number, encoding: number, bytes: Uint8Array][] = []
  if (variations) subtables.push([0, 5, variations])
  subtables.push([3, 1, format4(bmp)])
  if (bmp.length < sorted.length) subtables.push([3, 10, format12(sorted)])
  const header = 4 + 8 * subtables.length
  const out = new Uint8Array(header + subtables.reduce((n, [, , b]) => n + b.length, 0))
  const ov = view(out)
  ov.setUint16(2, subtables.length)
  let at = header
  subtables.forEach(([platform, encoding, bytes], i) => {
    ov.setUint16(4 + 8 * i, platform)
    ov.setUint16(6 + 8 * i, encoding)
    ov.setUint32(8 + 8 * i, at)
    out.set(bytes, at)
    at += bytes.length
  })
  return out
}

/** 码位与字形编号都连续的段。 */
function runsOf(
  sorted: readonly [number, number][],
): [start: number, end: number, glyph: number][] {
  const runs: [number, number, number][] = []
  for (const [c, g] of sorted) {
    const last = runs[runs.length - 1]
    if (last && c === last[1] + 1 && g === last[2] + (c - last[0])) last[1] = c
    else runs.push([c, c, g])
  }
  return runs
}

/** 格式 4：每段以 `idDelta` 映射，末尾为 0xFFFF 段。 */
function format4(bmp: readonly [number, number][]): Uint8Array {
  const runs = runsOf(bmp).filter(([start]) => start < 0xffff)
  runs.push([0xffff, 0xffff, 0])
  const segments = runs.length
  const length = 16 + 8 * segments
  const out = new Uint8Array(length)
  const v = view(out)
  const selector = Math.floor(Math.log2(segments))
  v.setUint16(0, 4)
  v.setUint16(2, length)
  v.setUint16(6, 2 * segments)
  v.setUint16(8, 2 * 2 ** selector)
  v.setUint16(10, selector)
  v.setUint16(12, 2 * segments - 2 * 2 ** selector)
  runs.forEach(([start, end, glyph], i) => {
    v.setUint16(14 + 2 * i, end)
    v.setUint16(16 + 2 * segments + 2 * i, start)
    v.setUint16(16 + 4 * segments + 2 * i, start === 0xffff ? 1 : (glyph - start) & 0xffff)
  })
  return out
}

/** 格式 12：每组码位与字形编号都连续。 */
function format12(sorted: readonly [number, number][]): Uint8Array {
  const runs = runsOf(sorted)
  const out = new Uint8Array(16 + 12 * runs.length)
  const v = view(out)
  v.setUint16(0, 12)
  v.setUint32(4, out.length)
  v.setUint32(12, runs.length)
  runs.forEach(([start, end, glyph], i) => {
    v.setUint32(16 + 12 * i, start)
    v.setUint32(20 + 12 * i, end)
    v.setUint32(24 + 12 * i, glyph)
  })
  return out
}

/**
 * 只保留左右字形都在 `keep` 中的字偶（格式 0 子表）；其他格式的子表与非版本 0 的表原样保留。
 * 格式 0 子表的长度字段只有 16 位，按字偶数计算长度（同 `features/kern.ts`）。
 */
function subsetKern(kern: Uint8Array, keep: ReadonlySet<number>): Uint8Array {
  const v = view(kern)
  if (kern.byteLength < 4 || v.getUint16(0) !== 0) return kern
  const parts: Uint8Array[] = []
  let off = 4
  const count = v.getUint16(2)
  for (let i = 0; i < count && off + 6 <= kern.byteLength; i++) {
    const coverage = v.getUint16(off + 4)
    if (coverage >> 8 !== 0) {
      const length = v.getUint16(off + 2)
      parts.push(kern.subarray(off, off + length))
      off += length
      continue
    }
    const pairs = v.getUint16(off + 6)
    const kept: number[] = []
    for (let k = 0; k < pairs; k++) {
      const p = off + 14 + 6 * k
      if (keep.has(v.getUint16(p)) && keep.has(v.getUint16(p + 2))) kept.push(p)
    }
    const out = new Uint8Array(14 + 6 * kept.length)
    const ov = view(out)
    const selector = kept.length > 0 ? Math.floor(Math.log2(kept.length)) : 0
    ov.setUint16(2, Math.min(0xffff, out.length))
    ov.setUint16(4, coverage)
    ov.setUint16(6, kept.length)
    ov.setUint16(8, kept.length > 0 ? 6 * 2 ** selector : 0)
    ov.setUint16(10, selector)
    ov.setUint16(12, kept.length > 0 ? 6 * kept.length - 6 * 2 ** selector : 0)
    kept.forEach((p, k) => {
      out.set(kern.subarray(p, p + 6), 14 + 6 * k)
    })
    parts.push(out)
    off += 14 + 6 * pairs
  }
  const out = new Uint8Array(4 + parts.reduce((n, p) => n + p.length, 0))
  view(out).setUint16(2, parts.length)
  let at = 4
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
