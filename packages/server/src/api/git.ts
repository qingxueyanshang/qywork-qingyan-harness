/**
 * 分支：列出分支与切换分支。
 *
 * 这是本应用中唯一写入 git 的路径。其余 git 调用均为只读
 * （`git.ts` 的 `currentBranch` / `branches`），而 `switch` 会修改用户磁盘上的文件。
 * 因此分支名必须先在实际的本地分支清单中核对；运行中的 run 不拦截，理由见切换处的注释。
 *
 * 会话修改了哪些文件不由此处回答，而由 step 账本提供（面板的 `ChangeRecord`）。
 * 此处只回答当前所在的分支与切换分支。
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
    if (!name) return json({ error: '缺少目标分支名' }, 422)

    /*
     * 运行中照常切换，不拦截。文件在模型读取之后发生变化，由文件工具裁决：
     * `edit_file` / `write_file` 写入前用读取时记录的哈希重新校验，不一致时以
     * `stale_write` 拒绝并要求重新 `read_file`（`packages/tools/src/files.ts`）。
     * 在此处再拦截一次会为同一件事增加第二个裁决者，且拦截的是用户明确要求的操作。
     * 用户在编辑器中修改同一个文件是相同的情形，该情形同样不拦截。
     */
    const r = await git.switchTo(d.workspaceRoot, name)
    if (!r.ok) return json({ error: r.message }, 409)
    // 立即广播新分支。等待 `.git/HEAD` 的监听触发时，分支标签会短暂显示旧名称。
    await publishGitState(d.workspaceRoot, d.workspaceId, d.bus)
    return json({ branch: name })
  }

  return null
}
