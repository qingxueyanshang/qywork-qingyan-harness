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
import type { ToolSpec } from '@qywork/agent'
import type { FileChange } from '@qywork/core'
import { displayPath, resolveInWorkspace, resolveWritablePath, rootsOf } from './paths.ts'

/** 记录本 run 内每个文件被读到时的内容哈希，供写前校验。 */
const READ_STATE_KEY = 'files.readHashes'

function readHashes(state: Map<string, unknown>): Map<string, string> {
  let m = state.get(READ_STATE_KEY) as Map<string, string> | undefined
  if (!m) {
    m = new Map()
    state.set(READ_STATE_KEY, m)
  }
  return m
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

    readHashes(ctx.state).set(abs, hash(text))

    const lines = text.split('\n')
    const offset = Math.max(1, Number(args.offset ?? 1))
    const limit = Math.max(1, Number(args.limit ?? 2000))
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    const truncated = offset - 1 + slice.length < lines.length

    return {
      status: 'success',
      message: `读取 ${displayPath(ctx.workspaceRoot, abs)}（${slice.length} 行${truncated ? '，已截断' : ''}）`,
      data: { content: numbered, totalLines: lines.length, truncated },
    }
  },
}

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
      const seen = readHashes(ctx.state).get(abs)
      if (seen === undefined) {
        return {
          status: 'failure',
          message: `${args.path} 已存在但本轮未读取过。先 read_file 再覆盖。`,
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
    readHashes(ctx.state).set(abs, hash(content))

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
    const seen = readHashes(ctx.state).get(abs)
    if (seen === undefined) {
      return {
        status: 'failure',
        message: `${args.path} 本轮未读取过。先 read_file。`,
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
    readHashes(ctx.state).set(abs, hash(next))

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

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.venv',
  '__pycache__',
  '.cache',
  'vendor',
  '.turbo',
])

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
