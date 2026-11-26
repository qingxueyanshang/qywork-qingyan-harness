/**
 * 覆盖 `video/frame-clip.ts` 的 `frameClipOf`、`http-util.ts` 的 `bytesResponse`，以及 `/api/files/raw` 的 `frame`。
 *
 * 原始失败形状：画布视频卡片的封面以原视频地址载入，WebKit 取一帧下载 2.9–5.7 MB，远程访问时 25 个视频的画布需数分钟。
 * 锁定：片段只含呈现该时刻所需的样本（最近的同步样本至目标样本，按解码顺序），合成时间等于原视频的呈现时间，
 * 样本时长之和与时长字段等于原视频轨的时长；音轨与分块布局不影响取出的字节；无法裁剪的文件返回 null 并答复 415；
 * 片段按请求的 Range 答复 206。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaBoxAt } from '@qywork/core'
import { handleWorkspaceFsApi } from '../api/workspace-fs.ts'
import { bytesResponse } from '../http-util.ts'
import { frameClipOf } from './frame-clip.ts'

const enc = (s: string) => new TextEncoder().encode(s)

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  out.set(enc(type), 4)
  let at = 8
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const v = new DataView(out.buffer)
  for (const [i, x] of values.entries()) {
    if (x < 0) v.setInt32(i * 4, x)
    else v.setUint32(i * 4, x)
  }
  return out
}

const concat = (parts: Uint8Array[]) => box('xxxx', ...parts).subarray(8)

/**
 * 时间单位 1000、每帧 100 的 8 帧视频，解码顺序的呈现帧号为 0 3 1 2 6 4 5 7（含 B 帧），同步样本为第 0、7 个；
 * 编辑表起点 100。视频分三块（3、3、2 个样本），块之间夹着音频块；音轨位于视频轨之前。
 * 第 k 个视频样本长 10 + k 字节、每字节为 k + 1。
 */
const FRAMES = [0, 3, 1, 2, 6, 4, 5, 7]
const STSD = box('stsd', u32(0, 1), box('avc1', new Uint8Array(78)))
const sample = (k: number) => new Uint8Array(10 + k).fill(k + 1)

function movie(moovFirst: boolean, video = true): Uint8Array {
  const ftyp = box('ftyp', enc('isom'), u32(0x200), enc('isomavc1'))
  const audio = new Uint8Array(50).fill(0xee)
  const chunks = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7],
  ]
  const payload = (offsetOfMdat: number) => {
    const parts: Uint8Array[] = []
    const videoChunks: number[] = []
    const audioChunks: number[] = []
    let pos = offsetOfMdat + 8
    chunks.forEach((ks, i) => {
      videoChunks.push(pos)
      for (const k of ks) {
        parts.push(sample(k))
        pos += sample(k).length
      }
      if (i < chunks.length - 1) {
        audioChunks.push(pos)
        parts.push(audio)
        pos += audio.length
      }
    })
    return { mdat: box('mdat', concat(parts)), videoChunks, audioChunks }
  }
  const moovOf = (videoChunks: number[], audioChunks: number[]) => {
    const cts = FRAMES.map((f, k) => f * 100 + 100 - k * 100)
    const audioTrak = box(
      'trak',
      box('tkhd', u32(3, 0, 0, 2, 0, 800), new Uint8Array(60)),
      box(
        'mdia',
        box('mdhd', u32(0, 0, 0, 1000, 800, 0)),
        box('hdlr', u32(0, 0), enc('soun'), new Uint8Array(13)),
        box(
          'minf',
          box(
            'stbl',
            box('stsd', u32(0, 0)),
            box('stts', u32(0, 1, 2, 400)),
            box('stsc', u32(0, 1, 1, 1, 1)),
            box('stsz', u32(0, 50, 2)),
            box('stco', u32(0, 2, ...audioChunks)),
          ),
        ),
      ),
    )
    const videoTrak = box(
      'trak',
      box('tkhd', u32(3, 0, 0, 7, 0, 800), new Uint8Array(52), u32(1280 << 16, 720 << 16)),
      box('edts', box('elst', u32(0, 1, 800, 100, 0x00010000))),
      box(
        'mdia',
        box('mdhd', u32(0, 0, 0, 1000, 800), new Uint8Array([0x55, 0xc4, 0, 0])),
        box('hdlr', u32(0, 0), enc('vide'), new Uint8Array(13)),
        box(
          'minf',
          box('vmhd', u32(1, 0, 0)),
          box('dinf', box('dref', u32(0, 1), box('url ', u32(1)))),
          box(
            'stbl',
            STSD,
            box('stts', u32(0, 1, 8, 100)),
            box('ctts', u32(0, 8, ...cts.flatMap((c) => [1, c]))),
            box('stss', u32(0, 2, 1, 8)),
            box('stsc', u32(0, 2, 1, 3, 1, 3, 2, 1)),
            box('stsz', u32(0, 0, 8, ...FRAMES.map((_, k) => 10 + k))),
            box('stco', u32(0, 3, ...videoChunks)),
          ),
        ),
      ),
    )
    return box(
      'moov',
      box('mvhd', u32(0, 0, 0, 1000, 800), new Uint8Array(80)),
      audioTrak,
      ...(video ? [videoTrak] : []),
    )
  }
  if (moovFirst) {
    const size = moovOf([0, 0, 0], [0, 0]).length
    const { mdat, videoChunks, audioChunks } = payload(ftyp.length + size)
    return concat([ftyp, moovOf(videoChunks, audioChunks), mdat])
  }
  const { mdat, videoChunks, audioChunks } = payload(ftyp.length)
  return concat([ftyp, mdat, moovOf(videoChunks, audioChunks)])
}

