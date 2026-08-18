/**
 * HTTP API 的派发器。
 *
 * 拆开之前这些全在 `server.ts` 的一个 439 行函数里，而那个文件同时还装着
 * 握手、指令分发、run 生命周期、team 编排、压缩和静态托管。同目录的
 * `files.ts` / `git.ts` / `runs.ts` / `pairing.ts` / `bus.ts` 早就是一域一文件，
 * **拆分模式一直在旁边，只是这一块没跟上**。
 *
 * 顺序有意义：**先匹配的先赢**。当前各域路径前缀互不重叠，所以顺序目前
 * 只影响性能不影响语义；但如果哪天加了会重叠的路由，这里就是决定谁优先的地方，
 * 而不是让两个模块各自判一遍再看谁先返回。
 */

import type { Store } from '@qywork/store'
import { getWorkspace, mostRecentWorkspace } from '@qywork/store'
import { handleAttachmentsApi } from './attachments.ts'
import { handleConfigApi } from './config.ts'
import { handleConversationsApi } from './conversations.ts'
import { handleExtrasApi } from './extras.ts'
import { handleGitApi } from './git.ts'
import { handleHostApi } from './host.ts'
import { handleMcpApi } from './mcp.ts'
import { handleMemoryApi } from './memory.ts'
import { handlePairingApi } from './pairing.ts'
import { handlePluginsApi } from './plugins.ts'
import { handleProbeApi } from './probe.ts'
import { handleSchedulesApi } from './schedules.ts'
import { handleTeamApi } from './team.ts'
import type { ApiDeps, ApiHandler, ApiRequestDeps } from './types.ts'
import { json } from './types.ts'
import { handleUsageApi } from './usage.ts'
import { handleWorkspaceApi } from './workspace.ts'
import { handleWorkspaceFsApi } from './workspace-fs.ts'

export type { ApiDeps } from './types.ts'
export { json } from './types.ts'

/**
 * 这一次请求问的是哪个项目。
 *
 * `?ws=<workspaceId>` 显式指定；不带就落到**最近打开的那个**
 * （`listWorkspaces` 已按 `last_opened_at DESC` 排序）。回落是给 CLI 和
 * 手输 URL 用的——界面永远显式带上，因为它同时开着好几个项目。
 *
 * 指了一个不存在的 id 返回 `null`，由派发器回 404：静默回落到别的项目，
 * 等于在用户以为是 A 的地方读写 B。
 */
function resolveWorkspace(store: Store, url: URL): { id: string; root: string } | null {
  const id = url.searchParams.get('ws')
  if (id) {
    const w = getWorkspace(store, id as never)
    return w ? { id: w.id, root: w.rootPath } : null
  }
  const recent = mostRecentWorkspace(store)
  return recent ? { id: recent.id, root: recent.rootPath } : null
}

const HANDLERS: ApiHandler[] = [
  handlePairingApi,
  handleWorkspaceApi,
  handleConfigApi,
  handleProbeApi,
  handleSchedulesApi,
  handleMemoryApi,
  handleMcpApi,
  handleExtrasApi,
  handleHostApi,
  handleAttachmentsApi,
  handlePluginsApi,
  handleTeamApi,
  handleUsageApi,
  handleConversationsApi,
  handleWorkspaceFsApi,
  handleGitApi,
]

/** 返回 `null` = 没有任何一域认领这条路径，交给调用方去走静态托管或 404。 */
export async function handleApi(url: URL, req: Request, d: ApiDeps): Promise<Response | null> {
  const ws = resolveWorkspace(d.store, url)
  if (!ws) {
    // 指名道姓要一个不存在的项目：404。静默换一个等于在用户以为是 A 的地方读写 B。
    if (url.searchParams.get('ws')) return json({ error: '这个项目不存在' }, 404)
    /*
     * 一个项目都还没有。**只有「列项目 / 加项目」这条路能走**——第一个项目就是
     * 从那里进来的，全部拦掉的话它永远加不进来。其余一律 404，而不是拿一个
     * 空字符串当根继续往下跑：空根在 path.join 下面就是进程的当前目录。
     */
    if (url.pathname !== '/api/workspaces') return json({ error: '还没有任何项目' }, 404)
    return handleWorkspaceApi(url, req, { ...d, workspaceRoot: '', workspaceId: '' })
  }
  const rd: ApiRequestDeps = { ...d, workspaceRoot: ws.root, workspaceId: ws.id }
  for (const handle of HANDLERS) {
    const res = await handle(url, req, rd)
    if (res) return res
  }
  return null
}
