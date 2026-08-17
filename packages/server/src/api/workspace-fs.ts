/**
 * 文件树、按名搜索、预览、新建 / 改名 / 删除，以及 git 只读视图。
 * 右侧面板的几个标签页都从这里取数。
 *
 * git 那几条只读。会写盘的是 create / rename / delete 三条，**它们共用同一套口径**：
 * 入参不合法回 422 且不落盘、目标已存在回 409 不覆盖、路径越界翻成 422
 * （那是入参问题，不该以 500 的面貌出现在界面上）。每条的特殊之处写在它自己头上。
 */

import { resolveInWorkspace } from '@qywork/tools'
import {
  createEntry,
  deleteEntry,
  EntryExistsError,
  findByName,
  listTree,
  preview,
  renameEntry,
} from '../files.ts'
import * as git from '../git.ts'
import { type ApiHandler, json } from './types.ts'

export const handleWorkspaceFsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname
  const q = url.searchParams

  if (p === '/api/files/tree') {
    const rel = q.get('path') ?? '.'
    // 走同一套路径约束：HTTP 入口和工具入口不能有两套安全策略。
    await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true })
    const depth = Math.min(6, Math.max(1, Number(q.get('depth') ?? 2)))
    return json({ nodes: await listTree(d.workspaceRoot, rel === '.' ? '' : rel, depth) })
  }

  if (p === '/api/files/find') {
    // 空查询由 `findByName` 判（它回空结果，不回整棵树）——这里不重复一遍。
    return json(await findByName(d.workspaceRoot, q.get('q') ?? ''))
  }

  /*
   * 新建文件 / 目录。**面板这一侧唯一的写入口**。
   *
   * 三条硬口径：不合法不落盘（422）、已存在不覆盖（409）、路径越界由
   * `resolveInWorkspace` 挡。越界翻成 422 而不是让它抛成 500——这是入参问题，
   * 用户要看到的是「这个路径不在项目里」，不是「服务器错误」。
   */
  if (p === '/api/files/create' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string; kind?: string } | null
    const rel = body?.path?.trim()
    const kind = body?.kind
    if (!rel || (kind !== 'file' && kind !== 'dir')) {
      return json({ error: 'invalid', message: '要建的路径和类型都得给' }, 422)
    }
    try {
      await resolveInWorkspace(d.workspaceRoot, rel)
    } catch {
      return json({ error: 'invalid', message: `${rel} 不在这个项目里` }, 422)
    }
    try {
      return json({ node: await createEntry(d.workspaceRoot, rel, kind) })
    } catch (err) {
      if (err instanceof EntryExistsError)
        return json({ error: 'exists', message: err.message }, 409)
      throw err
    }
  }

  /*
   * 改名。名字只能是**一个名字**：带分隔符就是搬家，而这颗菜单项写的是「重命名」，
   * 两件事混在一个接口里，用户在输入框里打个 `../x` 就把文件挪出了他以为的位置。
   */
  if (p === '/api/files/rename' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string; name?: string } | null
    const rel = body?.path?.trim()
    const name = body?.name?.trim()
    if (!rel || !name) return json({ error: 'invalid', message: '路径和新名字都得给' }, 422)
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      return json({ error: 'invalid', message: '名字里不能带路径分隔符' }, 422)
    }
    try {
      await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true })
    } catch {
      return json({ error: 'invalid', message: `${rel} 不在这个项目里` }, 422)
    }
    try {
      return json({ node: await renameEntry(d.workspaceRoot, rel, name) })
    } catch (err) {
      if (err instanceof EntryExistsError)
        return json({ error: 'exists', message: err.message }, 409)
      throw err
    }
  }

  /*
   * 删除。目录连着里面一起删——**确认在界面那一侧**（`ConfirmDialog`），
   * 这里不再问一遍。空路径直接拒：那指的是工作区根本身。
   */
  if (p === '/api/files/delete' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string } | null
    const rel = body?.path?.trim()
    if (!rel) return json({ error: 'invalid', message: '要删的路径得给' }, 422)
    try {
      await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true })
    } catch {
      return json({ error: 'invalid', message: `${rel} 不在这个项目里` }, 422)
    }
    await deleteEntry(d.workspaceRoot, rel)
    return json({ ok: true })
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
  /*
   * 切分支。git 这一侧唯一会改工作区的接口。
   *
   * 切不过去（最常见：本地改动会被覆盖）回 409 + git 的原话——那句话就是用户
   * 需要看的东西。**不替他 stash、不加 --force**：那是拿他的改动换一次成功。
   */
  if (p === '/api/git/checkout' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { name?: string } | null
    const name = body?.name?.trim()
    if (!name) return json({ error: 'invalid', message: '要切到哪个分支' }, 422)
    const r = await git.checkout(d.workspaceRoot, name)
    if (!r.ok) return json({ error: 'checkout_failed', message: r.err || '切换失败' }, 409)
    return json({ ok: true })
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
