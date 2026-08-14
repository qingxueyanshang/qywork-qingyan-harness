/** 项目：本机开过哪些、加一个、以及某个项目上装了什么扩展。 */

import { mkdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { configDir } from '@qywork/runtime'
import {
  archiveWorkspaceConversations,
  countConversations,
  getWorkspaceByPath,
  listWorkspaces,
  removeWorkspace,
  setWorkspacePinned,
  upsertWorkspace,
} from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

/**
 * 不给源文件夹时，默认工作区建在这里。
 *
 * 跟账本同根（`~/.qywork/`，可由 `QYWORK_HOME` 改）：它们是同一类东西——
 * 这台机器上 qywork 自己的数据，卸载时一并带走。放进用户主目录会多出一个
 * 谁都不知道能不能删的文件夹。要打开它有菜单里的「在资源管理器中打开」。
 */
function defaultWorkspacesRoot(): string {
  return join(configDir(), 'workspaces')
}

/** Windows 文件名里不能出现的那几个。斜杠与 `..` 另外单判。 */
const WINDOWS_RESERVED = '<>:"|?*'

/**
 * 项目名 → 文件夹名。不合法回 `null`，由调用方回 422。
 *
 * **拒绝而不是清洗**（CLAUDE.md E）：把 `../../etc` 洗成 `etc` 会让用户以为
 * 自己建的就是那个名字，而实际建的是别的——建到一半失败比一开始就说不行难查。
 *
 * 逐字符判控制字符，不写含控制字符的正则：那种正则要么在源码里塞裸控制字节，
 * 要么得挂一条 biome-ignore，两样都不必要。
 */
function folderNameFrom(name: string): string | null {
  if (!name || name === '.' || name === '..') return null
  if (/[/\\]/.test(name) || name.includes('..')) return null
  for (const ch of name) {
    if ((ch.codePointAt(0) ?? 0) < 32 || WINDOWS_RESERVED.includes(ch)) return null
  }
  // Windows 会静默去掉结尾的点和空格，落盘的名字就和用户填的不一样了。
  if (/[. ]$/.test(name)) return null
  return name
}

/** 重名就加后缀。**不复用已有目录**——那可能是上一个同名项目留下的东西。 */
async function freshDir(root: string, folder: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = join(root, i === 1 ? folder : `${folder}-${i}`)
    if (!(await stat(candidate).catch(() => null))) return candidate
  }
}

