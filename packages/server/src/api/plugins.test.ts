/**
 * 插件的两条**写**接口。
 *
 * 覆盖范围：`api/plugins.ts` 的 `/api/plugins/install` 与 `/api/plugins/<id>` DELETE。
 * `/api/plugins` GET 只是把 `loadExtensions` 的结果转出去，改坏了界面上立刻看得见，
 * 这里不测。
 *
 * 钉的是两条**安全边界**，它们只存在于代码里，没有任何检查挡着后续重构：
 *
 * - 装：目录里没有合法清单就必须拒绝。不拒绝的话，指错目录会「安装成功」，
 *   然后在下一次加载时变成一条 failure——那时候用户已经不记得自己指了哪里。
 *   同 id 再装一次必须回 409 而**不是覆盖**：覆盖会把用户改过的那一份直接抹掉。
 * - 删：id 来自 URL。这道闸一旦被绕过，这条路由就是一条任意目录删除。
 *   所以断言的不是状态码，是**插件目录外面的文件一个都没少**。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handlePluginsApi } from './plugins.ts'
import type { ApiRequestDeps } from './types.ts'

const dirs: string[] = []
const homeBefore = process.env.QYWORK_HOME

afterEach(async () => {
  if (homeBefore === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = homeBefore
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
})

/** 只用得到 `workspaceRoot` 一个字段，其余不造——造了就成了集成测试。 */
function call(path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handlePluginsApi(url, new Request(url.href, init), {
    workspaceRoot: '/nonexistent',
  } as unknown as ApiRequestDeps)
}

/** 把 `QYWORK_HOME` 指到一个临时目录，返回 `~/.qywork/plugins` 那一层。 */
async function home(): Promise<{ root: string; plugins: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-home-'))
  dirs.push(root)
  process.env.QYWORK_HOME = root
  const plugins = join(root, 'plugins')
  await mkdir(plugins, { recursive: true })
  return { root, plugins }
}

const MANIFEST = {
  manifestVersion: 1,
  id: 'demo-plugin',
  name: 'Demo',
  version: '0.0.1',
  description: '一个用来测边界的插件',
}

/** 造一个可以被装的源目录。`manifest` 传 null 表示故意不放清单。 */
async function source(manifest: unknown | null): Promise<string> {
  const src = await mkdtemp(join(tmpdir(), 'qywork-plugsrc-'))
  dirs.push(src)
  if (manifest !== null) {
    await writeFile(join(src, 'qywork.plugin.json'), JSON.stringify(manifest), 'utf8')
  }
  await writeFile(join(src, 'index.mjs'), '// noop\n', 'utf8')
  return src
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

describe('装一个插件', () => {
  test('不给路径回 400', async () => {
    await home()
    const res = await call('/api/plugins/install', { method: 'POST', body: JSON.stringify({}) })
    expect(res!.status).toBe(400)
  })

  test('目录里没有 qywork.plugin.json 就拒绝——不然装完才在加载时变成一条 failure', async () => {
    const { plugins } = await home()
    const res = await call('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ path: await source(null) }),
    })
    expect(res!.status).toBe(422)
    expect(await exists(join(plugins, 'demo-plugin'))).toBe(false)
  })

  test('清单不合法回 422，且什么都不落盘', async () => {
    const { plugins } = await home()
    const res = await call('/api/plugins/install', {
      method: 'POST',
      // id 只允许小写字母数字点横线下划线，大写和空格都不行。
      body: JSON.stringify({ path: await source({ ...MANIFEST, id: 'Bad Id' }) }),
    })
    expect(res!.status).toBe(422)
    expect(await exists(join(plugins, 'Bad Id'))).toBe(false)
  })

  test('装好之后目录里是源目录的内容', async () => {
    const { plugins } = await home()
    const res = await call('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ path: await source(MANIFEST) }),
    })
    expect(res!.status).toBe(200)
    expect(await readFile(join(plugins, 'demo-plugin', 'index.mjs'), 'utf8')).toBe('// noop\n')
  })

  test('同 id 再装一次回 409，**已经装好的那份原样不动**', async () => {
    const { plugins } = await home()
    await call('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ path: await source(MANIFEST) }),
    })
    // 装完之后用户改了它——覆盖会把这一行抹掉，而且没有任何提示。
    const installed = join(plugins, 'demo-plugin', 'index.mjs')
    await writeFile(installed, '// 用户改过的\n', 'utf8')

    const again = await call('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ path: await source(MANIFEST) }),
    })
    expect(again!.status).toBe(409)
    expect(await readFile(installed, 'utf8')).toBe('// 用户改过的\n')
  })
})

describe('删一个插件', () => {
  test('删得掉，删一个不存在的回 404', async () => {
    const { plugins } = await home()
    await mkdir(join(plugins, 'demo-plugin'), { recursive: true })

    expect((await call('/api/plugins/demo-plugin', { method: 'DELETE' }))!.status).toBe(200)
    expect(await exists(join(plugins, 'demo-plugin'))).toBe(false)
    expect((await call('/api/plugins/demo-plugin', { method: 'DELETE' }))!.status).toBe(404)
  })

  /*
   * 单独一段 `..` 到不了这里：`new URL()` 在解析阶段就把它连同上一段一起折掉
   * （`/api/plugins/..` → `/api/`），那条路由不匹配。反斜杠同理——WHATWG 对
   * 特殊 scheme 会把 `\` 归一成 `/`，因此变成两段、路由也不匹配。
   *
   * **留下来能到达处理器的是这两类**：id 里夹着 `..`（`..x` / `a..b`），
   * 以及百分号编码（`%2e%2e%2f`，pathname 不解码，它会原样进到 `join`）。
   * 断言分两层：夹着 `..` 的必须 400；两类都必须**没碰到插件目录外面的文件**。
   */
  test('id 里带 .. 的被拒，插件目录外面的文件一个都不会少', async () => {
    const { root, plugins } = await home()
    const sentinel = join(root, 'sentinel')
    await mkdir(sentinel, { recursive: true })
    await writeFile(join(sentinel, 'keep.txt'), 'keep', 'utf8')

    for (const id of ['..x', 'a..b', '%2e%2e%2fsentinel', '%2e%2e%5csentinel']) {
      const res = await call(`/api/plugins/${id}`, { method: 'DELETE' })
      if (id.includes('..') && !id.includes('%')) expect(res!.status).toBe(400)
      expect(await exists(join(sentinel, 'keep.txt'))).toBe(true)
    }
    // 插件目录本身也还在。
    expect(await exists(plugins)).toBe(true)
  })
})
