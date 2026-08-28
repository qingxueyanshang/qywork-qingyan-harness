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
 * **三层作用域，读跨层，写默认项目层。** 工作区 `.agents/skills/`（项目层）和 `~/.qywork/skills/`
 * （全局层）都扫，同名先到的赢。用户明确指定全局时写入全局；迁移由单个工具完成，目标冲突时不改来源，
 * 成功后不保留双份。
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { resolveInWorkspace } from './paths.ts'
import {
  type Scope,
  type ScopedItem,
  type ScopeRoots,
  scanAllScopes,
  scanScoped,
  scopeDir,
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

type WritableScope = Exclude<Scope, 'builtin'>

function writableScope(raw: unknown): WritableScope | null {
  if (raw === undefined || raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

function safeDirName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || null
}

function scopeProperty(): Record<string, unknown> {
  return {
    type: 'string',
    enum: ['project', 'global'],
    description: '写入层；不传默认 project，用户明确要求全局时必须传 global',
  }
}

function skillRoot(workspaceRoot: string, scope: WritableScope): string {
  const root = scopeDir(scopeRoots(workspaceRoot), scope, SKILLS_SUBDIR)
  if (root === null) throw new Error('这一层不可写')
  return root
}

/** 先在同层临时目录组好完整技能，再用目录改名提交，避免写到一半留下残缺技能。 */
async function commitSkill(
  target: string,
  markdown: string,
  files: { path: string; content: string }[],
): Promise<boolean> {
  const existed = (await stat(target).catch(() => null)) !== null
  const parent = join(target, '..')
  await mkdir(parent, { recursive: true })
  const temp = `${target}.qywork-writing-${crypto.randomUUID()}`
  const backup = `${target}.qywork-backup-${crypto.randomUUID()}`
  try {
    if (existed) await cp(target, temp, { recursive: true, errorOnExist: true, force: false })
    else await mkdir(temp, { recursive: false })
    await writeFile(join(temp, 'SKILL.md'), markdown, 'utf8')
    for (const file of files) {
      const dest = await resolveInWorkspace(temp, file.path, { mustExist: false })
      await mkdir(join(dest, '..'), { recursive: true })
      await writeFile(dest, file.content, 'utf8')
    }
    if (existed) await rename(target, backup)
    try {
      await rename(temp, target)
    } catch (err) {
      if (existed) await rename(backup, target).catch(() => undefined)
      throw err
    }
    if (existed) await rm(backup, { recursive: true, force: true })
    return existed
  } catch (err) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
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
    return {
      status: 'success',
      message: text,
      data: { name: hit.name, dir: hit.dir, scope: hit.scope },
    }
  },
}

export const writeSkillTool: ToolSpec = {
  name: 'write_skill',
  description:
    '创建或更新一个 qywork 技能。默认写项目层；用户明确要求全局时 scope 必须传 global。content 是 SKILL.md 的正文，不含前置元信息；附带脚本或模板放在 files。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名称' },
      description: { type: 'string', description: '一句话说明何时使用这个技能' },
      content: { type: 'string', description: '操作指南正文，不含 YAML 前置元信息' },
      scope: scopeProperty(),
      files: {
        type: 'array',
        description: '可选的附带文本文件，路径相对技能目录',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对技能目录的文件路径' },
            content: { type: 'string', description: '文件正文' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    required: ['name', 'description', 'content'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '技能',
  category: 'skills',
  facet: '技能',
  summary: '创建或更新一个技能',
  targetExtractor: (a) => (typeof a.name === 'string' ? a.name : null),
  permissionEffect: 'write',
  parallelSafe: false,
  resourceKeys: (a) => [`skill:${String(a.scope ?? 'project')}:${String(a.name ?? '*')}`],

  async fn(args, ctx) {
    const name = String(args.name ?? '').trim()
    const description = String(args.description ?? '').trim()
    const content = String(args.content ?? '').trim()
    const dirName = safeDirName(name)
    const scope = writableScope(args.scope)
    if (!dirName) return { status: 'failure', message: 'name 为空或全是非法字符' }
    if (!description) return { status: 'failure', message: 'description 为空' }
    if (!content) return { status: 'failure', message: 'content 为空' }
    if (!scope) return { status: 'failure', message: 'scope 只能是 project 或 global' }

    const rawFiles = Array.isArray(args.files) ? args.files : []
    const files: { path: string; content: string }[] = []
    for (const raw of rawFiles) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { status: 'failure', message: 'files 的每一项都必须包含 path 和 content' }
      }
      const item = raw as Record<string, unknown>
      const path = String(item.path ?? '').trim()
      if (!path || path === 'SKILL.md') {
        return { status: 'failure', message: '附带文件路径不能为空，也不能覆盖 SKILL.md' }
      }
      files.push({ path, content: String(item.content ?? '') })
    }

    const root = skillRoot(ctx.workspaceRoot, scope)
    const target = join(root, dirName)
    const markdown = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}\n`
    try {
      const replaced = await commitSkill(target, markdown, files)
      return {
        status: 'success',
        message: `已${replaced ? '更新' : '创建'}${scope === 'global' ? '全局' : '项目'}技能 ${name}`,
        data: {
          name,
          scope,
          dir: target,
          replaced,
          files: ['SKILL.md', ...files.map((f) => f.path)],
        },
      }
    } catch (err) {
      return { status: 'failure', message: `写入技能失败：${String(err)}` }
    }
  },
}

export const moveSkillTool: ToolSpec = {
  name: 'move_skill',
  description:
    '把一个技能目录从项目层迁移到全局层，或从全局层迁回项目层。成功后只保留目标副本；目标层已有同目录时拒绝且保留原件。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名称或技能目录名' },
      from_scope: scopeProperty(),
      to_scope: scopeProperty(),
    },
    required: ['name', 'from_scope', 'to_scope'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '技能',
  category: 'skills',
  facet: '技能',
  summary: '在项目层与全局层之间迁移技能',
  targetExtractor: (a) => (typeof a.name === 'string' ? a.name : null),
  permissionEffect: 'delete',
  parallelSafe: false,
  resourceKeys: (a) => [
    `skill:${String(a.from_scope ?? '*')}:${String(a.name ?? '*')}`,
    `skill:${String(a.to_scope ?? '*')}:${String(a.name ?? '*')}`,
  ],

  async fn(args, ctx) {
    const wanted = String(args.name ?? '').trim()
    const from = writableScope(args.from_scope)
    const to = writableScope(args.to_scope)
    if (!wanted) return { status: 'failure', message: '缺少 name' }
    if (!from || !to) return { status: 'failure', message: '作用域只能是 project 或 global' }
    if (from === to) return { status: 'failure', message: '迁移的来源层和目标层不能相同' }

    const fromRoot = skillRoot(ctx.workspaceRoot, from)
    const sourceSkills = await scanSkillDir(fromRoot, from)
    const hit = sourceSkills.find((s) => s.name === wanted || basename(s.dir) === wanted)
    if (!hit) {
      return { status: 'failure', message: `${from} 层没有技能 ${wanted}`, errorKind: 'not_found' }
    }
    const target = join(skillRoot(ctx.workspaceRoot, to), basename(hit.dir))
    if (await stat(target).catch(() => null)) {
      return {
        status: 'failure',
        message: `${to} 层已有同目录技能 ${basename(hit.dir)}，未迁移任何文件`,
      }
    }

    await mkdir(join(target, '..'), { recursive: true })
    const temp = `${target}.qywork-moving-${crypto.randomUUID()}`
    try {
      await cp(hit.dir, temp, { recursive: true, errorOnExist: true, force: false })
      await rename(temp, target)
      try {
        await rm(hit.dir, { recursive: true, force: false })
      } catch (err) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        throw err
      }
    } catch (err) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      return { status: 'failure', message: `迁移技能失败，原件仍在 ${from} 层：${String(err)}` }
    }

    return {
      status: 'success',
      message: `已把技能 ${hit.name} 从 ${from} 层迁移到 ${to} 层，只保留目标副本`,
      data: {
        name: hit.name,
        from_scope: from,
        to_scope: to,
        from_dir: hit.dir,
        to_dir: target,
      },
    }
  },
}
