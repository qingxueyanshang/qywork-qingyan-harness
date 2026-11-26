/**
 * 视频帧片段：从 ISO 媒体容器（mp4 / mov / m4v）中取出呈现某一时刻所需的视频样本，组成只含这一条视频轨的 MP4。
 * 界面以它解码视频卡片的封面，不载入原视频：浏览器载入原视频时按自身策略缓冲，WebKit 取一帧即下载数 MB，
 * 远程访问时这些字节全部经隧道传输；片段只含该时刻所在的几个样本。
 *
 * - 样本取自该时刻之前最近的同步样本至呈现该时刻的样本，按解码顺序：后者的参考帧都在它之前解码。
 * - 复制视频轨的 `tkhd`（矩阵含旋转）、`hdlr`、`vmhd`、`dinf` 与 `stsd`（编解码配置），样本表按所取样本重写；
 *   音轨、编辑表、样本分组与 `sdtp` 不复制。
 * - 片段的合成时间等于原视频的呈现时间（已计入原编辑表），时长字段写原视频轨的时长：界面照原视频的时刻定位，
 *   `duration` 为原视频的时长，不需要另外取得这两项。
 * - 分片 MP4（样本位于 `moof`）、Matroska、没有视频轨或样本表不完整的文件返回 null。
 */

import { open } from 'node:fs/promises'
import { mediaBoxAt } from '@qywork/core'

/** 与 `@qywork/agent` 读取视频信息的上限相同：`moov` 只存储索引，超过该值视为异常文件。 */
const MAX_MOOV = 64 * 1024 * 1024

interface Box {
  type: string
  /** 含 box 头的完整字节。 */
  whole: Uint8Array
  body: Uint8Array
}

const EMPTY = new Uint8Array()
const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const ascii = (s: string) => new TextEncoder().encode(s)

function boxesOf(parent: Uint8Array): Box[] {
  const out: Box[] = []
  let at = 0
  while (at + 8 <= parent.length) {
    const box = mediaBoxAt(parent, at, parent.length - at)
    if (!box) break
    out.push({
      type: box.type,
      whole: parent.subarray(at, at + box.size),
      body: parent.subarray(at + box.header, at + box.size),
    })
    at += box.size
  }
  return out
}

const childOf = (parent: Uint8Array | undefined, type: string): Box | undefined =>
  boxesOf(parent ?? EMPTY).find((b) => b.type === type)

/** 视频轨的样本表，下标为解码顺序。`cts` 为合成时间偏移，没有 `ctts` 时全为 0。 */
interface Samples {
  dts: number[]
  cts: number[]
  sizes: number[]
  offsets: number[]
  /** 同步样本的下标（从 0 起）；没有 `stss` 时为 null，表示全部是同步样本。 */
  sync: Set<number> | null
  /** 最后一个 `stts` 条目的时长，即最后一个样本的时长（媒体时间单位）。 */
  lastDelta: number
}

function samplesOf(stbl: Uint8Array): Samples | null {
  const stts = childOf(stbl, 'stts')?.body
  const stsz = childOf(stbl, 'stsz')?.body
  const stsc = childOf(stbl, 'stsc')?.body
  const stco = childOf(stbl, 'stco')?.body
  const co64 = childOf(stbl, 'co64')?.body
  if (!stts || !stsz || !stsc || !(stco || co64)) return null

  const sz = viewOf(stsz)
  const fixed = sz.getUint32(4)
  const count = sz.getUint32(8)
  if (count === 0) return null
  const sizes = Array.from({ length: count }, (_, i) =>
    fixed === 0 ? sz.getUint32(12 + i * 4) : fixed,
  )

  const dts: number[] = []
  let t = 0
  let lastDelta = 0
  const tt = viewOf(stts)
  for (let e = 0, n = tt.getUint32(4); e < n && dts.length < count; e++) {
    const run = tt.getUint32(8 + e * 8)
    lastDelta = tt.getUint32(12 + e * 8)
    for (let k = 0; k < run && dts.length < count; k++) {
      dts.push(t)
      t += lastDelta
    }
  }
  if (dts.length < count) return null

  const cts = new Array<number>(count).fill(0)
  const ctts = childOf(stbl, 'ctts')?.body
  if (ctts) {
    const v = viewOf(ctts)
    let i = 0
    for (let e = 0, n = v.getUint32(4); e < n && i < count; e++) {
      const run = v.getUint32(8 + e * 8)
      // 版本 0 规定为无符号数，但常见写出程序在其中写入负偏移；一律按有符号读取。
      const offset = v.getInt32(12 + e * 8)
      for (let k = 0; k < run && i < count; k++) cts[i++] = offset
    }
  }

  const chunks: number[] = []
  if (co64) {
    const v = viewOf(co64)
    for (let i = 0, n = v.getUint32(4); i < n; i++) chunks.push(Number(v.getBigUint64(8 + i * 8)))
  } else if (stco) {
    const v = viewOf(stco)
    for (let i = 0, n = v.getUint32(4); i < n; i++) chunks.push(v.getUint32(8 + i * 4))
  }
  const sc = viewOf(stsc)
  const runs = Array.from({ length: sc.getUint32(4) }, (_, e) => ({
    first: sc.getUint32(8 + e * 12),
    perChunk: sc.getUint32(12 + e * 12),
  }))
  const offsets: number[] = []
  for (let r = 0; r < runs.length && offsets.length < count; r++) {
    const end = runs[r + 1]?.first ?? chunks.length + 1
    for (let chunk = runs[r]!.first; chunk < end && offsets.length < count; chunk++) {
      let pos = chunks[chunk - 1]
      if (pos === undefined) return null
      for (let k = 0; k < runs[r]!.perChunk && offsets.length < count; k++) {
        offsets.push(pos)
        pos += sizes[offsets.length - 1]!
      }
    }
  }
  if (offsets.length < count) return null

  const stss = childOf(stbl, 'stss')?.body
  let sync: Set<number> | null = null
  if (stss) {
    const v = viewOf(stss)
    sync = new Set(Array.from({ length: v.getUint32(4) }, (_, i) => v.getUint32(8 + i * 4) - 1))
  }
  return { dts, cts, sizes, offsets, sync, lastDelta }
}

