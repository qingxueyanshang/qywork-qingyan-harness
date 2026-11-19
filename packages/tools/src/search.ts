/**
 * 搜索工具：glob（按文件名）与 grep（按内容）。
 *
 * grep 优先使用 ripgrep 二进制：它比 JS 实现快一至两个数量级，并自带
 * .gitignore 语义。未找到 rg 时降级为内置遍历，功能一致但速度较慢，
 * 且不会静默失败：结果中标明使用的是哪种引擎。
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import {
  type CloudTarget,
  cloudFailure,
  cloudSkillDir,
  cloudTarget,
  hiddenPath,
} from './cloud-skills/source.ts'
import { toLf } from './eol.ts'
import {
  fitBudget,
  SCAN_LIMITS,
  type Scan,
  startScan,
  truncationNote,
  walkFiles,
} from './files/scan.ts'
import { displayPath, hiddenInScan, IGNORED_DIRS, resolveInWorkspace, rootsOf } from './paths.ts'
import { collectProcess } from './process/collect.ts'
import { redactSecrets, type SecretSet } from './secrets.ts'

/** 结果不完整时 glob 与 grep 回执中缩小范围的方法。 */
const NARROW = '用 path 指定更小的目录，或使用更具体的模式'

/**
 * 单个文件最多返回的命中条数。
 *
 * 用途：单个巨型文件不能占满 `SCAN_LIMITS.results` 的名额，否则搜索整个目录树的结果
 * 退化为只搜索了一个文件。
 *
 * 两种引擎共用此数值，且截断后必须报告 `truncated`。只为 ripgrep 设上限
 * （`--max-count 50`）时，同一查询在是否安装 rg 的机器上结果不同；且 rg 的截断
 * 不计入 `truncated`：`truncated` 只按总条数计算。
 * 实测本仓库 `packages/ai` 中搜索 `cache`：实际命中 168 行，带上限取回 159 行，
 * 159 ≤ 200，因此报告 `truncated: false`，丢失 9 行，却告知模型结果完整。
 *
 * rg 没有任何选项能报告某个文件被截断，因此只能多请求一条来判定：
 * 请求 `MAX_PER_FILE + 1` 条，某个文件实际返回了该条数，即说明它还有更多命中。
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
 * rg 已输出的行数达到该值即终止 rg，不等待其遍历结束。每个文件至多输出 `MAX_PER_FILE + 1` 行，其中至多一行
 * 不计入结果，因此读取到该行数时保留的命中不少于 `SCAN_LIMITS.results + 1` 条，足以判定结果超过上限。
 */
const RG_ENOUGH_LINES = Math.ceil(((SCAN_LIMITS.results + 1) * (MAX_PER_FILE + 1)) / MAX_PER_FILE)

/**
 * rg 每行输出的最大字节数，超出部分只保留开头（`--max-columns-preview`）。压缩文件的一行可达数百 MB，
 * 不设上限时读取一行即可耗尽内存。取值须大于 `clipMatch` 保留的正文：400 个字符至多 1600 字节，
 * 其余留给行首缩进，保留的开头因此与内置遍历截取的结果相同。
 */
const RG_MAX_COLUMNS = 4096

/**
 * 把 `路径:行号:正文` 中的正文截断到上限，路径与行号原样保留。
 *
 * 不能对整个字符串截断：路径较长时行号会先被截去，该命中将无法定位。
 */
function clipMatch(line: string): string {
  const m = /^(.*?):(\d+):(.*)$/s.exec(line)
  if (!m) return line.length > MAX_MATCH_CHARS ? `${line.slice(0, MAX_MATCH_CHARS)}…` : line
  return `${m[1]}:${m[2]}:${clipBody(m[3]!)}`
}

function clipBody(body: string): string {
  const trimmed = body.trim()
  return trimmed.length > MAX_MATCH_CHARS ? `${trimmed.slice(0, MAX_MATCH_CHARS)}…` : trimmed
}

/** `context` 的上限。前后各取更多行时结果接近整段正文，应改用 read_file 按行号读取。 */
const MAX_CONTEXT = 10

/** 解析 `context`：缺省为 0；不是 0 到 `MAX_CONTEXT` 的整数时返回 null。 */
function contextArg(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 0
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= MAX_CONTEXT ? n : null
}

