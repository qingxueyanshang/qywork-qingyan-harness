/**
 * 技能。
 *
 * 技能是目录中的 `SKILL.md`：前置元信息声明 name/description，正文是操作指南。
 * 与记忆的区别：记忆是事实，技能是流程。「这个项目用 pnpm」是记忆，
 * 「如何发布一个版本」是技能。
 *
 * 按需加载：索引放在上下文末尾，正文只在被读取时进入上下文。这是技能体系的核心价值。
 * 若把所有技能正文都写入 system prompt，十个技能即可占用数万 token，而一次任务通常只用到其中一个。
 *
 * 因此索引（name + description，每条一行）写入上下文末尾的注记，模型据此
 * 自行决定是否调用 `read_skill` 读取全文。
 *
 * 索引同样不进入冻结前缀：否则用户安装一个技能就会使整个 provider 缓存失效。
 *
 * 三层作用域，读取跨层，写入默认项目层。工作区 `.agents/skills/`（项目层）和 `~/.qywork/skills/`
 * （全局层）都会扫描，同名时以先扫描到的为准。用户明确指定全局时写入全局；迁移由单个工具完成，
 * 目标冲突时不修改来源，成功后不保留两份副本。
 */

import { cp, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { type CloudSkill, isSkillDescription, parseSkillFrontmatter } from '@qywork/core'
import { CloudSkillPort } from './cloud-skills/port.ts'
import {
  CLOUD_SKILL_SCHEME,
  cloudSkillDir,
  cloudTarget,
  readCloudFile,
} from './cloud-skills/source.ts'
import { resolveInWorkspace, resolveWritablePath, rootsOf } from './paths.ts'
import {
  type Scope,
  type ScopedItem,
  type ScopeRoots,
  scanAllScopes,
  scopeDir,
  scopeRoots,
} from './scopes.ts'
import { deliverReadable } from './sink.ts'
import { commitSkillDirectory, importSkills } from './skills/install.ts'
import { SkillSourcePaths } from './skills/port.ts'

/** 各层根目录下存放技能的子目录。`.agents/skills` 是跨客户端约定的路径。 */
export const SKILLS_SUBDIR = 'skills'
/** 项目层技能相对工作区的路径。 */
export const SKILLS_DIR = `.agents/${SKILLS_SUBDIR}`

export interface SkillMeta {
  name: string
  description: string
  /**
   * 技能目录的绝对路径。
   *
   * 不能相对于工作区：全局层的技能不在工作区中，相对路径无法表示，
   * 拼接出的 `../../..` 既难以阅读，回填给工具时还会指向错误位置。
   */
  dir: string
  scope: Scope
}

/**
 * 扫描一个目录中的技能。
 *
 * 单个技能损坏（缺少 SKILL.md、前置元信息有误）时只跳过该技能，不影响其余技能：
 * 一个有误的技能包不应使整个技能体系不可用。
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

    const meta = parseSkillFrontmatter(text)
    // 缺少可用的 description 时技能安装后也不会被使用，因此跳过，不收录一个不会被触发的技能。
    if (!isSkillDescription(meta.description)) continue

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
 * 合并后的技能索引。同名时只保留优先级最高的一项。`cloud` 是本轮可用的内置技能（`CloudSkillPort` 的
 * `packages`），没有时传空数组。
 *
 * 加载器、`read_skill` 和设置页共用此函数。各自扫描时，菜单描述的是一个技能、
 * 实际执行的是另一个；这种错误只在同名时出现，最难被识别为缺陷。
 */
export async function scanSkills(
  rootsOrWorkspace: string | ScopeRoots,
  cloud: readonly CloudSkill[],
): Promise<SkillMeta[]> {
  const roots =
    typeof rootsOrWorkspace === 'string' ? scopeRoots(rootsOrWorkspace) : rootsOrWorkspace
  return (await scanAllSkills(roots, cloud)).filter((x) => x.shadowedBy === null).map((x) => x.item)
}

/**
 * 每一层各自安装的技能，包括被同名技能覆盖的项。内置技能排在最前，层为 `builtin`、目录为 `cloud-skill://<标识>`；
 * 同名的本地技能标为被内置层覆盖。
 *
 * 设置页按层分列时使用此结果。去重后被覆盖的项直接消失，而「全局安装了同名技能、
 * 生效的却是项目层的技能」这一情况只能依据此结果说明。
 */
export async function scanAllSkills(
  roots: ScopeRoots,
  cloud: readonly CloudSkill[],
): Promise<ScopedItem<SkillMeta>[]> {
  const taken = new Set<string>()
  const out: ScopedItem<SkillMeta>[] = []
  for (const p of cloud) {
    const item: SkillMeta = {
      name: p.name,
      description: p.description,
      dir: cloudSkillDir(p.id),
      scope: 'builtin',
    }
    out.push({ item, shadowedBy: taken.has(item.name) ? 'builtin' : null })
    taken.add(item.name)
  }
  for (const x of await scanAllScopes(roots, SKILLS_SUBDIR, scanSkillDir, (s) => s.name)) {
    out.push(taken.has(x.item.name) ? { ...x, shadowedBy: 'builtin' } : x)
  }
  return out
}

/** 内置技能的目录（`cloud-skill://<标识>`）。本地技能的目录是绝对路径。 */
export function isCloudSkillDir(dir: string): boolean {
  return dir.startsWith(CLOUD_SKILL_SCHEME)
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
    description: '写入层；不传时默认 project，用户明确要求全局时必须传 global',
  }
}

