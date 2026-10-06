/**
 * 插件。
 *
 * **只有一个全局目录** `~/.qywork/plugins/`。插件提供的是工具、预览器与供应商，属于 agent
 * 的能力，不属于某个仓库的内容。因此插件不分层，接口上也没有 `scope` 参数：安装一次对所有项目生效。
 * 某个项目是否加载某个插件由开关决定，不复制第二份。
 *
 * 页面名为「插件」，不叫「市场」。本项目没有中心 registry，也不应另建一个：
 * 名为「市场」而没有任何可安装内容的页面，只是换了名称的空壳。
 *
 * 数据源与 `qy plugins` 相同（loadExtensions），因此 CLI 与界面对已安装的插件
 * 及其隔离程度不会给出两种答案。
 *
 * 失败项与成功项一并返回：安装失败的插件是用户最需要看到的部分，
 * 只返回成功项时，放入目录后未出现的问题无从排查。
 */

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { PluginRegistry } from '@qywork/plugins'
import { globalPluginsDir, pluginToolPrefix } from '@qywork/runtime'
import { type ApiHandler, json } from './types.ts'

export interface PluginRow {
  id: string
  name: string
  version: string
  permissions: string[]
  tools: { name: string; description: string }[]
  /** 纯声明式插件没有进程，不涉及隔离。三种状态分开上报：把「不适用」显示为「无隔离」会被理解为安全问题。 */
  process: 'declarative' | 'running' | 'unknown'
  sandboxed?: boolean
  netGuarded?: boolean
  note?: string
}

/**
 * 将注册表投影为插件页的行。
 *
 * 工具归属按 `pluginToolPrefix` 判定，不要写成 `${id}__`：注册名经过规范化，
 * `qywork.browser` 的工具名为 `qywork_browser__tabs`，按原 id 拼接前缀无法匹配任何工具。
 */
export function pluginRows(reg: PluginRegistry): PluginRow[] {
  return reg.plugins.map((pl) => {
    const rt = pl.host?.runtime
    const prefix = pluginToolPrefix(pl.manifest.id)
    return {
      id: pl.manifest.id,
      name: pl.manifest.name,
      version: pl.manifest.version,
      permissions: pl.manifest.permissions ?? [],
      tools: reg.toolSpecs
        .filter((t) => t.name.startsWith(prefix))
        .map((t) => ({ name: t.name, description: t.description })),
      process: !pl.host ? 'declarative' : rt ? 'running' : 'unknown',
      ...(rt ? { sandboxed: rt.sandboxed, netGuarded: rt.netGuarded, note: rt.note } : {}),
    }
  })
}

/**
 * 读取插件目录的清单摘要，只读取，不安装。
 *
 * 两个调用方：本文件的安装接口（用户点击导入），以及模型安装插件工具使用的端口
 * （`plugin-port.ts`）。两处各写一份时，终将在同一 id 如何处理等问题上给出不同的答案。
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
  if (raw === null) return { ok: false, error: `目录中没有 qywork.plugin.json：${src}` }
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

/** 把校验过的目录复制到全局插件目录。调用方负责事先征得用户同意。 */
export async function copyPluginDir(
  src: string,
  id: string,
  opts: { replace: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const dest = join(globalPluginsDir(), id)
  const exists = (await stat(dest).catch(() => null)) !== null
  if (exists && !opts.replace) return { ok: false, error: `已安装同名插件 ${id}` }
  // 源目录即目标目录时直接返回：说明指定的是已安装的插件。
  if (resolve(src) === resolve(dest)) return { ok: true }
  // 覆盖前先完整删除：`cp` 不会移除旧版本中多出的文件，两个版本的代码混在一起比任一版本都更糟。
  if (exists) await rm(dest, { recursive: true, force: true })
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest, { recursive: true })
  return { ok: true }
}

export const handlePluginsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/plugins') {
    /*
     * 使用引用计数，与 release 配对，与 `/api/tools` 相同：直接调用 `loadExtensions` 会为每次请求
     * 启动一批新的插件与 MCP 子进程且无人关闭。返回的必须是模型持有的同一份扩展：
     * 另行启动一份时，卡片上的隔离状态与连接状态可能与模型实际使用的不一致。
     */
    const { acquireExtensions, releaseExtensions } = await import('@qywork/runtime')
    const ext = await acquireExtensions(d.workspaceRoot)
    try {
      return json({
        dir: globalPluginsDir(),
        plugins: pluginRows(ext.plugins),
        failures: ext.plugins.failures.map((f) => ({ dir: f.dir, reason: f.reason })),
      })
    } finally {
      await releaseExtensions(ext)
    }
  }

  // 安装与卸载插件。
  //
  // 安装只有一种形式：把一个目录复制到全局插件目录。
  // 没有中心 registry，因此没有「从市场安装」。来源只能是本机已存在的目录：
  // 用户先自行 clone 或下载，查看内容后再指定给此处。
  //
  // 有意不做 `git clone <任意 URL>`：那等于从网络获取一段代码并在下一次加载时运行。
  // 插件确实运行在沙箱中，但沙箱限制的是插件能访问什么，不判断它是否是用户想要的插件。
  // 不提供这一步的代价只是用户多输入一条 git 命令；提供这一步的代价是该入口
  // 等同于 `curl | sh`。同样的结果仍可达成，只是多一个步骤：用户能看到安装的内容。
  //
  // 安装前必须校验清单：
  // 目录中没有合法的 `qywork.plugin.json` 时直接拒绝。不校验时，
  // 指定了错误的目录会报告安装成功，随后在下一次加载时成为一条 failure，
  // 而此时用户已无法回忆所指定的路径。
  if (p === '/api/plugins/install' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string } | null
    const src = body?.path?.trim()
    if (!src) return json({ error: 'bad request', message: '缺少目录路径' }, 400)

    const found = await readPluginDir(src)
    if (!found.ok) return json({ error: 'invalid', message: found.error }, 422)
    // 已安装同一 id 时拒绝，而不是静默覆盖：覆盖会直接抹掉用户可能修改过的文件，
    // 且没有任何提示。更换版本时先卸载。
    if (found.replacing) {
      return json({ error: 'conflict', message: `已安装同名插件 ${found.id}，请先卸载` }, 409)
    }
    const done = await copyPluginDir(src, found.id!, { replace: false })
    if (!done.ok) return json({ error: 'invalid', message: done.error }, 422)
    return json({ ok: true, id: found.id })
  }

  const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(p)
  if (pluginMatch && req.method === 'DELETE') {
    const id = pluginMatch[1]!
    // id 来自 URL，必须拦截分隔符与 `..`，否则该路由构成任意目录删除。
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
