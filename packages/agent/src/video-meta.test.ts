/** 覆盖范围：`video-meta.ts` 的 `videoMetaOf` 与 `movieMetadataOfFile`。 */

import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4Bytes } from './mp4.test-helper.ts'
import { movieMetadataOfFile, videoMetaOf } from './video-meta.ts'

async function file(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-video-meta-'))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

test('读取位于文件末尾的 moov：字节数、时长与画面尺寸', async () => {
  const path = await file('a.mp4', mp4Bytes(12.5, 1920, 1080, 200_000))
  expect(videoMetaOf(path)).toEqual({
    bytes: 200_000,
    seconds: 12.5,
    size: { width: 1920, height: 1080 },
    audio: false,
  })
  expect(movieMetadataOfFile(path)).toEqual({
    duration: 12.5,
    pixels: { w: 1920, h: 1080 },
    audio: false,
  })
})

test('有声音轨时 audio 为 true；声音轨在画面轨之前时画面尺寸照常读出', async () => {
  const path = await file('s.mp4', mp4Bytes(4, 1280, 720, 4096, true))
  expect(videoMetaOf(path)).toMatchObject({
    seconds: 4,
    size: { width: 1280, height: 720 },
    audio: true,
  })
})

test('文件不存在时为 null；不是 ISO 容器时时长与尺寸为 null，字节数有效', async () => {
  expect(videoMetaOf(join(tmpdir(), 'qy-video-meta-missing.mp4'))).toBeNull()
  const path = await file(
    'b.webm',
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0)]),
  )
  expect(videoMetaOf(path)).toEqual({ bytes: 64, seconds: null, size: null, audio: false })
  expect(movieMetadataOfFile(path)).toBeNull()
})

test('文件被替换后重新读取，不返回缓存中的旧值', async () => {
  const path = await file('c.mp4', mp4Bytes(10, 1280, 720))
  expect(videoMetaOf(path)?.seconds).toBe(10)
  await writeFile(path, mp4Bytes(30, 640, 360, 8192))
  expect(videoMetaOf(path)).toEqual({
    bytes: 8192,
    seconds: 30,
    size: { width: 640, height: 360 },
    audio: false,
  })
})

/** EBML 元素：`id` 按原样写入（含长度标记），大小为 1 字节变长整数（载荷小于 127 字节）。 */
function ebml(id: number[], ...payload: number[][]): number[] {
  const body = payload.flat()
  return [...id, 0x80 | body.length, ...body]
}

test('Matroska 按文件开头的标识字节识别，不按扩展名：时长与像素宽高照常读出', async () => {
  const duration = new Uint8Array(8)
  new DataView(duration.buffer).setFloat64(0, 4_040)
  const bytes = [
    ...ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d])),
    ...ebml(
      [0x18, 0x53, 0x80, 0x67],
      ebml(
        [0x15, 0x49, 0xa9, 0x66],
        ebml([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
        ebml([0x44, 0x89], [...duration]),
      ),
      ebml(
        [0x16, 0x54, 0xae, 0x6b],
        ebml(
          [0xae],
          ebml([0x83], [1]),
          ebml([0xe0], ebml([0xb0], [0x05, 0x00]), ebml([0xba], [0x02, 0xd0])),
        ),
      ),
    ),
  ]
  const path = await file('d.mp4', new Uint8Array(bytes))
  expect(videoMetaOf(path)).toEqual({
    bytes: bytes.length,
    seconds: 4.04,
    size: { width: 1280, height: 720 },
    audio: false,
  })
})
