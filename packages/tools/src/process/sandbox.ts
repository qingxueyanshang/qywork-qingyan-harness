/**
 * 内核沙箱：本机探测，以及按策略生成 bwrap 与 seatbelt 的参数。由 `spawn.ts` 的 `spawnGuarded` 包裹每一次启动。
 *
 * 各平台的沙箱状态分别上报，不合并为单一的「有沙箱」。
 *
 * | 平台 | 后端 | 边界 |
 * |---|---|---|
 * | Linux / WSL2 | bubblewrap | 内核级：写边界 + 凭证目录屏蔽 |
 * | macOS | seatbelt（`sandbox-exec`） | 同上，以 SBPL 规则而非挂载实现 |
 * | 原生 Windows | 暂无（不实现） | 只有静态规则 |
 * | WSL1 | 暂无 | 没有独立内核，namespace 不可用 |
 *
 * 合并为一个布尔值时，界面显示「沙箱：开」，
 * 而实际生效的可能只是其中一个维度，因此按维度分别上报。
 *
 * 已安装不等于可用，因此必须实际执行一次。`detectSandbox()` 不以 `which` 的结果为准，
 * 而是实际执行一次空命令。Ubuntu 24.04+ 默认禁用无特权用户命名空间，此时 bwrap 位于 PATH 中，
 * 但任何命令都无法运行；只检查 `which` 会报告有边界，这是最严重的误报：
 * 用户会据此认为 shell 已受约束。
 *
 * macOS 后端同样依靠自检保证：本仓库没有 Mac 测试环境，profile 生成只有纯函数测试；
 * 确认其可用的是用户机器上的自检，失败时降级上报 `none`。
 *
 * 自行生成 argv，不引入现成的沙箱运行时，原因有二：现成方案的 vendor 二进制是
 * 磁盘上的文件，而发布产物是单文件二进制，无法携带（约束与 `netguard.ts` 相同）；
 * 本机无法安装其依赖，因而无法验证，未经验证的能力不能作为边界发布。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
/*
 * bwrap 只在 Linux 上运行，因此其路径始终是 POSIX 形式。
 *
 * 使用平台相关的 `node:path` 时，Windows 开发机上会把 `/ws` 拼接为 `C:\ws`、
 * 把分隔符写为反斜杠，生成的 argv 在 Linux 上无效；
 * 且 Windows 上不启用沙箱，该错误在运行时不会暴露，
 * 只有在 Windows 上调试这些函数时才会发现。因此固定使用 posix 版本。
 */
import { isAbsolute, join, normalize } from 'node:path/posix'
import { globalScopeRoot } from '@qywork/agent'
import { whichSync } from './command-shell.ts'

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
   * 工作区内只读的路径（相对工作区），取自 `PROTECTED_DIRS`（目前为 `.qy`）。
   * 判据是写入后能否为自身添加工具，见 `PROTECTED_DIRS`。
   * 条目可以是文件或目录（`--ro-bind-try` 两者都支持）。
   *
   * 与文件工具的 `PROTECTED_DIRS` 是同一约束的两种实现：
   * 前者拦截工具参数，本字段拦截 shell。没有内核沙箱的平台（Windows）上 shell 一侧不拦截：
   * 命令裁决有意不设 `.qy` 规则，理由见 `agent/policy.ts`。
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
 * 不能只检查 `which`：二进制位于 PATH 中与能够创建命名空间是两个条件，二者不一致的
 * 情况很常见：
 *
 * - Ubuntu 24.04+ 默认开启 `kernel.apparmor_restrict_unprivileged_userns`，
 *   `unshare(CLONE_NEWUSER)` 成功但新命名空间中没有 capability，
 *   bwrap 无法启动。
 * - 无特权容器中 `--proc` 不可用。
 * - macOS 的 `sandbox-exec` 会因 profile 语法或 SIP 策略拒绝执行。
 *
 * 只检查 `which` 时会报告有边界，而实际任何命令都无法运行；
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
       * 不要写成「只受静态规则约束，它是文本判断」：静态规则已包含字面路径检查，
       * 可确定拦截的写法已经较多，该说法夸大了缺口。
       * 夸大与低估同样不准确，且夸大会使用户习惯性忽略该提示，出现问题时不再关注。
       *
       * 该文字原样显示在设置页中，因此不写内部文档的编号：用户无法打开
       * 这些文档，编号对用户没有信息量。
       *
       * 只写边界，不写机制。用户据以决策的只有一点：工作区外且家目录外的
       * 路径无法拦截。静态规则的判定方式、WSL2 的替代方案均不写入。
       * 下方其他平台的缺省分支使用同一措辞，理由相同。
       */
      reason: '原生 Windows 无内核沙箱后端，工作区与家目录之外的路径不受约束。',
      platform,
      wsl,
    }
  }

  return {
    backend: 'none',
    active: false,
    reason: `${platform} 上没有对应的内核沙箱实现，工作区与家目录之外的路径不受约束。`,
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
 * 无法定位。这样的沙箱无法正常使用，用户关闭沙箱后没有任何防护。
 *
 * 要防范的是向本机之外的泄露，与 `secrets.ts` 的口径一致。按此口径，
 * 家目录中有风险的是凭证文件而非配置文件。因此家目录整体只读（写边界照常生效），
 * 另外以空目录覆盖凭证目录。
 *
 * 该清单是列举，因此与静态规则一样，未列入的目录不受保护。
 * 区别在于代价：此处遗漏一项是少屏蔽一个目录，静态规则遗漏一项是放行一条命令。
 */
export function defaultMaskPaths(home = homedir(), globalRoot = globalScopeRoot()): string[] {
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
    // QyWork 的全局数据目录：其中保存 provider 的明文 API Key。按实际位置列出，
    // `QYWORK_HOME` 指向别处时家目录中的 `.qywork` 仍可能保存着密钥，两处都屏蔽。
    join(home, '.qywork'),
    ...(globalRoot.startsWith('/') ? [globalRoot] : []),
  ]
}

