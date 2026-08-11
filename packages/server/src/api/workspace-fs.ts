/** 文件树、预览与 git 只读视图。右侧面板的三个标签页都从这里取数。 */

import { resolveInWorkspace } from '@qywork/tools'
import { listTree, preview } from '../files.ts'
import * as git from '../git.ts'
import { type ApiHandler, json } from './types.ts'

export const handleWorkspaceFsApi: ApiHandler = async (url, _req, d) => {
  const p = url.pathname
  const q = url.searchParams

  if (p === '/api/files/tree') {
    const rel = q.get('path') ?? '.'
    // 走同一套路径约束：HTTP 入口和工具入口不能有两套安全策略。
    await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true })
    const depth = Math.min(6, Math.max(1, Number(q.get('depth') ?? 2)))
    return json({ nodes: await listTree(d.workspaceRoot, rel === '.' ? '' : rel, depth) })
  }

  if (p === '/api/files/preview') {
    const rel = q.get('path')
    if (!rel) return json({ error: 'path required' }, 400)
    await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true })
    return json(await preview(d.workspaceRoot, rel))
  }

  if (p === '/api/git/status') {
    if (!(await git.isRepo(d.workspaceRoot))) return json({ repo: false })
    return json({ repo: true, status: await git.status(d.workspaceRoot) })
  }
  if (p === '/api/git/branches') {
    return json({ branches: await git.branches(d.workspaceRoot) })
  }
  if (p === '/api/git/log') {
    return json({
      commits: await git.log(d.workspaceRoot, {
        limit: Number(q.get('limit') ?? 50),
        ...(q.get('ref') ? { ref: q.get('ref')! } : {}),
      }),
    })
  }
  if (p === '/api/git/diff') {
    return json({
      diff: await git.diff(d.workspaceRoot, {
        ...(q.get('path') ? { path: q.get('path')! } : {}),
        ...(q.get('ref') ? { ref: q.get('ref')! } : {}),
        staged: q.get('staged') === '1',
      }),
    })
  }

  return null
}
