/** 工作区：我在哪，以及本机还开过哪些。 */

import { basename } from 'node:path'
import { listWorkspaces } from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

export const handleWorkspaceApi: ApiHandler = async (url, _req, d) => {
  const p = url.pathname

  if (p === '/api/workspaces') {
    return json({ workspaces: listWorkspaces(d.store), current: d.workspaceRoot })
  }

  // 当前工作区。侧边栏必须能显示「我在哪」——工作区由启动时的 --cwd 决定，
  // 而桌面端和手动起的 serve 很容易落在两个不同目录上，会话按 workspaceId 分表，
  // 于是同一个人在两个客户端看到两份互不相交的会话，界面上却没有任何线索。
  // 这是 ROADMAP §33.2 那条「数据看起来丢了」的 bug 的可见性一半。
  if (p === '/api/workspace') {
    return json({
      id: d.workspaceId,
      root: d.workspaceRoot,
      name: basename(d.workspaceRoot) || d.workspaceRoot,
    })
  }

  return null
}