/** 结果中的一项与其中的命中行数。不带上下文时一项即一行命中；带上下文时一项是合并后的一段。 */
interface GrepItem {
  text: string
  hits: number
}

/**
 * 同一文件的命中按行号补上前后 `context` 行，重叠或相邻的范围合并为一段，每段是结果中的一项。
 * 命中行写作 `路径:行号:正文`，上下文行写作 `路径-行号-正文`，与 ripgrep `-C` 的输出相同。
 *
 * 两种引擎共用：ripgrep 只给出命中行，上下文由调用方读取同一文件后交给本函数，结果不随是否安装 ripgrep 而不同。
 */
function contextBlocks(
  path: string,
  rows: readonly string[],
  hits: readonly number[],
  context: number,
  secrets: SecretSet,
): GrepItem[] {
  const hitSet = new Set(hits)
  const blocks: GrepItem[] = []
  let start = 0
  let end = -1
  let count = 0
  const flush = () => {
    if (end < start) return
    const lines: string[] = []
    for (let n = start; n <= end; n++) {
      const sep = hitSet.has(n) ? ':' : '-'
      lines.push(redactSecrets(`${path}${sep}${n}${sep}${clipBody(rows[n - 1] ?? '')}`, secrets))
    }
    blocks.push({ text: lines.join('\n'), hits: count })
  }
  for (const hit of [...hitSet].sort((a, b) => a - b)) {
    const from = Math.max(1, hit - context)
    const to = Math.min(rows.length, hit + context)
    if (end >= start && from <= end + 1) {
      end = Math.max(end, to)
      count++
    } else {
      flush()
      start = from
      end = to
      count = 1
    }
  }
  flush()
  return blocks
}

/** 结果的命中行数：只计按额度保留下来的各项。 */
function keptHits(items: readonly GrepItem[], kept: number): number {
  return items.slice(0, kept).reduce((sum, item) => sum + item.hits, 0)
}

/**
 * 为 ripgrep 的命中补上下文：按文件分组，读取该文件后交给 `contextBlocks`。文件按首次出现的顺序输出。
 * 文件无法读取或超过 2 MB 时只输出该文件的命中行，与内置遍历跳过大文件的界限相同。
 */
async function ripgrepContext(
  lines: readonly string[],
  cwd: string,
  workspaceRoot: string,
  context: number,
  secrets: SecretSet,
): Promise<GrepItem[]> {
  const byFile = new Map<string, { hits: number[]; lines: string[] }>()
  for (const line of lines) {
    const m = /^(.*?):(\d+):/s.exec(line)
    if (!m) continue
    const entry = byFile.get(m[1]!) ?? { hits: [], lines: [] }
    entry.hits.push(Number(m[2]))
    entry.lines.push(line)
    byFile.set(m[1]!, entry)
  }
  const items: GrepItem[] = []
  for (const [file, entry] of byFile) {
    const abs = resolve(cwd, file)
    const size = (await stat(abs).catch(() => null))?.size ?? Number.POSITIVE_INFINITY
    const text = size <= 2 * 1024 * 1024 ? await readFile(abs, 'utf8').catch(() => null) : null
    if (text === null) {
      for (const line of entry.lines) {
        items.push({
          text: clipMatch(redactSecrets(rebaseLine(line, cwd, workspaceRoot), secrets)),
          hits: 1,
        })
      }
      continue
    }
    const rows = toLf(text).split('\n')
    items.push(
      ...contextBlocks(displayPath(workspaceRoot, abs), rows, entry.hits, context, secrets),
    )
  }
  return items
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
    const cloud = cloudTarget(ctx, args.path)
    if (cloud) return 'status' in cloud ? cloud : globCloud(cloud, String(args.pattern))
    const roots = rootsOf(ctx)
    const root = await resolveInWorkspace(roots, String(args.path ?? '.'), { mustExist: true })
    if (!(await stat(root)).isDirectory()) {
      return {
        status: 'failure',
        message: `${String(args.path)} 不是目录，path 应为搜索起点目录`,
        errorKind: 'invalid_args',
      }
    }
    const plan = globPlan(String(args.pattern))
    const scan = startScan(ctx.signal)
    const hits: { path: string; mtime: number }[] = []

    // 模式开头的字面目录段中有噪音目录时没有结果，与遍历中跳过噪音目录的结论相同。
    if (!plan.base.split('/').some((seg) => IGNORED_DIRS.has(seg))) {
      // 字面目录段来自模型给出的模式，与 path 参数经同一个路径判定。按字面解析：模式中的百分号不是转义。
      const start = plan.base
        ? await resolveInWorkspace(roots, resolve(root, plan.base), { literal: true })
        : root
      for await (const file of walkFiles(start, scan, plan.descend)) {
        if (file.link || !plan.accept(file.rel, file.name)) continue
        const info = await stat(file.abs).catch(() => null)
        if (!info) continue
        hits.push({ path: displayPath(ctx.workspaceRoot, file.abs), mtime: info.mtimeMs })
        // 多取若干倍再按修改时间排序，取最新的部分。
        if (hits.length >= SCAN_LIMITS.results * 4) break
      }
    }
    if (hits.length > SCAN_LIMITS.results) scan.stop('limit')

    hits.sort((a, b) => b.mtime - a.mtime)
    const fit = fitBudget(
      ctx,
      hits.slice(0, SCAN_LIMITS.results).map((h) => h.path),
    )
    return {
      status: 'success',
      message:
        `匹配 ${fit.items.length} 个文件` +
        truncationNote(scan.stopped, fit.trimmed, SCAN_LIMITS.results, NARROW),
      data: { files: fit.items, truncated: scan.stopped !== null || fit.trimmed },
    }
  },
}

