/**
 * 搜索工具：glob（按文件名）与 grep（按内容）。
 *
 * grep 优先走 ripgrep 二进制——它比任何 JS 实现快一到两个数量级，而且自带
 * .gitignore 语义。找不到 rg 时降级到内置遍历，功能一致、速度慢，
 * 但**不会静默失败**：结果里会标明用的是哪条路径。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
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
    const target = await resolveInWorkspace(rootsOf(ctx), String(args.path ?? '.'), {
      mustExist: true,
    })
    const pattern = String(args.pattern)
    const ci = args.case_insensitive === true
    const fileGlob = typeof args.glob === 'string' ? args.glob : undefined

    /*
     * **起点可以是一个文件，不只是目录。** 模型很自然会写
     * `grep(pattern, path="js/game.js")`——rg 本来就支持，而两条实现路径都曾把
     * 起点当目录用：rg 那条拿文件当 `cwd` 去 spawn（直接抛，落到降级），
     * 降级那条对文件 `readdir`（抛，被 catch 成空数组）。合起来的表现是
     * **一次 `success` 的 0 命中**——比报错坏得多，模型会当成「这个符号不存在」。
     *
     * 所以起点在这里拆成「在哪搜」和「搜什么」：目录搜整棵树，文件只搜它自己。
     */
    const info = await stat(target)
    const isDir = info.isDirectory()
    const cwd = isDir ? target : dirname(target)
    const needle = isDir ? '.' : basename(target)

    const viaRg = await runRipgrep(cwd, needle, pattern, {
      ci,
      ...(fileGlob ? { glob: fileGlob } : {}),
    })
    if (viaRg) {
      return {
        status: 'success',
        message: `命中 ${viaRg.lines.length} 行（ripgrep）`,
        data: {
          matches: viaRg.lines.map((l) => rebaseLine(l, cwd, ctx.workspaceRoot)),
          truncated: viaRg.truncated,
          engine: 'ripgrep',
        },
      }
    }

    // 降级路径。结果里明确标 engine，让人知道为什么慢。
    const re = new RegExp(pattern, ci ? 'i' : '')
    const globMatcher = fileGlob ? new Bun.Glob(fileGlob) : null
    const lines: string[] = []
    let truncated = false

    const scanFile = async (abs: string): Promise<void> => {
      if (globMatcher && !globMatcher.match(basename(abs))) return
      const stats = await stat(abs).catch(() => null)
      if (!stats || stats.size > 2 * 1024 * 1024) return
      const text = await readFile(abs, 'utf8').catch(() => null)
      if (text === null) return
      const rel = toPosix(relative(ctx.workspaceRoot, abs))
      text.split('\n').forEach((line, i) => {
        if (lines.length >= MAX_RESULTS) return
        if (re.test(line)) lines.push(`${rel}:${i + 1}:${line.trim().slice(0, 400)}`)
      })
    }

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
        await scanFile(join(dir, e.name))
      }
    }
    if (isDir) await walk(target)
    else await scanFile(target)

    return {
      status: 'success',
      message: `命中 ${lines.length} 行（内置遍历，未找到 ripgrep）`,
      data: { matches: lines, truncated, engine: 'builtin' },
    }
  },
}

async function runRipgrep(
  cwd: string,
  needle: string,
  pattern: string,
  opts: { ci: boolean; glob?: string },
): Promise<{ lines: string[]; truncated: boolean } | null> {
  // `--with-filename` 不能省：只给一个文件当搜索起点时 rg 默认不打印文件名，
  // 输出会退化成 `行号:内容`，重挂路径那一步就无从下手，模型拿到的命中不带位置。
  const argv = [
    'rg',
    '--line-number',
    '--with-filename',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    '50',
  ]
  if (opts.ci) argv.push('--ignore-case')
  if (opts.glob) argv.push('--glob', opts.glob)
  argv.push('--regexp', pattern, needle)

  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    // rg 的退出码 1 = 没有命中，不是错误。>1 才是真失败。
    if (code > 1) return null
    const all = stdout.split('\n').filter(Boolean)
    return { lines: all.slice(0, MAX_RESULTS), truncated: all.length > MAX_RESULTS }
  } catch {
    return null
  }
}

const toPosix = (p: string) => p.split(sep).join('/')

/**
 * `路径:行号:内容` 里的路径重挂到工作区根上，只动路径段，不碰内容里的冒号。
 *
 * **rg 的路径是相对搜索起点的，不是相对工作区的。** 只剥 `./` 前缀的话，
 * `path="js"` 搜出来的 `game.js:486` 会原样端给模型，而它照着去 `read_file`
 * 只会拿到「文件不存在」——真实路径是 `js/game.js`。降级遍历那条一直是按
 * 工作区算的，两条路必须给出同一种路径，否则同一个工具会随 rg 装没装而变。
 */
function rebaseLine(line: string, cwd: string, workspaceRoot: string): string {
  const m = /^(.*?):(\d+):(.*)$/s.exec(line)
  if (!m) return line
  return `${toPosix(relative(workspaceRoot, resolve(cwd, m[1]!)))}:${m[2]}:${m[3]}`
}
