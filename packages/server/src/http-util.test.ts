/**
 * 覆盖范围：`http-util.ts` 的网页构建产物来源（`directoryAssets`、`embeddedAssets`）、`serveStatic`、
 * 网页来源 `fileSource` 与 `devServerSource`，以及 `server.ts` 经 `web` 选项提供页面的路径。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'
import { Store } from '@qywork/store'
import {
  devServerSource,
  directoryAssets,
  embeddedAssets,
  fileSource,
  serveStatic,
} from './http-util.ts'
import { serve } from './server.ts'

const INDEX = '<!doctype html><title>qywork</title>'
const SCRIPT = 'console.log(1)'

let dir = ''
/** 模拟编译产物中的嵌入文件：路径不带原扩展名，`Bun.file` 无法据此推断类型。 */
let embedded: Record<string, string> = {}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-http-util-'))
  await mkdir(join(dir, 'dist', 'assets'), { recursive: true })
  await writeFile(join(dir, 'dist', 'index.html'), INDEX)
  await writeFile(join(dir, 'dist', 'assets', 'app.js'), SCRIPT)
  await writeFile(join(dir, 'index-blob'), INDEX)
  await writeFile(join(dir, 'app-blob'), SCRIPT)
  embedded = { 'index.html': join(dir, 'index-blob'), 'assets/app.js': join(dir, 'app-blob') }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

test('嵌入的构建产物按相对路径的扩展名带 Content-Type', async () => {
  const web = embeddedAssets(embedded)
  const script = await serveStatic(web, '/assets/app.js')
  expect(script?.headers.get('content-type')).toStartWith('text/javascript')
  expect(await script?.text()).toBe(SCRIPT)
  const page = await serveStatic(web, '/')
  expect(page?.headers.get('content-type')).toStartWith('text/html')
})

test('未知路径回退到 index.html，供前端路由处理', async () => {
  for (const web of [embeddedAssets(embedded), directoryAssets(join(dir, 'dist'))]) {
    const res = await serveStatic(web, '/m')
    expect(res?.headers.get('content-type')).toStartWith('text/html')
    expect(await res?.text()).toBe(INDEX)
  }
})

test('含 .. 的路径不读取任何文件', async () => {
  expect(await serveStatic(directoryAssets(join(dir, 'dist')), '/../index-blob')).toBeNull()
})

test('没有 index.html 时返回 null', async () => {
  expect(await serveStatic(embeddedAssets({}), '/m')).toBeNull()
  expect(await serveStatic(directoryAssets(join(dir, 'missing')), '/m')).toBeNull()
})

test('服务按 web 选项向手机入口 /m 返回页面', async () => {
  const store = new Store({ path: join(dir, 'a.sqlite3') })
  const config: QyConfig = { providers: {}, mode: 'auto' }
  const handle = serve({
    store,
    config,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    web: fileSource(embeddedAssets(embedded)),
  })
  try {
    const page = await fetch(`http://127.0.0.1:${handle.port}/m`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toStartWith('text/html')
    expect(await page.text()).toBe(INDEX)
    const script = await fetch(`http://127.0.0.1:${handle.port}/assets/app.js`)
    expect(script.headers.get('content-type')).toStartWith('text/javascript')
  } finally {
    await handle.stop()
    store.close()
  }
})

test('开发服务器来源：路径与查询串原样转发并带上请求头，去掉压缩头；只转发 GET 与 HEAD；未运行时返回 502', async () => {
  const vite = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      return new Response(
        JSON.stringify({ path: `${url.pathname}${url.search}`, accept: req.headers.get('accept') }),
        { headers: { 'content-type': 'text/javascript', 'content-encoding': 'identity' } },
      )
    },
  })
  try {
    const web = devServerSource(`http://127.0.0.1:${vite.port}`)
    const url = new URL('http://device.example/src/app.css?import')
    const res = await web(url, new Request(url.href, { headers: { accept: 'text/css' } }))
    expect(res?.headers.get('content-type')).toBe('text/javascript')
    expect(res?.headers.get('content-encoding')).toBeNull()
    expect(await res?.json()).toEqual({ path: '/src/app.css?import', accept: 'text/css' })
    expect(await web(url, new Request(url.href, { method: 'POST', body: 'x' }))).toBeNull()
  } finally {
    vite.stop(true)
  }
  const down = devServerSource('http://127.0.0.1:9')
  const url = new URL('http://device.example/')
  expect((await down(url, new Request(url.href)))?.status).toBe(502)
})