/** glob 模式中的通配语法。含这些字符的段不是字面的目录名。 */
const GLOB_SYNTAX = /[*?[\]{}!\\]/

interface GlobPlan {
  /** 模式开头的字面目录段，以 / 连接。遍历从该目录开始；为空串时从搜索起点开始。 */
  base: string
  /** 是否进入子目录。`depth` 是该目录相对遍历起点的层数。 */
  descend(name: string, depth: number): boolean
  /** 文件是否匹配。`rel` 相对遍历起点，以 / 分隔。 */
  accept(rel: string, name: string): boolean
}

/**
 * 把 glob 模式拆为遍历方案，结果与 `Bun.Glob.scan({ onlyFiles: true, dot: false })` 相同：
 * - 开头的字面目录段作为遍历起点，`..` 与绝对路径的写法由此解析；
 * - 不含 `**` 时遍历深度不超过模式的段数，各层目录名须匹配对应的段，因此 `*.md` 只读取起点目录；
 * - 名称以 . 开头的目录与文件只由同样以 . 开头的段匹配，`**` 不进入点目录；
 * - Windows 上反斜杠是路径分隔符。
 * 含 `{}` 或以 `!` 开头的模式无法逐段对应，只按点段规则与整体匹配判定，不限深度。
 *
 * 不要省略深度与逐层的判定：只做整体匹配时，`*.md` 也会遍历起点之下的整棵目录树。
 */
