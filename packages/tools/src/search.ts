/**
 * 搜索工具：glob（按文件名）与 grep（按内容）。
 *
 * grep 优先使用 ripgrep 二进制：它比 JS 实现快一到两个数量级，并自带
 * .gitignore 语义。未找到 rg 时降级为内置遍历，功能一致但速度较慢，
 * 且不会静默失败：结果中标明使用的是哪种引擎。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  chargeBatchBudget,
  deliveredTokens,
  recordBatchSpent,
  type ToolContext,
  type ToolSpec,
} from '@qywork/agent'
import { toLf } from './eol.ts'
import { IGNORED_DIRS, resolveInWorkspace, rootsOf } from './paths.ts'
import { collectProcess } from './sandbox.ts'

const MAX_RESULTS = 200

/**
 * 单个文件最多返回的命中条数。
 *
 * 用途：单个巨型文件不能占满 `MAX_RESULTS` 的名额，否则搜索整个目录树的结果
 * 退化为只搜索了一个文件。
 *
 * 两种引擎共用此数值，且截断后必须报告 `truncated`。只为 ripgrep 设上限
 * （`--max-count 50`）时，同一查询在是否安装 rg 的机器上结果不同；且 rg 的截断
 * 不计入 `truncated`：`truncated` 只按总条数计算。
 * 实测本仓库 `packages/ai` 中搜索 `cache`：实际命中 168 行，带上限取回 159 行，
 * 159 ≤ 200，因此报告 `truncated: false`，丢失 9 行，却告知模型结果完整。
 *
 * rg 没有任何选项能报告某个文件被截断，因此只能多请求一条来判定：
 * 请求 `MAX_PER_FILE + 1` 条，某个文件实际返回了这么多条，即说明它还有更多命中。
 */
const MAX_PER_FILE = 50

/**
 * 每条命中最多返回的正文字符数。
 *
 * 两种引擎共用此数值。只在内置遍历中截断、ripgrep 只限条数不限长度时，
 * 两种引擎对模型是同一个工具，而同一次调用使用哪种引擎决定了结果是否有上限，
 * 同一工具因此有两种行为。
 *
 * 设置上限并非出于保守：压缩后的产物整个文件只有一行。实测一次不限文件类型的
 * `grep "TODO|bug"` 命中 152 行，其中 151 行不到 600 字符，
 * 余下一行是 `three.min.js` 的第 6 行，共 603,378 个字符，约 17 万 token。
 * 它随工具结果进入上下文后不会再移出，此后每一轮都重复计费，
 * 并使请求超过长上下文计价档位。
 *
 * 截断的是该行的正文，不是命中条数：路径与行号必须完整保留，
 * 模型依据它们调用 read_file 读取原文。
 */
const MAX_MATCH_CHARS = 400

/**
 * 按本次决策的剩余额度裁剪命中列表，并记录实际用量。
 *
 * grep 必须计入该额度。200 条 × 400 字符最多约 32,000 token，且它是 `parallelSafe`；
 * 一次决策中多个 grep 不记录用量时，同一决策中的后续读取会按虚高的余额准入。
 *
 * 裁剪而不是拒绝。该工具已有截断约定（`MAX_RESULTS` + `truncated`），
 * 按额度少返回几条属于同一机制；改为失败则新增一种失败模式，
 * 而 grep 没有 offset，模型只能推测并换用更窄的模式重试。
 */
function fitBudget(ctx: ToolContext, matches: string[]): { matches: string[]; trimmed: boolean } {
  const total = deliveredTokens(matches.join('\n'), ctx.density)
  const charged = chargeBatchBudget(ctx, total)
  if (charged.ok) return { matches, trimmed: false }

  const room = charged.cap
  const kept: string[] = []
  let used = 0
  for (const m of matches) {
    // +1 是行分隔符：不计入时，条数较多时的累计误差会导致超出预算。
    const n = deliveredTokens(m, ctx.density) + 1
    // 第一条超出余量时也返回：不返回任何命中等于告知模型没有匹配。
    if (kept.length > 0 && used + n > room) break
    kept.push(m)
    used += n
  }
  if (!chargeBatchBudget(ctx, used).ok) recordBatchSpent(ctx, used)
  return { matches: kept, trimmed: kept.length < matches.length }
}

/**
 * 把 `路径:行号:正文` 中的正文截断到上限，路径与行号原样保留。
 *
 * 不能对整个字符串截断：路径较长时行号会先被截掉，该命中将无法定位。
 */
function clipMatch(line: string): string {
  const m = /^(.*?):(\d+):(.*)$/s.exec(line)
  if (!m) return line.length > MAX_MATCH_CHARS ? `${line.slice(0, MAX_MATCH_CHARS)}…` : line
  const body = m[3]!.trim()
  const clipped = body.length > MAX_MATCH_CHARS ? `${body.slice(0, MAX_MATCH_CHARS)}…` : body
  return `${m[1]}:${m[2]}:${clipped}`
}

