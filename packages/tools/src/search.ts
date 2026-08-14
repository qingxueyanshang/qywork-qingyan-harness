/**
 * 搜索工具：glob（按文件名）与 grep（按内容）。
 *
 * grep 优先走 ripgrep 二进制——它比任何 JS 实现快一到两个数量级，而且自带
 * .gitignore 语义。找不到 rg 时降级到内置遍历，功能一致、速度慢，
 * 但**不会静默失败**：结果里会标明用的是哪条路径。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { IGNORED_DIRS, resolveInWorkspace, rootsOf } from './paths.ts'

const MAX_RESULTS = 200

export const globTool: ToolSpec = {
  name: 'glob',
  description:
    '按 glob 模式查找文件，返回相对路径列表（按修改时间倒序）。' +
    '例如 "**/*.ts"、"src/**/test_*.py"。适合「这个项目里所有 X 文件在哪」这类问题。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
      path: { type: 'string', description: '搜索起点（工作区相对），默认工作区根' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  actionKind: 'query',
  objectLabel: '文件',
  category: 'files',
  facet: '检索',
  summary: '按名字通配找文件',
  targetExtractor: (a) => (typeof a.pattern === 'string' ? a.pattern : null),
  permissionEffect: 'read',
  parallelSafe: true,
  async fn(args, ctx) {
    const root = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? '.'), {
      mustExist: true,
    })
    const glob = new Bun.Glob(String(args.pattern))
    const hits: { path: string; mtime: number }[] = []

    for await (const rel of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
      if (rel.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg))) continue
      const abs = join(root, rel)
      const info = await stat(abs).catch(() => null)
      if (!info) continue
      hits.push({ path: toPosix(relative(ctx.workspaceRoot, abs)), mtime: info.mtimeMs })
      if (hits.length >= MAX_RESULTS * 4) break
    }

    hits.sort((a, b) => b.mtime - a.mtime)
    const truncated = hits.length > MAX_RESULTS
    const files = hits.slice(0, MAX_RESULTS).map((h) => h.path)

    return {
      status: 'success',
      message: `匹配 ${files.length} 个文件${truncated ? '（已截断）' : ''}`,
      data: { files, truncated },
    }
  },
}

export const grepTool: ToolSpec = {
  name: 'grep',
  description:
    '按正则搜索文件内容，返回命中的 文件:行号:内容。' +
    '这是定位代码的首选方式——比读整个文件快得多也省得多。' +
    '可用 glob 参数限定文件类型，如 "*.ts"。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索起点（工作区相对），默认工作区根' },
      glob: { type: 'string', description: '文件名过滤，如 *.ts' },
      case_insensitive: { type: 'boolean', description: '忽略大小写' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  actionKind: 'query',
  objectLabel: '内容',
  category: 'files',
  facet: '检索',
  summary: '按正则在文件内容里找',
  targetExtractor: (a) => (typeof a.pattern === 'string' ? a.pattern : null),
  permissionEffect: 'read',
  parallelSafe: true,
  async fn(args, ctx) {
    const root = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? '.'), {
      mustExist: true,
    })
    const pattern = String(args.pattern)
    const ci = args.case_insensitive === true
    const fileGlob = typeof args.glob === 'string' ? args.glob : undefined

    const viaRg = await runRipgrep(root, pattern, { ci, ...(fileGlob ? { glob: fileGlob } : {}) })
    if (viaRg) {
      return {
        status: 'success',
        message: `命中 ${viaRg.lines.length} 行（ripgrep）`,
        data: { matches: viaRg.lines, truncated: viaRg.truncated, engine: 'ripgrep' },
      }
    }

    // 降级路径。结果里明确标 engine，让人知道为什么慢。
    const re = new RegExp(pattern, ci ? 'i' : '')
    const globMatcher = fileGlob ? new Bun.Glob(fileGlob) : null
    const lines: string[] = []
    let truncated = false

    const walk = async (dir: string): Promise<void> => {
      if (lines.length >= MAX_RESULTS) {
        truncated = true
        return
      }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (lines.length >= MAX_RESULTS) {
          truncated = true
          return
        }
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue
          await walk(join(dir, e.name))
          continue
        }
        if (globMatcher && !globMatcher.match(e.name)) continue
        const abs = join(dir, e.name)
        const info = await stat(abs).catch(() => null)
        if (!info || info.size > 2 * 1024 * 1024) continue
        const text = await readFile(abs, 'utf8').catch(() => null)
        if (text === null) continue
        const rel = toPosix(relative(ctx.workspaceRoot, abs))
        text.split('\n').forEach((line, i) => {
          if (lines.length >= MAX_RESULTS) return
          if (re.test(line)) lines.push(`${rel}:${i + 1}:${line.trim().slice(0, 400)}`)
        })
      }
    }
    await walk(root)

    return {
      status: 'success',
      message: `命中 ${lines.length} 行（内置遍历，未找到 ripgrep）`,
      data: { matches: lines, truncated, engine: 'builtin' },
    }
  },
}

async function runRipgrep(
  cwd: string,
  pattern: string,
  opts: { ci: boolean; glob?: string },
): Promise<{ lines: string[]; truncated: boolean } | null> {
  const argv = ['rg', '--line-number', '--no-heading', '--color', 'never', '--max-count', '50']
  if (opts.ci) argv.push('--ignore-case')
  if (opts.glob) argv.push('--glob', opts.glob)
  argv.push('--regexp', pattern, '.')

  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    // rg 的退出码 1 = 没有命中，不是错误。>1 才是真失败。
    if (code > 1) return null
    // rg 输出的是相对 cwd 的原生路径（Windows 上带反斜杠、且以 ./ 开头）。
    // 必须归一成与降级路径一致的 posix 相对路径——同一个工具在两条实现路径上
    // 返回不同的路径格式，模型会照着拼出打不开的路径。
    const all = stdout.split('\n').filter(Boolean).map(normalizeRgLine)
    return { lines: all.slice(0, MAX_RESULTS), truncated: all.length > MAX_RESULTS }
  } catch {
    return null
  }
}

const toPosix = (p: string) => p.split(sep).join('/')

/** `.\src\main.ts:1:内容` → `src/main.ts:1:内容`，只动路径段，不碰内容里的分隔符。 */
function normalizeRgLine(line: string): string {
  const m = /^(.*?):(\d+):(.*)$/s.exec(line)
  if (!m) return line
  const path = toPosix(m[1]!).replace(/^\.\//, '')
  return `${path}:${m[2]}:${m[3]}`
}
