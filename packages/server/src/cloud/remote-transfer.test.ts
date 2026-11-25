/**
 * 覆盖 `cloud/remote-transfer.ts` 中字体与其他文件的处理；JSON 的压缩与条件请求经隧道的装配测试覆盖（`tunnel.test.ts`）。
 *
 * 锁定的原始失败形状：远程打开 Word 文件时向手机下发 4 个主机字体共约 54 MB，按原字节经两段线路传输。
 */
import { expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { remoteTransfer } from './remote-transfer.ts'

const gzipRequest = new Request('http://127.0.0.1/api/fonts/file?name=x&id=y', {
  headers: { 'accept-encoding': 'gzip, deflate' },
})

/** 可压缩的字体字节：重复的表结构与字形数据。 */
const fontBytes = new Uint8Array(64 * 1024).map((_, i) => i % 97)

test('字体响应经 gzip 下发，保留按内容寻址的长期缓存，不加 etag', async () => {
  const cache = 'private, max-age=31536000, immutable'
  const res = await remoteTransfer(
    gzipRequest,
    new Response(fontBytes, { headers: { 'content-type': 'font/ttf', 'cache-control': cache } }),
  )
  expect(res.headers.get('content-encoding')).toBe('gzip')
  expect(res.headers.get('cache-control')).toBe(cache)
  expect(res.headers.get('etag')).toBeNull()
  const body = new Uint8Array(await res.arrayBuffer())
  expect(body.length).toBeLessThan(fontBytes.length / 2)
  expect(new Uint8Array(gunzipSync(body))).toEqual(fontBytes)
})

test('请求不接受 gzip 时字体按原字节下发', async () => {
  const res = await remoteTransfer(
    new Request('http://127.0.0.1/api/fonts/file?name=x&id=y'),
    new Response(fontBytes, { headers: { 'content-type': 'font/otf' } }),
  )
  expect(res.headers.get('content-encoding')).toBeNull()
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(fontBytes)
})

test('图片等其他文件原样返回', async () => {
  const original = new Response(fontBytes, { headers: { 'content-type': 'image/png' } })
  const res = await remoteTransfer(gzipRequest, original)
  expect(res).toBe(original)
})
