/**
 * 记忆。
 *
 * ## 存在工作区里，不存在账本里
 *
 * 记忆是 `<作用域>/memory/*.md`——普通文件。三个理由：
 *
 * 1. **用户能直接看、直接改、直接删。** 存进 SQLite 就需要一套 UI 才能管理，
 *    而记忆恰恰是最需要用户随手纠正的东西（记错了一条会一直错下去）。
 * 2. **能进版本控制。** 团队共享的项目约定就该跟着仓库走。
 * 3. **agent 自己能用普通文件工具读**，不需要为它单开一条读取路径。
 *
 * ## 永不进冻结前缀
 *
 * 这是本项目的既有不变量（ARCHITECTURE.md 第 6 节）。记忆随用户增删而变，
 * 放进前缀等于每加一条记忆就把整个 provider 缓存打掉一次。
 * 一律压到 transcript 之后的尾区。
 *
 * ## 进上下文的只有标题
 *
 * 尾区每轮列的是 `key：首行摘要`，正文只有 `read_memory` 拿得到。哪条相关由模型
 * 看着标题自己判断——上下文里已经有当前任务的全部细节，而任何按当轮文本打分的召回
 * 只看得见字面重合度。模型读了哪条是一次工具调用，会话流里看得见；打分选中了哪条
 * 是隐式的，「没生效」和「不存在」从外面看一模一样。
 *
 * 成立的前提是**第一行就是摘要**，所以 `write_memory` 的描述里这么要求。
 *
 * ## 三层作用域：列表和读跨层，写和删只在项目层
 *
 * 索引与 `read_memory` 看得到全局层的记忆（跨工作区那几条常用事实），
 * 但 `write_memory` / `delete_memory` **只动工作区 `.agents/memory/`**。
 *
 * 不对称是刻意的：让模型在一次任务里改掉一条「所有项目都生效」的记忆，
 * 影响范围远远超出它当时看到的上下文。全局那几条由人在设置页管。
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { resolveInWorkspace } from './paths.ts'
import {
  type Scope,
  type ScopedItem,
  type ScopeRoots,
  scanAllScopes,
  scanScoped,
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
/** 记忆条数上限。无上限的话尾区索引会慢慢吃掉整个上下文。同上，导出共用。 */
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
 * （`runtime/prompt.ts` 装配），列一遍拿回的是模型已经看得见的东西。
 */

/** 三个工具共用的记忆标识校验。key 由模型给，先安全化再用。 */
function requireKey(args: Record<string, unknown>): string | null {
  return safeName(String(args.key ?? ''))
}

export const readMemoryTool: ToolSpec = {
  name: 'read_memory',
  description: '读一条长期记忆的全文。尾区只列出 key 与首行摘要，正文只有这里拿得到。',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: '记忆标识' } },
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
    // 读跨层：项目层没有就往全局找。找不到才算 not_found。
    const found = await readScoped(scopeRoots(ctx.workspaceRoot), key)
    return found === null
      ? { status: 'failure', message: `没有名为 ${key} 的记忆`, errorKind: 'not_found' }
      : { status: 'success', message: found.content, data: { key, content: found.content } }
  },
}

export const writeMemoryTool: ToolSpec = {
  name: 'write_memory',
  description:
    '写入或覆盖一条长期记忆。用于记住跨会话有效的事实：项目约定、用户偏好、踩过的坑。' +
    '只记「下次还用得上」的东西，一次性的上下文不要记。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '记忆标识' },
      content: {
        type: 'string',
        description: '正文，整条覆盖。第一行写一句话摘要——尾区只列这一行，之后要不要读全文全看它。',
      },
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

    const dir = join(ctx.workspaceRoot, MEMORY_DIR)
    const existing = await listEntries(dir)
    if (existing.length >= MAX_ENTRIES && !existing.some((e) => e.key === key)) {
      return { status: 'failure', message: `记忆已达 ${MAX_ENTRIES} 条上限，先删掉不再需要的` }
    }
    // 即使已经安全化过也再走一遍工作区边界：安全化的规则将来可能被改宽。
    const file = await resolveInWorkspace(ctx.workspaceRoot, join(MEMORY_DIR, `${key}.md`), {
      mustExist: false,
    })
    await mkdir(dir, { recursive: true })
    await writeFile(file, `${content}\n`, 'utf8')
    return {
      status: 'success',
      message: `已记住 ${key}`,
      fileChanges: [
        {
          path: join(MEMORY_DIR, `${key}.md`).replaceAll('\\', '/'),
          changeType: existing.some((e) => e.key === key) ? 'modified' : 'created',
          additions: content.split('\n').length,
          deletions: 0,
        },
      ],
    }
  },
}

export const deleteMemoryTool: ToolSpec = {
  name: 'delete_memory',
  description: '删除一条长期记忆。只能删这个工作区的，全局那几条由用户在设置页管。',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: '记忆标识' } },
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
    const file = await resolveInWorkspace(ctx.workspaceRoot, join(MEMORY_DIR, `${key}.md`), {
      mustExist: false,
    })
    const ok = await unlink(file).then(
      () => true,
      () => false,
    )
    return ok
      ? {
          status: 'success',
          message: `已删除记忆 ${key}`,
          fileChanges: [
            {
              path: join(MEMORY_DIR, `${key}.md`).replaceAll('\\', '/'),
              changeType: 'deleted',
              additions: 0,
              deletions: 0,
            },
          ],
        }
      : { status: 'failure', message: `没有名为 ${key} 的记忆`, errorKind: 'not_found' }
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
 * 把全部正文塞进去，几十条记忆就能吃掉可观的上下文，而模型多数时候只需要
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