/** `p` 是否位于 `dir` 之中或即为 `dir`。两者都是规范化后的 POSIX 绝对路径。 */
function inside(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`)
}

/**
 * 把屏蔽目录按与可写根的关系分为两组：`outer` 中有可写根位于其内，`rest` 是其余的。
 *
 * 两个后端都按出现顺序叠加，后出现的生效。`outer` 必须排在可写根之前：默认工作区位于全局数据目录的
 * `workspaces/` 中，屏蔽排在后面时工作区随全局数据目录一并不可见，其中的每条命令都无法启动。
 * `rest` 必须排在可写根之后：工作区是家目录时，排在前面的屏蔽会被随后的可写根恢复为可见。
 * 屏蔽目录本身是可写根时归入 `rest`：用户把凭证目录打开为工作区，屏蔽仍然生效。
 */
function splitMasks(
  masks: readonly string[],
  writable: readonly string[],
): { outer: string[]; rest: string[] } {
  const outer: string[] = []
  const rest: string[] = []
  for (const mask of dedupe(masks)) {
    const holdsRoot = writable.some((root) => root !== mask && inside(mask, root))
    ;(holdsRoot ? outer : rest).push(mask)
  }
  return { outer, rest }
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
 * - 凭证目录以 `--tmpfs` 覆盖为空目录；其中有可写根的，排在可写根之前（`splitMasks`）。
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
 * - `opts.cwd` 以 `--chdir` 传入：不传时 bwrap 在工作目录于沙箱中不存在（`/tmp` 下的目录被 tmpfs 覆盖）时
 *   改用 `$HOME` 且不报错，命令在另一个目录中执行。传入后该情形以 bwrap 的报错结束。
 */
export function buildBwrapArgv(
  policy: SandboxPolicy,
  inner: readonly string[],
  opts: { exists?: (p: string) => boolean; cwd?: string } = {},
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
  const masks = splitMasks(policy.maskPaths ?? defaultMaskPaths(), writable)
  // 以空目录覆盖凭证目录。必须先确认目录存在：`--tmpfs` 没有 `-try` 变体，
  // 它会创建挂载点，父目录只读时直接失败：
  //
  //     bwrap: Can't mkdir /root/.nope: Read-only file system
  //
  // 在没有 `~/.aws` 的机器上无条件屏蔽该目录，会使每一条命令
  // 都无法启动。屏蔽清单按常见凭证目录列出，任何一台机器通常只有其中几个。
  const mask = (paths: readonly string[]): void => {
    for (const p of paths) {
      if (exists(p)) args.push('--tmpfs', p)
    }
  }

  // 其中有可写根的屏蔽目录先覆盖，可写根随后挂载到空目录之上，见 `splitMasks`。
  mask(masks.outer)
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

  mask(masks.rest)

  args.push('--unshare-pid', '--unshare-uts', '--unshare-ipc', '--proc', '/proc')
  // `--unshare-net` 创建空的网络命名空间，其中只有 lo。
  // 不配置代理桥接即完全断网，这正是该开关的语义。
  if (policy.denyNetwork) args.push('--unshare-net')
  if (opts.cwd !== undefined) args.push('--chdir', opts.cwd)
  args.push('--', ...inner)
  return args
}

/** 去除尾部斜杠，根目录 `/` 除外。 */
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

  const masks = splitMasks(policy.maskPaths ?? defaultMaskPaths(), writable)
  const masked = [...masks.outer, ...masks.rest].filter(exists)
  if (masked.length) {
    lines.push('', ';; 凭证目录：禁止读取')
    for (const p of masked) {
      lines.push(`(deny file-read* (subpath ${sbplString(p)}))`)
    }
  }
  // 位于屏蔽目录中的可写根恢复为可读：最后匹配的规则生效，必须排在上方的拒绝之后，见 `splitMasks`。
  const reopened = writable.filter((root) => masks.outer.some((m) => exists(m) && inside(m, root)))
  if (reopened.length) {
    lines.push('', ';; 位于凭证目录中的可写根：恢复读取')
    for (const root of reopened) {
      lines.push(`(allow file-read* (subpath ${sbplString(root)}))`)
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
    // 只做 posix 规范化（去除重复斜杠与尾部斜杠），不做 resolve：
    // resolve 会把结果拼接到本机 cwd 上，而此处的路径供另一个内核使用。
    const p = trimSlash(normalize(raw))
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}
