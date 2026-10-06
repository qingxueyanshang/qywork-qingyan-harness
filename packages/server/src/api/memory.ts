/**
 * 记忆与技能的读写接口。
 *
 * **必要性。** 记忆是 `<层根>/memory/*.md`，技能是 `<层根>/skills/<name>/`；项目层位于
 * 工作区 `.agents/` 下，全局层位于 `~/.qywork/` 下。二者都是普通文件，agent 可以随时通过工具写入，
 * 但用户无法查看与删除：桌面端用户不一定有编辑器，一条错误的记忆会持续生效。agent 可写而用户
 * 无法管理，是必须消除的不对称。
 *
 * **不重写扫描逻辑。** 列表直接调用 `@qywork/tools` 导出的 `listAllScopedEntries` / `scanAllSkills`，
 * 与工具使用同一组函数。另写一份供界面使用的扫描必然与工具的实现产生差异，
 * 表现为界面上有某条记忆而模型报告没有。
 *
 * **记忆：可列出、可删除，不在网页上修改正文。** 记忆是层目录中的文件，修改时直接编辑文件，
 * 或在会话中让模型修改；此处没有读取与写入单条记忆的接口。
 *
 * **技能：可列出、可导入、可删除，不在网页上编辑正文。** 技能目录中可以包含脚本与附件，
 * 在网页上编辑一个目录需要完整的文件管理器，这属于编辑器的职责。列表返回目录的绝对路径，
 * 修改时直接编辑该目录。
 *
 * 导入：把本机上已存在的目录或 ZIP 复制进来。不做 `git clone <URL>`：
 * 那等于从网络获取一段内容并在下次加载时使用，理由与插件的边界相同。
 */

import { rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  importSkills,
  listAllScopedEntries,
  MEMORY_DIR,
  MEMORY_SUBDIR,
  resolveInWorkspace,
  type Scope,
  SKILLS_SUBDIR,
  scanAllSkills,
  scopeDir,
  scopePaths,
  scopeRoots,
} from '@qywork/tools'
import type { ApiHandler } from './types.ts'
import { json } from './types.ts'

/**
 * key 安全化。
 *
 * 与 `tools/src/memory.ts` 的 `safeName` 使用同一套规则。不接受含 `..` 或分隔符的 key，
 * 安全化之后仍需再经过一次工作区边界检查：安全化规则将来可能放宽，
 * 边界检查是最后一道防线。
 */
function safeKey(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || null
}

/**
 * 写入的层。
 *
 * 默认项目层：模型写入与用户手动记录都应写入随项目存在的那一层。全局层必须显式指定，
 * 因为它对所有工作区生效，不应由默认值替用户决定。
 *
 * 内置层不可写：它随程序一同发布，写入后将在下次升级时丢失，而界面会显示保存成功。
 */
function writableScope(raw: string | null): 'project' | 'global' | null {
  if (raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

/** 某一层中某条记忆的绝对路径。`key` 已经过安全化，不含分隔符。 */
function memoryFile(workspaceRoot: string, scope: Scope, key: string): string | null {
  const dir = scopeDir(scopeRoots(workspaceRoot), scope, MEMORY_SUBDIR)
  return dir === null ? null : join(dir, `${key}.md`)
}

export const handleMemoryApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/memory' && req.method === 'GET') {
    const roots = scopeRoots(d.workspaceRoot)
    return json({
      // 每一层的目录均返回，无论是否有内容：告知应在何处添加比告知此处为空更有价值。
      dirs: scopePaths(roots, MEMORY_SUBDIR),
      // 返回全部层的全部条目，包括被覆盖的条目：设置页按层分列，去重后被项目层
      // 覆盖的全局记忆会从界面上消失，而用户正需要在全局一栏中找到它，
      // 并了解它不生效的原因。生效与否由 `shadowedBy === null` 判定。
      entries: (await listAllScopedEntries(roots)).map((x) => ({
        ...x.item,
        shadowedBy: x.shadowedBy,
      })),
    })
  }

  if (p.startsWith('/api/memory/')) {
    const raw = decodeURIComponent(p.slice('/api/memory/'.length))
    const key = safeKey(raw)
    if (!key) return json({ error: 'bad request', message: 'key 为空或全是非法字符' }, 400)

    const scope = writableScope(url.searchParams.get('scope'))
    if (!scope) {
      return json({ error: 'bad request', message: '只能删除项目层或全局层的条目' }, 400)
    }
    // 项目层额外经过一次工作区边界检查：安全化规则将来可能放宽，这是最后一道防线。
    // 全局层不在工作区内，依靠 `safeKey` 已清除全部分隔符与 `..`。
    const file =
      scope === 'project'
        ? await resolveInWorkspace(d.workspaceRoot, join(MEMORY_DIR, `${key}.md`), {
            mustExist: false,
          })
        : memoryFile(d.workspaceRoot, scope, key)
    if (file === null) return json({ error: 'bad request', message: '该层不可写' }, 400)

    if (req.method === 'DELETE') {
      // 删除不存在的键时返回 404 而不是静默成功：静默成功会使「删除后仍存在」
      // 成为无法查明原因的问题。
      const gone = await unlink(file).then(
        () => true,
        () => false,
      )
      return gone ? json({ ok: true }) : json({ error: 'not found' }, 404)
    }
  }

  if (p === '/api/skills' && req.method === 'GET') {
    const roots = scopeRoots(d.workspaceRoot)
    return json({
      dirs: scopePaths(roots, SKILLS_SUBDIR),
      // 与 `/api/memory` 相同：返回全部层的全部条目，并标出被同名条目覆盖的条目。
      skills: (await scanAllSkills(roots)).map((x) => ({ ...x.item, shadowedBy: x.shadowedBy })),
    })
  }

  if (p === '/api/skills/import' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      scope?: string
      path?: string
      replace?: boolean
    } | null
    const scope = writableScope(body?.scope ?? null)
    if (!scope) return json({ error: 'bad request', message: '只能写入项目层或全局层' }, 400)
    const src = body?.path?.trim()
    if (!src) return json({ error: 'bad request', message: '缺少目录或 ZIP 路径' }, 400)
    const result = await importSkills(d.workspaceRoot, scope, src, body?.replace === true)
    return json(
      { ...result, message: result.failures.map((f) => f.error).join('；') },
      result.ok ? 200 : result.failures.some((f) => f.kind === 'conflict') ? 409 : 422,
    )
  }

  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(p)
  if (skillMatch && req.method === 'DELETE') {
    // 删除的是目录名，而不是前置元信息中的 name：两者可以不同，而磁盘上只有目录。
    const dirName = decodeURIComponent(skillMatch[1] as string)
    if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) {
      return json({ error: 'bad request' }, 400)
    }
    const scope = writableScope(url.searchParams.get('scope'))
    if (!scope) return json({ error: 'bad request', message: '只能删除项目层或全局层的技能' }, 400)
    const root = scopeDir(scopeRoots(d.workspaceRoot), scope, SKILLS_SUBDIR)
    if (root === null) return json({ error: 'bad request', message: '该层不可写' }, 400)
    const dir = join(root, dirName)
    // 删除不存在的目录时返回 404 而不是静默成功：静默成功会使「删除后仍存在」
    // 成为无法查明原因的问题。
    if (!(await stat(dir).catch(() => null))) return json({ error: 'not found' }, 404)
    await rm(dir, { recursive: true, force: true })
    return json({ ok: true })
  }

  return null
}
