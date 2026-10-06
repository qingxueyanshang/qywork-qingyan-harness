/**
 * 长期记忆工具与记忆索引。
 *
 * **记忆保存为工作区中的普通文件，不保存在数据库中。** 记忆是 `<作用域>/memory/*.md`，理由有三：
 *
 * 1. 用户可以直接查看、修改与删除。保存在 SQLite 中需要专门的界面管理，
 *    而记忆是最需要用户随时纠正的数据：一条错误的记忆会持续影响后续会话。
 * 2. 可以纳入版本控制。团队共享的项目约定应随仓库分发。
 * 3. agent 可以用普通文件工具读取，无需单独的读取路径。
 *
 * **记忆不进入冻结前缀。** 这是本项目的既有不变量（ARCHITECTURE.md 第 6 节）。记忆随用户增删而变化，
 * 放入前缀会使每次增加记忆都令 provider 缓存整体失效。记忆一律放在 transcript 之后的上下文末尾。
 *
 * **进入上下文的只有标题。** 上下文末尾每轮列出 `key：首行摘要`，正文只能通过 `read_memory` 取得。
 * 哪条相关由模型根据标题判断：上下文中已有当前任务的全部细节，而按当轮文本打分的召回只能衡量字面重合度。
 * 模型读取哪条记忆是一次工具调用，在会话流中可见；打分召回的选择是隐式的，「未生效」与「不存在」无法区分。
 *
 * 该做法要求**第一行即摘要**，`write_memory` 的描述因此作此要求。
 *
 * **三层作用域：列表与读取跨层，写入默认项目层。** 用户明确指定 `global` 时，写入、删除与迁移都必须作用于
 * 全局层；未指定时使用项目层。迁移是单个工具动作：目标写入成功后才删除来源，失败时回滚目标。
 * 不要改为由模型先写后删：两步之间失败会留下两份。
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
import { deliverReadable } from './sink.ts'

/** 各层根目录下存放记忆的子目录名。 */
export const MEMORY_SUBDIR = 'memory'
/** 项目层记忆目录相对工作区的路径，用于写入与 `fileChanges`。 */
export const MEMORY_DIR = `.agents/${MEMORY_SUBDIR}`

/**
 * 单条记忆的字符上限。超过上限的内容应写成文档而不是记忆。
 *
 * 导出供 HTTP 接口（`server/api/memory.ts`）共用：两处写入同一批文件，各自定义会产生
 * 不一致的上限（同类问题见 ARCHITECTURE §5.7 的 `estimateTokens`）。
 */
export const MAX_ENTRY_CHARS = 4000
/** 记忆条数上限。无上限时上下文末尾的索引会持续占用上下文。导出原因同上。 */
export const MAX_ENTRIES = 200

/** 把 key 规范化为安全文件名：key 由模型提供，必须防止写入记忆目录之外。 */
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
 * **每个动作一个工具，不合并为一个带 `action` 参数的工具。** 各动作的必填参数不同
 * （读取与删除需要 key，写入需要 key 与 content）。合并后 `required` 只能包含分派字段，
 * schema 层失去约束：模型可以合法地发出缺少 key 的写入调用，
 * 要经过一整轮往返才由工具执行体报错。拆分后必填参数由参数校验拦截，
 * 每个工具的动作与权限也各是常量，无需根据参数计算。
 *
 * **不提供 `list_memory`**：全部记忆的 `key：首行摘要` 每轮都列在上下文末尾
 * （由 `runtime/prompt.ts` 装配），再列一次取回的是模型已可见的内容。
 */

/** 各记忆工具共用的 key 校验。key 由模型提供，使用前先规范化。 */
function requireKey(args: Record<string, unknown>): string | null {
  return safeName(String(args.key ?? ''))
}

type WritableScope = Exclude<Scope, 'builtin'>

