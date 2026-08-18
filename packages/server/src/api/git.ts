/**
 * 分支：列出来、切过去。
 *
 * **这是这个应用里唯一一条会写 git 的路径。** 其余所有 git 调用都是只读的
 * （`git.ts` 的 `currentBranch` / `branches`），而 `switch` 会改用户磁盘上的文件。
 * 所以它有两道闸：这个工作区里没有正在跑的 run，且分支名要在真实清单里核过。
 *
 * 「这条会话改了哪些文件」不走这里——那是 step 账本的事（面板的 `ChangeRecord`）。
 * 这里只回答「我在哪条分支上」和「换一条」。
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
     * **跑着的时候不许切。** 切分支会当场换掉工作区里的文件，而模型正拿着它读过的
     * 内容在写——切完之后它的 `old_string` 对不上，写回去的是两条分支的混合体。
     *
     * 界面上那颗 chip 在 `state.running` 时是禁用的，但**只拦界面不算拦**：
     * 这条路径 curl 得到，而它改的是用户的磁盘。
     */
    const busy = new Set(d.runs.conversationsOf(d.workspaceId))
    if (d.runs.listActive().some((r) => busy.has(r.conversationId))) {
      return json({ error: '这个项目里有正在执行的会话，先停下来再切分支' }, 409)
    }

    const r = await git.switchTo(d.workspaceRoot, name)
    if (!r.ok) return json({ error: r.message }, 409)
    // 立刻广播新分支。等 4 秒那次轮询的话，chip 会在切完之后还挂着旧名字。
    await publishGitState(d.workspaceRoot, d.workspaceId, d.bus)
    return json({ branch: name })
  }

  return null
}
