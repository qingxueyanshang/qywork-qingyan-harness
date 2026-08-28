/**
 * 记忆。
 *
 * **存在工作区里，不存在账本里。** 记忆是 `<作用域>/memory/*.md`——普通文件。三个理由：
 *
 * 1. **用户能直接看、直接改、直接删。** 存进 SQLite 就需要一套 UI 才能管理，
 *    而记忆是最需要用户随时纠正的一类数据（记错了一条会一直错下去）。
 * 2. **能进版本控制。** 团队共享的项目约定就该跟着仓库走。
 * 3. **agent 自己能用普通文件工具读**，不需要为它单开一条读取路径。
 *
 * **永不进冻结前缀。** 这是本项目的既有不变量（ARCHITECTURE.md 第 6 节）。记忆随用户增删而变，
 * 放进前缀等于每加一条记忆就把整个 provider 缓存打掉一次。
 * 一律压到 transcript 之后的尾区。
 *
 * **进上下文的只有标题。** 尾区每轮列的是 `key：首行摘要`，正文只有 `read_memory` 拿得到。哪条相关
 * 由模型看着标题自己判断——上下文里已经有当前任务的全部细节，而任何按当轮文本打分的召回只看得见
 * 字面重合度。模型读了哪条是一次工具调用，会话流里看得见；打分选中了哪条是隐式的，「没生效」和「不
 * 存在」从外面看一模一样。
 *
 * 成立的前提是**第一行就是摘要**，所以 `write_memory` 的描述里这么要求。
 *
 * **三层作用域：列表和读跨层，写默认项目层。** 用户明确指定 `global` 时，写、删和迁移都必须落到
 * 全局层；没有指定才用项目层。迁移是一个工具动作，目标写成后才删来源，失败时回滚目标，不能靠模型
 * 先写再删拼出一个会留下双份的流程。
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { resolveInWorkspace } from './paths.ts'
import {
  type Scope,
  type ScopedItem,
  type ScopeRoots,
  scanAllScopes,
  scanScoped,
  scopeDir,
  scopePaths,
  scopeRoots,
} from './scopes.ts'

/** 各层根目录下装记忆的那个子目录。 */
export const MEMORY_SUBDIR = 'memory'
/** 项目层记忆相对工作区的路径。写入、fileChanges 用它。 */
export const MEMORY_DIR = `.agents/${MEMORY_SUBDIR}`

/**
 * 单条记忆的上限。超过说明该写进文档而不是记忆。
 *
 * **导出**：HTTP 面（`server/api/memory.ts`）写的是同一批文件，两处各写一个数
 * 迟早漂成两个——`estimateTokens` 就是这么漂的（ARCHITECTURE §5.7）。
 */
export const MAX_ENTRY_CHARS = 4000
/** 记忆条数上限。无上限的话尾区索引会逐步占满上下文。同上，导出共用。 */
export const MAX_ENTRIES = 200

/** 文件名安全化：记忆的 key 由模型给，不能让它写到目录外。 */
function safeName(key: string): string | null {
  const cleaned = key
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || null
}

/*
 * **三个名字，不是一个带 `action` 的门面。** 三个动作的必填参数各不相同
 * （读删要 key，写要 key + content），合成一个的话 `required` 只剩下那个分派字段，
 * schema 层等于没有约束：模型可以合法发出一个「写记忆但没给 key」的调用，
 * 要跑完一整轮往返才由工具体报错。拆开之后必填由参数层拦住，
 * 每个工具的动作与权限也各自是一个常量，不必再从参数里现算。
 *
 * **不做 `list_memory`**：全部记忆的 `key：首行摘要` 每轮都在尾区列着
 * （`runtime/prompt.ts` 装配），列一遍拿回的是模型已经看得见的内容。
 */

/** 三个工具共用的记忆标识校验。key 由模型给，先安全化再用。 */
function requireKey(args: Record<string, unknown>): string | null {
  return safeName(String(args.key ?? ''))
}

type WritableScope = Exclude<Scope, 'builtin'>