/** 按路径取 box 载荷，如 `moov/trak/mdia/minf/stbl/stts`；同名的取第一个。 */
function find(bytes: Uint8Array, path: string): Uint8Array {
  let cur = bytes
  for (const type of path.split('/')) {
    let at = 0
    let next: Uint8Array | null = null
    while (at + 8 <= cur.length) {
      const b = mediaBoxAt(cur, at, cur.length - at)!
      if (b.type === type) {
        next = cur.subarray(at + b.header, at + b.size)
        break
      }
      at += b.size
    }
    if (!next) throw new Error(`缺少 ${path}`)
    cur = next
  }
  return cur
}

const has = (bytes: Uint8Array, path: string) => {
  try {
    find(bytes, path)
    return true
  } catch {
    return false
  }
}

const words = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return Array.from({ length: b.length / 4 }, (_, i) => v.getInt32(i * 4))
}

const STBL = 'moov/trak/mdia/minf/stbl'

/** 片段中第 k 个样本的字节（经 stco 与 stsz 定位）。 */
function clipSamples(clip: Uint8Array): Uint8Array[] {
  const [, , n, ...sizes] = words(find(clip, `${STBL}/stsz`))
  let pos = words(find(clip, `${STBL}/stco`))[2]!
  return Array.from({ length: n! }, (_, k) => {
    const s = clip.subarray(pos, pos + sizes[k]!)
    pos += sizes[k]!
    return s
  })
}

/** 片段中各样本的呈现时间：解码时间加合成时间偏移。 */
function clipPts(clip: Uint8Array): number[] {
  const stts = words(find(clip, `${STBL}/stts`)).slice(2)
  const dts: number[] = []
  let t = 0
  for (let e = 0; e < stts.length; e += 2)
    for (let k = 0; k < stts[e]!; k++) {
      dts.push(t)
      t += stts[e + 1]!
    }
  const offsets: number[] = []
  if (has(clip, `${STBL}/ctts`)) {
    const ctts = words(find(clip, `${STBL}/ctts`)).slice(2)
    for (let e = 0; e < ctts.length; e += 2)
      for (let k = 0; k < ctts[e]!; k++) offsets.push(ctts[e + 1]!)
  }
  return dts.map((d, k) => d + (offsets[k] ?? 0))
}

async function write(bytes: Uint8Array, name = 'v.mp4'): Promise<{ dir: string; abs: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-frame-clip-'))
  const abs = join(dir, name)
  await writeFile(abs, bytes)
  return { dir, abs }
}

