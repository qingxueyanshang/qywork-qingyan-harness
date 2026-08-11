/**
 * 记忆。移植自原版 `plugins/memory.py`。
 *
 * ## 存在工作区里，不存在账本里
 *
 * 记忆是 `.qy/memory/*.md`——普通文件。三个理由：
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
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { resolveInWorkspace } from './paths.ts'

export const MEMORY_DIR = '.qy/memory'

/** 单条记忆的上限。超过说明该写进文档而不是记忆。 */
const MAX_ENTRY_CHARS = 4000
/** 记忆条数上限。无上限的话尾区会慢慢吃掉整个上下文。 */
const MAX_ENTRIES = 200

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

export const memoryTool: ToolSpec = {
  name: 'memory',
  description:
    '读写长期记忆。用于记住跨会话有效的事实：项目约定、用户偏好、踩过的坑。' +
    'action=list 列出全部；read 读一条；write 写入或覆盖；delete 删除。' +
    '只记「下次还用得上」的东西，一次性的上下文不要记。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'write', 'delete'] },
      key: { type: 'string', description: '记忆标识，write/read/delete 必填' },
      content: { type: 'string', description: 'write 时的正文' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  // 动作语义从**显式参数**解析，不按工具名猜——这是 registry 的既有约定。
  actionKind: (a) => {
    const action = String(a.action ?? '')
    if (action === 'write') return 'write'
    if (action === 'delete') return 'delete'
    return 'read'
  },
  objectLabel: '记忆',
  targetExtractor: (a) => (typeof a.key === 'string' ? a.key : null),
  permissionEffect: (a) => {
    const action = String(a.action ?? '')
    // 读记忆不需要授权（就在工作区里，用户自己写的）；写和删要。
    if (action === 'write') return 'write'
    if (action === 'delete') return 'delete'
    return 'internal_control'
  },
  parallelSafe: (a) => String(a.action ?? '') !== 'write',
  resourceKeys: (a) => [`memory:${String(a.key ?? '*')}`],

  async fn(args, ctx) {
    const action = String(args.action ?? '')
    const dir = join(ctx.workspaceRoot, MEMORY_DIR)

    if (action === 'list') {
      const entries = await listEntries(dir)
      return {
        status: 'success',
        message: entries.length
          ? `${entries.length} 条记忆：\n${entries.map((e) => `- ${e.key}：${e.preview}`).join('\n')}`
          : '暂无记忆',
        data: { entries },
      }
    }

    const key = safeName(String(args.key ?? ''))
    if (!key) return { status: 'failure', message: 'key 为空或全是非法字符' }
    // 即使已经安全化过也再走一遍工作区边界：安全化的规则将来可能被改宽。
    const file = await resolveInWorkspace(ctx.workspaceRoot, join(MEMORY_DIR, `${key}.md`), {
      mustExist: false,
    })

    if (action === 'read') {
      const text = await readFile(file, 'utf8').catch(() => null)
      return text === null
        ? { status: 'failure', message: `没有名为 ${key} 的记忆`, errorKind: 'not_found' }
        : { status: 'success', message: text, data: { key, content: text } }
    }

    if (action === 'write') {
      const content = String(args.content ?? '').trim()
      if (!content) return { status: 'failure', message: 'write 需要 content' }
      if (content.length > MAX_ENTRY_CHARS) {
        return {
          status: 'failure',
          message: `单条记忆最多 ${MAX_ENTRY_CHARS} 字符，当前 ${content.length}——这么长的内容该写成文档`,
        }
      }
      const existing = await listEntries(dir)
      if (existing.length >= MAX_ENTRIES && !existing.some((e) => e.key === key)) {
        return {
          status: 'failure',
          message: `记忆已达 ${MAX_ENTRIES} 条上限，先删掉不再需要的`,
        }
      }
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
    }

    if (action === 'delete') {
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
    }

    return { status: 'failure', message: `未知 action：${action}` }
  },
}

export interface MemoryEntry {
  key: string
  preview: string
}

/**
 * 列出记忆索引。
 *
 * 只给**首行摘要**不给全文：索引要进尾区注记，每轮都发一遍。
 * 把全部正文塞进去，几十条记忆就能吃掉可观的上下文，而模型多数时候只需要
 * 知道「有哪些记忆」，需要哪条再单独读。
 */
export async function listEntries(dir: string): Promise<MemoryEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: MemoryEntry[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
    out.push({
      key: name.slice(0, -3),
      preview: firstLine.trim().slice(0, 100),
    })
  }
  return out
}
