/**
 * 记忆与技能的读写面。
 *
 * **为什么必须有这一层。** 记忆是 `<层根>/memory/*.md`、技能是 `<层根>/skills/<name>/`——项目层在
 * 工作区 `.agents/` 下，全局层在 `~/.qywork/` 下。都是普通文件，agent 通过工具随时能写。但**人看不
 * 到也删不掉**：桌面端用户手边不一定有编辑器，记错一条记忆就会一直错下去。「agent 能写、人不能管」
 * 是最不该留的不对称。
 *
 * **不重写扫描逻辑。** 列表直接调 `@qywork/tools` 导出的 `listEntries` / `scanSkills`——
 * 和工具走同一个函数。另写一份「给界面用的扫描」必然和工具那份漂移，
 * 而漂移的表现是「界面上有这条记忆，模型却说没有」。
 *
 * **记忆：能列、能删，不在网页上改正文。** 它是层目录里的文件，要改就改文件，或在会话里让模型改；
 * 这里没有读单条与写单条的接口。
 *
 * **技能：能建、能导、能删，但不能在网页上编辑正文。** 一个技能最少就是 `<目录>/SKILL.md`——建一个
 * 不需要文件管理界面，一个表单就够。所以建和删都在这里。**改正文不在**：技能目录里可以带脚本、附
 * 件，在网页上编辑一个目录需要一整套文件管理器，那是编辑器该干的事。列表回目录的绝对路径，要改就
 * 去那儿改。
 *
 * 「导入」= 把本机上一个已经存在的目录整个拷进来。**不做 `git clone <URL>`**：
 * 那等于从网上取一段内容、下次加载就用它，和插件那条边界同一个理由。
 */

import { cp, mkdir, readFile, rm, stat, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
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
 * 与 `memory.ts` 的 `safeName` 同一套规则。**不接受含 `..` / 分隔符的 key**，
 * 而且安全化之后还要再过一遍工作区边界——安全化规则将来可能被放宽，
 * 边界检查是最后一道。
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
 * 写哪一层。
 *
 * 默认项目层——模型写入与用户手动记录都该落在跟着项目走的那份。全局层要显式指定，
 * 因为它对所有工作区生效，那个决定不该由默认值替用户做。
 *
 * **内置层不可写**：它随程序一同发布，写入后将在下次升级时丢失，而界面会显示保存成功。
 */
function writableScope(raw: string | null): Scope | null {
  if (raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

/** 某一层里某条记忆的绝对路径。`key` 已经安全化过，不含分隔符。 */
function memoryFile(workspaceRoot: string, scope: Scope, key: string): string | null {
  const dir = scopeDir(scopeRoots(workspaceRoot), scope, MEMORY_SUBDIR)
  return dir === null ? null : join(dir, `${key}.md`)
}

export const handleMemoryApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/memory' && req.method === 'GET') {
    const roots = scopeRoots(d.workspaceRoot)
    return json({
      // 每一层的目录都报出来，无论是否有内容都予以报出：「应在何处添加」比「此处为空」更有价值。
      dirs: scopePaths(roots, MEMORY_SUBDIR),
      // **全部层的全部条目，被盖住的也回**：设置页按层分列，去重之后被项目层
      // 盖住的那条全局记忆会从界面上消失，而用户正是要在全局那一栏里找到它、
      // 并知道它为什么不生效。哪条生效由 `shadowedBy === null` 判定。
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
      return json({ error: 'bad request', message: '只能删项目层或全局层的条目' }, 400)
    }
    // 项目层多过一遍工作区边界：安全化规则将来可能被放宽，这是最后一道。
    // 全局层不在工作区里，靠的是 `safeKey` 已经把分隔符和 `..` 全清掉了。
    const file =
      scope === 'project'
        ? await resolveInWorkspace(d.workspaceRoot, join(MEMORY_DIR, `${key}.md`), {
            mustExist: false,
          })
        : memoryFile(d.workspaceRoot, scope, key)
    if (file === null) return json({ error: 'bad request', message: '这一层不可写' }, 400)

    if (req.method === 'DELETE') {
      // 删一个本来就不存在的键回 404 而不是静默成功：静默成功会让
      // 「删了却还在」变成一个查不出原因的问题。
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
      // 同 `/api/memory`：全部层全部条目，被同名盖住的标出来。
      skills: (await scanAllSkills(roots)).map((x) => ({ ...x.item, shadowedBy: x.shadowedBy })),
    })
  }

  /**
   * 导入一个技能目录：把本机上已经存在的那个整个拷进来。
   *
   * 拷之前先确认它里面真有 `SKILL.md`。不确认的话，指错目录会「导入成功」，
   * 然后在列表里一条都不出现——扫描器对没有 SKILL.md 的目录是静默跳过的。
   */
  if (p === '/api/skills/import' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { scope?: string; path?: string } | null
    const scope = writableScope(body?.scope ?? null)
    if (!scope) return json({ error: 'bad request', message: '只能写项目层或全局层' }, 400)
    const src = body?.path?.trim()
    if (!src) return json({ error: 'bad request', message: '缺少目录路径' }, 400)

    if (!(await readFile(join(src, 'SKILL.md'), 'utf8').catch(() => null))) {
      return json({ error: 'invalid', message: `目录里没有 SKILL.md：${src}` }, 422)
    }
    const dirName = safeKey(basename(src))
    if (!dirName) return json({ error: 'invalid', message: '目录名里没有可用的字符' }, 422)

    const root = scopeDir(scopeRoots(d.workspaceRoot), scope, SKILLS_SUBDIR)
    if (root === null) return json({ error: 'bad request', message: '这一层不可写' }, 400)
    const dest = join(root, dirName)
    if (resolve(src) === resolve(dest)) return json({ ok: true, name: dirName, dir: dest })
    if (await stat(dest).catch(() => null)) {
      return json({ error: 'conflict', message: `这一层已经有一个 ${dirName} 了` }, 409)
    }
    await mkdir(root, { recursive: true })
    await cp(src, dest, { recursive: true })
    return json({ ok: true, name: dirName, dir: dest })
  }

  const skillMatch = /^\/api\/skills\/([^/]+)$/.exec(p)
  if (skillMatch && req.method === 'DELETE') {
    // 删的是**目录名**不是前置元信息里的 name：那两个可以不一样，而盘上只有目录。
    const dirName = decodeURIComponent(skillMatch[1] as string)
    if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) {
      return json({ error: 'bad request' }, 400)
    }
    const scope = writableScope(url.searchParams.get('scope'))
    if (!scope) return json({ error: 'bad request', message: '只能删项目层或全局层' }, 400)
    const root = scopeDir(scopeRoots(d.workspaceRoot), scope, SKILLS_SUBDIR)
    if (root === null) return json({ error: 'bad request', message: '这一层不可写' }, 400)
    const dir = join(root, dirName)
    // 删一个本来就不存在的回 404 而不是静默成功：静默成功会让
    // 「删了却还在」变成一个查不出原因的问题。
    if (!(await stat(dir).catch(() => null))) return json({ error: 'not found' }, 404)
    await rm(dir, { recursive: true, force: true })
    return json({ ok: true })
  }

  return null
}
