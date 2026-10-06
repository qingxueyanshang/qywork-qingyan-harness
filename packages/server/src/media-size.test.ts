import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaDurationOf, mediaSizeOf } from './media-size.ts'

/** PNG 签名与 IHDR 头：尺寸只取决于这 24 字节。 */
function pngHead(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return new Uint8Array(b)
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

/** `tkhd` 载荷：版本 0 的矩阵位于偏移 40、版本 1 位于 52；宽高为 16.16 定点数。`rotated` 写入 90° 旋转矩阵。 */
function tkhd(w: number, h: number, opts: { version?: 0 | 1; rotated?: boolean } = {}): Buffer {
  const matrix = opts.version === 1 ? 52 : 40
  const b = Buffer.alloc(matrix + 44)
  b[0] = opts.version ?? 0
  b.writeInt32BE(opts.rotated ? 0 : 0x10000, matrix)
  b.writeInt32BE(opts.rotated ? 0x10000 : 0, matrix + 4)
  b.writeUInt32BE(w * 65536, matrix + 36)
  b.writeUInt32BE(h * 65536, matrix + 40)
  return box('tkhd', b)
}

/** `mvhd` 载荷：版本 0 的时间字段 4 字节、版本 1 的 8 字节。 */
function mvhd(scale: number, duration: number, version: 0 | 1 = 0): Buffer {
  const b = Buffer.alloc(version === 1 ? 112 : 100)
  b[0] = version
  if (version === 1) {
    b.writeUInt32BE(scale, 20)
    b.writeBigUInt64BE(BigInt(duration), 24)
  } else {
    b.writeUInt32BE(scale, 12)
    b.writeUInt32BE(duration, 16)
  }
  return box('mvhd', b)
}

/** 音轨（宽高为 0）在前、画面轨在后；`moov` 位于 `mdat` 之后，与未做快速启动优化的文件相同。 */
function mp4(video: Buffer, head = mvhd(1000, 0)): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom0000', 'latin1')),
    box('mdat', Buffer.alloc(4096)),
    box('moov', head, box('trak', tkhd(0, 0)), box('trak', video)),
  ])
}

async function file(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-media-size-'))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

describe('媒体像素宽高', () => {
  test('图片读取文件头', async () => {
    expect(await mediaSizeOf(await file('a.png', pngHead(1536, 1024)))).toEqual({
      w: 1536,
      h: 1024,
    })
  })

  test('mp4 / mov：跳过 mdat 找到文件末尾的 moov，取第一条宽高非零的轨道；支持 tkhd 的两个版本', async () => {
    expect(await mediaSizeOf(await file('a.mp4', mp4(tkhd(1920, 1080))))).toEqual({
      w: 1920,
      h: 1080,
    })
    expect(await mediaSizeOf(await file('b.mov', mp4(tkhd(720, 1280, { version: 1 }))))).toEqual({
      w: 720,
      h: 1280,
    })
  })

  test('带 90° 旋转矩阵时宽高对调：手机竖拍视频按横向存储', async () => {
    expect(
      await mediaSizeOf(await file('c.mp4', mp4(tkhd(1920, 1080, { rotated: true })))),
    ).toEqual({ w: 1080, h: 1920 })
  })

  test('无法读取时返回 null：文件头错误、截断、未识别的格式、不存在的文件', async () => {
    expect(await mediaSizeOf(await file('bad.png', new Uint8Array([1, 2, 3])))).toBeNull()
    expect(
      await mediaSizeOf(await file('cut.mp4', mp4(tkhd(1920, 1080)).subarray(0, 60))),
    ).toBeNull()
    expect(await mediaSizeOf(await file('a.webm', new Uint8Array(64)))).toBeNull()
    expect(await mediaSizeOf(join(tmpdir(), 'qywork-no-such-file.png'))).toBeNull()
  })
})

describe('视频时长', () => {
  test('取 mvhd 的 duration / timescale，支持两个版本', async () => {
    expect(
      await mediaDurationOf(await file('a.mp4', mp4(tkhd(1920, 1080), mvhd(1000, 5040)))),
    ).toBe(5.04)
    expect(
      await mediaDurationOf(await file('b.mov', mp4(tkhd(1920, 1080), mvhd(90000, 900000, 1)))),
    ).toBe(10)
  })

  test('不是 mp4 / mov、无法读取、timescale 为 0 时返回 null', async () => {
    expect(await mediaDurationOf(await file('a.png', pngHead(10, 10)))).toBeNull()
    expect(
      await mediaDurationOf(await file('cut.mp4', mp4(tkhd(10, 10)).subarray(0, 60))),
    ).toBeNull()
    expect(await mediaDurationOf(await file('z.mp4', mp4(tkhd(10, 10), mvhd(0, 100))))).toBeNull()
  })
})
