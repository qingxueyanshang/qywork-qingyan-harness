/**
 * 覆盖范围：`transfer/idle.ts`（下载与上传按进展计时：持续传输超过静默上限不中止，完全停滞时以 `TransferStalled` 中止；
 * multipart 编码的长度、字段与文件名与运行时的解析一致，文件按块读取）。
 */

import { afterAll, expect, test } from 'bun:test'
import { fetchWithIdle, formFields, multipartBody, TransferStalled } from './idle.ts'

const MB = 1024 * 1024
let mode: 'slow-down' | 'stall-down' | 'slow-up' | 'stall-up' | 'echo' = 'echo'

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    if (mode === 'slow-down') {
      // 每 150 ms 发 64 KB，共 1.5 秒：长于静默上限，但数据一直在到达。
      let n = 0
      return new Response(
        new ReadableStream({
          async pull(c) {
            if (n++ >= 10) return c.close()
            await Bun.sleep(150)
            c.enqueue(new Uint8Array(64 * 1024))
          },
        }),
      )
    }
    if (mode === 'stall-down') {
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new Uint8Array(1024))
          },
        }),
      )
    }
    if (mode === 'slow-up') {
      const reader = req.body!.getReader()
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.byteLength
        // 前一半慢读，总时长长于静默上限；后一半快读：缓冲中剩余的内容排空时客户端不再读取请求流，排空须快于静默上限。
        if (got < 8 * MB) await Bun.sleep(30)
      }
      return Response.json({ got })
    }
    if (mode === 'stall-up') {
      await Bun.sleep(60_000)
      return new Response('late')
    }
    const form = await req.formData()
    const out: Record<string, unknown> = { length: req.headers.get('content-length') }
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') out[k] = v
      else out[k] = [...((out[k] as unknown[]) ?? []), { name: v.name, type: v.type, size: v.size }]
    }
    return Response.json(out)
  },
})

afterAll(() => server.stop(true))
const url = `http://127.0.0.1:${server.port}/`

test('下载持续有数据时不中止，即使总时长超过静默上限', async () => {
  mode = 'slow-down'
  const res = await fetchWithIdle(url, {}, 600)
  expect((await res.arrayBuffer()).byteLength).toBe(10 * 64 * 1024)
})

test('下载中途停滞时以 TransferStalled 中止', async () => {
  mode = 'stall-down'
  const res = await fetchWithIdle(url, {}, 300)
  const err = await res.arrayBuffer().catch((e: unknown) => e)
  expect(err).toBeInstanceOf(TransferStalled)
  expect((err as Error).message).toBe('传输中断：连续 0 秒没有进展')
})

test('上传持续有进展时不中止；服务端不读取时以 TransferStalled 中止', async () => {
  mode = 'slow-up'
  const big = new Uint8Array(16 * MB)
  const form = new FormData()
  form.append('file', new Blob([big]), 'a.bin')
  const up = multipartBody(formFields(form))
  const res = await fetchWithIdle(
    url,
    {
      method: 'POST',
      headers: { 'content-type': up.contentType, 'content-length': String(up.length) },
      body: up.body,
    },
    2000,
  )
  expect(((await res.json()) as { got: number }).got).toBe(up.length)

  mode = 'stall-up'
  const stalled = multipartBody(formFields(form))
  const err = await fetchWithIdle(
    url,
    {
      method: 'POST',
      headers: { 'content-type': stalled.contentType, 'content-length': String(stalled.length) },
      body: stalled.body,
    },
    500,
  ).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(TransferStalled)
})

test('multipart 编码：长度与实际字节一致，字段与文件按运行时的解析取回，文件名按表单编码写出', async () => {
  mode = 'echo'
  const up = multipartBody([
    { name: 'body', value: '正文' },
    {
      name: 'files',
      filename: '登录 "失败"\n100%.png',
      type: 'image/png',
      file: new Blob([new Uint8Array(3)]),
    },
    { name: 'files', filename: 'idle.test.ts', file: Bun.file(import.meta.path) },
  ])
  const res = await fetchWithIdle(
    url,
    {
      method: 'POST',
      headers: { 'content-type': up.contentType, 'content-length': String(up.length) },
      body: up.body,
    },
    5000,
  )
  const got = (await res.json()) as Record<string, unknown>
  expect(got.length).toBe(String(up.length))
  expect(got.body).toBe('正文')
  // 文件名按表单编码写出：`"`、LF 写为 `%22`、`%0A`，其余原样。运行时的解析不还原这三个，云端的解析还原。
  expect(got.files).toEqual([
    { name: '登录 %22失败%22%0A100%.png', type: 'image/png', size: 3 },
    { name: 'idle.test.ts', type: expect.any(String), size: Bun.file(import.meta.path).size },
  ])
})