function skillRoot(workspaceRoot: string, scope: WritableScope): string {
  const root = scopeDir(scopeRoots(workspaceRoot), scope, SKILLS_SUBDIR)
  if (root === null) throw new Error('该层不可写')
  return root
}

export const readSkillTool: ToolSpec = {
  name: 'read_skill',
  description: '读取一个技能的完整内容（操作步骤）。名称取自上下文末尾的技能索引。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名称' } },
    required: ['name'],
    additionalProperties: false,
  },
  verb: '读取',
  category: 'skills',
  facet: '技能',
  summary: '读取一个技能的完整操作步骤',
  targetExtractor: (a) => (typeof a.name === 'string' ? a.name : null),
  permissionEffect: 'internal_control',
  parallelSafe: true,
  resourceKeys: (a) => [`skill:${String(a.name ?? '')}`],

  async fn(args, ctx) {
    const wanted = String(args.name ?? '').trim()
    if (!wanted) return { status: 'failure', message: '缺少 name' }

    const skills = await scanSkills(ctx.workspaceRoot, ctx.port(CloudSkillPort)?.packages ?? [])
    const hit = skills.find((s) => s.name === wanted || s.dir.endsWith(wanted))
    if (!hit) {
      // 列出可用名称而不是只返回「未找到」：模型给出的名称通常只与实际名称相差一个字，
      // 给出候选后，模型在下一轮即可自行修正。
      return {
        status: 'failure',
        message: `未找到技能 ${wanted}${skills.length ? `。可用：${skills.map((s) => s.name).join('、')}` : ''}`,
        errorKind: 'not_found',
      }
    }

    const data = { name: hit.name, dir: hit.dir, scope: hit.scope }
    // 内置技能：本机只有标记，按行段投递，回执的形状与 `read_file` 读取云端技能文件相同。
    if (isCloudSkillDir(hit.dir)) {
      const target = cloudTarget(ctx, `${hit.dir}/SKILL.md`)
      if (!target) return { status: 'failure', message: `本轮无法读取内置技能 ${hit.name}` }
      if ('status' in target) return target
      const read = await readCloudFile(ctx, target, {})
      // 内置技能的脚本不能读取，只能经命令执行运行（`cloud-skills/script.ts`）：在回执中给出写法。
      return read.status === 'success'
        ? {
            ...read,
            message: `${read.message}
内置技能的脚本以「python ${hit.dir}/scripts/<文件>.py 参数」经 run_command 运行，脚本内容不能读取。`,
            data: { ...read.data, ...data },
          }
        : read
    }
    const text = await readFile(join(hit.dir, 'SKILL.md'), 'utf8').catch(() => null)
    if (text === null) {
      return { status: 'failure', message: `技能 ${wanted} 的 SKILL.md 读取失败` }
    }
    // SKILL.md 没有长度上限：超出本轮剩余额度时存入正文库供续读。
    return deliverReadable(ctx, {
      toolName: 'read_skill',
      sourceType: 'skill',
      whole: { message: text, data },
      body: text,
      partial: (head, note) => ({ message: head + note, data: { ...data, truncated: true } }),
    })
  },
}

