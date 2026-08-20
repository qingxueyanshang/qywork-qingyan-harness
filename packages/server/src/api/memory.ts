/**
 * 记忆与技能的读写面。
 *
 * ## 为什么必须有这一层
 *
 * 记忆是 `.qy/memory/*.md`、技能是 `.qy/skills/<name>/`，都是工作区里的普通文件，
 * agent 通过工具随时能写。但**人看不到也删不掉**——`.qy/` 是权限边界
 * （`agent/src/policy.ts`），桌面端用户手边不一定有编辑器，
 * 记错一条记忆就会一直错下去。「agent 能写、人不能管」是最不该留的不对称。
 *
 * ## 不重写扫描逻辑
 *
 * 列表直接调 `@qywork/tools` 导出的 `listEntries` / `scanSkills`——
 * 和工具走同一个函数。另写一份「给界面用的扫描」必然和工具那份漂移，
 * 而漂移的表现是「界面上有这条记忆，模型却说没有」。
 *
 * ## 技能只读
 *
 * 技能是一个目录（`SKILL.md` + 附带脚本），不是单个文本；在网页上编辑一个目录
 * 需要一整套文件管理界面，而那正是编辑器该干的事。这里只回「装了哪些、
 * 在哪个目录、说明是什么」，改动请用编辑器——写不了就说清写不了，
 * 不做一个只能改标题的假编辑器。
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  listAllScopedEntries,
  listScopedEntries,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MEMORY_DIR,
  MEMORY_SUBDIR,
  resolveInWorkspace,
  type Scope,
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
 * 默认项目层——AI 和「随手记一条」都该落在跟着项目走的那份。全局层要显式指定，
 * 因为它对所有工作区生效，那个决定不该由默认值替用户做。
 *
 * **内置层不可写**：它随程序发布，写进去下次升级就没了，而用户会以为存住了。
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
      // 每一层的目录都报出来，有没有内容都报——「该去哪儿加」比「这里是空的」有用。
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
      return json({ error: 'bad request', message: '只能写项目层或全局层' }, 400)
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

    /**
     * 读单条的**全文**。
     *
     * 列表接口只回首行摘要（`listEntries` 的 `preview`），够渲染列表，不够编辑。
     * 没有这条接口的话，界面只能把摘要塞进编辑框，用户不改任何字点一下保存，
     * 正文就被截成一行——静默、不可恢复。靠界面上一句「这是摘要不是全文」挡着
     * 不算修，那是拿文案给结构缺陷打补丁。
     *
     * 不存在回 404 而不是空串：空串会被编辑器当成「这条是空的」照常保存下去。
     */
    if (req.method === 'GET') {
      // 读**认作用域**，读的就是下面 PUT / DELETE 要写的那个文件。
      //
      // 不能按优先级找：设置页按层分列，被项目层盖住的那条全局记忆照样列在
      // 全局那一栏里、照样点得开。按优先级找会把项目层那份的正文填进编辑框，
      // 用户不改任何字点一下保存，全局那条就被项目那条的内容覆盖了。
      const text = await readFile(file, 'utf8').catch(() => null)
      return text === null ? json({ error: 'not found' }, 404) : json({ key, content: text, scope })
    }

    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => null)) as { content?: string } | null
      const content = (body?.content ?? '').trim()
      // 校验先于落盘：不合法直接 422 且不写一半。
      if (!content) return json({ error: 'invalid', message: '内容为空' }, 422)
      if (content.length > MAX_ENTRY_CHARS) {
        return json(
          {
            error: 'invalid',
            message: `单条记忆最多 ${MAX_ENTRY_CHARS} 字符，当前 ${content.length}——这么长该写成文档`,
          },
          422,
        )
      }
      // 条数上限必须和工具那边**同样生效**。只在工具侧拦的话，界面成了绕过它的路：
      // 尾区索引每轮都发，无上限地涨下去会慢慢吃掉整个上下文，
      // 而表现是「模型越用越笨」——没人会联想到是记忆条数。
      const existing = await listScopedEntries(scopeRoots(d.workspaceRoot))
      if (existing.length >= MAX_ENTRIES && !existing.some((e) => e.key === key)) {
        return json(
          { error: 'invalid', message: `记忆已达 ${MAX_ENTRIES} 条上限，先删掉不再需要的` },
          422,
        )
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${content}\n`, 'utf8')
      return json({ ok: true, key })
    }

    if (req.method === 'DELETE') {
      // 删一个本来就不存在的键回 404 而不是静默成功：静默成功会让
      // 「我明明删了它还在」变成一个查不出原因的问题。
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
      dirs: scopePaths(roots, 'skills'),
      // 同 `/api/memory`：全部层全部条目，被同名盖住的标出来。
      skills: (await scanAllSkills(roots)).map((x) => ({ ...x.item, shadowedBy: x.shadowedBy })),
    })
  }

  return null
}
