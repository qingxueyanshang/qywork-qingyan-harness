/**
 * 工作区路径约束。这是安全边界，不是便利函数。
 *
 * 模型给出的 path 是不可信输入。每次文件操作前都必须把它解析为规范形式，并确认
 * 仍在工作区内；越界即拒绝。需要拦截的有：`..` 回溯、绝对路径、符号链接逃逸、
 * URL 编码的 `%2e%2e%2f`，以及 Windows 上的盘符切换与 UNC 路径。
 *
 * 不得把原始 path 直接交给 open/readFile/unlink：这是此类工具最常见的漏洞。
 */

import { readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 路径位于允许范围内，但该位置不存在文件。
 *
 * **必须与「越界」区分。** `realpath` 对 ENOENT 与真正的越界抛出同一个错误，
 * 若 `mustExist` 一律把它捕获为越界，模型读取不存在的文件时收到的是「路径越界，已拒绝……
 * 切换到完全访问或加入 additionalDirectories」，其中没有一项可执行：
 * 该路径是工作区内的相对路径，模型无法据此判断文件不存在还是名称有误。
 *
 * 实测后果（会话 `cv_0mt0x92q10000mx0dff`）：模型读取不存在的
 * `client/src/battle/battle-snapshot.js`，收到权限提示后改用其他方式，
 * 却在回复中把该文件列为「已用 read_file 校验最新版」，与界面上「读取 2 个文件、1 个失败」不一致。
 */
export class PathNotFoundError extends Error {
  readonly errorKind = 'path_not_found'

  constructor(readonly attempted: string) {
    super(`路径不存在：${attempted}
用 list_dir 或 glob 确认其实际位置后重试。`)
    this.name = 'PathNotFoundError'
  }
}

/**
 * 路径越界，已拒绝。
 *
 * **错误信息必须说明下一步操作。** 只返回「路径越界」时，模型会把策略判定当作偶发故障，
 * 转而用 `run_command` 绕过（shell 只限定 cwd，命令中的 `cd` 可以离开工作区），且不告知用户。
 * 账本中有一次实际记录。
 *
 * 信息说明本次路径参数被拒的原因与两种处理方式，不替命令裁决层承诺结果：
 * 命令规则允许普通的工作区外读取，因此不能声称 run_command 必然拒绝同一路径。
 *
 * **两种处理方式都必须列出**，因为该拒绝只发生在「自动审批」模式下：切换到「完全访问」
 * 确实能解除限制（该模式下不设路径边界），加入 `additionalDirectories`
 * 则在不放开全部权限的前提下只放行该目录。只列一种，用户就只能采用这一种。
 *
 * `errorKind` 使注册表把它作为**判定**而不是异常返回（见 `agent/registry.ts`
 * 的 catch）：`executed: false`，且不加「执行出错」前缀。
 */
export class PathEscapeError extends Error {
  readonly errorKind = 'path_out_of_workspace'

  constructor(readonly attempted: string) {
    super(
      `路径越界，已拒绝：${attempted}\n` +
        '该路径不在工作区（以及配置中显式放行的额外目录）之内，' +
        '且当前为「自动审批」模式。\n' +
        '要么改用工作区内的路径继续，要么停止并告知用户，由用户二选一：' +
        '切换到「完全访问」（放开全部权限，包括路径），' +
        '或将该目录加入配置的 additionalDirectories（仅放开该目录）。' +
        '这是本次路径参数的边界；run_command 的命令内容由命令权限规则另行裁决。',
    )
    this.name = 'PathEscapeError'
  }
}

/**
 * 可访问的根目录集合。
 *
 * **使用集合而不是单个工作区。** 「内核级沙箱」与「操作电脑」是方向相反的两项需求，额外根目录
 * 使两者可以共存：边界仍是白名单，只是白名单中不止一项。没有额外根目录时，
 * 让 agent 访问工作区外的任何路径只能整体关闭边界。
 *
 * **这份清单必须同时传给三层**（路径解析、`policy.ts` 的静态规则、沙箱 bind 列表）。
 * 只接入一层时的症状都是「已配置但不生效」，而三层的错误信息各不相同，
 * 看起来像三个独立的缺陷。
 */
export interface WorkspaceRoots {
  workspaceRoot: string
  /**
   * 「完全访问」模式：**不设边界**，任何路径都放行。
   *
   * 这不是路径层的后门，而是与其他层使用同一个定义。`full` 的语义是「不裁决」：
   * 同一模式下 `run_command` 已全部放行（`session.ts` 的 `decide` 在入口处直接返回 allowed，
   * 不执行静态规则），shell 中一个 `cd` 即可离开工作区。路径层单独拦截不会更安全，
   * 只会形成**两套边界**：模型的 `read_file` 被拒后改用 `run_command` 读到同一文件，账本中有一次实际记录。
   *
   * 也不新增暴露面：`full` 下能用 shell 读到的文件，本来同样能读到。
   */
  unrestricted?: boolean
  /**
   * 额外可读写的根目录，**必须是绝对路径**。
   *
   * 相对路径的基准是进程 cwd，而 `qy` 可以从任何目录启动，
   * 同一份配置在不同位置启动时含义不同，这是配置项最难排查的失败方式。
   * 非绝对路径在配置检查阶段即会被指出，此处再过滤一次，防止绕过上游校验。
   */
  additional?: readonly string[]
  /**
   * 只读根目录（已安装技能的目录）。读取按与上面相同的真实路径判定放行；
   * `resolveWritablePath` 不使用这一组，写入无法进入这些目录。
   */
  readOnly?: readonly string[]
}

/** 调用方可以只传工作区路径字符串：多数调用点没有额外根目录。 */
export type RootsInput = string | WorkspaceRoots

/**
 * 从 `ToolContext` 取得根目录清单。
 *
 * 参数写成结构类型而不是 `import type { ToolContext }`：本模块只做路径判定，
 * 不应为读取几个字段引入整个 agent 包。
 *
 * 每个工具各自构造 `{ workspaceRoot: ctx.workspaceRoot, additional: ... }` 时，
 * 遗漏 `additional` 的工具会退回只认工作区，形成配置只部分生效的问题。
 * 统一经由本函数即可避免遗漏。
 */
export function rootsOf(ctx: {
  workspaceRoot: string
  additionalDirectories?: readonly string[]
  readOnlyRoots?: readonly string[]
  unrestrictedPaths?: boolean
}): WorkspaceRoots {
  return {
    workspaceRoot: ctx.workspaceRoot,
    ...(ctx.additionalDirectories?.length ? { additional: ctx.additionalDirectories } : {}),
    ...(ctx.readOnlyRoots?.length ? { readOnly: ctx.readOnlyRoots } : {}),
    ...(ctx.unrestrictedPaths ? { unrestricted: true } : {}),
  }
}

/**
 * 校验并规范化配置中的额外根目录。
 *
 * 这是唯一入口，配置检查与装配使用同一份判定：两处各写一份必然出现分歧，
 * 表现为「检查通过，运行时不生效」。
 *
 * 拒绝而不是静默修正：被静默忽略的额外目录会让用户看到「已配置但仍被拒绝」，
 * 而错误出在用户自己的配置项上，本可用一句提示说明。
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
        `additionalDirectories 中的 "${trimmed}" 不是绝对路径。` +
          `相对路径以启动 qy 时的当前目录为基准，在不同目录启动含义不同，` +
          `请改为绝对路径。`,
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
 * 去除只读根目录后的清单。写入目标与命令的工作目录只按此清单判定：
 * 命令工作目录位于技能目录内时，命令中以相对路径写入的内容会进入只读根目录。
 */
export function writableRoots(roots: RootsInput): WorkspaceRoots {
  const { readOnly: _readOnly, ...rest } = normalizeRoots(roots)
  return rest
}

/**
 * 把工具参数中的路径解析为允许范围内的绝对路径。
 *
 * `mustExist=false`（写入新文件）时目标可能尚不存在，但**判定与返回值都必须是
 * 解析后的路径**：只解析祖先并返回字面路径时，若 `out` 是指向边界外的软链，
 * 边界检查的是 `<工作区>`，实际写入的却是 `out` 指向的位置，软链逃逸在写路径上依然成立。
 * 悬挂软链（指向尚不存在的位置）同样按其指向判定，见 `resolveForWrite`。
 *
 * 额外根目录使用**完全相同的判定**（先 realpath 再比对），不另设宽松路径：
 * 只按字面比较时，借助软链即可访问清单外的整棵目录树。
 */
export async function resolveInWorkspace(
  roots: RootsInput,
  candidate: string,
  opts: { mustExist?: boolean; literal?: boolean; followFinalSymlink?: boolean } = {},
): Promise<string> {
  const { workspaceRoot, additional, readOnly, unrestricted } = normalizeRoots(roots)
  // 从 file URL 解出的路径已是文件系统字面值，不再解码文件名中的百分号。
  const raw = opts.literal ? candidate : decodeSafely(candidate)

  // 相对路径的基准始终是工作区，不是额外根目录；额外根目录只能用绝对路径访问。
  // 否则 `read_file("notes.md")` 会在多个根目录中逐个尝试，
  // 命中哪一个取决于目录内容，同一调用两次可能读到不同的文件。
  const joined = isAbsolute(raw) ? resolve(raw) : resolve(workspaceRoot, raw)

  /*
   * **此处不判定存在性。** `realpath` 对「不存在」与「越界」抛出同一个错误，
   * 在此处捕获为 `PathEscapeError` 会把「文件不存在」报告为「没有权限」。
   * 理由与下方工作区根的处理相同：ENOENT 指向真正的问题，
   * 改报「路径越界」会把排查方向引向别处。
   *
   * 因此两种情形都经由 `resolveForWrite`：它把不存在的目标解析到最近的已存在祖先，
   * 中间目录的软链同样被解析，逃逸可以被拦截。存在性在边界判定之后再检查。
   */
  // 独占新建操作的对象是目录项本身：末段软链也占用名称，不能解析到其目标后再创建。
  // 父目录仍解析软链并接受同一套工作区边界检查。
  const targetReal =
    opts.followFinalSymlink === false
      ? resolve(await resolveForWrite(dirname(joined)), basename(joined))
      : await resolveForWrite(joined)

  /*
   * 「完全访问」下不设边界。**照常解析，只跳过归属判定**：返回的仍是
   * 按本次操作解析后的路径，因为「判定的路径即写入的路径」与边界无关：
   * 调用方用它记录本轮是否已读取，返回字面路径会使软链根目录下的新鲜度判定始终错误。
   */
  if (unrestricted) {
    if (opts.mustExist) await assertExists(targetReal, candidate)
    return targetReal
  }

  // 工作区根无法解析属于装配错误，原样抛出：ENOENT 指向真正的问题，
  // 改报「路径越界」会把排查方向引向用户输入。
  // 额外根目录不同：用户配错一条不应使整次解析失败，跳过即可。
  const rootReals = [await realpath(workspaceRoot)]
  for (const extra of additional ?? []) {
    const real = await realpath(extra).catch(() => null)
    if (real !== null) rootReals.push(real)
  }

  for (const rootReal of rootReals) {
    if (isInside(rootReal, targetReal)) {
      /*
       * **先判定边界，再判定存在性。该顺序是安全属性，不是风格。**
       *
       * 顺序相反时，「文件不存在」这一回复本身就泄露了工作区外某个路径是否存在，
       * 而拦截边界外的访问正是这一层的职责。
       */
      if (opts.mustExist) await assertExists(targetReal, candidate)
      // 判定与返回使用同一个路径。两者不同时，判定的是 A、写入的是 B，
      // 边界检查形同虚设；调用方按返回值记录读取状态时也会与读取路径不一致
      // （`files.ts` 的本轮已读判定在软链根目录下会始终判为 stale）。
      return targetReal
    }
  }

  // 只读根目录在可写根之后判定：同一路径同时位于两类根中时按可写根返回。
  // 判定使用真实路径，因此技能目录中指向目录外的链接不放行。
  for (const extra of readOnly ?? []) {
    const real = await realpath(extra).catch(() => null)
    if (real !== null && isInside(real, targetReal)) {
      if (opts.mustExist) await assertExists(targetReal, candidate)
      return targetReal
    }
  }

  throw new PathEscapeError(candidate)
}

/**
 * 解析一个即将写入的路径。
 *
 * 三种情形都必须解析到**实际写入的位置**：
 * 1. 目标已存在（含软链）：realpath 直接解析。
 * 2. 目标是**悬挂软链**：realpath 会失败，但写入时仍会跟随它。
 *    因此 readlink 成功时按其指向判定，这是写入新文件时的主要漏洞。
 * 3. 目标确实不存在：解析已存在的最近祖先，再拼接剩余的路径段，
 *    中间目录的软链因此也已解析。
 */
async function resolveForWrite(target: string): Promise<string> {
  const real = await realpath(target).catch(() => null)
  if (real !== null) return real

  const link = await readlink(target).catch(() => null)
  if (link !== null) return resolve(dirname(target), link)

  const { real: ancestor, rest } = await nearestExisting(target)
  return rest.length ? resolve(ancestor, ...rest) : ancestor
}

/** 确认目标存在。`mustExist` 的调用方由此得到「不存在」而不是「没有权限」。 */
async function assertExists(target: string, candidate: string): Promise<void> {
  const ok = await stat(target).then(
    () => true,
    () => false,
  )
  if (!ok) throw new PathNotFoundError(candidate)
}

/** 已存在的最近祖先目录，以及从该目录到目标之间的剩余路径段。 */
async function nearestExisting(target: string): Promise<{ real: string; rest: string[] }> {
  const rest: string[] = []
  let cur = target
  for (;;) {
    const parent = resolve(cur, '..')
    if (parent === cur) return { real: cur, rest } // 已到达根目录
    rest.unshift(basename(cur))
    const real = await realpath(parent).catch(() => null)
    if (real !== null) return { real, rest }
    cur = parent
  }
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const rel = relative(root, target)
  // relative() 在越界时以 '..' 开头，跨盘符时返回绝对路径，两种情况都必须拦截。
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 反复解码百分号转义，直到结果不再变化。
 * 单次解码无法拦截 `%252e%252e%252f` 这类双重编码。
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
 * 工作区内**禁止写入**的路径。
 *
 * **判据是「写入后是否会为自身增加工具」，不是「是否位于配置目录」。** 工作区约束拦截的是越界，
 * 而这些路径位于工作区**内部**，能合法通过 `resolveInWorkspace`。拦截它们是因为写入即**自我提权**：
 *
 * - `.agents/mcp.json`：配置 MCP server，写入一行即增加一批工具；
 * - `.qy/`：`plugins/` 是已安装的插件本体（下次加载时就会执行的代码），
 *   `plugin-data/` 是插件的私有存储。
 *
 * **技能与记忆不在其中**，尽管它们同样位于 `.agents/` 下：一篇 SKILL.md 是一段提示词，
 * 一条记忆是一条事实，两者都不给模型任何新能力。按整个目录拦截的代价是：
 * 设置页的「新增技能」把请求交给模型，而模型无法写入该文件，
 * 该按钮因此点击后无响应（B5）。
 *
 * 角色（`.qy/team.json` 的 `roles`）同样不提供新能力，但它与门禁位于同一个文件中，
 * 因此经由 `define_role` 只修改 `roles` 的写入路径，而不是放开整个 `.qy/`。
 *
 * **`full` 下不拦截**（判据在 `resolveWritablePath` 的 `unrestricted`）：该模式下
 * `run_command` 全部放行，`echo > .agents/mcp.json` 一行即可写入，只拦截文件工具会形成
 * 「文件工具拦截、shell 不拦截」的两套账。
 *
 * **它无法拦截的情形。** `run_command` 中的路径不经过这里（`rm .qy/mcp.json` 仍能执行）。
 * 这条路径只能依靠 OS 沙箱，Windows 上目前没有。
 *
 * **`.agents/` 下的 MCP 配置必须在其中。** 项目层的 MCP 配置位于 `.agents/`（跨客户端约定的路径），
 * 保护必须覆盖该位置，否则这项防护只剩一个空目录名。
 *
 * **插件不在其中**：插件只从 `~/.qywork/plugins/` 加载，工作区中没有插件目录，
 * 拦截 `.agents/plugins` 等于保护一条没有加载方的路径。
 *
 * **记忆无需例外条款**：它位于 `.agents/memory/` 下，而
 * `write_memory` 经由 `resolveInWorkspace` 而不是本清单。记忆应由模型写入，
 * 但必须经由这条唯一的写入路径，而不是用 `write_file` 直接修改。
 */
export const PROTECTED_DIRS: readonly string[] = ['.qy', '.agents/mcp.json']

/**
 * **模型**遍历工作区时跳过的噪音目录：依赖树、构建产物、缓存。
 *
 * **必须只有一份。** 模型侧三处使用它：`tools/search.ts`（glob / grep）、`tools/files.ts`（list_dir）
 * 与 `tools/workspace-watch.ts`（命令修改了哪些文件）。各自复制一份必然产生分歧，
 * 使各处对「该目录是否存在」给出不同答案：`list_dir` 列出 `coverage/` 而 `grep` 不搜索它，
 * 模型据此把构建产物当作源码读取，或报告「在 coverage/lcov-report/x.html 中找到」。
 *
 * **界面文件树不使用它**（`server/files.ts`）：那是用户自己的文件浏览器，磁盘上
 * 有什么就列出什么。两者不一致时只允许界面比模型看到的多，否则用户
 * 无法核对模型的说法。
 *
 * 它与 `PROTECTED_DIRS` 用途不同，不要合并：后者是**安全边界**（拦截自我提权），
 * 本清单是**噪音过滤**（节省 token）。跳过噪音目录不构成任何保护。
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
        `修改它等同于为自身添加工具。如需修改，请由用户手动修改。`,
    )
    this.name = 'ProtectedPathError'
  }
}

/**
 * 判断已解析的绝对路径是否位于受保护目录内。
 *
 * 入参必须是 `resolveInWorkspace` 的输出：在原始参数上判定等于重新处理一遍
 * `..` 与符号链接，而这正是已经完成且容易出错的步骤。
 */
export function isProtectedPath(workspaceRoot: string, resolved: string): boolean {
  const rel = relative(workspaceRoot, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  // 逐段比较，不用字符串前缀：`.qyX` 不在 `.qy` 目录下，
  // 而 `startsWith` 会把它一并拦截。
  const parts = rel.split(sep)
  return PROTECTED_DIRS.some((p) => {
    const want = p.split('/')
    return want.every((seg, i) => parts[i] === seg)
  })
}

/**
 * 写入路径解析：先经过根目录约束，再拦截受保护目录。
 *
 * `.qy/` 的保护**只按工作区判定**，与额外根目录无关：它是工作区内的
 * 路径判定。额外根目录再多也不会使 `<工作区>/.qy/` 变为可写。
 *
 * 「完全访问」下不设这一层：它拦截的是「为自身添加工具」，而同一模式下模型
 * 的 `run_command` 全部放行，`echo > .agents/x` 一行即可写入。
 * 保留它只会形成又一处「文件工具拦截、shell 不拦截」的两套账。
 */
export async function resolveWritablePath(
  roots: RootsInput,
  candidate: string,
  opts: { mustExist?: boolean; followFinalSymlink?: boolean } = {},
): Promise<string> {
  const writable = writableRoots(roots)
  const { workspaceRoot, unrestricted } = writable
  const resolved = await resolveInWorkspace(writable, candidate, opts)
  if (!unrestricted && isProtectedPath(workspaceRoot, resolved)) {
    throw new ProtectedPathError(candidate)
  }
  return resolved
}

/**
 * 展示给用户与模型的路径。
 *
 * 工作区内使用相对形式（简短、稳定、不泄露绝对路径）。**工作区外原样返回绝对路径**：
 * 额外根目录下的文件按相对形式计算会得到 `../../别处/x.ts`，既难以阅读，
 * 回传给工具时还会因基准不同而指向其他位置。
 */
export function displayPath(workspaceRoot: string, absolute: string): string {
  const rel = relative(workspaceRoot, absolute)
  if (rel === '') return '.'
  if (rel.startsWith('..') || isAbsolute(rel)) return absolute
  return rel.split(sep).join('/')
}
