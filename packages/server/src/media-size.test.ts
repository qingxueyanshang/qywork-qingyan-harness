import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaSizeOf } from './media-size.ts'

/** PNG 签名加 IHDR 头：尺寸只看这 24 字节。 */
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

/** `tkhd` 载荷：版本 0 的矩阵在 40、版本 1 的在 52；宽高是 16.16 定点。`rotated` 写 90° 旋转矩阵。 */
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

/** 音轨（宽高 0）在前、画面轨在后；`moov` 放在 `mdat` 之后，同未做快速启动的文件。 */
function mp4(video: Buffer): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom0000', 'latin1')),
    box('mdat', Buffer.alloc(4096)),
    box('moov', box('mvhd', Buffer.alloc(100)), box('trak', tkhd(0, 0)), box('trak', video)),
  ])
}

async function file(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-media-size-'))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

describe('媒体像素宽高', () => {
  test('图片读文件头', async () => {
    expect(await mediaSizeOf(await file('a.png', pngHead(1536, 1024)))).toEqual({
      w: 1536,
      h: 1024,
    })
  })

  test('mp4 / mov：跳过 mdat 找到文件尾的 moov，取第一条宽高非零的轨道；tkhd 两个版本都认', async () => {
    expect(await mediaSizeOf(await file('a.mp4', mp4(tkhd(1920, 1080))))).toEqual({
      w: 1920,
      h: 1080,
    })
    expect(await mediaSizeOf(await file('b.mov', mp4(tkhd(720, 1280, { version: 1 }))))).toEqual({
      w: 720,
      h: 1280,
    })
  })

  test('带 90° 旋转矩阵时宽高对调：手机竖拍按横向存', async () => {
    expect(
      await mediaSizeOf(await file('c.mp4', mp4(tkhd(1920, 1080, { rotated: true })))),
    ).toEqual({ w: 1080, h: 1920 })
  })

  test('读不出的回 null：头不对、截断、不认识的格式、不存在的文件', async () => {
    expect(await mediaSizeOf(await file('bad.png', new Uint8Array([1, 2, 3])))).toBeNull()
    expect(
      await mediaSizeOf(await file('cut.mp4', mp4(tkhd(1920, 1080)).subarray(0, 60))),
    ).toBeNull()
    expect(await mediaSizeOf(await file('a.webm', new Uint8Array(64)))).toBeNull()
    expect(await mediaSizeOf(join(tmpdir(), 'qywork-no-such-file.png'))).toBeNull()
  })
})