export const writeSkillTool: ToolSpec = {
  name: 'write_skill',
  deferred: { brief: '新增或更新一个 QyWork 技能' },
  description:
    '创建或更新一个 QyWork 技能。默认写入项目层；用户明确要求全局时 scope 必须传 global。content 是 SKILL.md 的正文，不含前置元信息；附带脚本或模板放在 files。',
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
  verb: '保存',
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
    if (!dirName) return { status: 'failure', message: 'name 为空或全部为非法字符' }
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

    const markdown = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}\n`
    try {
      const receipt = await commitSkillDirectory(
        ctx.workspaceRoot,
        scope,
        dirName,
        true,
        async (stage, existing) => {
          if (await stat(existing).catch(() => null)) await cp(existing, stage, { recursive: true })
          else await mkdir(stage)
          await writeFile(join(stage, 'SKILL.md'), markdown, 'utf8')
          for (const file of files) {
            const dest = await resolveWritablePath(stage, file.path)
            await mkdir(join(dest, '..'), { recursive: true })
            await writeFile(dest, file.content, 'utf8')
          }
        },
      )
      const { replaced } = receipt
      return {
        status: receipt.cleanupError ? 'failure' : 'success',
        message: `已${replaced ? '更新' : '创建'}${scope === 'global' ? '全局' : '项目'}技能 ${name}；${receipt.active ? '扫描与读取已验证' : `当前生效的是 ${receipt.effective.dir}`}${receipt.cleanupError ? `；${receipt.cleanupError}` : ''}`,
        data: {
          ...receipt,
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
  deferred: { brief: '在项目层与全局层之间迁移一个技能' },
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
  verb: '移动',
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
      return {
        status: 'failure',
        message: `${from} 层中未找到技能 ${wanted}`,
        errorKind: 'not_found',
      }
    }
    const target = join(skillRoot(ctx.workspaceRoot, to), basename(hit.dir))
    try {
      const receipt = await commitSkillDirectory(
        ctx.workspaceRoot,
        to,
        basename(hit.dir),
        false,
        (stage) => cp(hit.dir, stage, { recursive: true, errorOnExist: true, force: false }),
        hit.dir,
      )
      return {
        status: receipt.cleanupError ? 'failure' : 'success',
        message: `已把技能 ${hit.name} 从 ${from} 层迁移到 ${to} 层，只保留目标副本；扫描与读取已验证${receipt.cleanupError ? `；${receipt.cleanupError}` : ''}`,
        data: { ...receipt, from_scope: from, to_scope: to, from_dir: hit.dir, to_dir: target },
      }
    } catch (error) {
      return { status: 'failure', message: `迁移技能失败：${String(error)}` }
    }
  },
}

export const importSkillTool: ToolSpec = {
  name: 'import_skill',
  deferred: { brief: '安装现成的技能目录或 ZIP 包' },
  description:
    '安装现成技能目录或 ZIP，完整保留脚本、模板和二进制资源。程序计算安装目录并验证扫描读取；不要运行包内安装脚本。默认安装到项目层，明确要求全局时传 global；用户授权替换已有版本时传 replace=true。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '本机技能目录或 ZIP 路径，可直接使用当前会话附件' },
      scope: scopeProperty(),
      replace: { type: 'boolean', description: '用户已授权替换同目录旧版本' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  verb: '导入',
  category: 'skills',
  facet: '技能',
  summary: '导入技能目录或 ZIP 并验证生效',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  parallelSafe: false,
  resourceKeys: (a) => [`skill:${String(a.scope ?? 'project')}:*`],
  async fn(args, ctx) {
    const scope = writableScope(args.scope)
    if (!scope) return { status: 'failure', message: 'scope 只能是 project 或 global' }
    const path = String(args.path ?? '').trim()
    if (!path) return { status: 'failure', message: '缺少 path' }
    try {
      const requested = resolve(ctx.workspaceRoot, path)
      const bound = ctx
        .port(SkillSourcePaths)?.()
        .some((p) => resolve(ctx.workspaceRoot, p) === requested)
      const source = bound
        ? await realpath(requested)
        : await resolveInWorkspace(rootsOf(ctx), path, { mustExist: true })
      const result = await importSkills(ctx.workspaceRoot, scope, source, args.replace === true)
      return {
        status: result.ok ? 'success' : 'failure',
        message: [
          ...result.installed.map(
            (s) =>
              `已安装 ${s.name}：${s.dir}；${s.active ? '扫描与读取已验证' : `当前生效的是 ${s.effective.dir}`}`,
          ),
          ...result.failures.map((f) => `${f.source}：${f.error}`),
        ].join('\n'),
        data: { ...result },
      }
    } catch (error) {
      return { status: 'failure', message: `导入技能失败：${String(error)}` }
    }
  },
}
