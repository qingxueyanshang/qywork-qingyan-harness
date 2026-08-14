/**
 * 文件工具：read / write / edit / list。
 *
 * 两条贯穿全部写操作的规则：
 *
 * 1. **写前必须读过。** edit/write 对已存在文件要求调用方先读过且内容未变。
 *    这挡住的是「模型基于陈旧内容覆盖掉用户刚做的修改」——最贵的一类事故，
 *    而且用户往往到很久以后才发现。
 * 2. **edit 的 old_string 必须唯一命中。** 命中 0 次或多次都是失败，不猜第一个。
 *    猜错的那次会静默改错地方。
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { chargeBatchBudget, type ToolContext, type ToolSpec } from '@qywork/agent'
import { estimateText } from '@qywork/ai'
import type { FileChange } from '@qywork/core'
import {
  displayPath,
  IGNORED_DIRS,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
} from './paths.ts'
import { redactSecrets } from './secrets.ts'

/** 没有会话级 port 时的退路：把读记录暂存在 run 内的便签上。 */
const READ_STATE_KEY = 'files.readHashes'

/**
 * 默认读多少行。
 *
 * 与 `RESULT_BUDGET_RATIO` 是一对：2000 行普通代码约 20~25k token，
 * 而 200k 窗口的 1/8 正好是 25k。改这个数就要回去看那个比例还容不容得下，
 * 否则工具描述里写的默认值就是假的。
 */
const DEFAULT_READ_LINES = 2000

/**
 * 读记录的取用口。
 *
 * **寿命由装配方决定，不由这里决定。** 接上 `ctx.reads`（runtime 按会话落账本）
 * 就是会话级；没接上退回 run 内的便签——那是更严的一侧（每轮头一次写要先读），
 * 所以漏接不会放宽边界。这里只管「读的时候记、写之前比」。
 */
interface ReadHashes {
  get(path: string): string | null
  set(path: string, hash: string): void
}

function readHashes(ctx: ToolContext): ReadHashes {
  if (ctx.reads) {
    const port = ctx.reads
    return { get: (p) => port.seen(p), set: (p, h) => port.mark(p, h) }
  }
  let m = ctx.state.get(READ_STATE_KEY) as Map<string, string> | undefined
  if (!m) {
    m = new Map()
    ctx.state.set(READ_STATE_KEY, m)
  }
  const fallback = m
  return { get: (p) => fallback.get(p) ?? null, set: (p, h) => void fallback.set(p, h) }
}

function hash(text: string): string {
  return Bun.hash(text).toString(16)
}

const MAX_READ_BYTES = 1024 * 1024

