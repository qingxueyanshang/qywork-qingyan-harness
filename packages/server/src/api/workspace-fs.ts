/**
 * 文件树、按名搜索、预览与原始字节、新建 / 改名 / 删除。
 * 右侧面板的几个标签页都从这里取数。
 *
 * 会写盘的是 create / rename / delete 三条，**它们共用同一套口径**：
 * 入参不合法回 422 且不落盘、目标已存在回 409 不覆盖、路径越界翻成 422
 * （那是入参问题，不该以 500 的面貌出现在界面上）。每条的特殊之处写在它自己头上。
 *
 * 路径一律按 `literal` 解析，并把解析结果交给 `files.ts` 读写：查询参数已由
 * `URLSearchParams` 解码过一次，请求体里的路径是字面值，再解码一次会把文件名里的
 * `%20` 之类当成转义。create / rename / delete 操作的是目录项本身，用
 * `followFinalSymlink: false`：跟随末段软链时，删除和改名会作用到软链指向的目标。
 */

import { resolveInWorkspace } from '@qywork/tools'
import {
  createEntry,
  deleteEntry,
  EntryExistsError,
  findByName,
  listTree,
  openRaw,
  preview,
  renameEntry,
} from '../files.ts'
import { type ApiHandler, json } from './types.ts'

export const handleWorkspaceFsApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname
  const q = url.searchParams

  if (p === '/api/files/tree') {
    const rel = q.get('path') ?? '.'
    // 走同一套路径约束：HTTP 入口和工具入口不能有两套安全策略。
    const dir = await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true, literal: true })
    const depth = Math.min(6, Math.max(1, Number(q.get('depth') ?? 2)))
    return json({ nodes: await listTree(dir, rel === '.' ? '' : rel, depth) })
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
      return json({ error: 'invalid', message: '缺少路径或类型' }, 422)
    }
    let abs: string
    try {
      abs = await resolveInWorkspace(d.workspaceRoot, rel, {
        literal: true,
        followFinalSymlink: false,
      })
    } catch {
      return json({ error: 'invalid', message: `${rel} 不在这个项目里` }, 422)
    }
    try {
      return json({ node: await createEntry(abs, rel, kind) })
    } catch (err) {
      if (err instanceof EntryExistsError)
        return json({ error: 'exists', message: err.message }, 409)
      throw err
    }
  }

  /*
   * 改名。名字只能是**一个名字**：带分隔符就是搬家，而这颗菜单项写的是「重命名」，
   * 两件事混在一个接口里，用户在输入框里打个 `../x` 就把文件挪出了当前目录。
   */
  if (p === '/api/files/rename' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string; name?: string } | null
    const rel = body?.path?.trim()
    const name = body?.name?.trim()
    if (!rel || !name) return json({ error: 'invalid', message: '缺少路径或新名称' }, 422)
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      return json({ error: 'invalid', message: '名字里不能带路径分隔符' }, 422)
    }
    let abs: string
    try {
      abs = await resolveInWorkspace(d.workspaceRoot, rel, {
        mustExist: true,
        literal: true,
        followFinalSymlink: false,
      })
    } catch {
      return json({ error: 'invalid', message: `${rel} 不在这个项目里` }, 422)
    }
    try {
      return json({ node: await renameEntry(abs, rel, name) })
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
    if (!rel) return json({ error: 'invalid', message: '缺少要删除的路径' }, 422)
    let abs: string
    try {
      abs = await resolveInWorkspace(d.workspaceRoot, rel, {
        mustExist: true,
        literal: true,
        followFinalSymlink: false,
      })
    } catch {
      return json({ error: 'invalid', message: `${rel} 不在这个项目里` }, 422)
    }
    await deleteEntry(abs)
    return json({ ok: true })
  }

  if (p === '/api/files/preview') {
    const rel = q.get('path')
    if (!rel) return json({ error: 'path required' }, 400)
    const abs = await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true, literal: true })
    return json(await preview(abs, rel))
  }

  /*
   * 原始字节。PDF 预览用它：界面取回后 `createObjectURL` 交给 iframe。
   * 同一个地址在文件改写后是另一份内容，所以不许浏览器缓存。
   */
  if (p === '/api/files/raw') {
    const rel = q.get('path')
    if (!rel) return json({ error: 'path required' }, 400)
    const abs = await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true, literal: true })
    const raw = await openRaw(abs, rel)
    if (!raw) return json({ error: 'not_found' }, 404)
    return new Response(raw.body, {
      headers: { 'content-type': raw.mime, 'cache-control': 'no-store' },
    })
  }

  return null
}