describe('frameClipOf', () => {
  for (const moovFirst of [true, false]) {
    test(`取最近的同步样本至呈现该时刻的样本，呈现时间与原视频相同（moov ${moovFirst ? '在前' : '在后'}）`, async () => {
      const { abs } = await write(movie(moovFirst))
      const clip = (await frameClipOf(abs, 0.25))!
      // 呈现 0.25 秒的是呈现帧号 2（第 3 个解码样本）；它依赖第 0 至第 2 个样本。
      expect(clipSamples(clip)).toEqual([0, 1, 2, 3].map(sample))
      expect(clipPts(clip)).toEqual([0, 300, 100, 200])
      expect(words(find(clip, `${STBL}/stts`)).slice(2)).toEqual([3, 100, 1, 500])
      expect(words(find(clip, `${STBL}/stss`))).toEqual([0, 1, 1])
      expect(words(find(clip, `${STBL}/stsc`))).toEqual([0, 1, 1, 4, 1])
      expect(find(clip, `${STBL}/stsd`)).toEqual(STSD.subarray(8))
      expect(has(clip, 'moov/trak/edts')).toBe(false)
      expect(words(find(clip, 'moov/mvhd'))[4]).toBe(800)
      expect(words(find(clip, 'moov/trak/mdia/mdhd'))[4]).toBe(800)
      const tkhd = words(find(clip, 'moov/trak/tkhd'))
      expect([tkhd[3], tkhd[5]]).toEqual([1, 800])
      expect(clip.length).toBeLessThan(movie(moovFirst).length)
    })
  }

  test('目标即同步样本时只取它；早于第一帧时取第一帧', async () => {
    const { abs } = await write(movie(false))
    const late = (await frameClipOf(abs, 0.75))!
    expect(clipSamples(late)).toEqual([sample(7)])
    expect(clipPts(late)).toEqual([700])
    expect(words(find(late, `${STBL}/stts`)).slice(2)).toEqual([1, 800])
    expect(has(late, `${STBL}/stss`)).toBe(false)
    const early = (await frameClipOf(abs, 0))!
    expect(clipSamples(early)).toEqual([sample(0)])
    expect(clipPts(early)).toEqual([0])
  })

  test('没有视频轨或不是 ISO 媒体容器时返回 null', async () => {
    expect(await frameClipOf((await write(movie(false, false))).abs, 0.1)).toBeNull()
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01])
    expect(await frameClipOf((await write(webm, 'x.webm')).abs, 0.1)).toBeNull()
  })
})

describe('/api/files/raw 的 frame', () => {
  const get = (dir: string, query: string, headers: Record<string, string> = {}) => {
    const url = new URL(`http://x/api/files/raw?${query}`)
    return handleWorkspaceFsApi(url, new Request(url.href, { headers }), {
      workspaceRoot: dir,
    } as never) as Promise<Response>
  }

  test('返回帧片段并按 Range 答复 206；时刻不合法 422，非视频 415', async () => {
    const { dir, abs } = await write(movie(false))
    const clip = (await frameClipOf(abs, 0.1))!
    const full = await get(dir, 'path=v.mp4&v=1&frame=0.1')
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(full.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(new Uint8Array(clip))
    const head = await get(dir, 'path=v.mp4&v=1&frame=0.1', { range: 'bytes=0-1' })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe(`bytes 0-1/${clip.length}`)
    expect(new Uint8Array(await head.arrayBuffer())).toEqual(new Uint8Array(clip.subarray(0, 2)))
    expect((await get(dir, 'path=v.mp4&frame=-1')).status).toBe(422)
    await writeFile(join(dir, 'x.pdf'), '%PDF-1.4 x')
    expect((await get(dir, 'path=x.pdf&frame=0.1')).status).toBe(415)
  })
})

describe('bytesResponse', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  const answer = (range?: string) =>
    bytesResponse(new Request('http://x/', range ? { headers: { range } } : {}), bytes, {
      'content-type': 'video/mp4',
    })

  test('单段 Range 答复 206，起点越界 416，其余写法答复完整内容', async () => {
    const tail = answer('bytes=-3')
    expect([tail.status, tail.headers.get('content-range')]).toEqual([206, 'bytes 7-9/10'])
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.subarray(7))
    const open = answer('bytes=4-')
    expect([open.status, open.headers.get('content-range')]).toEqual([206, 'bytes 4-9/10'])
    const clamped = answer('bytes=8-100')
    expect(clamped.headers.get('content-range')).toBe('bytes 8-9/10')
    expect(answer('bytes=10-').status).toBe(416)
    for (const r of [undefined, 'bytes=0-1,4-5', 'items=0-1']) {
      const res = answer(r)
      expect([res.status, res.headers.get('accept-ranges')]).toEqual([200, 'bytes'])
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    }
  })
})