/**
 * 二进制嗅探：NUL 字节。
 *
 * 用转义写而不是把控制字符直接嵌进正则字面量——后者在编辑器和 diff 里是不可见的，
 * 改动它的人看不出这一行到底在匹配什么。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 NUL 正是本意——这是判断文件是不是二进制的标准做法
const BINARY_SNIFF = /\x00/

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    '读取工作区内一个文本文件的内容，返回带行号的正文。修改任何已存在的文件前必须先用它读一次——' +
    'write_file 和 edit_file 会校验你读到的内容是否仍是磁盘上的最新版本。' +
    '支持用 offset/limit 分段读取大文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      offset: { type: 'integer', description: '起始行号（1 起），默认 1' },
      limit: { type: 'integer', description: '最多读取行数，默认 2000' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'read',
  // 读操作互不干扰，可并行；资源键让同一文件的读写不会混进同一波。
  parallelSafe: true,
  resourceKeys: (a) => (typeof a.path === 'string' ? [`file:${a.path}`] : []),
  async fn(args, ctx) {
    const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path), { mustExist: true })
    const info = await stat(abs)
    if (info.isDirectory()) {
      return { status: 'failure', message: `${args.path} 是目录，请用 list_dir` }
    }
    if (info.size > MAX_READ_BYTES) {
      return {
        status: 'failure',
        message: `文件过大（${info.size} 字节），请用 offset/limit 分段读取`,
      }
    }
    const text = await readFile(abs, 'utf8')
    if (BINARY_SNIFF.test(text.slice(0, 4096))) {
      return { status: 'failure', message: '二进制文件，无法作为文本读取' }
    }

    readHashes(ctx).set(abs, hash(text))

    const lines = text.split('\n')
    const offset = Math.max(1, Number(args.offset ?? 1))
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_READ_LINES))
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    const truncated = offset - 1 + slice.length < lines.length

    /*
     * 投递预算：这一次调用最多往上下文里放多少。
     *
     * **超了就拒绝，不截断。** cc-haha 实测过反方向（#21841，2026-03，
     * `FileReadTool/limits.ts` 头部记着）：把拒绝改成截断，工具错误率下降但
     * **平均 token 反而上升**——拒绝只产生约 100 字节的错误回执，截断产生的是
     * 满额正文，而那份正文往往并不是模型要的那一段。已回滚。
     *
     * 预算随模型窗口走（`RESULT_BUDGET_RATIO`），不是硬编码；判据与建议范围
     * 一起给回去，否则模型只知道「太大了」，只能靠二分去猜。
     */
    const tokens = estimateText(numbered)
    const charged = chargeBatchBudget(ctx, tokens)
    if (!charged.ok) {
      const perLine = Math.max(1, Math.ceil(tokens / Math.max(1, slice.length)))
      const room = Math.min(charged.perCall, charged.batchRemaining)
      return {
        status: 'failure',
        message:
          `这一段约 ${tokens} token，超出单次投递预算 ${charged.perCall}` +
          `（本批还剩 ${charged.batchRemaining}）。` +
          `改成 offset=${offset}、limit=${Math.max(1, Math.floor(room / perLine))} 分段读。`,
        errorKind: 'result_too_large',
      }
    }

    return {
      status: 'success',
      message: `读取 ${displayPath(ctx.workspaceRoot, abs)}（${slice.length} 行${truncated ? '，已截断' : ''}）`,
      /*
       * **正文过一遍脱敏。**
       *
       * 这条路原来完全没接凭证保护：`shell.ts` 的输出有 `createStreamRedactor`，
       * 而 `read_file` 直接把磁盘上的字节交给模型。工作区里的 `.env`、误提交的
       * 私钥、`config/*.local.json` 里的 token，读一次就进上下文、随下一次请求
       * 发给 provider——**而那是不可撤回的**。
       *
       * 一头拦一头不拦等于没拦：模型拿不到 `cat .env` 的输出，换 `read_file`
       * 就拿到了，而它并不是在绕过什么，只是选了个更顺手的工具。
       *
       * 脱敏的是**交给模型的那一份**，磁盘上的文件一个字节没动；`edit_file`
       * 的读回校验走的是另一条路（`readHashes` 存的是原文哈希），不受影响。
       */
      data: {
        content: redactSecrets(numbered, ctx.secrets ?? EMPTY_SECRETS),
        totalLines: lines.length,
        truncated,
      },
    }
  },
}

/** 没有配置任何 secret 时的空集合。形状脱敏与它无关，照常生效。 */
const EMPTY_SECRETS = { values: [], envNames: [] }

