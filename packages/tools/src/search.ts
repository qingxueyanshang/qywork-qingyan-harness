/**
 * 搜索工具：glob（按文件名）与 grep（按内容）。
 *
 * grep 优先走 ripgrep 二进制——它比任何 JS 实现快一到两个数量级，而且自带
 * .gitignore 语义。找不到 rg 时降级到内置遍历，功能一致、速度慢，
 * 但**不会静默失败**：结果里会标明用的是哪条路径。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { chargeBatchBudget, type ToolContext, type ToolSpec } from '@qywork/agent'
import { estimateText } from '@qywork/ai'
import { toLf } from './eol.ts'
import { IGNORED_DIRS, resolveInWorkspace, rootsOf } from './paths.ts'
import { collectProcess } from './sandbox.ts'

const MAX_RESULTS = 200

/**
 * 单个文件最多带回多少条命中。
 *
 * 存在的理由：一个巨型文件不能吃光 `MAX_RESULTS` 的名额，否则「搜整棵树」的结果
 * 退化成「搜了一个文件」。
 *
 * **两条引擎共用这一个数，而且截了必须报 `truncated`。** 从前只有 ripgrep 那条
 * 有上限（`--max-count 50`），内置遍历那条没有，于是同一个查询在装没装 rg 的机器上
 * 结果不同；更要命的是 rg 那一刀不进 `truncated`——`truncated` 只按总条数算，
 * 实测本仓 `packages/ai` 搜 `cache`：真实命中 168 行、带上限拿回 159 行、
 * 159 ≤ 200 于是报 `truncated: false`。**丢了 9 行，还告诉模型搜全了。**
 *
 * rg 没有任何开关能说出「这个文件被截过」，所以判据只能靠多要一条：
 * 向它要 `MAX_PER_FILE + 1`，某个文件真回了这么多就说明它至少还有更多。
 */
const MAX_PER_FILE = 50

/**
 * 一条命中最多带回多少字符的正文。
 *
 * **两条引擎共用这一个数。** 从前只有内置遍历那条路截（一个内联的 400），
 * ripgrep 那条只限条数不限长度——而两条路对模型是同一个工具，
 * 于是同一次调用走哪条引擎决定了结果有没有上界，这是两本账。
 *
 * 上界不是保守起见：压缩过的产物是**一整个文件一行**。实测一次不限文件类型的
 * `grep "TODO|bug"` 命中 152 行，其中 151 行都不到 600 字符，
 * 剩下那一行是 `three.min.js` 的第 6 行——**603,378 个字符**，约 17 万 token。
 * 它随工具结果进上下文之后再也不会出去，此后每一轮都重付一遍，
 * 还把请求顶过了长上下文档的价钱。
 *
 * 截的是**这一行的正文**，不是命中条数：路径与行号一个字节不能少，
 * 模型要靠它们去 read_file 取原文。
 */
const MAX_MATCH_CHARS = 400

/**
 * 把 `路径:行号:正文` 里的正文截到上界，路径与行号原样留着。
 *
 * 整串一起截是错的：路径长的时候会把行号先切掉，那条命中就再也定位不回去。
 */
/**
 * 按投递预算把命中列表裁到装得下，并把实际用量记账。
 *
 * **grep 从前完全不计入这本账**，而 `loop.ts` 下发每一波之前 `resetBatchBudget`
 * 的理由写得很清楚：「压缩只留一个入口」的前提正是两次检查之间的跳变有上界。
 * 单次上界 25,000 token，而 200 条 × 400 字符最坏约 32,000——**单次就越了**；
 * 它又是 `parallelSafe`，一波五个就是整波上界的三倍多。那个前提于是不成立。
 *
 * **裁而不是拒。** 这个工具本来就有截断契约（`MAX_RESULTS` + `truncated`），
 * 按预算少给几条走的是同一条路；改成失败则是新增一种失败模式，
 * 而 grep 没有 offset，模型只能靠猜一个更窄的模式重来。
 */
function fitBudget(ctx: ToolContext, matches: string[]): { matches: string[]; trimmed: boolean } {
  const total = estimateText(matches.join('\n'))
  const charged = chargeBatchBudget(ctx, total)
  if (charged.ok) return { matches, trimmed: false }

  const room = Math.min(charged.perCall, charged.batchRemaining)
  const kept: string[] = []
  let used = 0
  for (const m of matches) {
    // +1 是行分隔符：不算它的话，条数多时累计误差正好朝着超预算的方向。
    const n = estimateText(m) + 1
    if (used + n > room) break
    kept.push(m)
    used += n
  }
  chargeBatchBudget(ctx, used)
  return { matches: kept, trimmed: true }
}

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
      const clipped = viaRg.lines.map((l) => clipMatch(rebaseLine(l, cwd, ctx.workspaceRoot)))
      const fit = fitBudget(ctx, clipped)
      return {
        status: 'success',
        message:
          `命中 ${fit.matches.length} 行（ripgrep）` +
          (fit.trimmed ? '，已按投递预算截断，收窄模式或范围可看到更多' : ''),
        data: {
          matches: fit.matches,
          truncated: viaRg.truncated || fit.trimmed,
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
      // 先去 CR：CRLF 文件里每行尾巴都拖着一个 `\r`，`foo$` 这类锚定模式会全部落空。
      const rows = toLf(text).split('\n')
      let inFile = 0
      rows.forEach((line, i) => {
        if (lines.length >= MAX_RESULTS) return
        if (!re.test(line)) return
        // 每文件上限与 ripgrep 那条同一个数，截了同样要报 truncated。
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
        (fit.trimmed ? '，已按投递预算截断，收窄模式或范围可看到更多' : ''),
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
  // `--with-filename` 不能省：只给一个文件当搜索起点时 rg 默认不打印文件名，
  // 输出会退化成 `行号:内容`，重挂路径那一步就无从下手，模型拿到的命中不带位置。
  const argv = [
    'rg',
    '--line-number',
    '--with-filename',
    '--no-heading',
    '--color',
    'never',
    // 多要一条，用来判断这个文件是不是还有更多——见 `MAX_PER_FILE`。
    '--max-count',
    String(MAX_PER_FILE + 1),
  ]
  if (opts.ci) argv.push('--ignore-case')
  if (opts.glob) argv.push('--glob', opts.glob)
  argv.push('--regexp', pattern, needle)

  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    // 走同一个收口：完成判据是进程退出，不是管道 EOF。
    //
    // **这条路上的 EOF 挂死不可达**：rg 不派生子进程，没人能在它退出后还扣着写端。
    // 改它是为了让「等子进程」只有一种写法——五处各写一遍的代价已经付过一次了。
    const { exitCode, stdout } = await collectProcess(proc)
    // rg 的退出码 1 = 没有命中，不是错误。>1 才是真失败。
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
      // 第 MAX_PER_FILE + 1 条只用来作证「还有更多」，不进结果。
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