function globPlan(pattern: string): GlobPlan {
  const segments = (process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern).split(
    '/',
  )
  let fixed = 0
  while (fixed < segments.length - 1 && !GLOB_SYNTAX.test(segments[fixed] ?? '')) fixed++
  const rest = segments.slice(fixed)
  const matcher = new Bun.Glob(rest.join('/'))
  const free = /[{}]/.test(pattern) || pattern.startsWith('!')
  const deep = rest.findIndex((s) => s.includes('**'))
  // 按位置对应的层数：这些层的目录名须匹配同一位置的段。
  const positional = free ? 0 : deep === -1 ? rest.length : deep
  const maxDepth = free || deep !== -1 ? Number.POSITIVE_INFINITY : rest.length
  const layers = rest.slice(0, positional).map((s) => new Bun.Glob(s))
  // 最后一段匹配文件名，其余以 . 开头的段决定可以进入哪些点目录。
  const dotDirs = rest
    .slice(0, -1)
    .filter((s) => s.startsWith('.'))
    .map((s) => new Bun.Glob(s))
  const dotFiles = (rest.at(-1) ?? '').startsWith('.')
  return {
    base: segments.slice(0, fixed).join('/'),
    descend(name, depth) {
      if (IGNORED_DIRS.has(name) || depth >= maxDepth) return false
      const dot = name.startsWith('.')
      if (depth <= positional) {
        const segment = rest[depth - 1] ?? ''
        return (layers[depth - 1]?.match(name) ?? false) && (!dot || segment.startsWith('.'))
      }
      return !dot || dotDirs.some((g) => g.match(name))
    },
    accept: (rel, name) => (!name.startsWith('.') || dotFiles) && matcher.match(rel),
  }
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
      context: {
        type: 'integer',
        description: `命中行前后各返回的行数，0–${MAX_CONTEXT}，缺省 0。上下文行写作 文件-行号-内容`,
      },
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
    const context = contextArg(args.context)
    if (context === null) {
      return {
        status: 'failure',
        message: `context 必须是 0 到 ${MAX_CONTEXT} 的整数`,
        errorKind: 'invalid_args',
      }
    }
    const cloud = cloudTarget(ctx, args.path)
    if (cloud) return 'status' in cloud ? cloud : grepCloud(ctx, cloud, args, context)
    const roots = rootsOf(ctx)
    const target = await resolveInWorkspace(roots, String(args.path ?? '.'), { mustExist: true })
    // 命中行是文件正文，与 read_file 的正文一样先脱敏再交给模型。
    const secrets = ctx.secrets ?? { values: [] }
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

    // rg 与降级遍历共用同一个时限与停止信号。停止时 rg 被终止，本次调用随即结束，不转入降级遍历。
    const scan = startScan(ctx.signal)
    const viaRg = await runRipgrep(
      cwd,
      needle,
      pattern,
      { ci, ...(fileGlob ? { glob: fileGlob } : {}) },
      scan,
    )
    ctx.signal.throwIfAborted()
    if (viaRg) {
      // rg 不跟随符号链接，输出的路径即真实路径。
      const visible: string[] = []
      for (const line of viaRg.lines) {
        const file = /^(.*?):\d+:/s.exec(line)?.[1]
        if (file !== undefined && (await hiddenInScan(roots, resolve(cwd, file)))) continue
        visible.push(line)
      }
      const items =
        context > 0
          ? await ripgrepContext(visible, cwd, ctx.workspaceRoot, context, secrets)
          : visible.map((line) => ({
              text: clipMatch(redactSecrets(rebaseLine(line, cwd, ctx.workspaceRoot), secrets)),
              hits: 1,
            }))
      const fit = fitBudget(
        ctx,
        items.map((item) => item.text),
      )
      return {
        status: 'success',
        message:
          `命中 ${keptHits(items, fit.items.length)} 行（ripgrep）` +
          truncationNote(scan.stopped, fit.trimmed, SCAN_LIMITS.results, NARROW),
        data: {
          matches: fit.items,
          truncated: viaRg.truncated || fit.trimmed,
          engine: 'ripgrep',
        },
      }
    }

    // 降级路径。结果中明确标出 engine，以说明速度较慢的原因。
    const re = new RegExp(pattern, ci ? 'i' : '')
    const globMatcher = fileGlob ? new Bun.Glob(fileGlob) : null
    const items: GrepItem[] = []
    let total = 0
    // 已有 `SCAN_LIMITS.results` 条命中时又遇到一条：结果超过上限，与 rg 一侧多取一条的判据相同。
    let overflow = false
    let perFileCapped = false

    const scanFile = async (abs: string): Promise<void> => {
      if (globMatcher && !globMatcher.match(basename(abs))) return
      // 遍历时读取会跟随符号链接，按链接指向的真实路径判定。
      const real = await realpath(abs).catch(() => null)
      if (real === null || (await hiddenInScan(roots, real))) return
      const stats = await stat(abs).catch(() => null)
      // 只读取普通文件：读取命名管道会一直等待写入方，停止信号无法中断这次读取。
      if (!stats?.isFile() || stats.size > 2 * 1024 * 1024) return
      const text = await readFile(abs, 'utf8').catch(() => null)
      if (text === null) return
      const rel = displayPath(ctx.workspaceRoot, abs)
      // 先去除 CR：CRLF 文件中每行末尾都有 `\r`，`foo$` 这类锚定模式将全部无法匹配。
      const rows = toLf(text).split('\n')
      const hits: number[] = []
      for (let i = 0; i < rows.length; i++) {
        if (!re.test(rows[i]!)) continue
        if (total >= SCAN_LIMITS.results) {
          overflow = true
          break
        }
        // 单文件上限与 ripgrep 使用同一数值，截断后同样必须报告 truncated。
        if (hits.length >= MAX_PER_FILE) {
          perFileCapped = true
          break
        }
        hits.push(i + 1)
        total++
      }
      if (context > 0) {
        items.push(...contextBlocks(rel, rows, hits, context, secrets))
        return
      }
      for (const n of hits) {
        items.push({
          text: clipMatch(redactSecrets(`${rel}:${n}:${rows[n - 1]}`, secrets)),
          hits: 1,
        })
      }
    }

    if (isDir) {
      const descend = (name: string) => !IGNORED_DIRS.has(name) && !name.startsWith('.')
      for await (const file of walkFiles(target, scan, descend)) {
        await scanFile(file.abs)
        if (overflow) break
      }
    } else {
      await scanFile(target)
    }
    if (overflow) scan.stop('limit')

    const fit = fitBudget(
      ctx,
      items.map((item) => item.text),
    )
    return {
      status: 'success',
      message:
        `命中 ${keptHits(items, fit.items.length)} 行（内置遍历，未找到 ripgrep）` +
        truncationNote(scan.stopped, fit.trimmed, SCAN_LIMITS.results, NARROW),
      data: {
        matches: fit.items,
        truncated: perFileCapped || scan.stopped !== null || fit.trimmed,
        engine: 'builtin',
      },
    }
  },
}

