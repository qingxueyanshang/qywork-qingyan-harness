/**
 * 覆盖 `media-jobs.ts` 与 `media-worker.ts`：缩小图片与字体的哈希、字节在计算线程中得到与主线程实现相同的结果；
 * 缩小结果按路径与修改时间缓存，文件改写后重新计算；字体哈希按修改时间与大小缓存。
 *
 * 锁定的原始失败形状：电脑端服务同时缩小 6 张大图时，普通请求一次停顿 1216 ms（缩小在主线程执行）。
 * 主线程是否停顿由 `.tmp/remote-probe/cpu-block.ts` 实测（改动后 0–5 ms），此处锁定结果与缓存。
 */

import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { imageSizeOf } from '@qywork/core'
import { imageAtWidth } from '@qywork/tools/image'
import { faceDigest, faceFile, scaledImage } from './media-jobs.ts'

/** `width`×`height` 的不透明灰阶 PNG，像素为噪声。 */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array((width + 1) * height)
  let seed = 7
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    raw[i] = i % (width + 1) === 0 ? 0 : seed >>> 24
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length)
    body.set(new TextEncoder().encode(type), 0)
    body.set(data, 4)
    const out = new Uint8Array(12 + data.length)
    const v = new DataView(out.buffer)
    v.setUint32(0, data.length)
    out.set(body, 4)
    v.setUint32(8 + data.length, Bun.hash.crc32(body))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, width)
  new DataView(ihdr.buffer).setUint32(4, height)
  ihdr.set([8, 0, 0, 0, 0], 8)
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

test('缩小图片的结果与主线程实现相同，按修改时间缓存，文件改写后重新计算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-media-'))
  const path = join(dir, 'a.png')
  await writeFile(path, png(400, 200))
  const first = await scaledImage(path, 'image/png', 100)
  const expected = await imageAtWidth(png(400, 200), 'image/png', 100)
  expect(first.mime).toBe(expected.mime)
  expect(imageSizeOf(first.bytes)).toEqual({ width: 100, height: 50 })
  expect(await scaledImage(path, 'image/png', 100)).toBe(first)

  await writeFile(path, png(300, 300))
  await utimes(path, new Date(), new Date(Date.now() + 5000))
  const rewritten = await scaledImage(path, 'image/png', 100)
  expect(rewritten).not.toBe(first)
  expect(imageSizeOf(rewritten.bytes)).toEqual({ width: 100, height: 100 })
})

test('字体的哈希与字节取自计算线程：单个字体文件按原字节，哈希为其 SHA-256', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-media-'))
  const path = join(dir, 'x.ttf')
  // 只需 sfnt 表目录：单个字体文件原样返回，不解析表内容。
  const bytes = new Uint8Array(12)
  new DataView(bytes.buffer).setUint32(0, 0x00010000)
  await writeFile(path, bytes)
  const digest = await faceDigest({ path, index: 0 })
  expect(digest).toBe(
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  )
  expect(await faceDigest({ path, index: 0 })).toBe(digest)
  expect(await faceFile({ path, index: 0 }, null)).toEqual(bytes)
})
