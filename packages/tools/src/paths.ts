/**
 * 工作区路径约束 —— 安全边界，不是便利函数。
 *
 * 模型给出的 path 是不可信输入。每一次文件操作前都必须把它解析成规范形式并确认
 * 仍在工作区内；越界就拒绝。这里要挡住的是：`..` 回溯、绝对路径、符号链接逃逸、
 * URL 编码的 `%2e%2e%2f`、以及 Windows 上的盘符切换与 UNC 路径。
 *
 * 绝不允许把原始 path 直接交给 open/readFile/unlink——那是这类工具最常见的破口。
 */

import { readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 越界被拒。
 *
 * ## 这条回话必须说清「接下来怎么办」
 *
 * 账本里留下过一次实证：模型读桌面上的某个项目被拒，只拿到一句
 * 「工具 read_file 执行出错: 路径越界」，于是它把这当成偶发故障，转头用
 * `run_command` 绕过去（shell 只锁 cwd，命令正文里 `cd` 得出去），也没告诉用户
 * 发生了什么。**一条被当成崩溃的策略判定，模型只会去找绕路。**
 *
 * 所以这里三件事一起说：为什么、哪两条路真的能走通、以及别去绕。
 *
 * **两条出路都要给全**，因为这条拒绝只发生在「自动审批」下：切「完全访问」
 * 是真的能解开（那个模式下路径边界整个不设），加 `additionalDirectories`
 * 则是在不放开全部权限的前提下只开这一个目录。少说一条就是把用户往另一条上逼。
 *
 * `errorKind` 让注册表把它当**判定**而不是异常端出去（见 `agent/registry.ts`
 * 的 catch）：`executed: false`，且不套「执行出错」的壳。
 */
/**
 * 路径在允许范围内，但那个位置上没有东西。
 *
 * **必须与「越界」分开。** 从前两者共用 `PathEscapeError`：`realpath` 对
 * ENOENT 和真正的越界抛的是同一个错，`mustExist` 那条把它一律 catch 成越界。
 * 于是模型读一个不存在的文件，收到的是「路径越界，已拒绝……要么让用户切到
 * 完全访问，要么把这个目录加进 additionalDirectories」——**一句都不可执行**：
 * 那个路径明明是工作区内的相对路径，模型没法据此判断「文件不存在、我记错了名字」。
 *
 * 实测代价（会话 `cv_0mt0x92q10000mx0dff`）：模型读一个不存在的
 * `client/src/battle/battle-snapshot.js`，拿到这句权限话术之后绕开了这个工具，
 * 却在回话里把那个文件写进了「已用 read_file 校验最新版」的清单——
 * 用户看见的是「读取 2 个文件、1 个失败」，模型说的是「5 个核心文件都已确认」。
 */
export class PathNotFoundError extends Error {
  readonly errorKind = 'path_not_found'

  constructor(readonly attempted: string) {
    super(`路径不存在：${attempted}
用 list_dir 或 glob 确认它的真实位置再试。`)
    this.name = 'PathNotFoundError'
  }
}

export class PathEscapeError extends Error {
  readonly errorKind = 'path_out_of_workspace'

  constructor(readonly attempted: string) {
    super(
      `路径越界，已拒绝：${attempted}\n` +
        '这个路径不在工作区（以及配置里显式放行的额外目录）之内，' +
        '而当前是「自动审批」模式。\n' +
        '要么改用工作区内的路径继续，要么停下来告诉用户，让他二选一：' +
        '切到「完全访问」（放开全部权限，包括路径），' +
        '或者把这个目录加进配置的 additionalDirectories（只开这一个）。' +
        '不要改用 run_command 去绕——同一个模式下它也会被同一份根目录清单拦。',
    )
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
   * 「完全访问」模式：**边界整个不设**，任何路径都放行。
   *
   * 这不是给路径层开的后门，是让它和别的层用同一个定义。`full` 的语义就是
   * 「不裁决」——同一个模式下 `run_command` 早就是全放行的（`session.ts` 的
   * `decide` 一进来就返回 allowed，静态规则那层根本不跑），而 shell 里一个 `cd`
   * 就出得去。路径层单独硬拦的结果不是「更安全」，是**两套边界**：
   * 模型 `read_file` 被拒、转头 `run_command` 读到了，账本里真发生过一次。
   *
   * 也不新增暴露面：`full` 下能用 shell 读到的东西，本来就一样能读到。
   */
  unrestricted?: boolean
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
  unrestrictedPaths?: boolean
}): WorkspaceRoots {
  return {
    workspaceRoot: ctx.workspaceRoot,
    ...(ctx.additionalDirectories?.length ? { additional: ctx.additionalDirectories } : {}),
    ...(ctx.unrestrictedPaths ? { unrestricted: true } : {}),
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
  const { workspaceRoot, additional, unrestricted } = normalizeRoots(roots)
  const raw = decodeSafely(candidate)

  // 相对路径的基准永远是工作区，不是额外根目录——额外根目录只能用绝对路径够到。
  // 否则 `read_file("notes.md")` 会变成「在若干个根里挨个碰运气」，
  // 而命中哪一个取决于目录内容，同一句话两次可能读到不同的文件。
  const joined = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)

  /*
   * **存在性不在这里判。** `realpath` 对「不存在」和「越界」抛的是同一个错，
   * 在这里 catch 成 `PathEscapeError` 就是把「文件不存在」报成「你没权限」。
   * 这条与下面几行给工作区根写的理由是同一条：那条 ENOENT 指向真正的问题，
   * 换成「路径越界」只会把排查方向引到别处。
   *
   * 两条路因此都走 `resolveForWrite`——它对不存在的目标解析到最近的已存在祖先，
   * 中间目录的软链照样解开，逃逸挡得住。存在性等边界判完再回答。
   */
  const targetReal = await resolveForWrite(joined)

  /*
   * 「完全访问」下不设边界。**解析照做、只跳过归属判定**——返回的仍然是
   * realpath 之后的那一个路径，因为「判的和写的是同一个路径」这条与边界无关：
   * 调用方拿它去记「本轮读过没有」，返回字面路径会让软链根下的新鲜度判定恒错。
   */
  if (unrestricted) {
    if (opts.mustExist) await assertExists(targetReal, candidate)
    return targetReal
  }

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
      /*
       * **先判边界，再判存在。顺序是安全属性，不是风格。**
       *
       * 反过来的话，「这个文件不存在」这句话本身就泄露了工作区外某个路径存不存在
       * ——而挡住界外正是这一层的全部工作。
       */
      if (opts.mustExist) await assertExists(targetReal, candidate)
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

/** 目标真的在那儿吗。`mustExist` 的调用方靠它拿到「不存在」而不是「没权限」。 */
async function assertExists(target: string, candidate: string): Promise<void> {
  const ok = await stat(target).then(
    () => true,
    () => false,
  )
  if (!ok) throw new PathNotFoundError(candidate)
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
 * 项目层的技能 / MCP 搬到了 `.agents/`（跨客户端约定的那条路径）。
 * 搬家之后保护必须跟着搬，否则这条防线就只剩一个空目录名。
 *
 * **记忆是例外，但不需要例外条款**：它也在 `.agents/memory/` 下，而
 * `write_memory` 走的是 `resolveInWorkspace` 不是这里——记忆本来就该由模型写，
 * 只是必须走那一条唯一的写入路径，而不是拿 `write_file` 直接改。
 */
export const PROTECTED_DIRS: readonly string[] = ['.qy', '.agents']

/**
 * **模型**遍历工作区时跳过的噪音目录——依赖树、构建产物、缓存。
 *
 * ## 为什么必须是一份
 *
 * 两处消费它：`tools/search.ts`（glob / grep）与 `tools/files.ts`（list_dir）。
 * 各抄一份的话会漂——实测漂到过 13 / 12 / 11 条。**后果不是不整洁，是两处对
 * 「这个目录存不存在」给出不同答案**：`list_dir` 把 `coverage/` 列出来、`grep`
 * 又搜不进去，模型据此去读一份构建产物当源码，或者报告「在
 * coverage/lcov-report/x.html 里找到了」。
 *
 * **界面文件树不用它**（`server/files.ts`）：那是用户自己的文件浏览器，磁盘上
 * 有什么就列什么。不一致的方向只允许是「界面比模型看得多」——反过来用户就
 * 没法核对模型说的话。
 *
 * 它和 `PROTECTED_DIRS` 不是一回事，别合并：那份是**安全边界**（挡自我提权），
 * 这份是**噪音过滤**（省 token）。跳过噪音目录不构成任何保护。
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
 *
 * 「完全访问」下这一层也不设：它挡的是「给自己加工具」，而同一个模式下模型
 * 手里的 `run_command` 是全放行的，`echo > .agents/x` 一行就写进去了。
 * 留着只会变成又一处「文件工具拦、shell 不拦」的两套账。
 */
export async function resolveWritablePath(
  roots: RootsInput,
  candidate: string,
  opts: { mustExist?: boolean } = {},
): Promise<string> {
  const { workspaceRoot, unrestricted } = normalizeRoots(roots)
  const resolved = await resolveInWorkspace(roots, candidate, opts)
  if (!unrestricted && isProtectedPath(workspaceRoot, resolved)) {
    throw new ProtectedPathError(candidate)
  }
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
