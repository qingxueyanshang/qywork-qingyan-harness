/**
 * HTTP API 的派发器。
 *
 * 各域路由按一域一文件拆分，与 `server.ts` 同目录的 `files.ts` / `git.ts` / `runs.ts` /
 * `pairing.ts` / `bus.ts` 组织方式一致；`server.ts` 只负责装配。
 *
 * 顺序有意义：先匹配的处理器优先。当前各域路径前缀互不重叠，因此顺序目前只影响性能、
 * 不影响语义；新增会重叠的路由时，由此处的顺序决定优先级，不要让两个模块各自判定后
 * 以先返回者为准。
 */

import type { Store } from '@qywork/store'
import { getWorkspace, mostRecentWorkspace } from '@qywork/store'
import { handleAttachmentsApi } from './attachments.ts'
import { handleCanvasApi } from './canvas.ts'
import { handleConfigApi } from './config.ts'
import { handleConversationsApi } from './conversations.ts'
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
 * 本次请求所指的项目。
 *
 * `?ws=<workspaceId>` 显式指定；未指定时回退到最近打开的项目
 * （`listWorkspaces` 已按 `last_opened_at DESC` 排序）。回退供 CLI 与
 * 手动输入的 URL 使用；界面始终显式指定，因为界面同时打开多个项目。
 *
 * 指定的 id 不存在时返回 `null`，由派发器返回 404：静默回退到其他项目，
 * 等于在用户选定 A 的位置上读写 B。
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
  handleHostApi,
  handleAttachmentsApi,
  handlePluginsApi,
  handleTeamApi,
  handleUsageApi,
  handleConversationsApi,
  handleWorkspaceFsApi,
  handleCanvasApi,
  handleGitApi,
]

/** 返回 `null` 表示没有任何域处理该路径，交给调用方进行静态托管或返回 404。 */
export async function handleApi(url: URL, req: Request, d: ApiDeps): Promise<Response | null> {
  const ws = resolveWorkspace(d.store, url)
  if (!ws) {
    // 显式指定了不存在的项目：返回 404。静默替换为其他项目等于在用户选定 A 的位置上读写 B。
    if (url.searchParams.get('ws')) return json({ error: '项目不存在' }, 404)
    /*
     * 尚无任何项目。只放行列出项目与添加项目的路径：第一个项目经由该路径添加，
     * 全部拦截则永远无法添加。其余请求一律返回 404，而不是把空字符串当作根目录继续执行：
     * 空根目录经 path.join 解析后即为进程的当前目录。
     */
    if (url.pathname !== '/api/workspaces') return json({ error: '尚无项目' }, 404)
    return handleWorkspaceApi(url, req, { ...d, workspaceRoot: '', workspaceId: '' })
  }
  const rd: ApiRequestDeps = { ...d, workspaceRoot: ws.root, workspaceId: ws.id }
  for (const handle of HANDLERS) {
    const res = await handle(url, req, rd)
    if (res) return res
  }
  return null
}