/** 不传就是项目层；只有显式的 global 才扩大到所有工作区。 */
function writableScope(raw: unknown): WritableScope | null {
  if (raw === undefined || raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

/** 项目层继续走工作区边界；全局层靠安全化后的单段 key 定位。 */
async function memoryFile(
  workspaceRoot: string,
  scope: WritableScope,
  key: string,
): Promise<string> {
  if (scope === 'project') {
    return resolveInWorkspace(workspaceRoot, join(MEMORY_DIR, `${key}.md`), { mustExist: false })
  }
  const dir = scopeDir(scopeRoots(workspaceRoot), scope, MEMORY_SUBDIR)
  if (dir === null) throw new Error('这一层不可写')
  return join(dir, `${key}.md`)
}

function scopeProperty(): Record<string, unknown> {
  return {
    type: 'string',
    enum: ['project', 'global'],
    description: '写入层；不传默认 project，用户明确要求全局时必须传 global',
  }
}

export const readMemoryTool: ToolSpec = {
  name: 'read_memory',
  description:
    '读一条长期记忆的全文。默认按项目层优先、再全局层查找；要读取被同名项目记忆盖住的全局记忆时显式传 scope=global。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识' },
      scope: scopeProperty(),
    },
    required: ['key'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '记忆',
  category: 'memory',
  facet: '记忆',
  summary: '读一条长期记忆',
  targetExtractor: (a) => (typeof a.key === 'string' ? a.key : null),
  // 读记忆不需要授权：就在工作区里，用户自己写的。
  permissionEffect: 'internal_control',
  parallelSafe: true,
  resourceKeys: (a) => [`memory:${String(a.key ?? '*')}`],

  async fn(args, ctx) {
    const key = requireKey(args)
    if (!key) return { status: 'failure', message: 'key 为空或全是非法字符' }
    const requested = args.scope === undefined ? null : writableScope(args.scope)
    if (args.scope !== undefined && !requested) {
      return { status: 'failure', message: 'scope 只能是 project 或 global' }
    }
    const found = requested
      ? await readFromScope(scopeRoots(ctx.workspaceRoot), requested, key)
      : await readScoped(scopeRoots(ctx.workspaceRoot), key)
    return found === null
      ? { status: 'failure', message: `没有名为 ${key} 的记忆`, errorKind: 'not_found' }
      : {
          status: 'success',
          message: found.content,
          data: { key, content: found.content, scope: found.scope },
        }
  },
}

export const writeMemoryTool: ToolSpec = {
  name: 'write_memory',
  description:
    '写入或覆盖一条长期记忆。用于记录跨会话有效的事实：项目约定、用户偏好、已知问题。' +
    '只记录后续仍然适用的内容，一次性上下文不记。默认写项目层；用户明确要求全局时 scope 必须传 global。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识' },
      content: {
        type: 'string',
        description: '正文，整条覆盖。第一行写一句话摘要——尾区只列这一行，它决定是否需要读取全文。',
      },
      scope: scopeProperty(),
    },
    required: ['key', 'content'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '记忆',
  category: 'memory',
  facet: '记忆',
  summary: '写入或覆盖一条长期记忆',
  targetExtractor: (a) => (typeof a.key === 'string' ? a.key : null),
  permissionEffect: 'write',
  parallelSafe: false,
  resourceKeys: (a) => [`memory:${String(a.key ?? '*')}`],

  async fn(args, ctx) {
    const key = requireKey(args)
    if (!key) return { status: 'failure', message: 'key 为空或全是非法字符' }
    const content = String(args.content ?? '').trim()
    if (!content) return { status: 'failure', message: 'content 为空' }
    if (content.length > MAX_ENTRY_CHARS) {
      return {
        status: 'failure',
        message: `单条记忆最多 ${MAX_ENTRY_CHARS} 字符，当前 ${content.length}——这么长的内容该写成文档`,
      }
    }

    const scope = writableScope(args.scope)
    if (!scope) return { status: 'failure', message: 'scope 只能是 project 或 global' }

    const dir = scopeDir(scopeRoots(ctx.workspaceRoot), scope, MEMORY_SUBDIR)
    if (dir === null) return { status: 'failure', message: '这一层不可写' }
    const existing = await listEntries(dir, scope)
    if (existing.length >= MAX_ENTRIES && !existing.some((e) => e.key === key)) {
      return { status: 'failure', message: `记忆已达 ${MAX_ENTRIES} 条上限，先删掉不再需要的` }
    }
    const file = await memoryFile(ctx.workspaceRoot, scope, key)
    await mkdir(dir, { recursive: true })
    await writeFile(file, `${content}\n`, 'utf8')
    const replaced = existing.some((e) => e.key === key)
    return {
      status: 'success',
      message: `已写入${scope === 'global' ? '全局' : '项目'}记忆 ${key}`,
      data: { key, scope, path: file, replaced },
      fileChanges: [
        {
          path: scope === 'project' ? join(MEMORY_DIR, `${key}.md`).replaceAll('\\', '/') : file,
          changeType: replaced ? 'modified' : 'created',
          additions: content.split('\n').length,
          deletions: 0,
        },
      ],
    }
  },
}

