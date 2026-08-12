/** 项目：本机开过哪些、加一个、以及某个项目上装了什么扩展。 */

import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { countConversations, listWorkspaces, removeWorkspace, upsertWorkspace } from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

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
     * 只接受**本机已存在的目录**（CLAUDE.md E）：这里不做 `git clone <URL>`，
     * 那等于从网上取一段代码、下次加载就跑它。
     */
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { path?: string }
      const raw = body.path?.trim()
      if (!raw) return json({ error: '缺少 path' }, 422)
      const path = resolve(raw)
      const st = await stat(path).catch(() => null)
      if (!st?.isDirectory()) return json({ error: `不是本机已存在的目录：${path}` }, 422)
      return json({ workspace: upsertWorkspace(d.store, path, basename(path) || path) })
    }
    /*
     * 每条带上会话数：删项目会把会话一起带走（`removeWorkspace` 的注释写明了
     * 为什么不能不带），界面得先能说出「这一下会丢多少」。
     */
    return json({
      workspaces: listWorkspaces(d.store).map((w) => ({
        ...w,
        conversations: countConversations(d.store, w.id),
      })),
    })
  }

  /*
   * 移除一个项目。
   *
   * **只能删自己不在的那个。** 删掉当前这一个之后，界面手里的 `?ws=` 立刻指向
   * 一行不存在的记录，随后每一条请求都回 404——而且如果它恰好是最后一行，
   * 整个服务就没有任何项目可服务了。让「不能删脚下这块地板」成为一条硬规则，
   * 比在下游到处补「删完之后跳去哪」的分支干净。
   *
   * 路径里的 id 直接进 SQL 参数，不拼路径也不拼 SQL；查不到回 404 而不是静默成功。
   */
  const del = /^\/api\/workspaces\/([^/]+)$/.exec(p)
  if (del && req.method === 'DELETE') {
    const id = decodeURIComponent(del[1] as string)
    if (id === d.workspaceId) return json({ error: '不能移除当前正在用的项目' }, 409)
    if (!removeWorkspace(d.store, id as never)) return json({ error: '这个项目不存在' }, 404)
    return json({ ok: true })
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

  return null
}