/** 未传时为项目层；仅显式传入 global 时作用于全部工作区。 */
function writableScope(raw: unknown): WritableScope | null {
  if (raw === undefined || raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

/** 项目层经由工作区边界检查解析；全局层由规范化后的单段 key 定位。 */
async function memoryFile(
  workspaceRoot: string,
  scope: WritableScope,
  key: string,
): Promise<string> {
  if (scope === 'project') {
    return resolveInWorkspace(workspaceRoot, join(MEMORY_DIR, `${key}.md`), { mustExist: false })
  }
  const dir = scopeDir(scopeRoots(workspaceRoot), scope, MEMORY_SUBDIR)
  if (dir === null) throw new Error('该层不可写')
  return join(dir, `${key}.md`)
}

function scopeProperty(): Record<string, unknown> {
  return {
    type: 'string',
    enum: ['project', 'global'],
    description: '写入层；不传时默认 project，用户明确要求全局时必须传 global',
  }
}

export const readMemoryTool: ToolSpec = {
  name: 'read_memory',
  description:
    '读取一条长期记忆的全文。默认先查找项目层、再查找全局层；读取被同名项目记忆遮蔽的全局记忆时显式传 scope=global。',
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
  summary: '读取一条长期记忆',
  targetExtractor: (a) => (typeof a.key === 'string' ? a.key : null),
  // 读取记忆无需授权：读取对象是用户自己的记忆文件。
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
    if (found === null) {
      return { status: 'failure', message: `没有名为 ${key} 的记忆`, errorKind: 'not_found' }
    }
    // 正文只放在 message 中：data 中再放一份会使同一段正文占用两份额度。
    // 用户手动修改的记忆文件不受长度上限约束，超出额度时存入正文库，供分段读取。
    const data = { key, scope: found.scope }
    return deliverReadable(ctx, {
      toolName: 'read_memory',
      sourceType: 'memory',
      whole: { message: found.content, data },
      body: found.content,
      partial: (head, note) => ({ message: head + note, data: { ...data, truncated: true } }),
    })
  },
}

export const writeMemoryTool: ToolSpec = {
  name: 'write_memory',
  description:
    '写入或覆盖一条长期记忆。用于记录跨会话有效的事实：项目约定、用户偏好、已知问题。' +
    '只记录后续仍然适用的内容，不记录一次性上下文。默认写入项目层；用户明确要求全局时 scope 必须传 global。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识' },
      content: {
        type: 'string',
        description:
          '正文，整条覆盖。第一行写一句摘要：上下文末尾只列出这一行，据此判断是否需要读取全文。',
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
        message: `单条记忆最多 ${MAX_ENTRY_CHARS} 字符，当前 ${content.length}；内容过长，应写成文档`,
      }
    }

    const scope = writableScope(args.scope)
    if (!scope) return { status: 'failure', message: 'scope 只能是 project 或 global' }

    const dir = scopeDir(scopeRoots(ctx.workspaceRoot), scope, MEMORY_SUBDIR)
    if (dir === null) return { status: 'failure', message: '该层不可写' }
    const existing = await listEntries(dir, scope)
    if (existing.length >= MAX_ENTRIES && !existing.some((e) => e.key === key)) {
      return { status: 'failure', message: `记忆已达 ${MAX_ENTRIES} 条上限，先删除不再需要的记忆` }
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
    '把一条记忆从项目层迁移到全局层，或从全局层迁回项目层。迁移成功后只保留目标副本；目标层已有同名记忆时拒绝迁移，两层均不修改。',
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
  /** 条目所在的层。界面据此判断能否编辑、开关由哪一层管理。 */
  scope: Scope
}

/**
 * 列出一层的记忆索引。
 *
 * 只返回**首行摘要**，不返回全文：索引进入上下文末尾的注记，每轮都会发送。
 * 放入全部正文时，几十条记忆即可占用可观的上下文，而模型多数情况下只需
 * 知道有哪些记忆，需要时再单独读取。
 *
 * 摘要即首行原文，不做加工：加工后的摘要与文件中的原句不一致时，
 * 用户在设置页看到的内容将与模型看到的不一致。
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
 * 三层合并后的记忆索引。同一 key 只保留优先级最高的条目。
 *
 * **加载器与设置页共用此函数**：界面列出的条目必须就是模型实际看到的条目。
 * 两处各自扫描时，可能界面显示全局层的条目、模型读取项目层的条目，而两者内容不同。
 */
export function listScopedEntries(roots: ScopeRoots): Promise<MemoryEntry[]> {
  return scanScoped(roots, MEMORY_SUBDIR, listEntries, (e) => e.key)
}

/**
 * 每一层各自的记忆，包括被遮蔽的条目。
 *
 * 设置页按层分列时使用此结果：`listScopedEntries` 去重后，被项目层遮蔽的全局记忆
 * 不再出现，用户在全局一栏看不到它，也就无法得知修改为何未生效。
 */
export function listAllScopedEntries(roots: ScopeRoots): Promise<ScopedItem<MemoryEntry>[]> {
  return scanAllScopes(roots, MEMORY_SUBDIR, listEntries, (e) => e.key)
}

/** 按优先级查找一条记忆的全文。未找到时返回 null。 */
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

/** 从指定层读取，不按优先级查找。用于读取被同名项目记忆遮蔽的全局记忆。 */
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