/** `elst` 第一段非空编辑的起点（媒体时间单位），即呈现时刻 0 对应的合成时间；没有编辑表时为 0。 */
function editStartOf(trak: Uint8Array): number {
  const elst = childOf(childOf(trak, 'edts')?.body, 'elst')?.body
  if (!elst) return 0
  const v = viewOf(elst)
  const wide = elst[0] === 1
  const step = wide ? 20 : 12
  for (let e = 0, n = v.getUint32(4); e < n; e++) {
    const at = 8 + e * step
    const start = wide ? Number(v.getBigInt64(at + 8)) : v.getInt32(at + 4)
    if (start >= 0) return start
  }
  return 0
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  viewOf(out).setUint32(0, size)
  out.set(ascii(type), 4)
  let at = 8
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 32 位大端整数序列；负数按有符号写入。 */
function words(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const v = viewOf(out)
  for (const [i, x] of values.entries()) {
    if (x < 0) v.setInt32(i * 4, x)
    else v.setUint32(i * 4, x)
  }
  return out
}

/** 连续相同的取值合并为（个数, 值）对，前面加条目数：`stts` 与 `ctts` 的条目格式。 */
function runTable(values: number[]): number[] {
  const pairs: number[] = []
  for (const x of values) {
    if (pairs.length && pairs[pairs.length - 1] === x) pairs[pairs.length - 2]! += 1
    else pairs.push(1, x)
  }
  return [pairs.length / 2, ...pairs]
}

/** 复制 `tkhd`，改写为已启用、轨道号 1、时长 `duration`（电影时间单位）。 */
function trackHeader(tkhd: Box, duration: number): Uint8Array {
  const out = tkhd.whole.slice()
  const body = out.subarray(tkhd.whole.length - tkhd.body.length)
  const v = viewOf(body)
  const wide = body[0] === 1
  body[3] = body[3]! | 0x03
  v.setUint32(wide ? 20 : 12, 1)
  if (wide) v.setBigUint64(28, BigInt(duration))
  else v.setUint32(20, duration)
  return out
}

/** 版本 0 的 `mvhd`：时间单位与视频轨的媒体时间单位相同，单位矩阵，下一个轨道号为 2。 */
function movieHeader(scale: number, duration: number): Uint8Array {
  return box(
    'mvhd',
    words(0, 0, 0, scale, duration, 0x00010000),
    new Uint8Array([0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    words(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000),
    new Uint8Array(24),
    words(2),
  )
}

/** 顶层的 `ftyp` 与 `moov` 载荷；`moov` 位于 `mdat` 之后时同样能找到。 */
async function topBoxesOf(
  file: Awaited<ReturnType<typeof open>>,
): Promise<{ ftyp: Uint8Array | null; moov: Uint8Array } | null> {
  const total = (await file.stat()).size
  const head = new Uint8Array(16)
  let ftyp: Uint8Array | null = null
  for (let pos = 0; pos + 8 <= total; ) {
    await file.read(head, 0, 16, pos)
    const top = mediaBoxAt(head, 0, total - pos)
    if (!top) return null
    if (top.type === 'ftyp' || top.type === 'moov') {
      if (top.size > MAX_MOOV) return null
      const whole = new Uint8Array(top.size)
      await file.read(whole, 0, top.size, pos)
      if (top.type === 'moov') return { ftyp, moov: whole.subarray(top.header) }
      ftyp = whole
    }
    pos += top.size
  }
  return null
}

/**
 * 取出呈现 `at` 秒所需的样本并组成 MP4。`at` 早于第一帧时取第一帧，晚于最后一帧时取最后一帧。
 * 文件不是可裁剪的 ISO 媒体容器时返回 null。
 */
export async function frameClipOf(abs: string, at: number): Promise<Uint8Array | null> {
  const file = await open(abs, 'r')
  try {
    const top = await topBoxesOf(file)
    if (!top) return null
    const trak = boxesOf(top.moov)
      .filter((b) => b.type === 'trak')
      .map((b) => b.body)
      .find((t) => {
        const hdlr = childOf(childOf(t, 'mdia')?.body, 'hdlr')?.body
        return hdlr !== undefined && String.fromCharCode(...hdlr.subarray(8, 12)) === 'vide'
      })
    const tkhd = childOf(trak, 'tkhd')
    const mdia = childOf(trak, 'mdia')?.body
    const mdhd = childOf(mdia, 'mdhd')?.body
    const hdlr = childOf(mdia, 'hdlr')
    const minf = childOf(mdia, 'minf')?.body
    const stbl = childOf(minf, 'stbl')?.body
    const stsd = childOf(stbl, 'stsd')
    const samples = stbl && samplesOf(stbl)
    if (!trak || !tkhd || !mdhd || !hdlr || !minf || !stsd || !samples) return null

    const wide = mdhd[0] === 1
    const mh = viewOf(mdhd)
    const scale = mh.getUint32(wide ? 20 : 12)
    const length = Math.min(0xffffffff, wide ? Number(mh.getBigUint64(24)) : mh.getUint32(16))
    const language = mdhd.subarray(wide ? 32 : 20, wide ? 34 : 22)
    if (scale === 0) return null

    // 呈现该时刻的样本：呈现时间不晚于该时刻的样本中最晚的一个；都晚于该时刻时取最早呈现的样本。
    const edit = editStartOf(trak)
    const target = Math.round(Math.max(0, at) * scale) + edit
    const pts = (i: number) => samples.dts[i]! + samples.cts[i]!
    let last = -1
    let earliest = 0
    for (let i = 0; i < samples.dts.length; i++) {
      if (pts(i) <= target && (last < 0 || pts(i) > pts(last))) last = i
      if (pts(i) < pts(earliest)) earliest = i
    }
    if (last < 0) last = earliest
    let first = last
    while (first > 0 && samples.sync && !samples.sync.has(first)) first--

    const picked = Array.from({ length: last - first + 1 }, (_, k) => first + k)
    const deltas = picked.map((i) => {
      const next = samples.dts[i + 1]
      return next === undefined ? samples.lastDelta : next - samples.dts[i]!
    })
    // Chromium 按样本时长之和计算 `duration`，不读取时长字段：最后一个样本延长到原视频轨的时长，两种内核取得的时长相同。
    const end = samples.dts[last]! - samples.dts[first]!
    deltas[deltas.length - 1] = Math.max(deltas[deltas.length - 1]!, length - end)
    // 片段的解码时间从 0 起，合成时间等于原视频的呈现时间：界面按原视频的时刻定位即得到同一帧。
    const cts = picked.map((i) => samples.cts[i]! - edit + samples.dts[first]!)
    const sizes = picked.map((i) => samples.sizes[i]!)
    const payload = sizes.reduce((n, s) => n + s, 0)
    const sync = samples.sync
    const marks = sync ? picked.flatMap((i, k) => (sync.has(i) ? [k + 1] : [])) : []

    const moovOf = (chunkOffset: number) =>
      box(
        'moov',
        movieHeader(scale, length),
        box(
          'trak',
          trackHeader(tkhd, length),
          box(
            'mdia',
            box('mdhd', words(0, 0, 0, scale, length), language, new Uint8Array(2)),
            hdlr.whole,
            box(
              'minf',
              ...['vmhd', 'dinf'].flatMap((t) => childOf(minf, t)?.whole ?? []),
              box(
                'stbl',
                stsd.whole,
                box('stts', words(0, ...runTable(deltas))),
                ...(cts.some((c) => c !== 0)
                  ? [box('ctts', words(cts.some((c) => c < 0) ? 0x01000000 : 0, ...runTable(cts)))]
                  : []),
                ...(marks.length < picked.length
                  ? [box('stss', words(0, marks.length, ...marks))]
                  : []),
                box('stsc', words(0, 1, 1, picked.length, 1)),
                box('stsz', words(0, 0, picked.length, ...sizes)),
                box('stco', words(0, 1, chunkOffset)),
              ),
            ),
          ),
        ),
      )
    const ftyp = top.ftyp ?? box('ftyp', ascii('isom'), words(0x200), ascii('isomiso2mp41'))
    const mdatAt = ftyp.length + moovOf(0).length
    const out = new Uint8Array(mdatAt + 8 + payload)
    out.set(ftyp, 0)
    out.set(moovOf(mdatAt + 8), ftyp.length)
    viewOf(out).setUint32(mdatAt, 8 + payload)
    out.set(ascii('mdat'), mdatAt + 4)
    let pos = mdatAt + 8
    for (const i of picked) {
      await file.read(out, pos, samples.sizes[i]!, samples.offsets[i]!)
      pos += samples.sizes[i]!
    }
    return out
  } finally {
    await file.close()
  }
}