export const handleWorkspaceApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/workspaces') {
    /*
     * 加一个项目。
     *
     * **同一条路既是「新增」也是「切过去」**：`upsertWorkspace` 已有就更新
     * `last_opened_at`，没有就插一行。给「切换」单开一个端点等于两条路写同一个
     * 字段，而那个字段正是 git 轮询与缺省 `?ws=` 的判据。
     *
     * 两种入参：
     *
     * - **给了 `path`**：只接受本机已存在的目录（CLAUDE.md E）。这里不做
     *   `git clone <URL>`——那等于从网上取一段代码、下次加载就跑它。
     *   `name` 不给就取目录名。
     * - **只给 `name`**：在 `~/.qywork/workspaces/<name>/` 建一个新目录。
     *   重名加后缀，不复用已有目录。
     *
     * **路径已经在账本里时复用那一行**（`root_path` 是 UNIQUE），
     * `upsertWorkspace` 顺带清掉 `removed_at`——移除过的项目重新添加，
     * 它原来的会话跟着回来。会话挂的是 id，不是路径。
     */
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { path?: string; name?: string }
      const rawPath = body.path?.trim()
      const rawName = body.name?.trim()

      if (rawPath) {
        const path = resolve(rawPath)
        const st = await stat(path).catch(() => null)
        if (!st?.isDirectory()) return json({ error: `不是本机已存在的目录：${path}` }, 422)
        /*
         * 名字的优先级：显式给的 > 账本里已有的 > 目录名。
         *
         * 中间那一档不能省：「切到另一个项目」走的也是这条 upsert 且不带 name，
         * 省掉的话每切一次就把用户自己起的项目名重置成目录名。
         */
        const known = getWorkspaceByPath(d.store, path)
        const name = rawName || known?.name || basename(path) || path
        return json({ workspace: upsertWorkspace(d.store, path, name) })
      }

      if (!rawName) return json({ error: '要么给 path，要么给 name' }, 422)
      const folder = folderNameFrom(rawName)
      if (!folder) {
        return json({ error: `这个名字不能当文件夹名：${rawName}` }, 422)
      }
      const root = defaultWorkspacesRoot()
      const path = await freshDir(root, folder)
      // 先建目录再写账本：反过来的话建失败就留下一条指向不存在目录的记录。
      await mkdir(path, { recursive: true })
      return json({ workspace: upsertWorkspace(d.store, path, rawName) })
    }
    /*
     * 每条带上会话数。它曾经的用途是「删之前说清会丢多少」——移除不再删数据之后
     * 那个用途没了，但计数本身仍是项目卡片上要显示的信息。
     */
    return json({
      workspaces: listWorkspaces(d.store).map((w) => ({
        ...w,
        conversations: countConversations(d.store, w.id),
      })),
    })
  }

  /*
   * 把一个项目从列表里移除。**不删任何数据**——见 `removeWorkspace`：
   * 它只打 `removed_at` 标记，会话、消息、run 一条不动，重新添加同一路径就回来。
   *
   * 路径里的 id 直接进 SQL 参数，不拼路径也不拼 SQL；查不到回 404 而不是静默成功。
   */
  const one = /^\/api\/workspaces\/([^/]+)$/.exec(p)
  if (one && req.method === 'DELETE') {
    const id = decodeURIComponent(one[1] as string)
    /*
     * **当前项目也能移除**，只要还剩别的可切。
     *
     * 原来一律回 409（「不能移除脚下这块地板」）。那条规则挡住的是真实需求：
     * 开发这个仓库时它自己就是当前项目，于是那一行的 `⋯` 里永远没有「移除」。
     * 而「先切到别的项目再回来移除它」不是用户该被要求做的编排。
     *
     * 只有它是**最后一个**时才拒绝——移除完界面没有任何项目可服务，
     * 那不是一个有终态的状态。这一条仍然是硬规则。
     */
    if (id === d.workspaceId && listWorkspaces(d.store).length <= 1) {
      return json({ error: '这是最后一个项目，先添加另一个再移除它' }, 409)
    }
    if (!removeWorkspace(d.store, id as never)) return json({ error: '这个项目不存在' }, 404)
    /*
     * 回「接下来该切到哪个」。客户端手里的 `?ws=` 指着刚被移除的那个，
     * 不给它一个去处的话，随后每条请求都落到 404——让服务端直接说，
     * 比在客户端各处补「移除之后跳哪」的分支干净。
     */
    const next = listWorkspaces(d.store)[0]
    return json({ ok: true, ...(next ? { next: { id: next.id, rootPath: next.rootPath } } : {}) })
  }

  /*
   * 置顶 / 取消置顶。
   *
   * PATCH 而不是两条 POST（`/pin` + `/unpin`）：它改的是同一行上的同一个字段，
   * 两条路写一个字段就是两本账。目标状态由 body 给，不是「翻转当前状态」——
   * 翻转在并发下会翻错方向，而且客户端没法重试。
   */
  if (one && req.method === 'PATCH') {
    const id = decodeURIComponent(one[1] as string)
    const body = (await req.json().catch(() => null)) as { pinned?: unknown } | null
    if (typeof body?.pinned !== 'boolean') return json({ error: '缺少 pinned（布尔）' }, 422)
    if (!setWorkspacePinned(d.store, id as never, body.pinned)) {
      return json({ error: '这个项目不存在，或已经是这个状态' }, 404)
    }
    return json({ ok: true })
  }

  /*
   * 归档这个项目当前的全部会话。
   *
   * **不删数据**：只是从会话列表里去掉，此后新建的照常显示（见
   * `archiveWorkspaceConversations`）。回归档条数而不是 `{ok:true}`——
   * 界面要能说「归档了 N 条」，而「0 条」和「成功」在界面上必须能区分开。
   */
  const archive = /^\/api\/workspaces\/([^/]+)\/archive$/.exec(p)
  if (archive && req.method === 'POST') {
    const id = decodeURIComponent(archive[1] as string)
    return json({ archived: archiveWorkspaceConversations(d.store, id as never) })
  }

  // 这一次请求问的是哪个项目（`?ws=` 解析的结果，见 api/index.ts）。
  // 名字取目录名；取不出来（根目录）时回落到整条路径，不回空串。
  if (p === '/api/workspace') {
    return json({
      id: d.workspaceId,
      root: d.workspaceRoot,
      name: basename(d.workspaceRoot) || d.workspaceRoot,
    })
  }

  /*
   * 这个项目上装了什么。
   *
   * **不在握手里报。** 扩展是按工作区的（`.qy/plugins`、`.qy/mcp.json`、
   * `.qy/team.json` 全在项目目录下），而一条 WebSocket 连接横跨用户开着的所有项目。
   * 握手报一份就等于「A 项目的插件显示在 B 项目上」，且它只在重连时才更新。
   */
  if (p === '/api/capabilities') {
    const { loadExtensions } = await import('@qywork/runtime')
    const ext = await loadExtensions(d.workspaceRoot)
    return json({
      plugins: ext.plugins.plugins.map((x) => x.manifest.id),
      teamBackends: Object.keys(ext.team.backends),
      mcpServers: ext.mcp.servers.map((m) => m.name),
    })
  }

  /*
   * 这个 agent 会做什么：全部工具按「能力大类 → 功能方向」两层列出来。
   *
   * **这是分类轴（`ToolCategory`）的消费者。** 没有它那条轴就是 C1 第 1 款的死链路
   * ——注册期校验着、schema 里写着、没有任何人读。
   *
   * 只回**中文的用途**（`summary`）、类目与功能方向，**不回工具名**：
   * 桌面端一律中文，`read_file` 这种机制字段只在 CLI 里露面。
   *
   * 内置工具直接从注册表取（零成本，就是这一份真源）；插件贡献的工具从清单取
   * （清单本来就已经读进来了，不用把插件跑起来）。**MCP 不在这里列** ——
   * 它的工具清单要连上 server 才知道，为了一个设置页去连一串外部进程不划算，
   * 而「装了几个 server」`/api/capabilities` 已经在回答。这条边界写在界面上。
   */
  if (p === '/api/tools') {
    const { ToolRegistry } = await import('@qywork/agent')
    const { registerBuiltinTools } = await import('@qywork/tools')
    const { loadExtensions } = await import('@qywork/runtime')

    const registry = new ToolRegistry()
    registerBuiltinTools(registry)
    const rows = registry
      .list()
      .map((s) => ({ category: s.category, facet: s.facet, summary: s.summary }))

    const ext = await loadExtensions(d.workspaceRoot)
    for (const plugin of ext.plugins.plugins) {
      for (const t of plugin.manifest.contributes?.tools ?? []) {
        rows.push({ category: 'external', facet: plugin.manifest.id, summary: t.description })
      }
    }

    // 确定性排序：类目按枚举顺序，其后按功能方向与用途字典序。
    const { TOOL_CATEGORIES } = await import('@qywork/agent')
    rows.sort(
      (a, b) =>
        TOOL_CATEGORIES.indexOf(a.category) - TOOL_CATEGORIES.indexOf(b.category) ||
        a.facet.localeCompare(b.facet, 'zh') ||
        a.summary.localeCompare(b.summary, 'zh'),
    )
    return json({ tools: rows, mcpServers: ext.mcp.servers.map((m) => m.name) })
  }

  return null
}
