/**
 * 工作区路径约束 —— 安全边界，不是便利函数。
 *
 * 模型给出的 path 是不可信输入。每一次文件操作前都必须把它解析成规范形式并确认
 * 仍在工作区内；越界就拒绝。这里要挡住的是：`..` 回溯、绝对路径、符号链接逃逸、
 * URL 编码的 `%2e%2e%2f`、以及 Windows 上的盘符切换与 UNC 路径。
 *
 * 绝不允许把原始 path 直接交给 open/readFile/unlink——那是这类工具最常见的破口。
 */

import { readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class PathEscapeError extends Error {
  constructor(readonly attempted: string) {
    super(`路径越界，已拒绝：${attempted}`)
    this.name = 'PathEscapeError'
  }
}

/**
 * 可访问的根目录集合。
 *
 * ## 为什么是「集合」而不是单个工作区
 *
 * 「要内核级沙箱」和「要操作电脑」是方向相反的两个需求，而额外根目录正是让
 * 两者共存的那个机制：边界仍然是白名单，只是白名单里不止一项。没有它的话，
 * 想让 agent 碰工作区外的任何东西，唯一的办法是整个关掉边界。
 *
 * **这份清单必须同时喂给三层**（路径解析、`policy.ts` 的静态规则、沙箱 bind 列表）。
 * 只接一层的症状都是「配了但不管用」，而三层各自的错误信息完全不同——
 * 用户会以为是三个 bug。见 ROADMAP §31。
 */
export interface WorkspaceRoots {
  workspaceRoot: string
  /**
   * 额外可读写的根目录，**必须是绝对路径**。
   *
   * 相对路径的基准是进程 cwd，而 `qy` 可以从任何目录启动——
   * 同一份配置在不同地方含义不同，那是配置项最坏的一种失败方式。
   * 非绝对路径在配置体检期就会被指出来，这里再滤一道（防止绕过上游校验）。
   */
  additional?: readonly string[]
}

/** 调用方可以只传工作区字符串——绝大多数地方没有额外根目录。 */
export type RootsInput = string | WorkspaceRoots

/**
 * 从 `ToolContext` 取根目录清单。
 *
 * 参数写成结构类型而不是 `import type { ToolContext }`：这个模块是纯路径判定，
 * 不该为了一个两字段的读取把整个 agent 包拖进来。
 *
 * 每个工具各写一遍 `{ workspaceRoot: ctx.workspaceRoot, additional: ... }` 的话，
 * 漏掉 `additional` 的那个工具会安静地退回「只认工作区」——而那正是
 * 「配了但只有一半管用」的来源。走同一个函数，漏不掉。
 */
export function rootsOf(ctx: {
  workspaceRoot: string
  additionalDirectories?: readonly string[]
}): WorkspaceRoots {
  return {
    workspaceRoot: ctx.workspaceRoot,
    ...(ctx.additionalDirectories?.length ? { additional: ctx.additionalDirectories } : {}),
  }
}

/**
 * 校验并规范化配置里的额外根目录。
 *
 * 唯一入口，配置体检和装配走同一份判定——两边各写一遍必然会分叉，
 * 而分叉的表现是「体检说没问题，运行时不生效」。
 *
 * 拒绝而不是静默修正：一条被悄悄忽略的额外目录，用户看到的是
 * 「我明明配了却还是被拒」，而错误出在他自己那一行上，本来一句话就能说清。
 */
export function normalizeAdditionalDirectories(raw: readonly string[] | undefined): {
  dirs: string[]
  problems: string[]
} {
  const dirs: string[] = []
  const problems: string[] = []
  const seen = new Set<string>()

  for (const entry of raw ?? []) {
    const trimmed = String(entry ?? '').trim()
    if (!trimmed) continue
    if (!isAbsolute(trimmed)) {
      problems.push(
        `additionalDirectories 里的 "${trimmed}" 不是绝对路径。` +
          `相对路径的基准是启动 qy 时所在的目录，换个地方启动含义就变了——` +
          `请写成绝对路径。`,
      )
      continue
    }
    const normalized = resolve(trimmed)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    dirs.push(normalized)
  }

  return { dirs, problems }
}

function normalizeRoots(input: RootsInput): WorkspaceRoots {
  return typeof input === 'string' ? { workspaceRoot: input } : input
}

/**
 * 把工具参数里的相对路径解析成允许范围内的绝对路径。
 *
 * `mustExist=false`（写入新文件）时目标可能还不存在，但**判定与返回值都必须是
 * 解析后的路径**：只解祖先、返回字面路径的话，`out` 是一条指向界外的软链时，
 * 边界查的是 `<工作区>`、写下去的却是 `out` 指向的地方——软链逃逸在写路径上原样成立。
 * 悬挂软链（指向一个还不存在的位置）也要按它指向的地方判，见 `resolveForWrite`。
 *
 * 额外根目录走的是**完全相同的一套判定**（先 realpath 再比对），不是另开一条
 * 宽松通道：一个指向清单内目录的软链，如果只按字面比较就能把整棵树带出来。
 */
export async function resolveInWorkspace(
  roots: RootsInput,
  candidate: string,
  opts: { mustExist?: boolean } = {},
): Promise<string> {
  const { workspaceRoot, additional } = normalizeRoots(roots)
  const raw = decodeSafely(candidate)

  // 相对路径的基准永远是工作区，不是额外根目录——额外根目录只能用绝对路径够到。
  // 否则 `read_file("notes.md")` 会变成「在若干个根里挨个碰运气」，
  // 而命中哪一个取决于目录内容，同一句话两次可能读到不同的文件。
  const joined = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)

  const targetReal = opts.mustExist
    ? await realpath(joined).catch(() => {
        throw new PathEscapeError(candidate)
      })
    : await resolveForWrite(joined)

  // 工作区根解析不了是**装配错误**，让它原样抛：那条 ENOENT 指向真正的问题，
  // 换成「路径越界」只会把排查方向引到用户输入上去。
  // 额外根目录不同——用户配错一条不该让整次解析炸掉，跳过即可。
  const rootReals = [await realpath(workspaceRoot)]
  for (const extra of additional ?? []) {
    const real = await realpath(extra).catch(() => null)
    if (real !== null) rootReals.push(real)
  }

  for (const rootReal of rootReals) {
    if (isInside(rootReal, targetReal)) {
      // **判定用的和返回的是同一个路径。** 两者不同的话，判的是 A、写的是 B，
      // 边界就只是看起来在那里；调用方按返回值记账时也会与读路径对不上
      // （`files.ts` 的「本轮读过没有」曾因此在软链根下恒判 stale）。
      return targetReal
    }
  }

  throw new PathEscapeError(candidate)
}

