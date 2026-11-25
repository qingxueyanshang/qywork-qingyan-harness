/**
 * 覆盖 `pdf-source.ts`：按 `Content-Range` 取得文件长度；pdf.js 经分段读取打开文档，取得第一页时只读取了文件的一小部分，
 * 其余页面按请求继续读取；开头之后的读取失败转交 `fail`。
 *
 * 锁定的原始失败形状：经隧道的应答没有 `Content-Length`，把地址交给 pdf.js 时先整份下载再显示（9.9 MB 的文件首屏 13 秒）。
 * pdf.js 在测试中以进程内的 Worker 运行，解析逻辑与浏览器中相同。
 */

import { expect, test } from 'bun:test'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApiError } from '../../lib/client.ts'
import { pdfSource, type ReadRange, rangeReader } from './pdf-source.ts'

/**
 * `pages` 页的 PDF，每页的内容流 `contentBytes` 字节。页面对象集中在文件开头，内容流依次在其后，交叉引用表在文件末尾：
 * 页面对象分散在内容流之间时，pdf.js 为确定页数须读取每个页面对象。
 */
function pdfWith(pages: number, contentBytes: number): Uint8Array {
  const parts: string[] = ['%PDF-1.4\n']
  const offsets: number[] = []
  let length = parts[0]!.length
  const add = (body: string) => {
    offsets.push(length)
    const text = `${offsets.length} 0 obj\n${body}\nendobj\n`
    parts.push(text)
    length += text.length
  }
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`)
  for (let i = 0; i < pages; i++) {
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${300 + i} 400] /Contents ${3 + pages + i} 0 R >>`,
    )
  }
  let seed = 1
  for (let i = 0; i < pages; i++) {
    let content = ''
    while (content.length < contentBytes) {
      seed = (seed * 1103515245 + 12345) >>> 0
      content += `% ${seed.toString(36)}\n`
    }
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  }
  const xref = length
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  parts.push(
    `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  )
  return new TextEncoder().encode(parts.join(''))
}

/** 从内存读取，每次读取延迟 `delayMs`，记录读取的区间。 */
function memoryReader(file: Uint8Array, delayMs: number) {
  const reads: [number, number][] = []
  const read: ReadRange = async (begin, end) => {
    reads.push([begin, end])
    await new Promise((r) => setTimeout(r, delayMs))
    return { bytes: file.slice(begin, Math.min(end, file.length)), total: file.length }
  }
  const bytesRead = () => reads.reduce((n, [b, e]) => n + Math.min(e, file.length) - b, 0)
  return { read, reads, bytesRead }
}

test('分段应答的文件长度取自 Content-Range，整份应答取正文长度，其余状态与缺少长度时拒绝', async () => {
  const sent: (string | null)[] = []
  const reply = (res: Response) =>
    rangeReader(async (_path, init) => {
      sent.push(new Headers(init.headers).get('range'))
      return res
    }, '/api/files/raw?path=a.pdf&v=1')
  const partial = new Response(new Uint8Array(4), {
    status: 206,
    headers: { 'content-range': 'bytes 0-3/9896648' },
  })
  expect(await reply(partial)(0, 4)).toEqual({ bytes: new Uint8Array(4), total: 9896648 })
  expect(sent).toEqual(['bytes=0-3'])
  expect(await reply(new Response(new Uint8Array(7)))(0, 4)).toEqual({
    bytes: new Uint8Array(7),
    total: 7,
  })
  expect(reply(new Response('', { status: 416 }))(0, 4)).rejects.toBeInstanceOf(ApiError)
  expect(reply(new Response('', { status: 206 }))(0, 4)).rejects.toBeInstanceOf(ApiError)
})

test('文件不长于首段时以全部字节打开，只读取一次', async () => {
  const file = pdfWith(2, 100)
  const { read, reads } = memoryReader(file, 0)
  const from = await pdfSource(read, 64 * 1024, () => {})
  expect('data' in from).toBe(true)
  const doc = await getDocument({ ...from }).promise
  expect(doc.numPages).toBe(2)
  expect(reads).toEqual([[0, 64 * 1024]])
})

test('取得第一页时只读取了文件的一小部分，其余页面按请求继续读取', async () => {
  const chunk = 64 * 1024
  const file = pdfWith(40, chunk)
  const { read, reads, bytesRead } = memoryReader(file, 5)
  const failures: unknown[] = []
  const from = await pdfSource(read, chunk, (err) => failures.push(err))
  expect('range' in from).toBe(true)
  const task = getDocument({ ...from, rangeChunkSize: chunk })
  try {
    const doc = await task.promise
    const first = await doc.getPage(1)
    expect(first.getViewport({ scale: 1 }).width).toBe(300)
    expect(reads[0]).toEqual([0, chunk])
    expect(bytesRead()).toBeLessThan(file.length / 4)
    // 最后一页的内容流位于文件末尾之前，解析它须按请求读取该段。
    const last = await doc.getPage(40)
    expect(last.getViewport({ scale: 1 }).width).toBe(339)
    await last.getOperatorList()
    expect(failures).toEqual([])
  } finally {
    await task.destroy()
  }
})

test('首段之后的读取失败转交 fail', async () => {
  const chunk = 64 * 1024
  const file = pdfWith(8, chunk)
  const error = new ApiError(0, '/api/files/raw', '')
  const read: ReadRange = async (begin, end) => {
    if (begin > 0) throw error
    return { bytes: file.slice(begin, end), total: file.length }
  }
  const failures: unknown[] = []
  const from = await pdfSource(read, chunk, (err) => failures.push(err))
  // 不销毁：读取失败后 pdf.js 的加载一直等待，此时销毁会在其 Worker 中抛出「Worker was terminated」，进程内的 Worker 中
  // 表现为未处理的异常。
  getDocument({ ...from, rangeChunkSize: chunk }).promise.catch(() => {})
  for (let i = 0; i < 100 && failures.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(failures[0]).toBe(error)
})
