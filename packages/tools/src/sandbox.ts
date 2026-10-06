/**
 * 启动子进程的唯一入口，以及包裹它的操作系统沙箱。
 *
 * 用途：`run_command` 是权限模型中唯一能同时绕过路径约束与 SSRF 防护的路径，
 * 命令字符串中的路径不经过本仓库的任何代码。在其上叠加的静态规则与分类器都是文本判断：
 * 静态规则只覆盖已列举的写法，分类器的结果是概率。两者都无法拦截未列举的写法，
 * 而可能的写法无法穷举。
 *
 * 内核层的边界与命令文本无关，只取决于系统调用访问的 inode。
 * 因此本文件的目标不是再增加一层规则，而是把边界从文本层移到内核层。
 *
 * 前提是包装点唯一，因此收敛为一个函数。`Bun.spawn` 分散在两处时，
 * 添加沙箱必须同时修改两处，遗漏的一处不会报错，只是没有边界。
 *
 * 各平台的沙箱状态分别上报，不合并为单一的「有沙箱」。
 *
 * | 平台 | 后端 | 边界 |
 * |---|---|---|
 * | Linux / WSL2 | bubblewrap | 内核级：写边界 + 凭证目录屏蔽 |
 * | macOS | seatbelt（`sandbox-exec`） | 同上，以 SBPL 规则而非挂载实现 |
 * | 原生 Windows | 暂无（不实现） | 只有静态规则与分类器 |
 * | WSL1 | 暂无 | 没有独立内核，namespace 不可用 |
 *
 * 合并为一个布尔值时，界面显示「沙箱：开」，
 * 而实际生效的可能只是其中一个维度，因此按维度分别上报。
 *
 * 已安装不等于可用，因此必须实际执行一次。`detectSandbox()` 不以 `which` 的结果为准，
 * 而是实际执行一次空命令。Ubuntu 24.04+ 默认禁用无特权用户命名空间，此时 bwrap 位于 PATH 中，
 * 但任何命令都无法运行；只查 `which` 会报告有边界，这是最严重的误报：
 * 用户会据此认为 shell 已受约束。
 *
 * macOS 后端同样依靠自检保证：本仓库没有 Mac 测试环境，profile 生成只有纯函数测试；
 * 确认其可用的是用户机器上的自检，失败时降级上报 `none`。
 *
 * 自行生成 argv，不引入现成的沙箱运行时，原因有二：现成方案的 vendor 二进制是
 * 磁盘上的文件，而发布产物是单文件二进制，无法携带（约束与 `netguard.ts` 相同）；
 * 本机无法安装其依赖，因而无法验证，未经验证的能力不能作为边界发布。
 *
 * 如需更换实现，在本文件的 `spawnGuarded` 中接入，不要新增第二个 spawn 入口。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join as joinNative } from 'node:path'
/*
 * bwrap 只在 Linux 上运行，因此其路径始终是 POSIX 形式。
 *
 * 使用平台相关的 `node:path` 时，Windows 开发机上会把 `/ws` 拼接为 `C:\ws`、
 * 把分隔符写为反斜杠，生成的 argv 在 Linux 上无效；
 * 且 Windows 上不启用沙箱，该错误在运行时不会暴露，
 * 只有在 Windows 上调试这些函数时才会发现。因此固定使用 posix 版本。
 */
import { isAbsolute, join, normalize } from 'node:path/posix'
import type { CommandRunner, ProcessLike } from './runner.ts'

/*
 * bwrap 与 seatbelt 都只在类 Unix 系统上运行，路径一律为 POSIX 形式，因此上方的
 * import 用于本文件中沙箱参数的路径拼接。例外是访问本机文件系统的位置
 * （`whichSync`、`findGitBash`、PowerShell 安装位置、临时脚本路径），它们必须使用平台原生的 `joinNative`。
 */

export type SandboxBackend = 'bwrap' | 'seatbelt' | 'none'

export interface SandboxStatus {
  backend: SandboxBackend
  /** 本次执行是否有内核边界。只有此字段为 true 时，才能向用户声明 shell 受约束。 */
  active: boolean
  /** 该结论的原因。必须能直接展示给用户，不要只写「不支持」这类不含下一步操作的文字。 */
  reason: string
  platform: NodeJS.Platform
  /** WSL 版本号字符串，非 WSL 为 null。WSL1 没有独立内核，等同原生 Windows。 */
  wsl: string | null
}

export interface SandboxPolicy {
  /** 工作区根，可写。 */
  workspaceRoot: string
  /** 额外可写根目录（`additionalDirectories`），绝对路径。 */
  writableRoots?: readonly string[]
  /**
   * 工作区内只读的路径（相对工作区）：`.qy`、`.agents/mcp.json`。
   * 判据是写入后能否为自身添加工具，见 `PROTECTED_DIRS`。
   * 条目可以是文件或目录（`--ro-bind-try` 两者都支持）。
   *
   * 与文件工具的 `PROTECTED_DIRS` 是同一约束的两种实现：
   * 前者拦截工具参数，本字段拦截 shell。两侧都必须存在：
   * 在没有沙箱的平台上，shell 一侧只剩静态规则的文本匹配。
   */
  readOnlySubdirs?: readonly string[]
  /**
   * 完全屏蔽（以空目录覆盖）的绝对路径，通常是凭证目录。
   *
   * 未提供时使用 `defaultMaskPaths()`。
   */
  maskPaths?: readonly string[]
  /**
   * 禁止 shell 命令访问网络。默认 `false`。
   *
   * 默认不禁止：禁止网络后 agent 无法安装依赖、拉取代码，多数测试也无法运行。默认开启时，
   * 用户首先遇到的是 `npm install` 失败，且报错与网络无关
   * （包管理器只报告拉取失败）。查明原因之前，用户通常会先关闭整个沙箱，
   * 文件边界随之失效。
   *
   * 仍提供此开关的原因：网络访问是该模型中唯一完全没有边界的路径。`web_fetch` 经过 SSRF
   * 防护，而 shell 中的 `curl` 不经过任何检查。对于运行来源不明的代码这类场景，完全断网
   * 明显更安全，且它是二值开关，不需要域名白名单所需的 MITM 代理与自签 CA。
   *
   * 有意不实现按域名过滤：它需要在沙箱内启动代理、在沙箱外转发，
   * 并使 TLS 校验接受自签 CA。这套组件在不同机器上有多种失败方式，
   * 失败时网络间歇性不可用，比不提供该功能更糟。
   */
  denyNetwork?: boolean
}

// ───────────────────────── 平台判定 ─────────────────────────

/**
 * WSL 版本。非 Linux 或非 WSL 返回 null。
 *
 * WSL1 必须单独识别：它把 Linux 系统调用转换到 NT 内核上，没有真正的
 * namespace，bwrap 在其中无法启动或无法提供边界。将其报告为「有沙箱」是最严重的误报。
 */
function detectWsl(): string | null {
  if (process.platform !== 'linux') return null
  try {
    const v = readFileSync('/proc/version', 'utf8')
    const m = v.match(/WSL(\d+)/i)
    if (m?.[1]) return m[1]
    // WSL1 的旧格式中没有版本号，只有 "Microsoft"。
    if (v.toLowerCase().includes('microsoft')) return '1'
    return null
  } catch {
    return null
  }
}

