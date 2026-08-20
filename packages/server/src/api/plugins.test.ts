/**
 * 「新建插件」落下去的那份骨架**必须真的能加载**。
 *
 * 覆盖范围：`api/plugins.ts` 的 `/api/plugins/new`。
 *
 * 这条测试是被一次真实的错误逼出来的：骨架第一版把工具的 `permissionEffect` 写成
 * `internal_control`（那是内置工具的档，插件清单不认），于是新建出来的插件在
 * `qy plugins` 里直接是一条红色 failure。**光校验清单结构不够**——要的是
 * 「装完之后它出现在工具表里」，所以这里真的跑一遍加载，起那个子进程。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExtensions } from '@qywork/runtime'
import { handlePluginsApi } from './plugins.ts'
import type { ApiRequestDeps } from './types.ts'

const dirs: string[] = []
const homeBefore = process.env.QYWORK_HOME

afterEach(async () => {
  if (homeBefore === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = homeBefore
  // **删失败不算测试失败。** Windows 上插件子进程刚被 kill 掉时文件句柄还没释放，
  // `rm` 会拿到 EBUSY；那是收尾的事，不是被测行为。留在 %TEMP% 里由系统清。
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 只用得到 `workspaceRoot` 一个字段，其余不造——造了就成了集成测试。 */
function call(root: string, path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handlePluginsApi(url, new Request(url.href, init), {
    workspaceRoot: root,
  } as unknown as ApiRequestDeps)
}

describe('新建插件', () => {
  test('落下去的骨架能被加载，工具进得了工具表', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-newplug-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'qywork-newplug-home-'))
    dirs.push(root, home)
    process.env.QYWORK_HOME = home

    const res = await call(root, '/api/plugins/new', {
      method: 'POST',
      body: JSON.stringify({ id: 'demo.hello', name: '打招呼', description: '把参数原样返回' }),
    })
    expect(res?.status).toBe(200)

    const ext = await loadExtensions(root)
    try {
      // failures 非空就说明骨架自己不合格——那正是这条测试要挡的东西，
      // 所以把原因一起断言出来，红的时候不用再去翻日志。
      expect(ext.plugins.failures.map((f) => f.reason)).toEqual([])
      expect(ext.plugins.plugins.map((p) => p.manifest.id)).toEqual(['demo.hello'])
      // 注册名是消毒过的：`demo.hello` 里的点被换成下划线。
      expect(ext.toolSpecs.map((t) => t.name)).toContain('demo_hello__echo')
    } finally {
      ext.stop()
    }
  })

  test('同 id 再建一次回 409，不覆盖已经写过的代码', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-newplug-dup-'))
    const home = await mkdtemp(join(tmpdir(), 'qywork-newplug-duphome-'))
    dirs.push(root, home)
    process.env.QYWORK_HOME = home

    const body = JSON.stringify({ id: 'demo.hello', name: 'x', description: 'y' })
    expect((await call(root, '/api/plugins/new', { method: 'POST', body }))?.status).toBe(200)
    expect((await call(root, '/api/plugins/new', { method: 'POST', body }))?.status).toBe(409)
  })

  test('带分隔符的 id 被拒——它同时是目录名和工具名前缀', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-newplug-bad-'))
    const home = await mkdtemp(join(tmpdir(), 'qywork-newplug-badhome-'))
    dirs.push(root, home)
    process.env.QYWORK_HOME = home

    for (const id of ['../escape', 'a/b', 'a\\b']) {
      const res = await call(root, '/api/plugins/new', {
        method: 'POST',
        body: JSON.stringify({ id, name: 'x', description: 'y' }),
      })
      expect(res?.status).toBe(422)
    }
  })
})