/** `glob` 在云端技能目录中按技能包的文件清单匹配。没有修改时间，按路径排序。 */
async function globCloud(target: CloudTarget, pattern: string): Promise<ToolOutcome> {
  const listed = await target.port.files(target.pkg)
  if (!listed.ok) return cloudFailure(listed, target)
  const glob = new Bun.Glob(pattern)
  const prefix = target.path ? `${target.path}/` : ''
  const hits = listed.value
    .map((f) => f.path)
    .filter((p) => p.startsWith(prefix))
    .filter((p) => !hiddenPath(p.slice(prefix.length)) && glob.match(p.slice(prefix.length)))
    .map((p) => `${cloudSkillDir(target.pkg)}/${p}`)
  const truncated = hits.length > SCAN_LIMITS.results
  const files = hits.slice(0, SCAN_LIMITS.results)
  return {
    status: 'success',
    message: `匹配 ${files.length} 个文件${truncated ? '（已截断）' : ''}`,
    data: { files, truncated },
  }
}

/**
 * 正则中只匹配字面文本的写法转为该文本；含其他正则语法时返回 null。云端只支持字面检索。
 * 未转义的 `.` 按字面处理：检索文件名与代码中的点号最常见，此时字面结果是正则结果的子集。
 */
function literalOf(pattern: string): string | null {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? ''
    if (c === '\\') {
      const next = pattern[i + 1]
      if (next === undefined || /[\p{L}\p{N}]/u.test(next)) return null
      out += next
      i++
    } else if ('*+?^$|()[]{}'.includes(c)) return null
    else out += c
  }
  return out || null
}

/**
 * `grep` 在云端技能目录中检索：云端只返回位置，命中写作 `路径:行号`，不含正文，内容按行号用 `read_file` 读取。
 * 条数上限、单文件上限与按额度裁剪与本地两种引擎相同。
 */
async function grepCloud(
  ctx: ToolContext,
  target: CloudTarget,
  args: Record<string, unknown>,
  context: number,
): Promise<ToolOutcome> {
  if (context > 0) {
    return {
      status: 'failure',
      message: '云端技能的检索只返回位置，不支持 context；内容用 read_file 按行号读取',
      errorKind: 'invalid_args',
    }
  }
  const literal = literalOf(String(args.pattern ?? ''))
  if (literal === null) {
    return {
      status: 'failure',
      message: '云端技能只支持按字面文本检索，pattern 中不要使用正则语法',
      errorKind: 'invalid_args',
    }
  }
  if (args.case_insensitive === true) {
    return {
      status: 'failure',
      message: '云端技能的检索区分大小写，不支持 case_insensitive',
      errorKind: 'invalid_args',
    }
  }
  const found = await target.port.search(target.pkg, literal, target.path)
  if (!found.ok) return cloudFailure(found, target)
  const nameGlob = typeof args.glob === 'string' ? new Bun.Glob(args.glob) : null
  const lines: string[] = []
  let truncated = found.value.truncated
  for (const m of found.value.matches) {
    if (target.path && m.path !== target.path && !m.path.startsWith(`${target.path}/`)) continue
    if (nameGlob && !nameGlob.match(basename(m.path))) continue
    if (m.lines.length > MAX_PER_FILE) truncated = true
    for (const line of m.lines.slice(0, MAX_PER_FILE)) {
      if (lines.length >= SCAN_LIMITS.results) {
        truncated = true
        break
      }
      lines.push(`${cloudSkillDir(target.pkg)}/${m.path}:${line}`)
    }
  }
  const fit = fitBudget(ctx, lines)
  return {
    status: 'success',
    message:
      `命中 ${fit.items.length} 行（云端技能，只返回位置，内容用 read_file 按行号读取）` +
      truncationNote(null, fit.trimmed, SCAN_LIMITS.results, NARROW),
    data: { matches: fit.items, truncated: truncated || fit.trimmed, engine: 'cloud' },
  }
}

