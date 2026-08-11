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

import { handleConfigApi } from './config.ts'
import { handleConversationsApi } from './conversations.ts'
import { handlePairingApi } from './pairing.ts'
import { handlePluginsApi } from './plugins.ts'
import { handleSchedulesApi } from './schedules.ts'
import { handleTeamApi } from './team.ts'
import type { ApiDeps, ApiHandler } from './types.ts'
import { handleWorkspaceApi } from './workspace.ts'
import { handleWorkspaceFsApi } from './workspace-fs.ts'

export type { ApiDeps } from './types.ts'
export { json } from './types.ts'

const HANDLERS: ApiHandler[] = [
  handlePairingApi,
  handleWorkspaceApi,
  handleConfigApi,
  handleSchedulesApi,
  handlePluginsApi,
  handleTeamApi,
  handleConversationsApi,
  handleWorkspaceFsApi,
]

/** 返回 `null` = 没有任何一域认领这条路径，交给调用方去走静态托管或 404。 */
export async function handleApi(url: URL, req: Request, d: ApiDeps): Promise<Response | null> {
  for (const handle of HANDLERS) {
    const res = await handle(url, req, d)
    if (res) return res
  }
  return null
}