export const globTool: ToolSpec = {
  name: 'glob',
  description:
    '按 glob 模式查找文件，返回相对路径列表（按修改时间倒序）。' +
    '例如 "**/*.ts"、"src/**/test_*.py"。适用于「项目中所有 X 文件位于何处」这类问题。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 **/*.ts' },
      path: { type: 'string', description: '搜索起点（工作区相对路径），默认为工作区根' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  actionKind: 'query',
  objectLabel: '文件',
  category: 'files',
  facet: '检索',
  summary: '按文件名通配查找文件',
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
    '这是定位代码的首选方式，开销低于读取整个文件。' +
    '可用 glob 参数限定文件类型，如 "*.ts"。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索起点（工作区相对路径），默认为工作区根' },
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
  summary: '按正则搜索文件内容',
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
     * 起点可以是文件，不只是目录。模型常会写 `grep(pattern, path="js/game.js")`，
     * rg 本身支持这种用法；但把起点当作目录时两种实现都会出错：rg 以文件作为
     * `cwd` 执行 spawn（抛出异常，转入降级路径），降级路径对文件执行 `readdir`
     * （抛出异常，被 catch 为空数组）。结果是一次 0 命中的 `success`，
     * 比报错更糟：模型会认为该符号不存在。
     *
     * 因此在此处把起点拆分为搜索位置与搜索对象：目录搜索整个目录树，文件只搜索其自身。
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
      const clipped = viaRg.lines.map((l) => clipMatch(rebaseLine(l, cwd, ctx.workspaceRoot)))
      const fit = fitBudget(ctx, clipped)
      return {
        status: 'success',
        message:
          `命中 ${fit.matches.length} 行（ripgrep）` +
          (fit.trimmed ? '，已按上下文剩余空间截断，收窄模式或范围可查看更多' : ''),
        data: {
          matches: fit.matches,
          truncated: viaRg.truncated || fit.trimmed,
          engine: 'ripgrep',
        },
      }
    }

    // 降级路径。结果中明确标出 engine，以说明速度较慢的原因。
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
      // 先去除 CR：CRLF 文件中每行末尾都有 `\r`，`foo$` 这类锚定模式将全部无法匹配。
      const rows = toLf(text).split('\n')
      let inFile = 0
      rows.forEach((line, i) => {
        if (lines.length >= MAX_RESULTS) return
        if (!re.test(line)) return
        // 单文件上限与 ripgrep 使用同一数值，截断后同样必须报告 truncated。
        if (inFile >= MAX_PER_FILE) {
          truncated = true
          return
        }
        inFile++
        lines.push(clipMatch(`${rel}:${i + 1}:${line}`))
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

    const fit = fitBudget(ctx, lines)
    return {
      status: 'success',
      message:
        `命中 ${fit.matches.length} 行（内置遍历，未找到 ripgrep）` +
        (fit.trimmed ? '，已按上下文剩余空间截断，收窄模式或范围可查看更多' : ''),
      data: { matches: fit.matches, truncated: truncated || fit.trimmed, engine: 'builtin' },
    }
  },
}

async function runRipgrep(
  cwd: string,
  needle: string,
  pattern: string,
  opts: { ci: boolean; glob?: string },
): Promise<{ lines: string[]; truncated: boolean } | null> {
  // 不能省略 `--with-filename`：以单个文件作为搜索起点时 rg 默认不输出文件名，
  // 输出退化为 `行号:内容`，无法重新计算路径，模型收到的命中不含位置。
  const argv = [
    'rg',
    '--line-number',
    '--with-filename',
    '--no-heading',
    '--color',
    'never',
    // 多请求一条，用于判断该文件是否还有更多命中，见 `MAX_PER_FILE`。
    '--max-count',
    String(MAX_PER_FILE + 1),
  ]
  if (opts.ci) argv.push('--ignore-case')
  if (opts.glob) argv.push('--glob', opts.glob)
  argv.push('--regexp', pattern, needle)

  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    // 使用统一的等待入口：完成判据是进程退出，不是管道 EOF。
    //
    // 此路径上不会因 EOF 而永久阻塞：rg 不派生子进程，退出后没有进程持有写端。
    // 使用统一入口是为了使等待子进程只有一种实现，各处分别实现必然不一致。
    const { exitCode, stdout } = await collectProcess(proc)
    // rg 的退出码 1 表示没有命中，不是错误；大于 1 才是失败。
    if (exitCode > 1) return null
    const kept: string[] = []
    const seen = new Map<string, number>()
    let capped = false
    for (const line of stdout.split('\n')) {
      if (!line) continue
      const at = line.indexOf(':')
      const path = at < 0 ? line : line.slice(0, at)
      const n = (seen.get(path) ?? 0) + 1
      seen.set(path, n)
      // 第 MAX_PER_FILE + 1 条只用于证明还有更多命中，不计入结果。
      if (n > MAX_PER_FILE) {
        capped = true
        continue
      }
      kept.push(line)
    }
    return { lines: kept.slice(0, MAX_RESULTS), truncated: capped || kept.length > MAX_RESULTS }
  } catch {
    return null
  }
}

const toPosix = (p: string) => p.split(sep).join('/')

/**
 * 将 `路径:行号:内容` 中的路径改为相对于工作区根目录，只修改路径段，不涉及内容中的冒号。
 *
 * rg 输出的路径相对于搜索起点，而不是相对于工作区。只去掉 `./` 前缀时，
 * `path="js"` 搜索得到的 `game.js:486` 会原样交给模型，模型据此调用 `read_file`
 * 只会得到「文件不存在」，实际路径是 `js/game.js`。降级遍历始终按
 * 工作区计算路径，两种引擎必须给出同一形式的路径，否则同一工具的行为会随是否安装 rg 而变化。
 */
function rebaseLine(line: string, cwd: string, workspaceRoot: string): string {
  const m = /^(.*?):(\d+):(.*)$/s.exec(line)
  if (!m) return line
  return `${toPosix(relative(workspaceRoot, resolve(cwd, m[1]!)))}:${m[2]}:${m[3]}`
}