/**
 * 用 rg 搜索。rg 无法执行该模式（未安装、正则语法不受支持）时返回 null，由调用方转入内置遍历。
 * 总时长不超过 `scan` 的剩余时限，输出足够判定结果超过上限时即终止 rg，到期与提前终止都记入 `scan.stopped`。
 */
async function runRipgrep(
  cwd: string,
  needle: string,
  pattern: string,
  opts: { ci: boolean; glob?: string },
  scan: Scan,
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
    // 无法读取的文件不输出说明，只使退出码为 2，其余文件的结果照常输出。
    // 因此 stderr 只在 rg 无法执行该模式时非空，下方据此区分两种退出码 2。
    '--no-messages',
    '--max-columns',
    String(RG_MAX_COLUMNS),
    '--max-columns-preview',
    // 多请求一条，用于判断该文件是否还有更多命中，见 `MAX_PER_FILE`。
    '--max-count',
    String(MAX_PER_FILE + 1),
  ]
  if (opts.ci) argv.push('--ignore-case')
  if (opts.glob) argv.push('--glob', opts.glob)
  argv.push('--regexp', pattern, needle)

  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    // 输出足够时经停止信号的同一入口终止 rg：只停止读取时，没有后续输出的 rg 会一直遍历到时限。
    const enough = new AbortController()
    let read = 0
    // 使用统一的等待入口：完成判据是进程退出，不是管道 EOF。到期、停止与输出足够都终止进程树。
    const run = await collectProcess(proc, {
      signal: AbortSignal.any([scan.signal, enough.signal]),
      timeoutMs: scan.remainingMs(),
      onText: (channel, text) => {
        if (channel === 'stdout') {
          read += text.split('\n').length - 1
          if (read >= RG_ENOUGH_LINES) enough.abort()
        }
        return text
      },
    })
    if (run.timedOut) scan.stop('time')
    // 被本地终止时退出码不反映搜索结果。自行结束时退出码 1 表示没有命中；
    // 2 且 stderr 为空表示部分文件无法读取，其余结果照常使用。不要把后者转入内置遍历：
    // 以家目录为起点时几乎必然有无法读取的文件，内置遍历逐个读取文件，远慢于 rg。
    else if (!enough.signal.aborted && run.exitCode > 1 && run.stderr.trim()) return null
    // 被终止的 rg 最后一行可能只输出了一部分，截在路径中间时无法定位，丢弃最后一个换行之后的内容。
    const stdout = run.stdout.slice(0, run.stdout.lastIndexOf('\n') + 1)
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
    if (kept.length > SCAN_LIMITS.results) scan.stop('limit')
    return {
      lines: kept.slice(0, SCAN_LIMITS.results),
      truncated: capped || scan.stopped !== null,
    }
  } catch {
    return null
  }
}

/**
 * 将 `路径:行号:内容` 中的路径改为展示路径（`displayPath`：工作区内为相对路径，工作区外为绝对路径），
 * 只修改路径段，不涉及内容中的冒号。
 *
 * rg 输出的路径相对于搜索起点，而不是相对于工作区。只去除 `./` 前缀时，
 * `path="js"` 搜索得到的 `game.js:486` 会原样交给模型，模型据此调用 `read_file`
 * 只会得到「文件不存在」，实际路径是 `js/game.js`。降级遍历使用同一展示路径，
 * 两种引擎必须给出同一形式的路径，否则同一工具的行为会随是否安装 rg 而变化。
 */
function rebaseLine(line: string, cwd: string, workspaceRoot: string): string {
  const m = /^(.*?):(\d+):(.*)$/s.exec(line)
  if (!m) return line
  return `${displayPath(workspaceRoot, resolve(cwd, m[1]!))}:${m[2]}:${m[3]}`
}
