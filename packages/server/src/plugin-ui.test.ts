/**
 * 覆盖 `plugin-ui.ts`：已安装工作台的列出（只列能打开的页面）与页面文件服务（随机段、越界路径），
 * 以及 `api/plugins.ts` 中工作台调用接口在插件未加载、未声明工具、参数不合法时的结果。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireExtensions, releaseExtensions } from '@qywork/runtime'
import { handlePluginsApi } from './api/plugins.ts'
import type { ApiRequestDeps } from './api/types.ts'
import { listWorkbenches, servePluginUi } from './plugin-ui.ts'

let homeBefore: string | undefined
let plugins = ''

beforeEach(async () => {
  homeBefore = process.env.QYWORK_HOME
  const home = await mkdtemp(join(tmpdir(), 'qy-plugin-ui-'))
  process.env.QYWORK_HOME = home
  plugins = join(home, 'plugins')
  await mkdir(plugins, { recursive: true })
})

afterEach(() => {
  if (homeBefore === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = homeBefore
})

async function install(id: string, panels: unknown[], files: Record<string, string>) {
  const dir = join(plugins, id)
  await mkdir(dir, { recursive: true })
  const manifest = {
    manifestVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    description: '测试',
    permissions: [],
    contributes: { panels },
  }
  await writeFile(join(dir, 'qywork.plugin.json'), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true })
    await writeFile(join(dir, name), text)
  }
}

describe('工作台', () => {
  test('列出已安装的工作台；入口文件缺失的不列出', async () => {
    await install(
      'dev.demo',
      [
        { id: 'board', title: '看板', entry: 'ui/index.html' },
        { id: 'gone', title: '缺失', entry: 'ui/gone.html' },
      ],
      { 'ui/index.html': '<h1>看板</h1>' },
    )
    expect(await listWorkbenches('k1')).toEqual([
      {
        plugin: 'dev.demo',
        id: 'board',
        title: '看板',
        path: '/plugin-ui/k1/dev.demo/ui/index.html',
      },
    ])
  })

  test('提供页面文件；随机段不符、越界路径、不存在的文件返回 404', async () => {
    await install('dev.demo', [{ id: 'board', title: '看板', entry: 'ui/index.html' }], {
      'ui/index.html': '<h1>看板</h1>',
      'ui/app.js': 'console.log(1)',
    })
    await writeFile(join(plugins, 'secret.txt'), '不应读到')
    const ok = await servePluginUi('/plugin-ui/k1/dev.demo/ui/app.js', 'k1')
    expect(ok?.status).toBe(200)
    expect(ok?.headers.get('access-control-allow-origin')).toBe('*')
    expect(await ok?.text()).toBe('console.log(1)')
    expect((await servePluginUi('/plugin-ui/k2/dev.demo/ui/app.js', 'k1'))?.status).toBe(404)
    expect((await servePluginUi('/plugin-ui/k1/dev.demo/../secret.txt', 'k1'))?.status).toBe(404)
    expect((await servePluginUi('/plugin-ui/k1/dev.demo/%2e%2e/secret.txt', 'k1'))?.status).toBe(
      404,
    )
    expect((await servePluginUi('/plugin-ui/k1/dev.demo/ui/none.js', 'k1'))?.status).toBe(404)
    expect(await servePluginUi('/other', 'k1')).toBeNull()
  })

  test('调用接口：参数不合法 422，插件不存在或未声明该工具 404，安装晚于扩展加载时 409', async () => {
    const call = async (path: string, body: unknown) => {
      const url = new URL(`http://x${path}`)
      const req = new Request(url.href, { method: 'POST', body: JSON.stringify(body) })
      return handlePluginsApi(url, req, { workspaceRoot: plugins } as unknown as ApiRequestDeps)
    }
    // 先持有一份扩展：服务端对启动项目常驻持有，此后安装的插件不在这份扩展中。
    const lease = await acquireExtensions(plugins)
    try {
      await install('dev.demo', [], {})
      expect((await call('/api/plugins/dev.demo/call', { args: {} }))?.status).toBe(422)
      expect((await call('/api/plugins/dev.demo/call', { tool: 'x', args: [] }))?.status).toBe(422)
      expect((await call('/api/plugins/dev.none/call', { tool: 'x' }))?.status).toBe(404)
      const notLoaded = await call('/api/plugins/dev.demo/call', { tool: 'x' })
      expect(notLoaded?.status).toBe(409)
    } finally {
      await releaseExtensions(lease)
    }
    // 重新加载后插件在扩展中，但它没有声明该工具。
    expect((await call('/api/plugins/dev.demo/call', { tool: 'x' }))?.status).toBe(404)
  })
})