/** 在 PATH 里查找一个可执行文件。未找到时返回 null。 */
function whichSync(name: string): string | null {
  const paths = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of paths) {
    if (!dir) continue
    const full = joinNative(dir, name)
    if (existsSync(full)) return full
  }
  return null
}

let cached: SandboxStatus | null = null

/**
 * 本机是否有可用的内核级边界。结果会缓存：它在进程生命周期内不变，
 * 而 `run_command` 每次调用都要查询。
 */
export function detectSandbox(): SandboxStatus {
  if (cached) return cached
  cached = probe()
  return cached
}

/**
 * 自检使用的最小策略：一个必然存在的可写根，没有屏蔽项。
 *
 * 有意不使用真实策略：自检只判定本机是否允许创建命名空间，
 * 与开放哪些目录无关；引入真实路径会使探测在某个目录恰好不存在时
 * 误报失败。
 */
const PROBE_POLICY: SandboxPolicy = { workspaceRoot: '/tmp', maskPaths: [] }

/**
 * 实际执行一次，确认该后端在本机可用。
 *
 * 不能只查 `which`：二进制位于 PATH 中与能够创建命名空间是两个条件，二者不一致的
 * 情况很常见：
 *
 * - Ubuntu 24.04+ 默认开启 `kernel.apparmor_restrict_unprivileged_userns`，
 *   `unshare(CLONE_NEWUSER)` 成功但新命名空间中没有 capability，
 *   bwrap 无法启动。
 * - 无特权容器中 `--proc` 不可用。
 * - macOS 的 `sandbox-exec` 会因 profile 语法或 SIP 策略拒绝执行。
 *
 * 只查 `which` 时会报告有边界，而实际任何命令都无法运行；
 * 这一方向的误报最严重：用户会据此认为 shell 已受约束。
 *
 * 返回 `null` 表示可用；返回字符串表示不可用及其原因。
 *
 * 代价是一次进程启动，整个进程生命周期只执行一次（`detectSandbox` 缓存结果）。
 */
