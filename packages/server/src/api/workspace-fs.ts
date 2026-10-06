/**
 * 文件树、按名称搜索、预览与原始字节、新建 / 重命名 / 删除。
 * 右侧面板的各标签页均从此处取数。
 *
 * 写入磁盘的是 create / rename / delete 三个接口，它们使用同一套口径：
 * 入参不合法返回 422 且不落盘，目标已存在返回 409 且不覆盖，路径越界转换为 422
 * （这是入参问题，不应以 500 的形式出现在界面上）。各接口的特殊之处写在各自的注释中。
 *
 * 路径一律按 `literal` 解析，并把解析结果交给 `files.ts` 读写：查询参数已由
 * `URLSearchParams` 解码一次，请求体中的路径是字面值，再解码一次会把文件名中的
 * `%20` 等内容当作转义。create / rename / delete 操作的是目录项本身，使用
 * `followFinalSymlink: false`：跟随末段符号链接时，删除与重命名会作用于链接指向的目标。
 */

import { CANVAS_FILE_KINDS, canvasFileKind } from '@qywork/core'
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
    // 使用同一套路径约束：HTTP 入口与工具入口不能有两套安全策略。
    const dir = await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true, literal: true })
    const depth = Math.min(6, Math.max(1, Number(q.get('depth') ?? 2)))
    return json({ nodes: await listTree(dir, rel === '.' ? '' : rel, depth) })
  }

  if (p === '/api/files/find') {
    // 空查询由 `findByName` 判定（返回空结果，不返回整棵树），此处不重复判定。
    // 带 `kinds`（逗号分隔的画布文件类别）时只返回这些类别的文件，查询允许为空：画布上选择素材的对话框打开时即列出文件。
    const kinds = q.get('kinds')
    if (kinds === null) return json(await findByName(d.workspaceRoot, q.get('q') ?? ''))
    const wanted = new Set(kinds.split(','))
    if (![...wanted].every((k) => (CANVAS_FILE_KINDS as readonly string[]).includes(k))) {
      return json({ error: 'invalid', message: `类别不合法：${kinds}` }, 422)
    }
    const accept = (path: string) => {
      const kind = canvasFileKind(path)
      return kind !== null && wanted.has(kind)
    }
    return json(await findByName(d.workspaceRoot, q.get('q') ?? '', undefined, accept))
  }

  /*
   * 新建文件或目录，是面板一侧唯一的写入口。
   *
   * 三条硬性口径：不合法不落盘（422）、已存在不覆盖（409）、路径越界由
   * `resolveInWorkspace` 拦截。越界转换为 422 而不是抛出为 500：这是入参问题，
   * 用户需要看到的是路径不在项目中，而不是服务器错误。
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
      return json({ error: 'invalid', message: `${rel} 不在当前项目中` }, 422)
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
   * 重命名。新名称只能是单个名称：带分隔符即为移动，而菜单项写的是「重命名」；
   * 两种操作混在一个接口中时，用户在输入框中输入 `../x` 即可把文件移出当前目录。
   */
  if (p === '/api/files/rename' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { path?: string; name?: string } | null
    const rel = body?.path?.trim()
    const name = body?.name?.trim()
    if (!rel || !name) return json({ error: 'invalid', message: '缺少路径或新名称' }, 422)
    if (/[/\\]/.test(name) || name === '.' || name === '..') {
      return json({ error: 'invalid', message: '名称中不能包含路径分隔符' }, 422)
    }
    let abs: string
    try {
      abs = await resolveInWorkspace(d.workspaceRoot, rel, {
        mustExist: true,
        literal: true,
        followFinalSymlink: false,
      })
    } catch {
      return json({ error: 'invalid', message: `${rel} 不在当前项目中` }, 422)
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
   * 删除。目录连同其内容一并删除；确认在界面一侧完成（`ConfirmDialog`），
   * 此处不再确认。空路径直接拒绝：空路径指向工作区根目录本身。
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
      return json({ error: 'invalid', message: `${rel} 不在当前项目中` }, 422)
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
   * 原始字节。PDF 预览使用该接口：界面取回后经 `createObjectURL` 交给 iframe。
   * 文件改写后同一地址对应另一份内容，因此禁止浏览器缓存。
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