/**
 * 解析一个「即将写入」的路径。
 *
 * 三种情形，都要落到**它实际会写到的那个位置**：
 * 1. 目标已存在（含软链）—— realpath 直接解开。
 * 2. 目标是**悬挂软链** —— realpath 会失败，但写下去照样跟随它。
 *    所以 lstat 到软链时按 readlink 的指向判，这是「写新文件」这条路上的真正破口。
 * 3. 目标确实不存在 —— 解析已存在的最近祖先，再把消耗掉的段接回去，
 *    这样中间目录的软链也已经解开。
 */
async function resolveForWrite(target: string): Promise<string> {
  const real = await realpath(target).catch(() => null)
  if (real !== null) return real

  const link = await readlink(target).catch(() => null)
  if (link !== null) return resolve(dirname(target), link)

  const { real: ancestor, rest } = await nearestExisting(target)
  return rest.length ? resolve(ancestor, ...rest) : ancestor
}

/** 已存在的最近祖先目录，以及从它到目标之间被消耗掉的路径段。 */
async function nearestExisting(target: string): Promise<{ real: string; rest: string[] }> {
  const rest: string[] = []
  let cur = target
  for (;;) {
    const parent = resolve(cur, '..')
    if (parent === cur) return { real: cur, rest } // 到根了
    rest.unshift(basename(cur))
    const real = await realpath(parent).catch(() => null)
    if (real !== null) return { real, rest }
    cur = parent
  }
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const rel = relative(root, target)
  // relative() 越界时会以 '..' 开头；跨盘符时会返回绝对路径。两种都要挡。
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 反复解码百分号转义，直到不再变化。
 * 单次解码挡不住 `%252e%252e%252f` 这类双重编码。
 */
function decodeSafely(input: string): string {
  let cur = input
  for (let i = 0; i < 4; i++) {
    let next: string
    try {
      next = decodeURIComponent(cur)
    } catch {
      break
    }
    if (next === cur) break
    cur = next
  }
  // 归一化分隔符，避免 Windows 上混用 / 与 \ 绕过检查。
  return cur.split(/[\\/]/).join(sep)
}

/**
 * 工作区内**禁止写入**的目录。
 *
 * ## 为什么单独有这一条
 *
 * 工作区约束挡的是「越界」，而这两个目录就在工作区**里面**——它们完全合法地
 * 通过了 `resolveInWorkspace`。但里面放的是 `mcp.json`（配哪些 MCP server，
 * 等于配模型能拿到哪些工具）、`plugins/`（装什么插件）和 `skills/`（跑什么流程）。
 *
 * 也就是说：**模型可以通过写一个它自己有权限写的文件，给自己加工具。**
 * 这是自我提权，不是越权——两种模式都必须挡，`full` 也不例外，
 * 因为「完全访问」的意思是「不裁决这次操作」，不是「可以修改裁决规则本身」。
 *
 * ## 它挡不住什么
 *
 * `run_command` 里的路径不经过这里（`rm .qy/mcp.json` 照样能跑）。
 * 那条路只能靠 OS 沙箱，Windows 上暂时没有。如实记在 ROADMAP §26.6。
 *
 * ## 为什么 `.agents/` 也在里面
 *
 * 用户层的技能 / MCP / 插件搬到了 `.agents/`（跨客户端约定的那条路径）。
 * 搬家之后保护必须跟着搬，否则这条防线就只剩一个空目录名。
 *
 * **记忆是例外，但不需要例外条款**：它也在 `.agents/memory/` 下，而 `memory`
 * 工具走的是 `resolveInWorkspace` 不是这里——记忆本来就该由模型写，
 * 只是必须走那一条唯一的写入路径，而不是拿 `write_file` 直接改。
 */
export const PROTECTED_DIRS: readonly string[] = ['.qy', '.agents']

/**
 * 遍历工作区时跳过的噪音目录——依赖树、构建产物、缓存。
 *
 * ## 为什么必须是一份
 *
 * 这份清单原来抄了三份：`server/files.ts`（界面文件树）、`tools/search.ts`
 * （glob / grep）、`tools/files.ts`（list_dir）。到发现时已经漂成 13 / 12 / 11 条：
 * `coverage` 和 `.svelte-kit` 只有界面那份有。**后果不是不整洁，是三方对
 * 「这个目录存不存在」给出不同答案**——用户在文件树里看不到 `coverage/`，
 * 模型 `list_dir` 却把它列出来，然后 `grep` 又搜不进去。模型据此去读一份
 * 构建产物当源码，或者报告「在 coverage/lcov-report/x.html 里找到了」。
 *
 * 它和 `PROTECTED_DIRS` 不是一回事，别合并：那份是**安全边界**（挡自我提权），
 * 这份是**噪音过滤**（省 token、省眼睛）。跳过噪音目录不构成任何保护。
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
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
  'coverage',
  '.svelte-kit',
])

export class ProtectedPathError extends Error {
  constructor(readonly attempted: string) {
    super(
      `拒绝写入 ${attempted}：该目录保存的是权限与扩展配置，` +
        `改它等于给自己加工具。需要改请让用户手动改。`,
    )
    this.name = 'ProtectedPathError'
  }
}

/**
 * 这个已解析的绝对路径是不是落在受保护目录里。
 *
 * 入参必须是 `resolveInWorkspace` 的输出——在原始参数上判等于把
 * `..` 和符号链接的活又干一遍，而那是已经做过且容易做错的事。
 */
export function isProtectedPath(workspaceRoot: string, resolved: string): boolean {
  const rel = relative(workspaceRoot, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  const first = rel.split(sep)[0]
  return first !== undefined && PROTECTED_DIRS.includes(first)
}

/**
 * 写路径解析：先过根目录约束，再挡受保护目录。
 *
 * `.qy/` 的保护**只按工作区判**，与额外根目录无关——它是一条工作区内的
 * 路径判定。额外根目录再多也不会让 `<工作区>/.qy/` 变得可写。
 */
export async function resolveWritablePath(
  roots: RootsInput,
  candidate: string,
  opts: { mustExist?: boolean } = {},
): Promise<string> {
  const { workspaceRoot } = normalizeRoots(roots)
  const resolved = await resolveInWorkspace(roots, candidate, opts)
  if (isProtectedPath(workspaceRoot, resolved)) throw new ProtectedPathError(candidate)
  return resolved
}

/**
 * 展示给用户/模型的路径。
 *
 * 工作区内用相对形式（短、稳定、不泄露绝对路径）。**工作区外则原样给绝对路径**——
 * 额外根目录下的文件算出来是 `../../别处/x.ts` 那种形状，既读不懂，
 * 拿去回填给工具还会因为基准不同而指向别的地方。
 */
export function displayPath(workspaceRoot: string, absolute: string): string {
  const rel = relative(workspaceRoot, absolute)
  if (rel === '') return '.'
  if (rel.startsWith('..') || isAbsolute(rel)) return absolute
  return rel.split(sep).join('/')
}