function selfCheck(argv: readonly string[]): string | null {
  try {
    const r = Bun.spawnSync(argv as string[], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    if (r.exitCode === 0) return null
    const err = new TextDecoder().decode(r.stderr).trim()
    return err.split('\n')[0] ?? `退出码 ${r.exitCode}`
  } catch (e) {
    // 二进制不存在、权限不足、被安全软件拦截，均进入此分支。
    return e instanceof Error ? e.message : String(e)
  }
}

function probe(): SandboxStatus {
  const platform = process.platform
  const wsl = detectWsl()

  if (platform === 'linux') {
    if (wsl === '1') {
      return {
        backend: 'none',
        active: false,
        reason: 'WSL1 无独立内核，bubblewrap 不可用，shell 命令不受内核级路径约束。',
        platform,
        wsl,
      }
    }
    const bwrap = whichSync('bwrap')
    if (bwrap === null) {
      return {
        backend: 'none',
        active: false,
        reason: '未安装 bubblewrap，shell 命令不受内核级路径约束。',
        platform,
        wsl,
      }
    }
    // 已安装不等于可用，见 selfCheck 的注释。
    // 自检使用最小策略：只验证能否创建命名空间。
    // 使用真实策略时，`workspaceRoot: '/'` 会生成 `--bind / /`（整机可写），
    // 安全模块中使整机可写的探测参数容易被误读为真实配置。
    const check = selfCheck(buildBwrapArgv(PROBE_POLICY, ['/bin/true']))
    if (check !== null) {
      return {
        backend: 'none',
        active: false,
        reason: `bubblewrap 已安装但不可用，shell 命令不受内核级路径约束：${check}`,
        platform,
        wsl,
      }
    }
    return {
      backend: 'bwrap',
      active: true,
      reason: `bubblewrap 已验证可用：工作区之外只读，凭证目录不可见，网络不受限。`,
      platform,
      wsl,
    }
  }

  if (platform === 'darwin') {
    const check = selfCheck(buildSeatbeltArgv(PROBE_POLICY, ['/usr/bin/true']))
    if (check !== null) {
      return {
        backend: 'none',
        active: false,
        reason: `seatbelt 不可用，shell 命令不受内核级路径约束：${check}`,
        platform,
        wsl,
      }
    }
    return {
      backend: 'seatbelt',
      active: true,
      reason: 'seatbelt 已验证可用：工作区之外只读，凭证目录不可读，网络不受限。',
      platform,
      wsl,
    }
  }

  if (platform === 'win32') {
    return {
      backend: 'none',
      active: false,
      /*
       * 措辞必须按实际的残余风险编写，不能只写「没有沙箱」。
       *
       * 不要写成「只受静态规则与分类器约束，两者都是文本判断」：静态规则已包含字面路径检查，
       * 可确定拦截的写法已经较多，该说法夸大了缺口。
       * 夸大与低估同样不准确，且夸大会使用户习惯性忽略该提示，出现问题时不再关注。
       *
       * 该文字原样显示在设置页中，因此不写内部文档的编号：用户无法打开
       * 这些文档，编号对用户没有信息量。
       *
       * 只写边界，不写机制。用户据以决策的只有一点：工作区外且家目录外的
       * 路径无法拦截。静态规则与分类器的判定方式、WSL2 的替代方案均不写入。
       */
      reason: '原生 Windows 无内核沙箱后端，工作区与家目录之外的路径不受约束。',
      platform,
      wsl,
    }
  }

  return {
    backend: 'none',
    active: false,
    reason: `${platform} 上没有对应的内核沙箱实现，shell 命令只受静态规则与分类器约束。`,
    platform,
    wsl,
  }
}

// ───────────────────────── 策略 → bwrap 参数 ─────────────────────────

/**
 * 默认屏蔽的凭证目录。
 *
 * 只屏蔽选定的目录，不使整个家目录不可见。屏蔽整个家目录时，`~/.gitconfig`、`~/.npmrc`、
 * nvm/rustup/pyenv 全部不可见，`git commit` 没有作者、`npm install` 使用其他 registry、`node` 可能
 * 无法定位。用户开启一次这样的沙箱就会关闭，关闭后不剩任何防护。
 *
 * 要防范的是向本机之外的泄露，与 `secrets.ts` 的口径一致。按此口径，
 * 家目录中有风险的是凭证文件而非配置文件。因此家目录整体只读（写边界照常生效），
 * 另外以空目录覆盖凭证目录。
 *
 * 该清单是列举，因此与静态规则一样，未列入的目录不受保护。
 * 区别在于代价：此处遗漏一项是少屏蔽一个目录，静态规则遗漏一项是放行一条命令。
 */
export function defaultMaskPaths(home = homedir()): string[] {
  // 非 POSIX 绝对路径（Windows 的 `C:\\Users\\x`）拼接后为
  // `C:\\Users\\x/.ssh` 这类混用两种分隔符的字符串。两个后端都只在类 Unix 系统上运行，
  // 因此此处应返回空列表，而不是返回形似路径的字符串。
  if (!home.startsWith('/')) return []
  return [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.docker'),
    join(home, '.kube'),
    join(home, '.config', 'gh'),
    join(home, '.config', 'gcloud'),
    // qywork 的配置目录：其中保存 provider 的明文 API Key。
    join(home, '.qywork'),
  ]
}

/**
 * 将策略转换为 bwrap 参数。文件系统访问经 `opts.exists` 注入，因此可在任何平台上运行，
 * 可纳入 `bun test`。
 *
 * 边界构成：
 *
 * - `--ro-bind / /`：整机可读、不可写。这是写边界，不是读边界。
 *   读边界需要只 bind 少数目录，此时 `/usr`、`/lib`、`/etc` 均不可见，
 *   几乎无法运行任何程序。`docs/permissions.md` 中已写明：
 *   工作区外的文件仍可读取，凭证目录单独屏蔽。
 * - 可写根目录逐个 `--bind`。
 * - `.qy/` 在可写根之后再以 `--ro-bind` 恢复为只读：顺序不能颠倒，bwrap 中后出现的挂载生效。
 * - 凭证目录以 `--tmpfs` 覆盖为空目录。
 * - `--unshare-pid` + `--proc /proc`：无法查看宿主进程表（`/proc/<pid>/environ`
 *   中有其他进程的环境变量，而传给子进程的环境变量已剥离凭证）。
 * - 默认不使用 `--unshare-net`：网络照常可用。断网后 agent 无法安装依赖、拉取代码，
 *   而按域名过滤需要完整的代理组件。这是有意保留的缺口，见 `SandboxPolicy.denyNetwork` 与文档。
 * - 不使用 `--die-with-parent`：它为命名空间的 init 设置 `PR_SET_PDEATHSIG`，bwrap 外层进程
 *   在 shell 退出时随之退出，init 收到 SIGKILL，内核结束命名空间中的全部进程，命令留下的
 *   后台进程因此全部终止；runner 退出时同理。超时、中断与探测结束时由 `killTree` 按进程组发送信号，
 *   命名空间中的进程与外层进程同组，不依赖该选项。
 * - 命名空间的 init 持有 stdout / stderr，直到其中最后一个进程退出。因此后台进程即使重定向了输出，
 *   `collectProcess` 仍报告 `backgroundHeld`。
 */
export function buildBwrapArgv(
  policy: SandboxPolicy,
  inner: readonly string[],
  opts: { exists?: (p: string) => boolean } = {},
): string[] {
  // 注入 exists 使该函数可在任何平台上测试。默认访问实际磁盘。
  const exists = opts.exists ?? existsSync
  const args: string[] = [
    'bwrap',
    // 整机只读。后续的 --bind 在此基础上开放可写目录。
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
  ]

  /*
   * /tmp 必须可写：编译器、包管理器、git 都向其中写入。
   * 使用 tmpfs 而不是 bind：宿主 /tmp 中可能有其他进程写入的临时凭证文件。
   *
   * 它必须排在可写 bind 之前。bwrap 按出现顺序叠加，顺序颠倒时，
   * 位于 /tmp 下的工作区会被随后的 tmpfs 完全覆盖，且不报错：
   * 命令照常执行，但工作区在沙箱内为空。
   *
   * `bun test` 中的纯函数断言无法发现该错误：每个参数都正确，
   * 错误在于两个参数之间的顺序。
   */
  args.push('--tmpfs', '/tmp')

  const writable = dedupe([policy.workspaceRoot, ...(policy.writableRoots ?? [])])
  for (const dir of writable) {
    args.push('--bind', dir, dir)
  }

  // 只读子目录必须排在可写根之后：bwrap 按出现顺序叠加，后出现的覆盖先出现的。
  // 顺序颠倒时 .qy/ 会被随后的 --bind 恢复为可写，且不报错。
  for (const root of writable) {
    for (const sub of policy.readOnlySubdirs ?? []) {
      args.push('--ro-bind-try', join(root, sub), join(root, sub))
    }
  }

  // 以空目录覆盖凭证目录。必须先确认目录存在：`--tmpfs` 没有 `-try` 变体，
  // 它会创建挂载点，父目录只读时直接失败：
  //
  //     bwrap: Can't mkdir /root/.nope: Read-only file system
  //
  // 在没有 `~/.aws` 的机器上无条件屏蔽该目录，会使每一条命令
  // 都无法启动。屏蔽清单按常见凭证目录列出，任何一台机器通常只有其中几个。
  for (const p of policy.maskPaths ?? defaultMaskPaths()) {
    if (exists(p)) args.push('--tmpfs', p)
  }

  args.push('--unshare-pid', '--unshare-uts', '--unshare-ipc', '--proc', '/proc')
  // `--unshare-net` 创建空的网络命名空间，其中只有 lo。
  // 不配置代理桥接即完全断网，这正是该开关的语义。
  if (policy.denyNetwork) args.push('--unshare-net')
  args.push('--', ...inner)
  return args
}

/** 去掉尾部斜杠，根目录 `/` 除外。 */
function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

// ───────────────────────── 策略 → seatbelt profile ─────────────────────────

/**
 * 将策略转换为 macOS 的 SBPL（sandbox profile language）。文件系统访问经 `opts.exists` 注入，任何平台均可测试。
 *
 * 边界有意与 bwrap 保持一致，二者对应同一份文档中的同一张表：
 * 整机可读、只有可写根目录可写、凭证目录不可读、网络不受限。
 * 两者实现方式不同（挂载与规则），但对用户的承诺必须相同，
 * 否则 `docs/permissions.md` 需要按平台分别说明，难以维护。
 *
 * 一处差别无法避免：bwrap 以空目录覆盖凭证目录（可见但为空），
 * seatbelt 没有挂载机制，只能拒绝读取（存在但无法打开）。
 * 拦截的行为相同，报错文字不同。
 */
export function buildSeatbeltProfile(
  policy: SandboxPolicy,
  opts: { exists?: (p: string) => boolean } = {},
): string {
  const exists = opts.exists ?? existsSync
  const writable = dedupe([policy.workspaceRoot, ...(policy.writableRoots ?? [])])
  const lines: string[] = [
    '(version 1)',
    // 先全部放行，再逐条收紧。反向写法（deny default）需要枚举能运行 node/git 的
    // 完整白名单，该名单必然有遗漏，遗漏时某个工具无法启动，且报错中没有原因。
    '(allow default)',
    '',
    ';; 写入：默认全部禁止，只开放可写根目录',
    '(deny file-write*)',
  ]

  for (const dir of writable) {
    lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`)
  }

  // /tmp 与 /private/var/folders（macOS 的实际临时目录）必须可写：
  // 编译器、包管理器、git 都向其中写入。
  lines.push('(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))')
  lines.push('(allow file-write* (subpath "/private/var/folders"))')
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
  )

  // 只读子目录必须排在可写根之后：SBPL 中最后匹配的规则生效，
  // 与 bwrap 的挂载顺序原理相同，顺序颠倒时同样不报错。
  if (policy.readOnlySubdirs?.length) {
    lines.push('', ';; 工作区内禁止写入的目录（.qy/ 等），必须排在上方的放行规则之后')
    for (const root of writable) {
      for (const sub of policy.readOnlySubdirs) {
        lines.push(`(deny file-write* (subpath ${sbplString(join(root, sub))}))`)
      }
    }
  }

  if (policy.denyNetwork) {
    lines.push('', ';; 断网：禁止全部出站连接，本机 socket 仍然放行（许多工具用它实现 IPC）')
    lines.push('(deny network-outbound)')
    lines.push('(allow network-outbound (literal "/private/var/run/mDNSResponder"))')
    lines.push('(allow network-bind (local ip))')
  }

  const masked = (policy.maskPaths ?? defaultMaskPaths()).filter(exists)
  if (masked.length) {
    lines.push('', ';; 凭证目录：禁止读取')
    for (const p of masked) {
      lines.push(`(deny file-read* (subpath ${sbplString(p)}))`)
    }
  }

  return `${lines.join('\n')}\n`
}

/** 生成 `sandbox-exec -p <profile> -- <cmd>` 的完整 argv。 */
export function buildSeatbeltArgv(
  policy: SandboxPolicy,
  inner: readonly string[],
  opts: { exists?: (p: string) => boolean } = {},
): string[] {
  return ['/usr/bin/sandbox-exec', '-p', buildSeatbeltProfile(policy, opts), '--', ...inner]
}

/**
 * SBPL 字符串字面量。
 *
 * 必须转义，这是安全边界而非格式处理：路径中的一个 `"` 会使其后的
 * 内容脱离字符串，成为 profile 的一部分，即路径名可以改写沙箱策略。
 * macOS 的文件名允许包含引号和反斜杠，因此该情况实际可能发生。
 */
function sbplString(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    if (!raw || !isAbsolute(raw)) continue
    // 只做 posix 规范化（去掉重复斜杠与尾部斜杠），不做 resolve：
    // resolve 会把结果拼接到本机 cwd 上，而此处的路径供另一个内核使用。
    const p = trimSlash(normalize(raw))
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

// ───────────────────────── 唯一的 spawn 入口 ─────────────────────────

/**
 * 启动子进程的两种输入：交给 shell 执行的命令，或直接执行的参数数组。
 *
 * 参数数组供产品自身的执行程序使用（`office` 的 Python worker）：程序与参数均由产品确定，
 * 模型代码经文件传递，不经 shell 转义。两种输入共用下方的沙箱、runner 与返回结构。
 */
export type GuardedSpawnInput = GuardedSpawnCommon &
  (
    | {
        /** 调用方选定的解释器，必须与命令语法及工具说明一致。 */
        shell: CommandShell | null
        /** 要执行的命令原文。由调用方保证已经过裁决。 */
        command: string
      }
    | {
        /** 可执行文件的绝对路径在前，其后是参数。 */
        argv: readonly string[]
      }
  )

interface GuardedSpawnCommon {
  /** 已解析的绝对工作目录。 */
  cwd: string
  /** 已剥离凭证的环境变量。本函数不做脱敏，由调用方负责。 */
  env: Record<string, string>
  /**
   * 沙箱策略。`null` 表示明确不使用沙箱（插件的 `exec.run` 使用独立的隔离机制）。
   *
   * 传入 `null` 与本机没有沙箱是两种情况，返回的 `sandbox.reason`
   * 分别说明；合并为「无沙箱」时，排查中无法区分配置问题与环境问题。
   */
  policy: SandboxPolicy | null
}

export interface GuardedSpawn {
  /**
   * 两条输出流、退出码与 pid，满足 `collectProcess` 和 `killTree` 的需要。
   *
   * 该字段有两个实现：本进程直接 spawn 的 `Bun.Subprocess`，以及由 runner
   * 代为执行的进程（`runner.ts`）。后者用于确定父进程：命令必须运行在一个
   * 先于监听端口启动的进程之下，否则其派生的后台服务会继承并占用监听端口。
   */
  proc: ProcessLike
  sandbox: SandboxStatus
}

/**
 * Git for Windows 自带的 bash。未找到时返回 `null`。
 *
 * Windows 上只采用该 bash：`resolveBashPath` 的 win32 分支只调用它（由 `probeBash` 注入）。
 *
 * 不查 PATH。本机 `where bash` 的第一条结果是
 * `C:\Windows\System32\bash.exe`，即 WSL 启动器，它在另一个
 * 发行版的文件系统中运行命令（工作区在其中位于 `/mnt/c/...`），cwd 和路径全部不一致，
 * 且失败形式是「命令已执行但文件不存在」，比没有 bash 更难排查。
 * 因此只采用 Git 的安装目录，按几个确定的位置查找。
 *
 * 从 `git.exe` 反推时必须同时向上查找两级和三级：PATH 上可能是 `Git\cmd\git.exe`，
 * 也可能是 `Git\mingw64\bin\git.exe`（本机实测两者都存在）。
 */
function findGitBash(): string | null {
  const candidates: string[] = []
  const git = whichSync('git.exe')
  if (git) {
    const cmdDir = joinNative(git, '..')
    candidates.push(
      joinNative(cmdDir, '..', 'bin', 'bash.exe'),
      joinNative(cmdDir, '..', '..', 'bin', 'bash.exe'),
    )
  }
  const local = process.env.LOCALAPPDATA
  for (const base of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    local ? joinNative(local, 'Programs') : undefined,
  ]) {
    if (base) candidates.push(joinNative(base, 'Git', 'bin', 'bash.exe'))
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/** 覆盖 bash 路径的环境变量。bash 安装在非常规位置（scoop、MSYS2、Cygwin）时只能经由它指定。 */
export const BASH_PATH_ENV = 'QYWORK_BASH_PATH'

/**
 * bash 的探测结果。结构与 `SandboxStatus` 相同：未找到是可上报的状态，不是异常。
 *
 * 易错点：不要在模块加载时抛出异常。否则在没有 bash 的机器上整个 `qy serve` 无法启动，
 * 用户在浏览器中只看到无法连接。终端程序可以 `exit(1)` 输出一行后退出，带界面的
 * 服务端不可以：它必须能启动，并如实报告本机没有 bash。
 *
 * 本类型只表示是否有 bash。没有 bash 时命令交给哪个 shell，
 * 由 `resolveCommandShell` 决定。
 */
export interface BashResolution {
  /** 找到的 bash 可执行文件；`null` 表示本机没有可用的 bash。 */
  path: string | null
  /** `path` 为 `null` 时说明原因与下一步操作；找到时为空串。 */
  reason: string
}

/** 执行命令的 shell。`null` 表示没有任何可用的 shell，此时 `run_command` 不会被注册。 */
export interface CommandShell {
  readonly path: string
  readonly argv: readonly string[]
  readonly hint: string
  /**
   * 命令写入脚本文件后的执行方式。提供此字段的 shell 在 Windows 上经脚本文件传递命令。
   *
   * 只有 bash 提供此字段。Windows 上 argv 需要经过一次命令行字符串的转换，而 MSYS
   * 按自身规则解析时会去掉成对反斜杠的一半：实测发送 1/2/3/4 个，到达
   * 1/1/2/2 个（`ceil(n/2)`）。结果是模型写的 `'\\'` 传给 python 时变为 `'\'`，
   * 产生 `SyntaxError`，且无从得知命令已被修改；正则的 `\\d`、Windows 路径同理。
   * 经脚本文件传递时，1/2/3/4 个反斜杠原样到达。
   *
   * 两种 PowerShell 不提供此字段，依据是实测结果：它们的 argv 不丢失反斜杠
   * （`-Command` 与 `-File` 都收到 4 个），而改用 `-File` 会丢失原生命令的非零
   * 退出码（`cmd /c exit 7` 时 `-Command` 返回 1、`-File` 返回 0），这比反斜杠问题更严重。
   */
  readonly scriptArgv?: (scriptPath: string) => readonly string[]
}

/**
 * 本机的 bash。未找到时返回 `null` 与原因，本函数不回退到其他 shell：
 * 回退到哪个 shell 由 `resolveCommandShell` 决定，只有那里能看到全部三种 shell。
 *
 * 必须提供环境变量入口。回退后的 PowerShell 语法与 bash 差异很大，因此 bash 安装在其他位置时，
 * 必须有一处用户可以自行指定的配置，否则 bash 安装在 scoop / MSYS2 / Cygwin / 自定义盘符的
 * 机器会被判定为没有 bash，从而使用本不需要的语法。
 *
 * 指定的路径不存在时返回 `null` 与原因，不静默回退到自动查找：回退会把路径配置错误变成
 * 「已运行，但运行的不是指定的 bash」，后者只能通过对比输出发现。
 *
 * 查找顺序：Windows 只采用 Git for Windows（不查 PATH 的原因见 `findGitBash`）。
 * 其余平台按位置查找，Homebrew 的 bash 5 排在 `/bin/bash` 之前：macOS 自带的
 * 是 bash 3.2（2007 年，停留在 GPLv2），没有 `declare -A`、`mapfile`、`${x,,}`，
 * 而模型按 bash 4+ 的语法编写。
 *
 * 不使用 `/bin/sh`：它在 Debian 系发行版上是 dash，`[[ ]]`、数组、`<(...)` 均不可用。
 * 判据是模型的默认语法必须与实际执行的 shell 一致；按同一判据，PowerShell
 * 只在未找到任何 bash 时才被采用，见 `resolveCommandShell`。
 *
 * 参数全部注入，以便直接测试查找顺序与环境变量覆盖，无需重新加载模块。
 */
export function resolveBashPath(deps: {
  env: Record<string, string | undefined>
  platform: string
  exists: (p: string) => boolean
  gitBash: () => string | null
}): BashResolution {
  const pinned = deps.env[BASH_PATH_ENV]
  if (pinned) {
    if (deps.exists(pinned)) return { path: pinned, reason: '' }
    return {
      path: null,
      reason: `${BASH_PATH_ENV} 指向 ${pinned}，但该位置不存在文件。修正该值，或不设置该变量以启用自动查找。`,
    }
  }

  if (deps.platform === 'win32') {
    const bash = deps.gitBash()
    if (bash !== null) return { path: bash, reason: '' }
    return {
      path: null,
      reason:
        '未找到 Git for Windows 自带的 bash（已查找 git.exe 的同级目录、' +
        `Program Files\\Git\\bin、LOCALAPPDATA\\Programs\\Git\\bin）。安装 Git for Windows，或用 ${BASH_PATH_ENV} 指向已有的 bash.exe。`,
    }
  }

  const candidates = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash', '/usr/bin/bash']
  const found = candidates.find(deps.exists)
  if (found !== undefined) return { path: found, reason: '' }
  return {
    path: null,
    reason: `以下位置均未找到 bash：${candidates.join('、')}。安装 bash，或用 ${BASH_PATH_ENV} 指向 bash。`,
  }
}

/**
 * 探测本机的 bash。每次调用重新探测，不缓存。
 *
 * 缓存时，安装 git 后重新连接不会生效，
 * 用户必须重启整个服务，且无从得知需要重启。探测只是几次 `existsSync`
 * （`whichSync` 只扫描 PATH，不启动进程），每次执行的开销可以接受。
 */
export function probeBash(): BashResolution {
  return resolveBashPath({
    env: process.env,
    platform: process.platform,
    exists: existsSync,
    gitBash: findGitBash,
  })
}

/**
 * 三种 shell 探测的注入参数。
 *
 * 参数全部注入，理由同 `resolveBashPath`：本机只会命中其中一种
 * （安装了 Git Bash 的机器在第一步即返回），查找顺序与另外两种的结果只能以注入方式测试。
 */
export interface ShellProbeDeps {
  bash: () => BashResolution
  /** 在 PATH 上查找可执行文件。 */
  which: (name: string) => string | null
  exists: (p: string) => boolean
  env: Record<string, string | undefined>
}

/** PowerShell 7 的默认安装位置。安装在其他位置时经由 PATH 上的 `pwsh.exe` 查找。 */
function pwsh7Install(env: Record<string, string | undefined>): string {
  return joinNative(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
}

/**
 * Windows PowerShell 5.1 的固定位置。系统盘不一定是 C:，因此按 `SystemRoot` 确定；
 * 它是系统组件，不查 PATH：PATH 上名为 `powershell` 的可能是其他同名程序。
 */
function windowsPowerShellInstall(env: Record<string, string | undefined>): string {
  return joinNative(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

/**
 * 选择执行命令的 shell，并给出模型必须知道的语法差异。
 *
 * 顺序：bash → pwsh 7 → Windows PowerShell 5.1 → 无可用 shell。
 *
 * bash 始终排第一。模型的默认语法是 POSIX：训练数据中运行命令的语境
 * 绝大多数是 bash；账本中有过只被告知「平台：win32」就按 POSIX 写法编写、
 * 在 PowerShell 上完全未执行的调用（`node --version & python --version`）。
 * 有 bash 的机器上始终使用 bash。
 *
 * pwsh 7 优先于 5.1 是硬性差异，不是偏好。5.1 上 `&&` / `||` 是解析错误
 * （实测 `标记「&&」不是此版本中的有效语句分隔符`），也不支持三元 `? :`、`??`、`?.`、
 * `ConvertFrom-Json -AsHashtable`：同一条命令在 7 上执行成功，在 5.1 上
 * 整条失败。两者都存在时必须选择 7。
 *
 * 两种 PowerShell 都必须使用 `-NoProfile`：用户 profile 会改变行为（别名、函数、`$ErrorActionPreference`），
 * 而其内容在其他机器上无法预知。
 *
 * 语法差异带来三处成本：
 *
 * `policy.ts` 的拒绝规则必须同时识别两种语法、涉及命令的测试必须按 shell 区分、
 * 模型收到的提示也随之不同。前两处是固定成本，无法避免。第三处通过将语法提示前置缓解：
 * `hint` 是 `run_command` 描述的第一句，非 bash 时第一句即声明「不是 bash」。
 * 缓解不等于消除：`run_command` 这个名称本身不携带语法信息，而名称的影响强于描述。
 *
 * 收益是：未安装 Git Bash 的 Windows 机器上，agent 从无法运行任何命令变为可以运行。
 *
 * `hint` 原样写入 `run_command` 的工具说明，与 `spawnGuarded` 使用的 argv 来自同一对象：
 * 两处分别编写必然不一致，告知模型的 shell 与实际执行的 shell 不同，
 * 比不告知更糟。
 *
 * 三种 shell 均未找到时返回 `null`，`run_command` 不会被注册（`tools/index.ts`）：
 * 模型没有该工具，而不是持有一个必然失败的工具。
 */
export function resolveCommandShell(deps: ShellProbeDeps): CommandShell | null {
  const bash = deps.bash().path
  if (bash !== null) {
    return {
      path: bash,
      argv: [bash, '-c'],
      // 以正斜杠形式把路径交给 MSYS：反斜杠形式的路径同样会经过上述去除反斜杠的解析。
      scriptArgv: (scriptPath) => [bash, scriptPath.replaceAll('\\', '/')],
      hint:
        '命令由 `bash -c` 执行（POSIX 语法；Windows 上是 Git for Windows 自带的 bash，' +
        '不是 cmd/PowerShell，也不是 WSL）：`&&`、`||`、管道、`2>/dev/null` 都可用；路径用 `/` 分隔。',
    }
  }

  // pwsh 7 可安装在任意位置，因此优先查 PATH；已安装但未加入 PATH 时由默认安装位置查找。
  const installed = pwsh7Install(deps.env)
  const pwsh7 = deps.which('pwsh.exe') ?? (deps.exists(installed) ? installed : null)
  if (pwsh7 !== null) {
    return {
      path: pwsh7,
      argv: [pwsh7, '-NoProfile', '-NonInteractive', '-Command'],
      hint:
        '**本机没有 bash：命令由 PowerShell 7（`pwsh -NoProfile -NonInteractive -Command`）' +
        '执行，不是 bash。** 按 PowerShell 语法编写：`&&`、`||`、管道可用，但管道中传递的是对象而非文本；' +
        '`2>/dev/null` 写作 `2>$null`；环境变量写作 `$env:NAME`；`ls`/`cat`/`rm` 是 cmdlet 的别名，' +
        '参数写法与 POSIX 不同（`ls -Recurse`、`rm -Recurse -Force`）。',
    }
  }

  const ps51 = windowsPowerShellInstall(deps.env)
  if (deps.exists(ps51)) {
    return {
      path: ps51,
      argv: [ps51, '-NoProfile', '-NonInteractive', '-Command'],
      hint:
        '**本机既没有 bash 也没有 PowerShell 7：命令由 Windows PowerShell 5.1' +
        '（`powershell -NoProfile -NonInteractive -Command`）执行，不是 bash。** ' +
        '5.1 不支持以下写法，按 PowerShell 7 的写法编写会导致整条命令失败：' +
        '`&&` / `||`（解析错误；顺序执行用 `;`，仅在上一条成功时继续用 `if ($?) { … }`）、' +
        '三元 `? :`、null 合并 `??`、null 条件 `?.`、`ConvertFrom-Json -AsHashtable`。' +
        '其余按 PowerShell 语法编写：`2>$null`、`$env:NAME`、`ls -Recurse`。',
    }
  }

  return null
}

/**
 * 本机的 shell。每次调用重新探测，理由同 `probeBash`：安装完成后，
 * 下一条消息即应可用 `run_command`，无需用户重启服务。
 */
export function commandShell(): CommandShell | null {
  return resolveCommandShell({
    bash: probeBash,
    which: whichSync,
    exists: existsSync,
    env: process.env,
  })
}

/**
 * 命令的父进程由谁担任。
 *
 * 这是进程级的事实，因此使用进程级变量：进程要么绑定了监听端口（此时必须经由
 * runner），要么没有（直接 spawn 即可）。它不随调用方、会话、工作区变化，
 * 作为参数逐层传递只会把同一个事实复制多份。
 *
 * `qy serve` 在绑定端口之前注册；`qy exec` 与测试进程不注册，直接 spawn。
 */
let runner: CommandRunner | null = null

export function setCommandRunner(next: CommandRunner | null): void {
  runner = next
}

/** 在沙箱与 runner 之内实际执行的 argv；命令输入在 Windows 上另有一个随进程退出删除的脚本文件。 */
async function innerArgv(
  input: GuardedSpawnInput,
  isWindows: boolean,
): Promise<{ inner: string[]; scriptPath: string | null }> {
  if ('argv' in input) return { inner: [...input.argv], scriptPath: null }

  // 没有任何 shell 时 `run_command` 不注册，因此正常路径不会到达此处；
  // 插件的 `exec.run` 调用同一函数，需要明确的错误信息，而不是在构造 argv 时崩溃。
  const shell = input.shell
  if (shell === null) {
    // 报告 bash 的原因：三种 shell 中只有它能给出下一步操作（安装 Git for Windows），
    // 另外两种只能说明本机没有，没有可执行的下一步。
    throw new Error(
      `没有可用的 shell（bash / pwsh / powershell 均未找到），无法执行命令：${probeBash().reason}`,
    )
  }

  /*
   * 命令原样交给 shell，不做转义处理，与 shell.ts 的约定一致：
   * 转义黑名单无法拦截构造出的命令，实际边界在内核层。
   *
   * 原样传递的前提是命令能原样到达。Windows 上 argv 需要经过一次命令行字符串的转换，
   * 成对的反斜杠在 MSYS 一侧会去掉一半（见 `CommandShell.scriptArgv`）。因此 bash
   * 改为经脚本文件传递：命令正文不进入 argv，逐字节到达。
   */
  const scriptRun = isWindows ? shell.scriptArgv : undefined
  const scriptPath = scriptRun ? joinNative(tmpdir(), `qy-cmd-${randomUUID()}.sh`) : null
  if (scriptPath) await writeFile(scriptPath, input.command, 'utf8')
  const inner =
    scriptRun && scriptPath ? [...scriptRun(scriptPath)] : [...shell.argv, input.command]
  return { inner, scriptPath }
}

/**
 * 本项目中为模型给出的命令启动子进程的唯一位置。
 *
 * 新增调用方之前须确认：绕过此处即绕过沙箱，且不会有任何报错。
 */
export async function spawnGuarded(input: GuardedSpawnInput): Promise<GuardedSpawn> {
  const status = detectSandbox()
  const isWindows = process.platform === 'win32'
  const { inner, scriptPath } = await innerArgv(input, isWindows)
  const policy = input.policy

  const argv =
    policy === null || status.backend === 'none'
      ? inner
      : status.backend === 'bwrap'
        ? buildBwrapArgv(policy, inner)
        : buildSeatbeltArgv(policy, inner)

  const effective: SandboxStatus =
    input.policy === null
      ? { ...status, active: false, reason: '本次调用显式不使用沙箱（插件 exec 使用独立隔离）' }
      : status

  /**
   * 脚本文件的生命周期与进程一致：进程退出后删除。
   *
   * 不在返回前删除：此时命令尚未开始读取。删除失败也不抛出异常：临时目录中残留一个几百字节
   * 的文件，好于因清理失败把一次成功的命令报告为失败。
   */
  const sweep = (proc: { exited: Promise<unknown> }): void => {
    if (!scriptPath) return
    void proc.exited.then(() => rm(scriptPath, { force: true }).catch(() => {}))
  }

  // 有 runner 时由它担任父进程（理由见 `runner.ts` 的模块注释）。
  if (runner) {
    const proc = await runner.spawn({
      argv,
      cwd: input.cwd,
      env: input.env,
      detached: !isWindows,
    })
    sweep(proc)
    return { proc, sandbox: effective }
  }

  /*
   * 三个流的类型显式声明，不依赖推断：带 spread 的字面量会被推断为
   * `'inherit'`，`proc.stderr` 因此可能为 undefined，而读取它的代码在其他文件中。
   */
  const opts = {
    cwd: input.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // 关闭 stdin：交互式提示在此处无人响应，只会等待至超时。
    stdin: 'ignore',
    env: input.env,
    /*
     * 非 Windows 平台上子进程自成进程组，`killTree` 才能终止整个进程组。
     *
     * 否则它与 `qy serve` 同组，按其 pid 无法定位进程组，`killTree`
     * 只能终止 shell 本身，shell 派生的子孙进程继续运行。
     *
     * Windows 不设置：Windows 由 `taskkill /T` 遍历进程树，不需要进程组语义，
     * 且 detached 在 Windows 上表示脱离控制台，与此处目的无关。
     */
    ...(isWindows ? {} : { detached: true }),
  } as Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>

  const proc = Bun.spawn(argv, opts)
  sweep(proc)
  return { proc, sandbox: effective }
}

/**
 * 终止整个进程树。
 *
 * 不能只调用 `proc.kill()`：spawn 启动的不是命令本身，而是一个 shell
 * （`commandShell()` 的 argv 加命令字符串）。实际执行命令的是它的子进程，
 * 而 `proc.kill()` 只终止该 shell：实测 shell 退出后服务进程仍在监听、孙进程
 * 持有 stdout，管道 3 秒内没有 EOF（Windows 11 / Bun 1.3.14）。
 *
 * 管道没有 EOF 比服务未终止更严重。若以管道 EOF 作为命令结束的判据，该次
 * `registry.execute` 永不返回，而 `agent/loop/tool-wave.ts` 中调用它的位置外层没有任何超时。结果
 * 逐层传导：`run-control.ts` 的 finally 不执行、`runs.unregister` 不执行，
 * 该会话此后一直以「已有任务在执行」拒绝新任务，直到重启 `qy serve`。触发条件不限于
 * 启动服务器这类少见情况：任何经 shell 派生子进程的命令（`npm test` → node、
 * `python x.py`）遇到超时或用户中断都会触发。
 *
 * 终止进程树可同时消除这两个问题，但无法终止已脱离父子关系的孤儿进程：进程树解散后再执行一次
 * `taskkill /F /T`，返回 `The process not found`，而管道仍没有 EOF。因此命令是否结束
 * 不能以管道 EOF 判定，该判据由 `collectProcess` 负责：以进程退出为准。
 *
 * 平台：
 * - Windows：`taskkill /F /T`，`/T` 包括全部子孙进程。上文数据为本机实测。
 * - 其余平台：向以 `proc.pid` 为组号的进程组发送 SIGKILL。以 `detached` 启动的子进程自成一组，
 *   组号即其 pid，shell 派生的子孙进程与 bwrap 命名空间中的进程都在组内（Linux / WSL2 实测，
 *   macOS 未实测）。非 detached 启动的子进程不是组长，不存在以其 pid 为组号的组，
 *   调用抛出 ESRCH，转为终止单个进程；该调用不会命中 `qy serve` 自身所在的组。
 *   不要改成先用 `process.getpgid` 验证组长：Bun 1.3.14 没有该方法，验证始终不通过，
 *   进程树终止将退化为只终止 shell。
 */
export function killTree(proc: { pid: number; kill(): void }): void {
  if (process.platform === 'win32') {
    // 同步等待终止完成：异步时调用方随即读取流，可能读到尚未关闭的管道。
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return
  }
  try {
    process.kill(-proc.pid, 'SIGKILL')
    return
  } catch {
    // 该进程组不存在：子进程不是以 detached 启动的，或整组已经退出。
  }
  proc.kill()
}

/**
 * 进程退出后，读取管道中剩余字节的时限。
 *
 * 这不是超时后备处理：正常命令上它没有开销，EOF 紧随退出到达，下方的 race
 * 立即结束。只有后代进程持有写端时才产生这一次固定的少量等待。
 *
 * 取值依据：写端在管道写满时阻塞，因此进程退出前其输出已被读取
 * （本机实测 `seq 1 200000` 加一个后台孙进程，退出时 1288895 字节完整无缺，
 * 最后一个 chunk 比退出早 9ms）；退出后剩余的至多是一个内核缓冲区
 * （Windows 默认 64KB），读取它只是本地内存拷贝。200ms 是为调度抖动留的余量，
 * 不是为命令留的时间。
 */
const DRAIN_AFTER_EXIT_MS = 200

/**
 * 代码页号 → `TextDecoder` 支持的标签。
 *
 * 只列出需要换名的代码页：Bun 不支持 `windows-936` / `x-cp936`，支持 `gb18030`。
 * 未列出的按 `windows-<页号>` 拼接（1250–1258 系列），无法识别的回退到 UTF-8。
 */
const CODE_PAGE_LABELS: Record<string, string> = {
  '932': 'shift_jis',
  '936': 'gb18030',
  '949': 'euc-kr',
  '950': 'big5',
  '65001': 'utf-8',
}

/** 探测结果只计算一次：代码页是机器属性，不随调用变化。 */
let cachedCharset: string | null = null

/**
 * 按运行时计算出的标签创建解码器。
 *
 * Bun 把标签类型收窄为字面量联合，而代码页在运行时计算，不属于该联合。
 * 类型断言的正确性由构造本身保证：无法识别的标签在此处立即抛出异常，调用方捕获后回退到 UTF-8，
 * 无效标签不会进入解码阶段。
 */
function decoderFor(label: string): TextDecoder {
  return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0])
}

/**
 * 本机原生程序向管道写入字节时使用的字符集。
 *
 * Windows 下读取注册表中的 ACP：`chcp` 取得的是控制台代码页，而 sidecar 由外壳启动时
 * 没有控制台，该方式的结果不稳定。探测失败、无法拼接标签或不是 Windows 时，
 * 一律按 UTF-8 处理。
 */
function consoleCharset(): string {
  if (cachedCharset !== null) return cachedCharset
  cachedCharset = 'utf-8'
  if (process.platform !== 'win32') return cachedCharset
  try {
    const out = Bun.spawnSync([
      'reg',
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage',
      '/v',
      'ACP',
    ])
    const page = new TextDecoder().decode(out.stdout).match(/ACP\s+REG_SZ\s+(\d+)/)?.[1]
    if (!page) return cachedCharset
    const label = CODE_PAGE_LABELS[page] ?? `windows-${page}`
    // 是否支持由 TextDecoder 判定，不要在此处另维护一份支持清单。
    decoderFor(label)
    cachedCharset = label
  } catch {
    // 保持 utf-8
  }
  return cachedCharset
}

/**
 * 子进程输出的解码器。
 *
 * 不能固定为 UTF-8：Windows 上原生程序按系统代码页输出字节（实测 `powershell`、
 * mingw 的 `curl` 均为 GBK），按 UTF-8 解码会得到大量 U+FFFD，模型会把这些乱码
 * 当作事实，据此做出错误判断，再用一整轮去证伪。也不能固定为代码页：
 * 同一台机器上 node、设置了 `PYTHONIOENCODING` 的 python 输出 UTF-8。
 *
 * 判据是字节本身：严格 UTF-8 解码器对跨片的不完整字符不抛出异常（`{ stream: true }` 会把
 * 它保留在内部缓冲中），只对非法序列抛出异常。抛出异常即说明该流不是 UTF-8。
 *
 * 判定后不再切换回 UTF-8。同一条流中交替出现两种编码不是实际场景，而反复切换会截断跨片
 * 字符。代价是切换时缓冲中至多三个字节的不完整字符会丢失，不为此增加第二套缓冲。
 */
export function makeOutputDecoder(): (chunk: Uint8Array) => string {
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  let fallback: TextDecoder | null = null
  return (chunk) => {
    if (fallback) return fallback.decode(chunk, { stream: true })
    try {
      return utf8.decode(chunk, { stream: true })
    } catch {
      fallback = decoderFor(consoleCharset())
      return fallback.decode(chunk, { stream: true })
    }
  }
}

export interface CollectedProcess {
  exitCode: number
  stdout: string
  stderr: string
  /** `timeoutMs` 或 `idleMs` 已到期，进程树已终止。 */
  timedOut: boolean
  /**
   * 进程已经退出，但仍有后代进程持有输出管道，读取由本地主动结束。
   *
   * 调用方应据此告知上游：后台仍有进程在运行，其后续输出不在本结果中。
   * 启动后台服务的脚本属于这种情况，且结果中没有其他迹象。
   */
  backgroundHeld: boolean
}

export interface CollectOptions {
  /** 到期后终止进程树。不提供时不设超时，只适用于不可能长时间运行的命令。 */
  timeoutMs?: number
  /**
   * 无输出时限：任一条流每收到一片输出即重置计时，到期后终止进程树并报告 `timedOut`。
   *
   * 与 `timeoutMs` 相互独立，两者都提供时先到期的生效。二者判据不同：
   * `timeoutMs` 计量总时长，无法区分仍在输出与已停止响应；
   * `idleMs` 计量两片输出之间的间隔，只要仍在输出就持续等待。
   */
  idleMs?: number
  /** 中断信号。abort 时终止进程树，使用户点击停止后子进程确实停止。 */
  signal?: AbortSignal
  /** 每片解码后的文本先经过此函数，其返回值计入结果。脱敏与流式回传都在此完成。 */
  onText?: (channel: 'stdout' | 'stderr', text: string) => string
  /** 流结束时追加的内容（通常是脱敏器的跨片缓冲）。返回值不再经过 `onText`。 */
  onEnd?: (channel: 'stdout' | 'stderr') => string
  /**
   * 每条流的字符上限。它限制的是读取本身，而不只是返回值：
   * 读完再截断时，一条 `yes` 命令会在截断生效之前耗尽内存。
   * 是否达到上限由调用方判断（长度达到上限即是），此处只负责停止读取。
   */
  maxChars?: number
}

/**
 * 等待子进程执行完毕，并读取其输出的字节。
 *
 * 这是等待子进程的唯一入口，理由与 `spawnGuarded` 是启动子进程的唯一入口相同：
 * 等待逻辑分散在各处时，完成判据需要分别实现，实现错误的一处不会报错，
 * 只会永久阻塞。
 *
 * 完成判据是进程退出，不是管道 EOF。EOF 表示所有继承了写端的进程都已关闭写端，这取决于
 * 一组不属于本次调用的进程。任何经 shell 派生、脱离父子关系后继续存活的进程都能永久持有
 * 写端，启动后台服务的脚本正是这种情况，且这是脚本的正确行为：服务本应继续运行。
 * 实测 `bash -c 'echo hello; sleep 20 &'`：26ms 收到退出码，6 秒后 EOF 仍未到达。
 *
 * 以 EOF 为判据的代价不限于本次调用：调用方不返回 → `run-control` 的 finally
 * 不执行 → `runs.unregister` 不执行 → 该会话此后拒绝所有新任务，且用户点击
 * 停止也无法停止（停止只是 abort，无法结束一个不返回的 await），直到重启服务。
 *
 * 退出后仍需短暂等待：退出后立即停止读取会静默丢失字节，内核缓冲中可能还有最后一段输出。
 * 因此退出后留出 `DRAIN_AFTER_EXIT_MS` 读取剩余字节，到期仍无 EOF 即判定有后代进程持有写端，
 * 取消读取并如实报告 `backgroundHeld`。
 */
export async function collectProcess(
  proc: ProcessLike,
  opts: CollectOptions = {},
): Promise<CollectedProcess> {
  const text: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  let timedOut = false
  let backgroundHeld = false
  // 类型从 `getReader()` 推断：直接写 `ReadableStreamDefaultReader` 会使用
  // Bun 的全局声明（多一个 `readMany`），与 `node:stream/web` 的声明不一致。
  const readers: ReturnType<ReadableStream<Uint8Array>['getReader']>[] = []

  // 无输出计时。每片输出重置一次，因此计量的是两片之间的间隔而不是总时长。
  // 进程退出后必须停止：退出后还有一段读取剩余缓冲的时间，其间没有输出属于正常情况，
  // 不停止时一次正常退出会被报告为 `timedOut`。
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const stopIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }
  const armIdle = () => {
    if (opts.idleMs === undefined) return
    stopIdle()
    idleTimer = setTimeout(() => {
      timedOut = true
      killTree(proc)
    }, opts.idleMs)
  }

  // 使用显式 reader 而不是 `for await`：后者把流锁定在循环中，结束时在外部调用
  // `stream.cancel()` 会直接抛出 `locked`；若不 cancel 而只是放弃该 promise，
  // 孤儿进程向管道写入多少，此处内存就增长多少，造成内存泄漏。
  const pump = async (stream: ReadableStream<Uint8Array>, channel: 'stdout' | 'stderr') => {
    const reader = stream.getReader()
    readers.push(reader)
    const decode = makeOutputDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armIdle()
        const decoded = decode(value)
        text[channel] += opts.onText ? opts.onText(channel, decoded) : decoded
        if (opts.maxChars !== undefined && text[channel].length >= opts.maxChars) {
          // 必须 cancel，不能只 break。读端未关闭时，写端写满后阻塞，
          // 进程无法退出，输出上限会成为新的阻塞点。
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      const tail = opts.onEnd?.(channel)
      if (tail) text[channel] += tail
    }
  }

  // 先启动计时再开始读取：不输出任何字节的进程同样必须在到期时终止。
  armIdle()
  const pumping = Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')])

  // 总时长到期、无输出到期与中断都终止整个进程树：启动的是 shell 或会派生子进程的程序，
  // 只终止它本身时，实际执行命令的进程仍在运行（详见 `killTree`）。
  const timer =
    opts.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true
          killTree(proc)
        }, opts.timeoutMs)
  const onAbort = () => killTree(proc)
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const exitCode = await proc.exited
    stopIdle()
    const drained = await Promise.race([
      pumping.then(() => true),
      Bun.sleep(DRAIN_AFTER_EXIT_MS).then(() => false),
    ])
    if (!drained) {
      backgroundHeld = true
      for (const reader of readers) await reader.cancel().catch(() => {})
      await pumping
    }
    return { exitCode, stdout: text.stdout, stderr: text.stderr, timedOut, backgroundHeld }
  } finally {
    if (timer !== null) clearTimeout(timer)
    stopIdle()
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
