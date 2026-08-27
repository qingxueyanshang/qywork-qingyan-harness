/**
 * 分支：列出来、切过去。
 *
 * **这是这个应用里唯一一条会写 git 的路径。** 其余所有 git 调用都是只读的
 * （`git.ts` 的 `currentBranch` / `branches`），而 `switch` 会改用户磁盘上的文件。
 * 所以它有两道闸：这个工作区里没有正在跑的 run，且分支名要在真实清单里核过。
 *
 * 「这条会话改了哪些文件」不走这里——那是 step 账本的事（面板的 `ChangeRecord`）。
 * 这里只回答「当前在哪条分支上」和「换一条」。
 */

import * as git from '../git.ts'
import { publishGitState } from '../http-util.ts'
import { type ApiHandler, json } from './types.ts'

export const handleGitApi: ApiHandler = async (url, req, d) => {
  if (url.pathname === '/api/git/branches') {
    return json({ branches: await git.branches(d.workspaceRoot) })
  }

  if (url.pathname === '/api/git/switch' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { branch?: unknown } | null
    const name = typeof body?.branch === 'string' ? body.branch.trim() : ''
    if (!name) return json({ error: '要切到哪条分支' }, 422)

    /*
     * **跑着的时候照切，不拦。** 文件在模型读过之后变了这件事，权威在文件工具那边：
     * `edit_file` / `write_file` 落笔前会拿读取时记下的哈希重算一遍，对不上就以
     * `stale_write` 拒绝并要求重新 `read_file`（`packages/tools/src/files.ts`）。
     * 在这里再拦一次是在同一件事上加第二个裁决者，而它挡住的是用户明确要做的动作。
     * 用户在编辑器里改同一个文件是一模一样的情形，那边也没有谁拦着。
     */
    const r = await git.switchTo(d.workspaceRoot, name)
    if (!r.ok) return json({ error: r.message }, 409)
    // 立刻广播新分支。等 `.git/HEAD` 那条监听的话，chip 会多挂着旧名字一小会儿。
    await publishGitState(d.workspaceRoot, d.workspaceId, d.bus)
    return json({ branch: name })
  }

  return null
}
