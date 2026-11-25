/**
 * 覆盖 `http.ts` 的 `download` 在运行上下文给出 `download` 选项时的续传与进度（`claimPartial`、`receiver`、`contentRange`）：
 * 中途断线后自动续传只请求剩余字节、停止后再次下载同一地址从断点继续、文件已变化或服务器不支持分段时从头下载、
 * 进度回报与完成后删除临时文件。服务器为本机接口，不调用付费接口。
 */
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { download, reportingRetries } from './http.ts'

const SIZE = 300 * 1024
const content = new Uint8Array(SIZE).map((_, i) => (i * 31 + 7) % 251)
let etag = '"v1"'
let ranges = true
/** 设置时，下一次完整或分段答复在发出该字节数之后断开连接。 */
let dropAfter: number | null = null
let requests: { range: string | null; ifRange: string | null }[] = []

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const range = req.headers.get('range')
    const ifRange = req.headers.get('if-range')
    requests.push({ range, ifRange })
    let start = 0
    const m = /^bytes=(\d+)-$/.exec(range ?? '')
    if (ranges && m && (!ifRange || ifRange === etag)) start = Number(m[1])
    const body = content.slice(start)
    const limit = dropAfter
    dropAfter = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (limit === null) {
          controller.enqueue(body)
          controller.close()
          return
        }
        controller.enqueue(body.slice(0, limit))
        setTimeout(() => controller.error(new Error('连接中断')), 20)
      },
    })
    const headers: Record<string, string> = {
      'content-type': 'video/mp4',
      'content-length': String(body.length),
      ...(ranges ? { etag, 'accept-ranges': 'bytes' } : {}),
    }
    if (start > 0) headers['content-range'] = `bytes ${start}-${SIZE - 1}/${SIZE}`
    return new Response(stream, { status: start > 0 ? 206 : 200, headers })
  },
})
afterAll(() => server.stop(true))

const url = () => `http://127.0.0.1:${server.port}/v1/media/jobs/mj_1/files/0`
let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-download-'))
  etag = '"v1"'
  ranges = true
  dropAfter = null
  requests = []
})

const same = (bytes: Uint8Array) => bytes.length === SIZE && bytes.every((b, i) => b === content[i])

/**
 * 原始失败形状：41 MB 的成片下载中途中断，再次取回时从头下载，三次都没有下载完成。
 */
test('下载中途断线后自动重试，只请求剩余部分并带上校验标识，结果与原文件一致', async () => {
  dropAfter = 100 * 1024
  const progress: [number, number | null][] = []
  const file = await reportingRetries(
    { download: { dir, onProgress: (r, t) => progress.push([r, t]) } },
    () => download(url(), new AbortController().signal),
  )
  expect(same(file.bytes)).toBe(true)
  expect(requests).toEqual([
    { range: null, ifRange: null },
    { range: `bytes=${100 * 1024}-`, ifRange: '"v1"' },
  ])
  expect(progress.at(-1)).toEqual([SIZE, SIZE])
  expect(await readdir(dir)).toEqual([])
})

test('停止后保留已下载的部分，再次下载同一地址从断点继续', async () => {
  const stop = new AbortController()
  dropAfter = 120 * 1024
  const first = reportingRetries(
    {
      download: {
        dir,
        onProgress: (received) => {
          if (received >= 120 * 1024) stop.abort(new Error('用户停止'))
        },
      },
    },
    () => download(url(), stop.signal),
  )
  await expect(first).rejects.toThrow('用户停止')
  expect((await readdir(dir)).sort()).toHaveLength(2)

  const again = await reportingRetries({ download: { dir } }, () =>
    download(url(), new AbortController().signal),
  )
  expect(same(again.bytes)).toBe(true)
  expect(requests.at(-1)).toEqual({ range: `bytes=${120 * 1024}-`, ifRange: '"v1"' })
  expect(await readdir(dir)).toEqual([])
})

test('服务器上的文件已变化时按完整答复从头写入，不拼接两个文件', async () => {
  dropAfter = 100 * 1024
  const stop = new AbortController()
  await reportingRetries(
    { download: { dir, onProgress: (r) => r >= 100 * 1024 && stop.abort(new Error('停止')) } },
    () => download(url(), stop.signal),
  ).catch(() => {})
  etag = '"v2"'
  const file = await reportingRetries({ download: { dir } }, () =>
    download(url(), new AbortController().signal),
  )
  expect(same(file.bytes)).toBe(true)
  expect(requests.at(-1)).toEqual({ range: `bytes=${100 * 1024}-`, ifRange: '"v1"' })
})

test('服务器不支持分段下载时从头下载', async () => {
  ranges = false
  dropAfter = 100 * 1024
  const file = await reportingRetries({ download: { dir } }, () =>
    download(url(), new AbortController().signal),
  )
  expect(same(file.bytes)).toBe(true)
  // 没有校验标识时不发分段请求：无法确认已下载的部分仍属于同一个文件。
  expect(requests).toEqual([
    { range: null, ifRange: null },
    { range: null, ifRange: null },
  ])
})

test('没有临时文件目录时在内存中下载，同样回报进度', async () => {
  const progress: number[] = []
  const file = await reportingRetries({ download: { onProgress: (r) => progress.push(r) } }, () =>
    download(url(), new AbortController().signal),
  )
  expect(same(file.bytes)).toBe(true)
  expect(progress.at(-1)).toBe(SIZE)
})
