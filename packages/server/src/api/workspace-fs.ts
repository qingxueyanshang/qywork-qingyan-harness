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

import { realpath } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { CANVAS_FILE_KINDS, canvasFileKind } from '@qywork/core'
import { resolveInWorkspace } from '@qywork/tools'
import {
  classify,
  createEntry,
  deleteEntry,
  EntryExistsError,
  findByName,
  listTree,
  OFFICE_FORMATS,
  openRaw,
  preview,
  renameEntry,
} from '../files.ts'
import { bytesResponse } from '../http-util.ts'
import { scaledImage } from '../media-jobs.ts'
import { frameClipOf } from '../video/frame-clip.ts'
import { type ApiHandler, json } from './types.ts'

/** `/api/files/raw` 的 `w` 可缩小的位图类型；GIF 只取第一帧，SVG 无需缩小，均原样返回。 */
const SCALABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp'])
/** `w` 的上限：界面请求的宽度不超过画布解码档位的上限（4096）与图片预览的显示宽度。 */
const MAX_SCALED_WIDTH = 16384

/**
 * 解析后的目标是否为项目根目录本身。`.`、`./`、`a/..` 都解析为根目录；仅检查输入是否为空串时，这些写法均可通过。
 * 比较方式与 `resolveInWorkspace` 在 `followFinalSymlink: false` 下相同：父目录取 realpath，末段保留原名。
 */
async function isWorkspaceRoot(root: string, abs: string): Promise<boolean> {
  const literal = resolve(root)
  const parent = await realpath(dirname(literal)).catch(() => dirname(literal))
  return relative(resolve(parent, basename(literal)), abs) === ''
}

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
    // 带筛选参数时只返回该类文件，查询允许为空：选择文件的对话框打开时即列出文件。两种筛选只能给出一个：
    // `kinds`（逗号分隔的画布文件类别）按 `canvasFileKind` 判定；`office`（Office 格式）按预览分类 `classify` 判定。
    const query = q.get('q') ?? ''
    const kinds = q.get('kinds')
    const office = q.get('office')
    if (office !== null) {
      if (kinds !== null) {
        return json({ error: 'invalid', message: '筛选参数 kinds 与 office 不能同时给出' }, 422)
      }
      if (!OFFICE_FORMATS.has(office)) {
        return json({ error: 'invalid', message: `格式不合法：${office}` }, 422)
      }
      const accept = (path: string) => classify(path).office === office
      return json(await findByName(d.workspaceRoot, query, undefined, accept))
    }
    if (kinds === null) return json(await findByName(d.workspaceRoot, query))
    const wanted = new Set(kinds.split(','))
    if (![...wanted].every((k) => (CANVAS_FILE_KINDS as readonly string[]).includes(k))) {
      return json({ error: 'invalid', message: `类别不合法：${kinds}` }, 422)
    }
    const accept = (path: string) => {
      const kind = canvasFileKind(path)
      return kind !== null && wanted.has(kind)
    }
    return json(await findByName(d.workspaceRoot, query, undefined, accept))
  }

  /*
   * 新建文件或目录，是面板一侧唯一的写入口。
   *
   * 三条硬性口径：不合法不落盘（422）、已存在不覆盖（409）、路径越界由
   * `resolveInWorkspace` 拦截。越界转换为 422 而不是抛出为 500：这是入参问题，
   * 界面应显示路径不在项目中，而不是服务器错误。
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
   * 两种操作合并为一个接口时，用户在输入框中输入 `../x` 即可把文件移出当前目录。
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
    // 根目录改名即把整个项目文件夹移到别处。
    if (await isWorkspaceRoot(d.workspaceRoot, abs)) {
      return json({ error: 'invalid', message: '不能重命名项目根目录' }, 422)
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
   * 此处不再确认。解析后的目标是项目根目录时拒绝，否则删除整个项目。
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
    if (await isWorkspaceRoot(d.workspaceRoot, abs)) {
      return json({ error: 'invalid', message: '不能删除项目根目录' }, 422)
    }
    await deleteEntry(abs)
    return json({ ok: true })
  }

  if (p === '/api/files/preview') {
    const rel = q.get('path')
    if (!rel) return json({ error: 'path required', message: '缺少路径' }, 400)
    const abs = await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true, literal: true })
    return json(await preview(abs, rel))
  }

  /*
   * 原始字节。带非空的版本 `v`（界面传入修改时间或画布记录的版本）时地址随内容变化，按一年缓存并标为不可变：
   * 远程访问时再次打开同一文件不再经隧道传输。不带版本时同一地址在文件改写后对应另一份内容，禁止浏览器缓存。
   * 带宽度 `w` 的位图返回缩小到该宽度的版本（`scaledImage`，在计算线程中执行并缓存），界面按显示尺寸取图，原图只在放大查看时传输。
   * 带时刻 `frame`（秒）的视频返回呈现该时刻所需的帧组成的 MP4（`frameClipOf`），画布卡片的封面据此解码，不载入原视频；
   * 无法裁出时答复 415。
   */
  if (p === '/api/files/raw') {
    const rel = q.get('path')
    if (!rel) return json({ error: 'path required', message: '缺少路径' }, 400)
    const width = q.has('w') ? Number(q.get('w')) : null
    if (width !== null && !(Number.isInteger(width) && width > 0 && width <= MAX_SCALED_WIDTH)) {
      return json({ error: 'invalid', message: '宽度不合法' }, 422)
    }
    const frame = q.has('frame') ? Number(q.get('frame')) : null
    if (frame !== null && !(Number.isFinite(frame) && frame >= 0)) {
      return json({ error: 'invalid', message: '时刻不合法' }, 422)
    }
    const abs = await resolveInWorkspace(d.workspaceRoot, rel, { mustExist: true, literal: true })
    const raw = await openRaw(abs, rel)
    if (!raw) return json({ error: 'not_found', message: '文件不存在' }, 404)
    const cache = q.get('v') ? 'private, max-age=31536000, immutable' : 'no-store'
    if (frame !== null) {
      const clip = raw.mime.startsWith('video/') ? await frameClipOf(abs, frame) : null
      if (!clip) return json({ error: 'unsupported', message: '无法从该文件取帧' }, 415)
      return bytesResponse(req, clip, { 'content-type': 'video/mp4', 'cache-control': cache })
    }
    if (width !== null && SCALABLE.has(raw.mime)) {
      const out = await scaledImage(abs, raw.mime, width)
      return new Response(out.bytes, {
        headers: { 'content-type': out.mime, 'cache-control': cache },
      })
    }
    return new Response(raw.body, {
      headers: { 'content-type': raw.mime, 'cache-control': cache },
    })
  }

  return null
}
