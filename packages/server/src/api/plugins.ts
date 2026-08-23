/**
 * 插件。
 *
 * ## 只有全局一个目录
 *
 * `~/.qywork/plugins/`。插件贡献的是工具、预览器、供应商——那些是这个 agent 的
 * 能力，不是某个仓库的内容。所以它不分层，接口上也就没有 `scope` 参数：
 * 装一次对所有项目生效。「这个项目要不要加载某个插件」是开关，不是第二份拷贝。
 *
 * 页面叫「插件」，**不叫市场**。这个项目没有中心 registry，也不该现造一个：
 * 一个叫「市场」而里面没有任何可安装内容的页面，就是把这次要删的空壳
 * 换个名字再造一遍（ROADMAP §34.3）。
 *
 * 数据源与 `qy plugins` 完全相同（loadExtensions），所以 CLI 与界面不会
 * 对「装了什么、隔离到什么程度」给出两种答案。
 *
 * 失败项与成功项一起回：装失败的插件恰恰是用户最需要看到的那部分，
 * 只回成功的会让「我明明放进去了怎么没有」无从查起。
 */

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { globalPluginsDir } from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

/**
 * 读一个插件目录的清单摘要。**只看不装。**
 *
 * 两个调用方：这个文件里的安装接口（用户点导入），以及模型那条装插件工具的端口
 * （`plugin-port.ts`）。两处各写一份的话，迟早在「同 id 怎么办」这种问题上
 * 给出两种答案。
 */
export async function readPluginDir(src: string): Promise<{
  ok: boolean
  error?: string
  id?: string
  name?: string
  version?: string
  tools?: string[]
  permissions?: string[]
  replacing?: boolean
}> {
  const manifestPath = join(src, 'qywork.plugin.json')
  const raw = await readFile(manifestPath, 'utf8').catch(() => null)
  if (raw === null) return { ok: false, error: `目录里没有 qywork.plugin.json：${src}` }
  try {
    const { parseManifest } = await import('@qywork/plugins')
    const m = parseManifest(JSON.parse(raw), manifestPath)
    return {
      ok: true,
      id: m.id,
      name: m.name,
      version: m.version,
      tools: (m.contributes.tools ?? []).map((t) => t.name),
      permissions: m.permissions,
      replacing: (await stat(join(globalPluginsDir(), m.id)).catch(() => null)) !== null,
    }
  } catch (e) {
    return { ok: false, error: `清单不合法：${(e as Error).message}` }
  }
}

/** 把校验过的目录复制进全局插件目录。调用方负责先问过用户。 */
export async function copyPluginDir(
  src: string,
  id: string,
  opts: { replace: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const dest = join(globalPluginsDir(), id)
  const exists = (await stat(dest).catch(() => null)) !== null
  if (exists && !opts.replace) return { ok: false, error: `已经装了同名插件 ${id}` }
  // 源目录就是目标目录时直接返回：那说明指的是已经装好的那一个。
  if (resolve(src) === resolve(dest)) return { ok: true }
  // 覆盖前先删干净：`cp` 不会移走旧版本多出来的文件，混着的两份代码比哪一份都糟。
  if (exists) await rm(dest, { recursive: true, force: true })
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
  return { ok: true }
}

export const handlePluginsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/plugins') {
    const { loadExtensions } = await import('@qywork/runtime')
    const ext = await loadExtensions(d.workspaceRoot)
    const reg = ext.plugins
    return json({
      dir: globalPluginsDir(),
      plugins: reg.plugins.map((pl) => {
        const rt = pl.host?.runtime
        return {
          id: pl.manifest.id,
          name: pl.manifest.name,
          version: pl.manifest.version,
          permissions: pl.manifest.permissions ?? [],
          tools: reg.toolSpecs
            .filter((t) => t.name.startsWith(`${pl.manifest.id}__`))
            .map((t) => ({ name: t.name, description: t.description })),
          // 纯声明式插件没有进程，也就无所谓隔离。这三种状态必须分开报——
          // 把「不适用」显示成「无隔离」会让人以为出了安全问题。
          process: !pl.host ? 'declarative' : rt ? 'running' : 'unknown',
          ...(rt ? { sandboxed: rt.sandboxed, netGuarded: rt.netGuarded, note: rt.note } : {}),
        }
      }),
      failures: reg.failures.map((f) => ({ dir: f.dir, reason: f.reason })),
    })
  }

  // 安装 / 卸载插件。
  //
  // ## 「安装」只有一种形式：把一个目录放进某一层的 plugins/
  //
  // 没有中心 registry，所以没有「从市场安装」。来源只能是**本机已经存在的目录**——
  // 用户先自己 clone 或下载，看过内容，再指给这里。
  //
  // **刻意不做 `git clone <任意 URL>`**：那等于「从网上取一段代码，下一次加载就跑它」。
  // 插件确实跑在沙箱里，但沙箱管的是它能碰什么，不管它是不是你想要的东西。
  // 少这一步的代价只是用户多敲一条 git 命令，而多这一步的代价是这个入口
  // 变成一条 `curl | sh`。同样的结果照样能达成，只是中间多一次「你看到了自己装的是什么」。
  //
  // ## 装之前必须校验清单
  //
  // 目录里没有合法的 `qywork.plugin.json` 就直接拒绝。不校验的话，
  // 指错目录会「安装成功」然后在下一次加载时变成一条 failure——
  // 而那时候用户已经不记得自己指了哪里。
  if (p === '/api/plugins/install' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string } | null
    const src = body?.path?.trim()
    if (!src) return json({ error: 'bad request', message: '缺少目录路径' }, 400)

    const found = await readPluginDir(src)
    if (!found.ok) return json({ error: 'invalid', message: found.error }, 422)
    // 已经装过同 id 的就拒绝，而不是静默覆盖：覆盖会把用户可能改过的
    // 那一份直接抹掉，且没有任何提示。要换版本先卸载。
    if (found.replacing) {
      return json({ error: 'conflict', message: `已经装了同名插件 ${found.id}，请先卸载` }, 409)
    }
    const done = await copyPluginDir(src, found.id!, { replace: false })
    if (!done.ok) return json({ error: 'invalid', message: done.error }, 422)
    return json({ ok: true, id: found.id })
  }

  const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(p)
  if (pluginMatch && req.method === 'DELETE') {
    const id = pluginMatch[1]!
    // id 来自 URL，必须挡住 `..` 之类——否则这就是一条任意目录删除。
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      return json({ error: 'bad request' }, 400)
    }
    const target = join(globalPluginsDir(), id)
    if (!(await stat(target).catch(() => null))) return json({ error: 'not found' }, 404)
    await rm(target, { recursive: true, force: true })
    return json({ ok: true })
  }

  return null
}
