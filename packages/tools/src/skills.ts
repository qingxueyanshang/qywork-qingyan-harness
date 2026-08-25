/**
 * 技能。
 *
 * 技能 = 一个目录里的 `SKILL.md`，前置元信息声明 name/description，正文是操作指南。
 * 与记忆的区别：**记忆是事实，技能是流程**。「这个项目用 pnpm」是记忆，
 * 「怎么发一个版本」是技能。
 *
 * **按需加载，索引进尾区，正文只在被读时才进上下文。** 这是技能体系的全部价值。把所有技能正文都塞进
 * system prompt 的话，十个技能就能占掉几万 token，而一次任务通常只用得上其中一个。
 *
 * 所以：**索引**（name + description，每条一行）进尾区注记，模型看到后
 * 自己决定要不要 `read_skill` 拉全文。
 *
 * 索引同样**永不进冻结前缀**——用户装一个技能就会让整个 provider 缓存失效。
 *
 * **三层作用域，技能全程只读。** 工作区 `.agents/skills/`（项目层）和 `~/.qywork/skills/`（全局层）
 * 都扫，同名先到的赢。技能没有任何写接口——它是一个目录（`SKILL.md` + 附带脚本），在网页上编辑一
 * 个目录需要一整套文件管理界面，而那是编辑器该干的事。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import {
  type Scope,
  type ScopedItem,
  type ScopeRoots,
  scanAllScopes,
  scanScoped,
  scopeRoots,
} from './scopes.ts'

/** 各层根目录下装技能的那个子目录。`.agents/skills` 是跨客户端约定的那条。 */
export const SKILLS_SUBDIR = 'skills'
/** 项目层技能相对工作区的路径。 */
export const SKILLS_DIR = `.agents/${SKILLS_SUBDIR}`

export interface SkillMeta {
  name: string
  description: string
  /**
   * 技能目录的**绝对路径**。
   *
   * 不能相对工作区：全局层的技能不在工作区里，相对路径表达不了它，
   * 而拼出来的 `../../..` 既读不懂、回填给工具还会指向别处。
   */
  dir: string
  scope: Scope
}

/**
 * 扫一个目录里的技能。
 *
 * 单个技能坏了（缺 SKILL.md、前置元信息写错）**只跳过它自己**，不影响其余——
 * 一个手滑的技能包让整个技能体系不可用是不可接受的。
 */
export async function scanSkillDir(root: string, scope: Scope): Promise<SkillMeta[]> {
  const names = await readdir(root).catch(() => [] as string[])
  const out: SkillMeta[] = []

  for (const name of names.sort()) {
    const dir = join(root, name)
    const s = await stat(dir).catch(() => null)
    if (!s?.isDirectory()) continue

    const text = await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null)
    if (text === null) continue

    const meta = parseFrontmatter(text)
    // description 是模型判断「何时用这个技能」的唯一依据。没有就等于装了也不会被用到，
    // 与其静默收录一个永远不会触发的技能，不如跳过并让它在扫描结果里缺席。
    if (!meta.description) continue

    out.push({
      name: meta.name || name,
      description: meta.description,
      dir,
      scope,
    })
  }
  return out
}

/**
 * 三层合起来的技能索引。同名只留优先级最高的那个。
 *
 * **加载器和设置页共用这一个函数。** 两边各扫一遍的话，菜单描述的是一个技能、
 * 跑的是另一个——而这种错只在同名时才犯，最难被当成 bug 报出来。
 */
export function scanSkills(rootsOrWorkspace: string | ScopeRoots): Promise<SkillMeta[]> {
  const roots =
    typeof rootsOrWorkspace === 'string' ? scopeRoots(rootsOrWorkspace) : rootsOrWorkspace
  return scanScoped(roots, SKILLS_SUBDIR, scanSkillDir, (s) => s.name)
}

/**
 * 每一层各自装了哪些技能，被同名盖住的也在里面。
 *
 * 设置页按层分列要的是这一份。去重之后被盖住的那个直接消失，而「全局装了一个
 * 同名技能、生效的却是项目里那个」正是靠它才答得出来。
 */
export function scanAllSkills(roots: ScopeRoots): Promise<ScopedItem<SkillMeta>[]> {
  return scanAllScopes(roots, SKILLS_SUBDIR, scanSkillDir, (s) => s.name)
}

/**
 * 解析 YAML 前置元信息。
 *
 * 只认 `name` 和 `description` 两个标量键，不引 YAML 库：技能元信息就这两个字段，
 * 为它引一个解析器（以及它的攻击面）不划算。写了别的键会被安静忽略——
 * 这里宽松是对的，将来加字段时旧技能不会因此报错。
 */
export function parseFrontmatter(text: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return { name: '', description: '' }

  const out = { name: '', description: '' }
  for (const line of m[1]!.split('\n')) {
    const kv = /^\s*(name|description)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2]!.trim()
    // 去掉可选的引号。YAML 的多行标量不支持——技能描述是一句话，需要多行说明就写正文。
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[kv[1] as 'name' | 'description'] = value
  }
  return out
}

export const readSkillTool: ToolSpec = {
  name: 'read_skill',
  description: '读取一个技能的完整内容（操作步骤）。名称从尾区的技能索引里取。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名称' } },
    required: ['name'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '技能',
  category: 'skills',
  facet: '技能',
  summary: '读一个技能的完整操作步骤',
  targetExtractor: (a) => (typeof a.name === 'string' ? a.name : null),
  permissionEffect: 'internal_control',
  parallelSafe: true,
  resourceKeys: (a) => [`skill:${String(a.name ?? '')}`],

  async fn(args, ctx) {
    const wanted = String(args.name ?? '').trim()
    if (!wanted) return { status: 'failure', message: '缺少 name' }

    const skills = await scanSkills(ctx.workspaceRoot)
    const hit = skills.find((s) => s.name === wanted || s.dir.endsWith(wanted))
    if (!hit) {
      // 列出可用的名字而不是只说「找不到」：模型通常是名字记错了一个字，
      // 给它候选它下一轮就能自己修正。
      return {
        status: 'failure',
        message: `没有技能 ${wanted}${skills.length ? `。可用：${skills.map((s) => s.name).join('、')}` : ''}`,
        errorKind: 'not_found',
      }
    }

    const text = await readFile(join(hit.dir, 'SKILL.md'), 'utf8').catch(() => null)
    if (text === null) {
      return { status: 'failure', message: `技能 ${wanted} 的 SKILL.md 读取失败` }
    }
    return { status: 'success', message: text, data: { name: hit.name, dir: hit.dir } }
  },
}
