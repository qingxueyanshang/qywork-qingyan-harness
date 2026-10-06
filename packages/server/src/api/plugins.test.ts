/**
 * 插件的两个写接口。
 *
 * 覆盖范围：`api/plugins.ts` 的 `/api/plugins/install`、`/api/plugins/<id>` DELETE，
 * 以及 GET 使用的投影 `pluginRows`。GET 本身只转发共享扩展，此处不启动子进程。
 *
 * 锁定两条安全边界，它们只存在于代码中，没有其他检查防止后续重构破坏它们：
 *
 * - 安装：目录中没有合法清单时必须拒绝。不拒绝时，指定了错误的目录会报告安装成功，
 *   随后在下一次加载时成为一条 failure，而此时用户已无法回忆所指定的路径。
 *   同一 id 再次安装必须返回 409，不能覆盖：覆盖会直接抹掉用户修改过的文件。
 * - 删除：id 来自 URL。该检查一旦被绕过，该路由即构成任意目录删除。
 *   因此断言的不是状态码，而是插件目录以外的文件全部保留。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginRegistry } from '@qywork/plugins'
import { handlePluginsApi, pluginRows } from './plugins.ts'
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

/** 只需要 `workspaceRoot` 一个字段，其余字段不构造：构造后即成为集成测试。 */
function call(path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handlePluginsApi(url, new Request(url.href, init), {
    workspaceRoot: '/nonexistent',
  } as unknown as ApiRequestDeps)
}

/** 把 `QYWORK_HOME` 指向临时目录，返回 `~/.qywork/plugins` 一层的路径。 */
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

/** 创建一个可安装的源目录。`manifest` 为 null 表示有意不放清单。 */
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

describe('安装插件', () => {
  test('未提供路径时返回 400', async () => {
    await home()
    const res = await call('/api/plugins/install', { method: 'POST', body: JSON.stringify({}) })
    expect(res!.status).toBe(400)
  })

  test('目录中没有 qywork.plugin.json 时拒绝，否则安装后在加载时才成为一条 failure', async () => {
    const { plugins } = await home()
    const res = await call('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ path: await source(null) }),
    })
    expect(res!.status).toBe(422)
    expect(await exists(join(plugins, 'demo-plugin'))).toBe(false)
  })

  test('清单不合法时返回 422，且不写入任何内容', async () => {
    const { plugins } = await home()
    const res = await call('/api/plugins/install', {
      method: 'POST',
      // id 只允许小写字母、数字、点、连字符与下划线，大写字母与空格均不允许。
      body: JSON.stringify({ path: await source({ ...MANIFEST, id: 'Bad Id' }) }),
    })
    expect(res!.status).toBe(422)
    expect(await exists(join(plugins, 'Bad Id'))).toBe(false)
  })

  test('安装后目录内容与源目录一致', async () => {
    const { plugins } = await home()
    const res = await call('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ path: await source(MANIFEST) }),
    })
    expect(res!.status).toBe(200)
    expect(await readFile(join(plugins, 'demo-plugin', 'index.mjs'), 'utf8')).toBe('// noop\n')
  })

  test('同一 id 再次安装返回 409，已安装的文件保持不变', async () => {
    const { plugins } = await home()
    await call('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ path: await source(MANIFEST) }),
    })
    // 安装后用户修改了文件：覆盖会抹掉这次修改，且没有任何提示。
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

describe('删除插件', () => {
  test('可以删除；删除不存在的插件返回 404', async () => {
    const { plugins } = await home()
    await mkdir(join(plugins, 'demo-plugin'), { recursive: true })

    expect((await call('/api/plugins/demo-plugin', { method: 'DELETE' }))!.status).toBe(200)
    expect(await exists(join(plugins, 'demo-plugin'))).toBe(false)
    expect((await call('/api/plugins/demo-plugin', { method: 'DELETE' }))!.status).toBe(404)
  })

  /*
   * 单独一段 `..` 无法到达处理器：`new URL()` 在解析阶段将它与上一段一并消去
   * （`/api/plugins/..` → `/api/`），路由不匹配。反斜杠同理：WHATWG 对
   * 特殊 scheme 会把 `\` 规范化为 `/`，因此变成两段，路由同样不匹配。
   *
   * 能够到达处理器的只有两类：id 中包含 `..`（`..x` / `a..b`），
   * 以及百分号编码（`%2e%2e%2f`，pathname 不解码，会原样传入 `join`）。
   * 断言分两层：包含 `..` 的必须返回 400；两类都不得访问插件目录以外的文件。
   */
  test('id 含 .. 的请求被拒绝，插件目录以外的文件全部保留', async () => {
    const { root, plugins } = await home()
    const sentinel = join(root, 'sentinel')
    await mkdir(sentinel, { recursive: true })
    await writeFile(join(sentinel, 'keep.txt'), 'keep', 'utf8')

    for (const id of ['..x', 'a..b', '%2e%2e%2fsentinel', '%2e%2e%5csentinel']) {
      const res = await call(`/api/plugins/${id}`, { method: 'DELETE' })
      if (id.includes('..') && !id.includes('%')) expect(res!.status).toBe(400)
      expect(await exists(join(sentinel, 'keep.txt'))).toBe(true)
    }
    // 插件目录本身同样保留。
    expect(await exists(plugins)).toBe(true)
  })
})

describe('插件页的投影', () => {
  /** 注册名经过规范化，id 中的点变为下划线；按原 id 拼接前缀会把工具数报告为 0。 */
  test('id 含点的插件同样能统计出自身的工具', () => {
    const reg = {
      plugins: [
        {
          manifest: { id: 'qywork.browser', name: '内置浏览器', version: '0.1.0', permissions: [] },
          dir: '/x',
          host: null,
        },
      ],
      previewers: new Map(),
      roles: new Map(),
      providers: new Map(),
      toolSpecs: [
        { name: 'qywork_browser__tabs', description: '标签页' },
        { name: 'other_plugin__go', description: '别家的' },
      ],
      failures: [],
    } as unknown as PluginRegistry
    const [row] = pluginRows(reg)
    expect(row!.tools).toEqual([{ name: 'qywork_browser__tabs', description: '标签页' }])
    expect(row!.process).toBe('declarative')
  })
})