export const deleteMemoryTool: ToolSpec = {
  name: 'delete_memory',
  description: '删除一条长期记忆。默认删除项目层；用户明确要求删除全局记忆时 scope 必须传 global。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识' },
      scope: scopeProperty(),
    },
    required: ['key'],
    additionalProperties: false,
  },
  actionKind: 'delete',
  objectLabel: '记忆',
  category: 'memory',
  facet: '记忆',
  summary: '删除一条长期记忆',
  targetExtractor: (a) => (typeof a.key === 'string' ? a.key : null),
  permissionEffect: 'delete',
  parallelSafe: true,
  resourceKeys: (a) => [`memory:${String(a.key ?? '*')}`],

  async fn(args, ctx) {
    const key = requireKey(args)
    if (!key) return { status: 'failure', message: 'key 为空或全是非法字符' }
    const scope = writableScope(args.scope)
    if (!scope) return { status: 'failure', message: 'scope 只能是 project 或 global' }
    const file = await memoryFile(ctx.workspaceRoot, scope, key)
    const ok = await unlink(file).then(
      () => true,
      () => false,
    )
    return ok
      ? {
          status: 'success',
          message: `已删除${scope === 'global' ? '全局' : '项目'}记忆 ${key}`,
          data: { key, scope, path: file },
          fileChanges: [
            {
              path:
                scope === 'project' ? join(MEMORY_DIR, `${key}.md`).replaceAll('\\', '/') : file,
              changeType: 'deleted',
              additions: 0,
              deletions: 0,
            },
          ],
        }
      : { status: 'failure', message: `没有名为 ${key} 的记忆`, errorKind: 'not_found' }
  },
}

