/**
 * 记忆。移植自原版 `plugins/memory.py`。
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
 * ## 三层作用域：列表和读跨层，写和删只在用户层
 *
 * `list` / `read` 看得到全局层的记忆（跨工作区那几条常用事实），
 * 但 `write` / `delete` **只动工作区 `.agents/memory/`**。
 *
 * 不对称是刻意的：让模型在一次任务里改掉一条「所有项目都生效」的记忆，
 * 影响范围远远超出它当时看到的上下文。全局那几条由人在设置页管。
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { estimateText } from '@qywork/ai'
import { resolveInWorkspace } from './paths.ts'
import { type Scope, type ScopeRoots, scanScoped, scopePaths, scopeRoots } from './scopes.ts'

/** 各层根目录下装记忆的那个子目录。 */
export const MEMORY_SUBDIR = 'memory'
/** 用户层记忆相对工作区的路径。写入、fileChanges 用它。 */
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
    const roots = scopeRoots(ctx.workspaceRoot)
    const dir = join(ctx.workspaceRoot, MEMORY_DIR)

    if (action === 'list') {
      const entries = await listScopedEntries(roots)
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
      // 读跨层：用户层没有就往全局找。找不到才算 not_found。
      const found = await readScoped(roots, key)
      return found === null
        ? { status: 'failure', message: `没有名为 ${key} 的记忆`, errorKind: 'not_found' }
        : { status: 'success', message: found.content, data: { key, content: found.content } }
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
  /** 这条来自哪一层。界面据此决定能不能改、开关归谁管。 */
  scope: Scope
}

/**
 * 列出记忆索引。
 *
 * 只给**首行摘要**不给全文：索引要进尾区注记，每轮都发一遍。
 * 把全部正文塞进去，几十条记忆就能吃掉可观的上下文，而模型多数时候只需要
 * 知道「有哪些记忆」，需要哪条再单独读。
 */
export async function listEntries(dir: string, scope: Scope = 'user'): Promise<MemoryEntry[]> {
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
 * 那条。两边各扫一遍的话，界面显示全局那份、模型读到用户层那份，而两者内容不同。
 */
export function listScopedEntries(roots: ScopeRoots): Promise<MemoryEntry[]> {
  return scanScoped(roots, MEMORY_SUBDIR, listEntries, (e) => e.key)
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

// ─────────────────────────── 注入选择 ───────────────────────────

/**
 * 每轮注入记忆的 token 预算。
 *
 * 青研魔盒是两池各自计数（常驻 800 + 召回 1200，`memory/select.py:11-12`）。
 * 这里合成一个池，因为 qywork 的记忆文件**没有「常驻」这个标记**——
 * 造一个新的存储格式去表达它，只为在预算内区分优先级，不划算。
 *
 * 合成之后行为在两端都对：条数少时全部装得下（等价于全部常驻），
 * 条数多时按相关性排序取前若干条（等价于召回）。
 */
export const MEMORY_BUDGET_TOKENS = 2000

/** 中文二元组 + 英文单词。与青研魔盒的 `_tokenize` 同口径（它把这套同时用于技能召回）。 */
function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) out.push(m[0])
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length === 1) out.push(run)
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

/**
 * BM25。参数取标准值（k1=1.5, b=0.75）。
 *
 * 对几十条记忆这种小语料，IDF 会出现负值（一个词出现在多数文档里时），
 * 所以下限截到 0——负分会让「到处都出现的常用词」反过来把文档往下压，
 * 而在小语料里那恰恰常常是主题词。
 */
function bm25(query: string[], docs: string[][]): number[] {
  const n = docs.length
  if (n === 0) return []
  const avg = docs.reduce((s, d) => s + d.length, 0) / n
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)

  return docs.map((doc) => {
    const tf = new Map<string, number>()
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const q of new Set(query)) {
      const f = tf.get(q)
      if (!f) continue
      const idf = Math.max(0, Math.log(1 + (n - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5)))
      score += (idf * (f * 2.5)) / (f + 1.5 * (0.25 + (0.75 * doc.length) / avg))
    }
    return score
  })
}

export interface SelectedMemory {
  key: string
  body: string
  scope: Scope
}

/**
 * 挑出这一轮要注入正文的记忆。
 *
 * ## 为什么是正文不是目录
 *
 * 目录制（只发 `key：首行摘要`）省 token，代价是**模型得自己判断哪条相关**。
 * 判断错了那条记忆这一轮就等于不存在——而且不报错、界面上看不出来。
 * 「记忆没生效」和「记忆不存在」从外面看一模一样，出了问题查不出来。
 *
 * ## 装不下的怎么办
 *
 * 转按需：`memory(action=read)` 仍然读得到全文。所以超预算不是丢失，
 * 是降级——降级路径必须存在，否则记忆一多就变成随机丢几条。
 */
export function selectMemories(
  all: SelectedMemory[],
  query: string,
  budgetTokens = MEMORY_BUDGET_TOKENS,
): { selected: SelectedMemory[]; deferred: string[] } {
  if (all.length === 0) return { selected: [], deferred: [] }

  const scores = bm25(
    tokenize(query),
    all.map((m) => tokenize(`${m.key} ${m.body}`)),
  )
  // 相关性降序；同分按 key 稳定排序——顺序抖动会让尾区字节每轮都变。
  const ranked = all
    .map((m, i) => ({ m, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score || (a.m.key < b.m.key ? -1 : 1))

  const selected: SelectedMemory[] = []
  const deferred: string[] = []
  let spent = 0
  for (const { m } of ranked) {
    const cost = estimateText(m.body)
    if (spent + cost > budgetTokens && selected.length > 0) {
      deferred.push(m.key)
      continue
    }
    selected.push(m)
    spent += cost
  }
  // 注入顺序按 key 定序，不按相关性——相关性每轮都变，而尾区字节每变一次
  // 就是一次多付。哪些进来由相关性决定，进来之后怎么排由 key 决定。
  selected.sort((a, b) => (a.key < b.key ? -1 : 1))
  return { selected, deferred }
}

/** 读出三层全部记忆的正文。 */
export async function loadScopedMemories(roots: ScopeRoots): Promise<SelectedMemory[]> {
  const index = await listScopedEntries(roots)
  const out: SelectedMemory[] = []
  for (const e of index) {
    const found = await readScoped(roots, e.key)
    if (found) out.push({ key: e.key, body: found.content.trim(), scope: found.scope })
  }
  return out
}
