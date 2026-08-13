/** 项目：本机开过哪些、加一个、以及某个项目上装了什么扩展。 */

import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  archiveWorkspaceConversations,
  countConversations,
  listWorkspaces,
  removeWorkspace,
  setWorkspacePinned,
  upsertWorkspace,
} from '@qywork/store'
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
   * **只能移除自己不在的那个。** 移除当前这一个之后，界面手里的 `?ws=` 指向一个
   * 已经不在列表里的项目，而且如果它恰好是最后一行，界面就没有任何项目可切。
   * 让「不能移除脚下这块地板」成为一条硬规则，比在下游到处补「移除之后跳去哪」
   * 的分支干净。
   *
   * 路径里的 id 直接进 SQL 参数，不拼路径也不拼 SQL；查不到回 404 而不是静默成功。
   */
  const one = /^\/api\/workspaces\/([^/]+)$/.exec(p)
  if (one && req.method === 'DELETE') {
    const id = decodeURIComponent(one[1] as string)
    if (id === d.workspaceId) return json({ error: '不能移除当前正在用的项目' }, 409)
    if (!removeWorkspace(d.store, id as never)) return json({ error: '这个项目不存在' }, 404)
    return json({ ok: true })
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

  return null
}