export const moveMemoryTool: ToolSpec = {
  name: 'move_memory',
  description:
    '把一条记忆从项目层迁移到全局层，或从全局层迁回项目层。迁移成功后只保留目标副本；目标已有同名记忆时拒绝且不改任何一份。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识' },
      from_scope: scopeProperty(),
      to_scope: scopeProperty(),
    },
    required: ['key', 'from_scope', 'to_scope'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '记忆',
  category: 'memory',
  facet: '记忆',
  summary: '在项目层与全局层之间迁移记忆',
  targetExtractor: (a) => (typeof a.key === 'string' ? a.key : null),
  permissionEffect: 'delete',
  parallelSafe: false,
  resourceKeys: (a) => [
    `memory:${String(a.from_scope ?? '*')}:${String(a.key ?? '*')}`,
    `memory:${String(a.to_scope ?? '*')}:${String(a.key ?? '*')}`,
  ],

  async fn(args, ctx) {
    const key = requireKey(args)
    if (!key) return { status: 'failure', message: 'key 为空或全是非法字符' }
    const from = writableScope(args.from_scope)
    const to = writableScope(args.to_scope)
    if (!from || !to) return { status: 'failure', message: '作用域只能是 project 或 global' }
    if (from === to) return { status: 'failure', message: '迁移的来源层和目标层不能相同' }

    const source = await memoryFile(ctx.workspaceRoot, from, key)
    const target = await memoryFile(ctx.workspaceRoot, to, key)
    const content = await readFile(source, 'utf8').catch(() => null)
    if (content === null) {
      return {
        status: 'failure',
        message: `${from} 层没有名为 ${key} 的记忆`,
        errorKind: 'not_found',
      }
    }
    if (await stat(target).catch(() => null)) {
      return { status: 'failure', message: `${to} 层已有同名记忆 ${key}，未迁移任何文件` }
    }

    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.qywork-moving-${crypto.randomUUID()}`
    try {
      await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
      await rename(temp, target)
      try {
        await unlink(source)
      } catch (err) {
        await unlink(target).catch(() => undefined)
        throw err
      }
    } catch (err) {
      await unlink(temp).catch(() => undefined)
      return { status: 'failure', message: `迁移记忆失败，原件仍在 ${from} 层：${String(err)}` }
    }

    return {
      status: 'success',
      message: `已把记忆 ${key} 从 ${from} 层迁移到 ${to} 层，只保留目标副本`,
      data: { key, from_scope: from, to_scope: to, from_path: source, to_path: target },
    }
  },
}

export interface MemoryEntry {
  key: string
  preview: string
  /** 这条来自哪一层。界面据此决定能不能改、开关归谁管。 */
  scope: Scope
}

/**
 * 列出记忆索引。
 *
 * 只给**首行摘要**不给全文：索引要进尾区注记，每轮都发一遍。
 * 把全部正文塞进去，几十条记忆就能占掉可观的上下文，而模型多数时候只需要
 * 知道「有哪些记忆」，需要哪条再单独读。
 *
 * 摘要就是首行原文，这里不做任何加工——加工出来的一句话和文件里写着的那句
 * 不一致时，用户在设置页看到的和模型看到的就是两回事。
 */
export async function listEntries(dir: string, scope: Scope = 'project'): Promise<MemoryEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: MemoryEntry[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
    out.push({
      key: name.slice(0, -3),
      preview: firstLine.trim().slice(0, 100),
      scope,
    })
  }
  return out
}

/**
 * 三层合起来的记忆索引。同 key 只留优先级最高的那条。
 *
 * **加载器和设置页共用这一个函数**：界面上列出来的那条，必须就是模型真的看到的
 * 那条。两边各扫一遍的话，界面显示全局那份、模型读到项目层那份，而两者内容不同。
 */
export function listScopedEntries(roots: ScopeRoots): Promise<MemoryEntry[]> {
  return scanScoped(roots, MEMORY_SUBDIR, listEntries, (e) => e.key)
}

/**
 * 每一层各自有哪些记忆，被盖住的也在里面。
 *
 * 设置页按层分列要的是这一份：`listScopedEntries` 去重之后，被项目层盖住的那条
 * 全局记忆直接消失，用户在全局那一栏看不到它，也就无从知道自己改的那条为什么没生效。
 */
export function listAllScopedEntries(roots: ScopeRoots): Promise<ScopedItem<MemoryEntry>[]> {
  return scanAllScopes(roots, MEMORY_SUBDIR, listEntries, (e) => e.key)
}

/** 按优先级找一条记忆的全文。找不到回 null。 */
export async function readScoped(
  roots: ScopeRoots,
  key: string,
): Promise<{ content: string; scope: Scope } | null> {
  for (const { scope, dir } of scopePaths(roots, MEMORY_SUBDIR)) {
    const text = await readFile(join(dir, `${key}.md`), 'utf8').catch(() => null)
    if (text !== null) return { content: text, scope }
  }
  return null
}

/** 从指定层读，不走优先级。用于读取被同名项目条目盖住的全局记忆。 */
export async function readFromScope(
  roots: ScopeRoots,
  scope: WritableScope,
  key: string,
): Promise<{ content: string; scope: Scope } | null> {
  const dir = scopeDir(roots, scope, MEMORY_SUBDIR)
  if (dir === null) return null
  const content = await readFile(join(dir, `${key}.md`), 'utf8').catch(() => null)
  return content === null ? null : { content, scope }
}
