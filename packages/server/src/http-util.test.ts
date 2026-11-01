/**
 * 覆盖范围：`http-util.ts` 的网页构建产物来源（`directoryAssets`、`embeddedAssets`）与 `serveStatic`，
 * 以及 `server.ts` 经 `web` 选项提供页面的路径。
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'
import { Store } from '@qywork/store'
import { directoryAssets, embeddedAssets, serveStatic } from './http-util.ts'
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
    web: embeddedAssets(embedded),
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
