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
  })
  expect(movieMetadataOfFile(path)).toEqual({ duration: 12.5, pixels: { w: 1920, h: 1080 } })
})

test('文件不存在时为 null；不是 ISO 容器时时长与尺寸为 null，字节数有效', async () => {
  expect(videoMetaOf(join(tmpdir(), 'qy-video-meta-missing.mp4'))).toBeNull()
  const path = await file(
    'b.webm',
    new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(60).fill(0)]),
  )
  expect(videoMetaOf(path)).toEqual({ bytes: 64, seconds: null, size: null })
  expect(movieMetadataOfFile(path)).toBeNull()
})

test('文件被替换后重新读取，不返回缓存中的旧值', async () => {
  const path = await file('c.mp4', mp4Bytes(10, 1280, 720))
  expect(videoMetaOf(path)?.seconds).toBe(10)
  await writeFile(path, mp4Bytes(30, 640, 360, 8192))
  expect(videoMetaOf(path)).toEqual({ bytes: 8192, seconds: 30, size: { width: 640, height: 360 } })
})