export const writeFileTool: ToolSpec = {
  name: 'write_file',
  description:
    '把完整内容写入一个文件，覆盖原有内容。用于新建文件，或改动幅度大到不适合 edit_file 的重写。' +
    '覆盖已存在的文件前必须先 read_file——内容自你读过之后被改动过会拒绝写入。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      content: { type: 'string', description: '文件完整内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    const abs = await resolveWritablePath(rootsOf(ctx), String(args.path))
    const content = String(args.content)

    const existing = await readFile(abs, 'utf8').catch(() => null)
    if (existing !== null) {
      const seen = readHashes(ctx).get(abs)
      if (seen === null) {
        return {
          status: 'failure',
          message: `${args.path} 已存在但没读取过。先 read_file 再覆盖。`,
          errorKind: 'stale_write',
        }
      }
      if (seen !== hash(existing)) {
        return {
          status: 'failure',
          message: `${args.path} 在你读取之后被改动过，已拒绝覆盖。请重新 read_file。`,
          errorKind: 'stale_write',
        }
      }
    }

    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    readHashes(ctx).set(abs, hash(content))

    const change: FileChange = {
      path: displayPath(ctx.workspaceRoot, abs),
      changeType: existing === null ? 'created' : 'modified',
      ...countDiff(existing ?? '', content),
    }
    return {
      status: 'success',
      message: `${existing === null ? '创建' : '写入'} ${change.path}`,
      fileChanges: [change],
    }
  },
}

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    '在文件中把一段精确文本替换成另一段。old_string 必须在文件中恰好出现一次——' +
    '出现 0 次或多次都会失败并告诉你实际次数，此时请加长 old_string 让它唯一。' +
    '调用前必须先 read_file。这是修改已有文件的首选方式，比 write_file 安全。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径' },
      old_string: { type: 'string', description: '要被替换的原文，需含足够上下文以保证唯一' },
      new_string: { type: 'string', description: '替换后的文本' },
      replace_all: { type: 'boolean', description: '为 true 时替换全部出现处' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '文件',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    const abs = await resolveWritablePath(rootsOf(ctx), String(args.path), {
      mustExist: true,
    })
    const oldStr = String(args.old_string)
    const newStr = String(args.new_string)
    const replaceAll = args.replace_all === true

    const current = await readFile(abs, 'utf8')
    const seen = readHashes(ctx).get(abs)
    if (seen === null) {
      return {
        status: 'failure',
        message: `${args.path} 没读取过。先 read_file。`,
        errorKind: 'stale_write',
      }
    }
    if (seen !== hash(current)) {
      return {
        status: 'failure',
        message: `${args.path} 在你读取之后被改动过。请重新 read_file。`,
        errorKind: 'stale_write',
      }
    }

    const occurrences = countOccurrences(current, oldStr)
    if (occurrences === 0) {
      return { status: 'failure', message: 'old_string 未在文件中找到', errorKind: 'no_match' }
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        status: 'failure',
        message: `old_string 命中 ${occurrences} 处，不唯一。请加长上下文，或设 replace_all=true。`,
        errorKind: 'ambiguous_match',
      }
    }

    const next = replaceAll ? current.split(oldStr).join(newStr) : current.replace(oldStr, newStr)
    await writeFile(abs, next, 'utf8')
    readHashes(ctx).set(abs, hash(next))

    const change: FileChange = {
      path: displayPath(ctx.workspaceRoot, abs),
      changeType: 'modified',
      ...countDiff(current, next),
    }
    return {
      status: 'success',
      message: `编辑 ${change.path}（${occurrences} 处）`,
      fileChanges: [change],
    }
  },
}

export const listDirTool: ToolSpec = {
  name: 'list_dir',
  description:
    '列出一个目录下的条目。默认跳过 node_modules/.git/dist 等噪声目录。' +
    '用于摸清项目结构；找具体文件用 glob，找文件内容用 grep。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区相对路径，默认为工作区根' },
    },
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '目录',
  targetExtractor: (a) => (typeof a.path === 'string' ? a.path : '.'),
  permissionEffect: 'read',
  parallelSafe: true,
  async fn(args, ctx) {
    const abs = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? '.'), {
      mustExist: true,
    })
    const entries = await readdir(abs, { withFileTypes: true })
    const rows = entries
      .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory()
            ? -1
            : 1,
      )
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))

    return {
      status: 'success',
      message: `${displayPath(ctx.workspaceRoot, abs)}：${rows.length} 项`,
      data: { entries: rows },
    }
  },
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/** 行级增删统计，供 UI 的「+x -y」展示。不做真 diff，代价不值得。 */
function countDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const common = new Set(a)
  const additions = b.filter((l) => !common.has(l)).length
  const seen = new Set(b)
  const deletions = a.filter((l) => !seen.has(l)).length
  return { additions, deletions }
}
