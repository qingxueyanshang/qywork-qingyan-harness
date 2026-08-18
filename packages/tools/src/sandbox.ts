/**
 * 起子进程的唯一出口，以及套在它外面的 OS 沙箱。
 *
 * ## 为什么要有这个文件
 *
 * `run_command` 是整套权限模型里唯一一条**能同时绕开路径约束和 SSRF 闸**的路径——
 * 命令字符串里的路径不经过我们任何一行代码。在它之上加的静态规则和分类器都是
 * **文本判断**：静态规则是一张想得到才写得出的表，分类器是概率。两者都挡不住
 * 一个没想到的写法，而「没想到」这件事按定义列不完。
 *
 * 内核层的边界不一样：它不关心命令长什么样，只关心系统调用打到哪个 inode。
 * 所以这个文件的目标不是「再加一层规则」，是**把边界从文本层挪到内核层**。
 *
 * 收成一个函数是前提：包装点必须唯一。散落在两处的 `Bun.spawn` 意味着
 * 加沙箱时要记得两个地方都改，而漏掉的那处不会报错，只会安静地没有边界。
 *
 * ## 三档平台，分开报，不合并成「有沙箱」
 *
 * | 平台 | 后端 | 边界 |
 * |---|---|---|
 * | Linux / WSL2 | bubblewrap | 内核级：写边界 + 凭证目录屏蔽 |
 * | macOS | seatbelt（`sandbox-exec`） | 同上，用 SBPL 规则而不是挂载表达 |
 * | 原生 Windows | 暂无（决定不做，ROADMAP §42） | 只有静态规则与分类器 |
 * | WSL1 | 暂无 | 没有独立内核，namespace 不可用 |
 *
 * 合并成一个布尔值是插件那边踩过的坑（ROADMAP §16）：用户看到「沙箱：开」
 * 就以为全都保住了，而实际生效的可能只有其中一维。**分维度报**。
 *
 * ## 「装了」不等于「能用」，所以要真跑一次
 *
 * `detectSandbox()` 不是查 `which` 就下结论——它**真的执行一次**空命令。
 * Ubuntu 24.04+ 默认禁掉无特权用户命名空间，那种机器上 bwrap 在 PATH 里、
 * 但一条命令都跑不起来；只查 `which` 的话我们会报「有边界」，
 * 而那是最坏的一种错——用户据此认为 shell 被拦住了。
 *
 * 这也是 macOS 那条的保证方式：本仓库没有 Mac，profile 生成只有纯函数测试；
 * **真正确认它可用的是用户机器上的那次自检**，失败就降级报 `none`。
 *
 * ## 为什么是自己拼 bwrap，不是引 `@anthropic-ai/sandbox-runtime`
 *
 * 那个包（0.0.71，Apache-2.0）评估过，功能远比这里全，但四条对不上：
 *
 * 1. **它的网络隔离在 Linux 上关不掉。** `needsNetworkRestriction` 由
 *    `network.allowedDomains !== undefined` 决定，而那个字段是 schema 必填，
 *    于是 bwrap 一定带 `--unshare-net`：要么整个断网（`npm install`、`git fetch`
 *    全废），要么起一套 socat + MITM 代理 + 自签 CA。对一个写代码的 agent 来说，
 *    前者是不能用，后者是引入一整套会在别人机器上以奇怪方式坏掉的东西。
 * 2. **依赖装不上。** Linux 侧要 bwrap + socat + ripgrep，本机 WSL2 只有 bwrap，
 *    而它没有外网（DNS 与 TCP 均不通）——装不上就验不了。
 * 3. **单文件产物带不了它的 vendor 二进制。** `apply-seccomp` / `srt-win.exe`
 *    是磁盘上的文件，而 sidecar 是单文件。这与 §24 的 netguard 是同一个坑。
 * 4. **验不了的东西不能当边界发出去。** 这是本项目反复付过学费的一条。
 *
 * 需要域名白名单、凭证脱敏代理、macOS seatbelt 时应该回头用它——
 * 那时的正确做法是把它接在这个文件的 `wrap()` 后面，而不是再开一个 spawn 点。
 * 它另有一个 **Windows 后端**（`srt-win.exe` + WFP + 专用本地账户），
 * 这件事推翻了「Windows 上没有内核边界的实现」这个说法，单独记在 ROADMAP §32。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinNative } from 'node:path'
/*
 * bwrap 只在 Linux 上跑，所以它的路径**永远是 POSIX 形式**。
 *
 * 用平台相关的 `node:path` 会在 Windows 开发机上把 `/ws` 拼成 `C:\ws`、
 * 把分隔符写成反斜杠——生成的 argv 变成一串在 Linux 上毫无意义的东西，
 * 而且因为 Windows 上根本不会启用沙箱，**这个错误在运行时永远不会暴露**，
 * 只会在有人把它当真拿去调试时才发现。固定用 posix 版本。
 */
import { isAbsolute, join, normalize } from 'node:path/posix'
import type { CommandRunner, ProcessLike } from './runner.ts'

/*
 * bwrap 与 seatbelt 都只在类 Unix 上跑，路径一律 POSIX 形式，所以上面那条
 * import 覆盖了这个文件里**全部**的路径拼接。唯一的例外是 `whichSync`——
 * 它查的是本机 PATH，那必须用平台原生的 `join`。
 */

export type SandboxBackend = 'bwrap' | 'seatbelt' | 'none'

export interface SandboxStatus {
  backend: SandboxBackend
  /** 这次执行是不是真的有内核边界。**唯一可以对用户说「拦得住」的判据。** */
  active: boolean
  /** 为什么是这个结论。要能直接贴给用户，不要「不支持」这种没有下一步的话。 */
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
   * 工作区内只读的子目录（相对工作区）。目前只有 `.qy`。
   *
   * 与文件工具那边的 `PROTECTED_DIRS` 是同一件事的两种实现：
   * 那边挡工具参数，这边挡 shell。两边都要有——**shell 那条路
   * 在没有沙箱的平台上只剩静态规则的文本匹配**。
   */
  readOnlySubdirs?: readonly string[]
  /**
   * 完全屏蔽（挂空目录盖住）的绝对路径，典型是凭证目录。
   *
   * 不填时用 `defaultMaskPaths()`。
   */
  maskPaths?: readonly string[]
  /**
   * 断掉 shell 命令的出网。默认 `false`。
   *
   * ## 为什么默认不断
   *
   * 断网的 agent 装不了依赖、拉不了代码、跑不了大半的测试。默认打开的话，
   * 用户遇到的第一个现象是「`npm install` 挂了」，而**报错跟网络毫不相干**
   * （包管理器只会说拉取失败）。查到原因之前他会先把整个沙箱关掉——
   * 于是文件边界也一起没了。
   *
   * ## 为什么仍然给这个开关
   *
   * 出网是这套模型里唯一一条**完全没有边界**的路：`web_fetch` 过 SSRF 闸，
   * 而 shell 里一句 `curl` 什么都不过。对于「跑一段来路不明的代码」这类场景，
   * 全断比不断好得多，而且它是二值的——不需要域名白名单那一整套
   * MITM 代理 + 自签 CA。
   *
   * **中间态（按域名过滤）刻意不做**：它需要在沙箱里起代理、在沙箱外做转发、
   * 还要让 TLS 校验认我们自签的 CA。那套东西会在别人的机器上以各种方式坏掉，
   * 而坏掉的表现是「网络时好时坏」——比没有这个功能糟得多。
   */
  denyNetwork?: boolean
}

// ───────────────────────── 平台判定 ─────────────────────────

/**
 * WSL 版本。非 Linux 或非 WSL 返回 null。
 *
 * WSL1 要单独认出来：它把 Linux 系统调用翻译到 NT 内核上，**没有真正的
 * namespace**，bwrap 在那里要么起不来要么给不出边界。报成「有沙箱」是最坏的结果。
 */
function detectWsl(): string | null {
  if (process.platform !== 'linux') return null
  try {
    const v = readFileSync('/proc/version', 'utf8')
    const m = v.match(/WSL(\d+)/i)
    if (m?.[1]) return m[1]
    // WSL1 的老格式里没有版本号，只有 "Microsoft"。
    if (v.toLowerCase().includes('microsoft')) return '1'
    return null
  } catch {
    return null
  }
}

/** 在 PATH 里找一个可执行文件。找不到返回 null。 */
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
 * 本机有没有内核级边界可用。结果缓存——它在一次进程生命周期内不会变，
 * 而 `run_command` 每次调用都要问。
 */
export function detectSandbox(): SandboxStatus {
  if (cached) return cached
  cached = probe()
  return cached
}

/**
 * 自检用的最小策略：一个一定存在的可写根，没有屏蔽项。
 *
 * 刻意不用真实策略——自检要回答的是「这台机器允不允许建命名空间」，
 * 与具体放开哪些目录无关，而掺进真实路径只会让探针在某个目录恰好不存在时
 * 假红一次。
 */
const PROBE_POLICY: SandboxPolicy = { workspaceRoot: '/tmp', maskPaths: [] }

/**
 * 真的跑一次，确认这个后端在**这台机器上**确实能用。
 *
 * ## 为什么不能只查 `which`
 *
 * 「二进制在 PATH 里」和「它能建出一个命名空间」是两件事，而它们分开的情况
 * 一点也不罕见：
 *
 * - **Ubuntu 24.04+ 默认开着 `kernel.apparmor_restrict_unprivileged_userns`**，
 *   于是 `unshare(CLONE_NEWUSER)` 成功但**新命名空间里没有 capability**，
 *   bwrap 起不来。
 * - 无特权容器里 `--proc` 不可用。
 * - macOS 的 `sandbox-exec` 会因为 profile 语法或 SIP 策略拒绝执行。
 *
 * 只查 `which` 的后果是**报告说有边界，实际一条命令都跑不了**——
 * 而这个方向的错是最坏的一种：用户据此认为 shell 是被拦住的。
 *
 * 返回 `null` = 可用；返回一句话 = 不可用及其原因。
 *
 * 代价是一次进程启动，**整个进程生命周期只付一次**（`detectSandbox` 缓存结果）。
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
    // 二进制不存在、权限不足、被安全软件拦下——都落这里。
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
        reason:
          'WSL1 没有独立内核，namespace 不可用，bubblewrap 给不出真实边界。' +
          '升级到 WSL2（wsl --set-version <发行版> 2）后本项目会自动启用沙箱。',
        platform,
        wsl,
      }
    }
    const bwrap = whichSync('bwrap')
    if (bwrap === null) {
      return {
        backend: 'none',
        active: false,
        reason:
          '未安装 bubblewrap，shell 命令没有内核级边界。' +
          '装上即可启用：apt-get install bubblewrap / dnf install bubblewrap / pacman -S bubblewrap',
        platform,
        wsl,
      }
    }
    // 装了 ≠ 能用。见 selfCheck 的注释。
    // 自检用**最小策略**：要验的只是「命名空间建得起来」。
    // 用真实策略的话，`workspaceRoot: '/'` 会拼出 `--bind / /`（整机可写），
    // 而一条把整机变可写的探针放在安全模块里，迟早会被人当成真实配置读。
    const check = selfCheck(buildBwrapArgv(PROBE_POLICY, ['/bin/true']))
    if (check !== null) {
      return {
        backend: 'none',
        active: false,
        reason:
          `bubblewrap 已安装（${bwrap}）但**跑不起来**，因此没有内核级边界：${check}\n` +
          '  最常见的原因是内核禁掉了无特权用户命名空间（Ubuntu 24.04+ 默认如此）。\n' +
          '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
        platform,
        wsl,
      }
    }
    return {
      backend: 'bwrap',
      active: true,
      reason: `bubblewrap（${bwrap}），已实测可用：工作区之外只读、凭证目录不可见、网络不受限`,
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
        reason:
          `seatbelt（sandbox-exec）跑不起来，因此没有内核级边界：${check}\n` +
          '  shell 命令目前只受静态规则与分类器约束，两者都是文本判断。',
        platform,
        wsl,
      }
    }
    return {
      backend: 'seatbelt',
      active: true,
      reason:
        'sandbox-exec，已实测可用：工作区之外只读、凭证目录不可读、网络不受限。' +
        '（`sandbox-exec` 被 Apple 标记为 deprecated，但目前没有可替代的用户态接口。）',
      platform,
      wsl,
    }
  }

  if (platform === 'win32') {
    return {
      backend: 'none',
      active: false,
      /*
       * 措辞要**按真实的残余风险**写，不能只说「没有沙箱」。
       *
       * 前一版写成「只受静态规则与分类器约束，两者都是文本判断」，
       * 读起来像「你完全没有防护」——而补完字面路径那条之后（ROADMAP §40），
       * 确定性拦得住的东西已经不少了。把缺口说大和说小一样是不如实的，
       * 而说大的代价是用户对提示脱敏，真出问题时那条提示已经没人看了。
       *
       * 这段话会原样出现在设置页里，所以**不写内部文档的编号**——用户打不开
       * ROADMAP，那行字对他只是噪音。（为什么不在原生 Windows 上做：ROADMAP §42。）
       */
      reason:
        '原生 Windows 上没有内核级边界：shell 命令只受硬边界 + 静态规则 + 分类器约束，' +
        '而后两者是**文本判断**。\n' +
        '  确定性拦得住的：家目录与系统目录（符号写法和字面绝对路径都认）、' +
        '写 .qy/、提权、毁盘、下载即执行、写 SSH 凭据。\n' +
        '  **拦不住的**：工作区外**且**家目录外的路径（另一块盘、ProgramData、网络共享）。\n' +
        '  要那一层也有边界，现成的办法是在 WSL2 里运行 qy——会自动启用 bubblewrap。',
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
 * ## 为什么是「挑几个目录屏蔽」而不是「整个家目录不可见」
 *
 * 整个家目录盖掉的话，`~/.gitconfig`、`~/.npmrc`、nvm/rustup/pyenv 全部消失，
 * 于是 `git commit` 没有作者、`npm install` 换了 registry、`node` 可能根本找不到。
 * 那种沙箱用户开一次就会关掉，而关掉之后一层都不剩。
 *
 * 真正要防的是**跨出这台机器的泄露**，与 `secrets.ts` 的口径一致。按这个口径，
 * 家目录里危险的是凭证文件，不是配置文件。所以家目录整体**只读**（写边界照常生效），
 * 额外把凭证目录盖成空的。
 *
 * 这是一份**列举**，因此和静态规则一样有「没想到就是个洞」的性质。
 * 区别在于代价：这里漏一条是少屏蔽一个目录，静态规则漏一条是放行一条命令。
 */
export function defaultMaskPaths(home = homedir()): string[] {
  // 非 POSIX 绝对路径（Windows 的 `C:\\Users\\x`）拼出来会是
  // `C:\\Users\\x/.ssh` 这种两种分隔符混用的怪东西。两个后端都只在类 Unix 上跑，
  // 所以这里的正确答案是**给不出**，而不是给一个看起来像路径的字符串。
  if (!home.startsWith('/')) return []
  return [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.docker'),
    join(home, '.kube'),
    join(home, '.config', 'gh'),
    join(home, '.config', 'gcloud'),
    // qywork 自己的配置目录：里面就是 provider 的 API Key 明文。
    join(home, '.qywork'),
  ]
}

/**
 * 把策略翻成 bwrap 参数。**纯函数**——不碰文件系统，任何平台都跑得起来，
 * 所以它进得了 `bun test`。
 *
 * 边界的形状：
 *
 * - `--ro-bind / /`：整机可读、**不可写**。这是「写边界」，不是读边界。
 *   读边界要靠只 bind 少数几个目录，而那样 `/usr`、`/lib`、`/etc` 全没了，
 *   基本上什么都跑不起来。如实记在 `docs/permissions.md`：
 *   **工作区外的文件仍然读得到**，凭证目录是单独盖掉的。
 * - 可写根目录逐个 `--bind`。
 * - `.qy/` 在可写根之后再 `--ro-bind` 盖回只读：**顺序不能反**，bwrap 后到的赢。
 * - 凭证目录 `--tmpfs` 盖成空的。
 * - `--unshare-pid` + `--proc /proc`：看不到宿主进程表（`/proc/<pid>/environ`
 *   里有别的进程的环境变量，而我们刚在自己这边把凭证剥干净）。
 * - **不 `--unshare-net`**：网络照常。断网的 agent 装不了依赖、拉不了代码，
 *   而按域名过滤要一整套代理。这是本次刻意留下的缺口，见文件头注释与文档。
 */
export function buildBwrapArgv(
  policy: SandboxPolicy,
  inner: readonly string[],
  opts: { exists?: (p: string) => boolean } = {},
): string[] {
  // 注入是为了让这个函数在任何平台上都可测。默认就是真的查磁盘。
  const exists = opts.exists ?? existsSync
  const args: string[] = [
    'bwrap',
    // 整机只读。后面的 --bind 会在此之上开出可写的口子。
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--die-with-parent',
  ]

  /*
   * /tmp 必须可写：编译器、包管理器、git 都往那儿写。
   * 用 tmpfs 而不是 bind：宿主 /tmp 里可能躺着别的进程写下的临时凭证文件。
   *
   * **它必须排在可写 bind 之前。** bwrap 按出现顺序叠加，反过来写的话
   * 一个位于 /tmp 下的工作区会被随后的 tmpfs 整个盖掉——而且**不报错**：
   * 命令照常执行，只是工作区在里面是空的。
   *
   * 这条是真跑 WSL2 撞出来的，`bun test` 里的纯函数断言看不见它：
   * 参数生成得完全正确，错的是两条正确参数之间的顺序。
   */
  args.push('--tmpfs', '/tmp')

  const writable = dedupe([policy.workspaceRoot, ...(policy.writableRoots ?? [])])
  for (const dir of writable) {
    args.push('--bind', dir, dir)
  }

  // 只读子目录**必须排在可写根之后**——bwrap 按出现顺序叠加，后到的覆盖先到的。
  // 反过来写的话 .qy/ 会被随后的 --bind 重新变成可写，而且不报错。
  for (const root of writable) {
    for (const sub of policy.readOnlySubdirs ?? []) {
      args.push('--ro-bind-try', join(root, sub), join(root, sub))
    }
  }

  // 凭证目录盖空。**必须先确认它存在**——`--tmpfs` 没有 `-try` 变体，
  // 而它会去 mkdir 挂载点，父目录只读时直接失败：
  //
  //     bwrap: Can't mkdir /root/.nope: Read-only file system
  //
  // 也就是说，一台没有 `~/.aws` 的机器上，盲目屏蔽它会让**每一条命令**
  // 都起不来。这是实测出来的，不是想出来的：屏蔽清单是按常见凭证目录
  // 列的，而任何一台机器都只会有其中几个。
  for (const p of policy.maskPaths ?? defaultMaskPaths()) {
    if (exists(p)) args.push('--tmpfs', p)
  }

  args.push('--unshare-pid', '--unshare-uts', '--unshare-ipc', '--proc', '/proc')
  // `--unshare-net` 把网络命名空间清空，里面只剩 lo。
  // 不加代理桥接就是**彻底断网**，这正是这个开关的语义。
  if (policy.denyNetwork) args.push('--unshare-net')
  args.push('--', ...inner)
  return args
}

/** 去掉尾部斜杠，但保留根目录的那一个。 */
function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

// ───────────────────────── 策略 → seatbelt profile ─────────────────────────

/**
 * 把策略翻成 macOS 的 SBPL（sandbox profile language）。**纯函数**，任何平台可测。
 *
 * 边界与 bwrap 那份**刻意保持一致**，因为它们服务同一份文档里的同一张表：
 * 整机可读、只有可写根目录能写、凭证目录连读都不行、网络不限。
 * 两边形状不同（一个是挂载，一个是规则），但**用户看到的承诺必须是同一句话**——
 * 否则 `docs/permissions.md` 就得按平台分叉，而分叉的文档没人维护得住。
 *
 * 一处必然的差别要写清楚：bwrap 是把凭证目录**盖成空的**（看得见但是空），
 * seatbelt 没有挂载这回事，只能**拒绝读**（存在但打不开）。
 * 防的东西一样，报错文案会不同。
 */
export function buildSeatbeltProfile(
  policy: SandboxPolicy,
  opts: { exists?: (p: string) => boolean } = {},
): string {
  const exists = opts.exists ?? existsSync
  const writable = dedupe([policy.workspaceRoot, ...(policy.writableRoots ?? [])])
  const lines: string[] = [
    '(version 1)',
    // 先全放行，再逐条收紧。反过来（deny default）要枚举出一个能跑起 node/git 的
    // 完整白名单，而那份名单一定会漏——漏的表现是「某个工具莫名其妙起不来」。
    '(allow default)',
    '',
    ';; 写：默认全禁，只开可写根目录',
    '(deny file-write*)',
  ]

  for (const dir of writable) {
    lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`)
  }

  // /tmp 与 /private/var/folders（macOS 的真实临时目录）必须可写：
  // 编译器、包管理器、git 都往那儿写。
  lines.push('(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))')
  lines.push('(allow file-write* (subpath "/private/var/folders"))')
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
  )

  // 只读子目录要排在可写根**之后**：SBPL 是最后匹配的规则赢，
  // 与 bwrap 的挂载顺序是同一个道理，反了同样不报错。
  if (policy.readOnlySubdirs?.length) {
    lines.push('', ';; 工作区内禁止写入的目录（.qy/ 等），必须排在上面的放行之后')
    for (const root of writable) {
      for (const sub of policy.readOnlySubdirs) {
        lines.push(`(deny file-write* (subpath ${sbplString(join(root, sub))}))`)
      }
    }
  }

  if (policy.denyNetwork) {
    lines.push('', ';; 断网：出站全禁，本机 socket 仍然放行（很多工具用它做 IPC）')
    lines.push('(deny network-outbound)')
    lines.push('(allow network-outbound (literal "/private/var/run/mDNSResponder"))')
    lines.push('(allow network-bind (local ip))')
  }

  const masked = (policy.maskPaths ?? defaultMaskPaths()).filter(exists)
  if (masked.length) {
    lines.push('', ';; 凭证目录：连读都不行')
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
 * **必须转义**，而且这是一条安全边界不是格式化：路径里的一个 `"` 能让后面的
 * 规则整个跑出字符串外，变成 profile 的一部分——那等于让路径名去改写沙箱策略。
 * macOS 的文件名允许引号和反斜杠，所以这不是理论问题。
 */
function sbplString(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    if (!raw || !isAbsolute(raw)) continue
    // 只做 posix 规范化（去掉重复斜杠与尾部斜杠），不做 resolve——
    // resolve 会把结果拼到**本机 cwd** 上，而这里的路径是给另一个内核用的。
    const p = trimSlash(normalize(raw))
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

// ───────────────────────── 唯一的 spawn 出口 ─────────────────────────

export interface GuardedSpawnInput {
  /** 要执行的命令原文。由调用方保证已经过裁决。 */
  command: string
  /** 已解析的绝对工作目录。 */
  cwd: string
  /** 已剥过凭证的环境变量。这个函数**不做脱敏**——那是调用方的事。 */
  env: Record<string, string>
  /**
   * 沙箱策略。`null` = 明确不套沙箱（插件的 `exec.run` 走另一套隔离）。
   *
   * 传 `null` 与「本机没有沙箱」是两件不同的事，所以返回的 `sandbox.reason`
   * 会分别说明——把它们混成一句「无沙箱」，排查时就分不出是配置问题还是环境问题。
   */
  policy: SandboxPolicy | null
}

export interface GuardedSpawn {
  /**
   * 两条输出流 + 退出码 + pid，够 `collectProcess` 和 `killTree` 用。
   *
   * **这里确实有两个实现**：本进程直接 spawn 的 `Bun.Subprocess`，以及由 runner
   * 代跑的那一份（`runner.ts`）。后者存在的理由是「谁是父进程」——命令必须挂在一个
   * 比监听端口先出生的进程底下，否则它派生的后台服务会把端口攥走。
   */
  proc: ProcessLike
  sandbox: SandboxStatus
}

/**
 * Git for Windows 自带的 bash。找不到返回 `null`。
 *
 * 这是 Windows 上**唯一**认的 bash——`locateBash` 的 win32 分支只调它。
 *
 * **不查 PATH。** 这台机器上 `where bash` 的第一条是
 * `C:\Windows\System32\bash.exe` —— 那是 **WSL 启动器**，它把命令送进另一个
 * 发行版的文件系统里跑（工作区在那边是 `/mnt/c/...`），cwd 和路径全对不上，
 * 而且失败形状是「命令跑了但找不到文件」，比没有 bash 难查得多。
 * 所以只认 Git 的安装目录，按确定的几个位置找。
 *
 * 从 `git.exe` 反推要往上走两级**和**三级：PATH 上可能是 `Git\cmd\git.exe`，
 * 也可能是 `Git\mingw64\bin\git.exe`（本机实测两条都在）。
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

/** bash 路径的环境变量覆盖。装在非常规位置（scoop、MSYS2、Cygwin）时唯一的出路。 */
export const BASH_PATH_ENV = 'QYWORK_BASH_PATH'

/**
 * 探测结果。形状照 `SandboxStatus`：**「没有」也是一种可上报的状态，不是崩溃。**
 *
 * 坑：不要在模块加载时抛。没有 bash 的机器上那会让整个 `qy serve` 起不来，
 * 用户在浏览器里只看到「连不上」。终端程序可以 `exit(1)` 打一行了事，带界面的
 * 服务端不行——它得能起来，然后如实说「这台机器没有 bash」。
 *
 * 这里只回答「有没有 bash」这一件事。没有的时候命令落到哪个 shell，
 * 由 `resolveCommandShell` 定。
 */
export interface BashResolution {
  /** 找到的 bash 可执行文件；`null` = 这台机器上没有可用的 bash。 */
  path: string | null
  /** `path` 为 `null` 时说明为什么、下一步怎么办；找到时是空串。 */
  reason: string
}

/** 命令交给哪个 shell。`null` = 一个可用的 shell 都没有，`run_command` 因此不会被注册。 */
export interface CommandShell {
  readonly path: string
  readonly argv: readonly string[]
  readonly hint: string
}

/**
 * 本机的 bash。找不到返回 `null` 加原因，**这一层不落回任何别的 shell**——
 * 落回哪个由 `resolveCommandShell` 定，那里才看得见全部三档。
 *
 * ## 为什么必须有环境变量这个口
 *
 * 落回的 PowerShell 方言和 bash 差得远，所以「bash 装在别处」必须有一个
 * **用户自己能指的地方**，否则 bash 装在 scoop / MSYS2 / Cygwin / 自定义盘符的
 * 机器上会被判成没有 bash，然后拿到一个它本来不需要的方言。
 *
 * **指了但不存在照样抛，不悄悄回到搜索**：回搜索会把「我指错了」变成
 * 「跑起来了，但跑的不是我指的那个」，而后者要靠对比输出才能发现。
 *
 * ## 顺序
 *
 * Windows 只认 Git for Windows（见 `findGitBash` 上方为什么不查 PATH）。
 * 其余平台按位置找，**Homebrew 的 bash 5 排在 `/bin/bash` 前面**：macOS 自带的
 * 是 bash 3.2（2007 年，卡在 GPLv2），没有 `declare -A`、`mapfile`、`${x,,}`，
 * 而模型写的是 bash 4+ 的方言。
 *
 * 不用 `/bin/sh`：那在 Debian 系是 dash，`[[ ]]`、数组、`<(...)` 全部散架。
 * 判据是模型的默认方言要和真正执行的 shell 对得上——同一条判据让 PowerShell
 * 只在**一个 bash 都找不到**时才轮得到，见 `resolveCommandShell`。
 *
 * 参数全部注入，是为了能直接测顺序和逃生口，不必重载模块。
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
      reason: `${BASH_PATH_ENV} 指向 ${pinned}，但那个位置没有文件。改对，或者不设它、让它自己找。`,
    }
  }

  if (deps.platform === 'win32') {
    const bash = deps.gitBash()
    if (bash !== null) return { path: bash, reason: '' }
    return {
      path: null,
      reason:
        '没找到 Git for Windows 自带的 bash（找过 git.exe 的同级目录、' +
        `Program Files\\Git\\bin、LOCALAPPDATA\\Programs\\Git\\bin）。装 Git for Windows，或用 ${BASH_PATH_ENV} 指向已有的 bash.exe。`,
    }
  }

  const candidates = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash', '/usr/bin/bash']
  const found = candidates.find(deps.exists)
  if (found !== undefined) return { path: found, reason: '' }
  return {
    path: null,
    reason: `这几个位置都没有 bash：${candidates.join('、')}。装 bash，或用 ${BASH_PATH_ENV} 指向它。`,
  }
}

/**
 * 探测结果。**每次调用重新探测，不缓存。**
 *
 * 判据抄 `detectSandbox()` 上方那段：缓存的话「装完 git 之后重连一下就生效」不成立，
 * 用户得重启整个服务，而他不会知道要重启。探测本身是几次 `existsSync`
 * （`whichSync` 是纯 PATH 扫描，不起进程），每次跑得起。
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
 * 三档探测的注入口。
 *
 * 参数全部注入，理由同 `resolveBashPath`：**本机只可能命中其中一档**
 * （装了 Git Bash 的机器第一步就返回），顺序与另外两档的落点只能这么测。
 */
export interface ShellProbeDeps {
  bash: () => BashResolution
  /** PATH 上找一个可执行文件。 */
  which: (name: string) => string | null
  exists: (p: string) => boolean
  env: Record<string, string | undefined>
}

/** PowerShell 7 的默认安装位置。装在别处时靠 PATH 上的 `pwsh.exe` 找到。 */
function pwsh7Install(env: Record<string, string | undefined>): string {
  return joinNative(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
}

/**
 * Windows PowerShell 5.1 的固定位置。**系统盘不一定是 C:**，所以跟着 `SystemRoot` 走；
 * 它是系统组件，不查 PATH——PATH 上叫 `powershell` 的可能是别人放的同名东西。
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
 * 命令交给哪个 shell，以及**模型必须知道的那条语法差异**。
 *
 * ## 顺序：bash → pwsh 7 → Windows PowerShell 5.1 → 一个都没有
 *
 * **bash 永远排第一。** 模型的默认方言是 POSIX——「跑一条命令」这个语境在训练
 * 数据里绝大多数是 bash，账本里有过只被告知「平台：win32」就写出 POSIX 写法、
 * 在 PowerShell 上一个字都没执行的调用（`node --version & python --version`）。
 * 有 bash 的机器上行为与只有 bash 那时完全一致。
 *
 * **pwsh 7 排在 5.1 前面是硬差别，不是偏好。** 5.1 上 `&&` / `||` 是解析错误
 * （实测 `标记「&&」不是此版本中的有效语句分隔符`），三元 `? :`、`??`、`?.`、
 * `ConvertFrom-Json -AsHashtable` 一个都没有——同一条命令在 7 上跑得通、在 5.1 上
 * 整条废掉。两个都在就必须挑 7。
 *
 * `-NoProfile` 两档都要：用户 profile 会改变行为（别名、函数、`$ErrorActionPreference`），
 * 而它在别人机器上长什么样我们不知道。
 *
 * ## 方言分叉的代价，付在三个地方
 *
 * `policy.ts` 的拒绝规则要同时认两种语法、涉及命令的测试要按 shell 分叉、
 * 模型拿到的提示也分叉。前两条是死账，只能付。第三条靠**方言提示前置**缓解：
 * `hint` 是 `run_command` 描述的第一句，且非 bash 时第一句就说「不是 bash」。
 * 缓解不是消除——`run_command` 这个名字本身不携带方言，而名字的信号比描述强。
 *
 * 换来的是：没装 Git Bash 的 Windows 机器上，agent 从「一条命令都跑不了」变成能跑。
 *
 * `hint` 会原样进 `run_command` 的工具说明，与 `spawnGuarded` 用的是同一份 argv：
 * 两处各写一遍必然漂移，而漂移的表现是**告诉模型的那个 shell 和真正执行的不是
 * 同一个**，比不告诉更糟。
 *
 * 三档全落空返回 `null`，`run_command` **不会被注册**（`tools/index.ts`）——
 * 模型手里根本没有这个工具，而不是有一个必然失败的工具。
 */
export function resolveCommandShell(deps: ShellProbeDeps): CommandShell | null {
  const bash = deps.bash().path
  if (bash !== null) {
    return {
      path: bash,
      argv: [bash, '-c'],
      hint:
        '命令由 `bash -c` 执行（POSIX 语法；Windows 上是 Git for Windows 自带的 bash，' +
        '不是 cmd/PowerShell，也不是 WSL）：`&&`、`||`、管道、`2>/dev/null` 都可用；路径用 `/` 分隔。',
    }
  }

  // pwsh 7 装在哪都行，所以 PATH 优先；默认安装位置兜住「装了但没进 PATH」。
  const installed = pwsh7Install(deps.env)
  const pwsh7 = deps.which('pwsh.exe') ?? (deps.exists(installed) ? installed : null)
  if (pwsh7 !== null) {
    return {
      path: pwsh7,
      argv: [pwsh7, '-NoProfile', '-NonInteractive', '-Command'],
      hint:
        '**这台机器没有 bash：命令由 PowerShell 7（`pwsh -NoProfile -NonInteractive -Command`）' +
        '执行，不是 bash。** 按 PowerShell 写：`&&`、`||`、管道可用，但管道里流的是对象不是文本；' +
        '`2>/dev/null` 写成 `2>$null`；环境变量是 `$env:NAME`；`ls`/`cat`/`rm` 是 cmdlet 的别名，' +
        '参数写法与 POSIX 不同（`ls -Recurse`、`rm -Recurse -Force`）。',
    }
  }

  const ps51 = windowsPowerShellInstall(deps.env)
  if (deps.exists(ps51)) {
    return {
      path: ps51,
      argv: [ps51, '-NoProfile', '-NonInteractive', '-Command'],
      hint:
        '**这台机器没有 bash 也没有 PowerShell 7：命令由 Windows PowerShell 5.1' +
        '（`powershell -NoProfile -NonInteractive -Command`）执行，不是 bash。** ' +
        '5.1 上这几样不存在，照 PowerShell 7 的写法写会整条命令废掉：' +
        '`&&` / `||`（解析错误——顺序执行用 `;`，「上一条成功才继续」用 `if ($?) { … }`）、' +
        '三元 `? :`、null 合并 `??`、null 条件 `?.`、`ConvertFrom-Json -AsHashtable`。' +
        '其余按 PowerShell 写：`2>$null`、`$env:NAME`、`ls -Recurse`。',
    }
  }

  return null
}

/**
 * 本机的 shell。**每次调用重新探测**，理由同 `probeBash`：装完之后
 * 下一条消息就该有 `run_command`，而不是要用户重启服务。
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
 * **本项目唯一一处为模型给出的命令起子进程的地方。**
 *
 * 新增调用方之前先想清楚：绕开这里就等于绕开沙箱，而且不会有任何报错。
 */
/**
 * 命令挂在谁底下。
 *
 * **进程级的事实，所以是进程级的变量**：一个进程要么绑了监听端口（那就必须借
 * runner），要么没绑（直接 spawn 就对）。它不随调用方、会话、工作区变化，
 * 穿成参数一路传下去只是把同一个事实抄很多遍。
 *
 * `qy serve` 在**绑端口之前**注册；`qy exec`、测试进程不注册，走直接 spawn。
 */
let runner: CommandRunner | null = null

export function setCommandRunner(next: CommandRunner | null): void {
  runner = next
}

export async function spawnGuarded(input: GuardedSpawnInput): Promise<GuardedSpawn> {
  const status = detectSandbox()
  const isWindows = process.platform === 'win32'

  // `run_command` 在一个 shell 都没有时压根不注册，所以正常路径到不了这里；
  // 插件的 `exec.run` 走的是同一个函数，它需要一个说得清的错而不是崩在 argv 上。
  const shell = commandShell()
  if (shell === null) {
    // 说 bash 那一档的原因：三档里只有它给得出「下一步怎么办」（装 Git for Windows），
    // 而另外两档是「这台机器上就是没有」，没有可操作的下一步。
    throw new Error(
      `没有可用的 shell（bash / pwsh / powershell 都没找到），命令跑不了：${probeBash().reason}`,
    )
  }

  // 命令原样交给 shell，不做「安全化」处理——立场承自 shell.ts：
  // 转义黑名单挡不住构造，真正的边界在内核那一层。
  const inner = [...shell.argv, input.command]

  const policy = input.policy

  const argv =
    policy === null || status.backend === 'none'
      ? inner
      : status.backend === 'bwrap'
        ? buildBwrapArgv(policy, inner)
        : buildSeatbeltArgv(policy, inner)

  const effective: SandboxStatus =
    input.policy === null
      ? { ...status, active: false, reason: '本次调用显式不套沙箱（插件 exec 走独立隔离）' }
      : status

  // 有 runner 就由它来当父进程（理由见 `runner.ts` 的模块注释）。
  if (runner) {
    return {
      proc: await runner.spawn({ argv, cwd: input.cwd, env: input.env, detached: !isWindows }),
      sandbox: effective,
    }
  }

  /*
   * 三个流的形态写在类型里，不靠推断：带 spread 的字面量会把它推成
   * `'inherit'`，于是 `proc.stderr` 变成可能 undefined，而真正读它的地方在别的文件。
   */
  const opts = {
    cwd: input.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // 关掉 stdin：交互式提示在这里等不到人，只会挂到超时。
    stdin: 'ignore',
    env: input.env,
      /*
       * 非 Windows 上自成进程组，`killTree` 才有整组可杀。
       *
       * 不这么做的话它和 `qy serve` 同组，而 `process.kill(-pid)` 打的是**组**
       * ——那一下会连自己一起杀掉。`killTree` 因此还要再验一次组长身份，
       * 见那边的注释：这里只是把「能安全整组杀」这个前提创造出来。
       *
       * Windows 不加：那边靠 `taskkill /T` 走进程树，不需要组语义，
       * 而 detached 在 Windows 上是「脱离控制台」，与这里的目的无关。
       */
    ...(isWindows ? {} : { detached: true }),
  } as Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>

  return { proc: Bun.spawn(argv, opts), sandbox: effective }
}

/**
 * 杀掉整棵进程树。
 *
 * ## 为什么不能只 `proc.kill()`
 *
 * 我们 spawn 的从来不是命令本身，是一个 shell（`commandShell()` 的 argv + 命令串）。
 * 真正干活的进程是它的**子进程**，而 `proc.kill()` 只杀那一个 shell。
 *
 * 本机实测（Windows 11 / Bun 1.3.14，完全复刻上面的 spawn 参数）：
 *
 * ```
 * kill 前:  HTTP 200
 * proc.kill(); await proc.exited   → 143
 * kill 后:  HTTP 200               ← powershell 死了，服务进程还在监听
 * pump:     3 秒没等到 EOF          ← 孙进程握着 stdout，管道永不关闭
 * ```
 *
 * **第二行比第一行严重得多。** 孙进程握着 stdout，于是谁要是拿管道 EOF 当
 * 「命令结束了」的判据，那次 `registry.execute` 就永不返回，而
 * `loop.ts:546` 外面没有任何超时。后果一路传导到 `run-control.ts` 的 finally
 * 不执行、`runs.unregister` 不执行——**这条会话从此永远回绝「已有任务在执行」，
 * 直到重启 `qy serve`**。触发它不需要「起服务器」这种边角：任何经 shell 派生了
 * 子进程的命令（`npm test` → node、`python x.py`）碰上超时或用户中断都会走到。
 *
 * 换成树杀之后同一个脚本：
 *
 * ```
 * taskkill /F /T /PID → 0
 * kill 后:  连不上
 * pump:     EOF
 * ```
 *
 * 两个症状在**孙进程还留在树里**时一次消失。树杀够不着已经脱离父子关系的孤儿
 * ——实测：shell 正常退出之后再补一次 `taskkill /F /T`，回的是
 * `ERROR: The process not found`，而管道照旧不 EOF。所以「命令结束了没有」
 * 不能靠管道 EOF 判，那条判据归 `shell.ts` 的 `settle()`：进程退出才是权威。
 *
 * ## 平台
 *
 * - **Windows**：`taskkill /F /T`，`/T` 连子孙一起。上面那段是本机实测。
 * - **其余平台**：杀进程组。**但必须先确认它真是自己那一组的组长**——
 *   `detached` 万一没生效，`-pid` 指向的就是 `qy serve` 自己所在的组，
 *   而那一下不会报错，它会安静地把服务端杀掉。验不过就回落到单进程 kill，
 *   那是本次改动之前的行为，不会更糟。
 *   **这条路径没有在本机验证过**（本机是 Windows），如实写在这里。
 */
export function killTree(proc: { pid: number; kill(): void }): void {
  if (process.platform === 'win32') {
    // 同步等它杀完：异步的话调用方紧接着读流，可能读到一个还没断的管道。
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return
  }
  // `getpgid` 运行时有、`@types/bun` 里没声明；断言到最小形状而不是 any，
  // 这样「它可能不存在」这件事仍然写在类型里。
  const getpgid = (process as unknown as { getpgid?: (pid: number) => number }).getpgid
  let leadsOwnGroup = false
  try {
    leadsOwnGroup = getpgid?.(proc.pid) === proc.pid
  } catch {
    // 进程已经没了，或者平台不提供 getpgid：都按「不确定」处理。
    leadsOwnGroup = false
  }
  if (leadsOwnGroup) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
      return
    } catch {
      // 组已经空了，落到下面补一刀单进程的。
    }
  }
  proc.kill()
}

/**
 * 进程退出之后，把管道里的残余字节取干净所留的时间。
 *
 * 这**不是**超时兜底：正常命令上它的代价是 0——EOF 紧跟退出到达，下面那个 race
 * 立刻就赢了。只有当有后代进程扣着写端时才付这一次固定小额。
 *
 * 这个数从哪来：写端在管道写满时阻塞，所以进程退出前它的输出已经被读走了
 * （本机实测 `seq 1 200000` 加一个后台孙进程，退出时 1288895 字节一个不少，
 * 最后一个 chunk 比退出还早 9ms）；退出后残留的至多是一个内核缓冲区
 * （Windows 默认 64KB），读它是本地内存拷贝。留 200ms 是给调度抖动的余量，
 * 不是给命令的。
 */
const DRAIN_AFTER_EXIT_MS = 200

export interface CollectedProcess {
  exitCode: number
  stdout: string
  stderr: string
  /** 超时到点，进程树已被杀。 */
  timedOut: boolean
  /**
   * 进程已经退出，但仍有后代扣着输出管道，读取是我们主动收手的。
   *
   * 调用方该据此告诉上游「后台还留着东西在跑，它之后的输出不在这份结果里」——
   * 起后台服务的脚本就是这个形状，而那件事在结果里没有别的痕迹。
   */
  backgroundHeld: boolean
}

export interface CollectOptions {
  /** 到点树杀。不给就不设超时——只有形状上不可能长跑的命令才该这么用。 */
  timeoutMs?: number
  /** 中断信号。abort 即树杀，这样用户点停止时子进程真的会停。 */
  signal?: AbortSignal
  /** 每片解码后的文本先过它，**返回值**才计入结果。脱敏与流式回传都在这里做。 */
  onText?: (channel: 'stdout' | 'stderr', text: string) => string
  /** 流收尾时补一段（典型是脱敏器的跨片缓冲）。返回值不再过 `onText`。 */
  onEnd?: (channel: 'stdout' | 'stderr') => string
  /**
   * 每条流的字符上限。**上限是读取行为的上限，不是返回值的上限**——
   * 读完再截的话，一条 `yes` 能在截断生效之前把内存吃光。
   * 触到上限的判断留给调用方（长度到界即是），这里只负责不再往下读。
   */
  maxChars?: number
}

/**
 * 等一个子进程跑完，并把它写出的字节收回来。
 *
 * **这是「等子进程」的唯一出口**，与 `spawnGuarded` 是「起子进程」的唯一出口同一条
 * 理由：散在各处的等待意味着完成判据要各写一遍，而写错的那一处不会报错，
 * 只会安静地永远挂着。
 *
 * ## 完成判据是进程退出，不是管道 EOF
 *
 * EOF 的含义是「所有继承了写端的进程都关掉了它」——那是一群**不属于这次调用**的
 * 进程共同决定的事。任何经 shell 派生、又脱离父子关系活下去的进程都能永久扣住它，
 * 而起后台服务的脚本正是这个形状，且那是脚本**正确**的行为：服务本来就该留下。
 *
 * 本机实测（Windows / Git Bash，`bash -c 'echo hello; sleep 20 &'`）：
 *
 * ```
 * [19ms]   stdout: "hello\n"
 * [26ms]   proc.exited -> 0
 * [2178ms] taskkill /F /T /PID → ERROR: The process not found   ← 树已散，够不着孤儿
 * [6014ms] EOF 仍未到达
 * ```
 *
 * 拿 EOF 当判据的代价不止这一次调用：调用方不返回 → `run-control` 的 finally
 * 不执行 → `runs.unregister` 不执行 → **整条会话此后回绝所有新任务，
 * 而且用户点停止也停不下来**（停止只是 abort，停不掉一个不返回的 await），
 * 直到重启服务。
 *
 * ## 退出之后为什么还要再等一小会儿
 *
 * 反过来「退出即收手」会静默吞字节：内核缓冲里可能还压着最后一截。
 * 所以退出后给 `DRAIN_AFTER_EXIT_MS` 把它捞干净，到点仍无 EOF 就认定有后代扣着
 * 写端，取消读端并如实报 `backgroundHeld`。
 */
export async function collectProcess(
  proc: ProcessLike,
  opts: CollectOptions = {},
): Promise<CollectedProcess> {
  const text: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  let timedOut = false
  let backgroundHeld = false
  // 类型从 `getReader()` 本身推：直接写 `ReadableStreamDefaultReader` 会取到
  // Bun 的那个全局声明（多一个 `readMany`），与 `node:stream/web` 的那个对不上。
  const readers: ReturnType<ReadableStream<Uint8Array>['getReader']>[] = []

  // 用显式 reader 而不是 `for await`：后者把流锁在循环里，收尾时外面调
  // `stream.cancel()` 直接抛 `locked`；而不 cancel、只是丢开这个 promise 的话，
  // 孤儿进程往管道里写多少，这里就涨多少——那是内存泄漏。
  const pump = async (stream: ReadableStream<Uint8Array>, channel: 'stdout' | 'stderr') => {
    const reader = stream.getReader()
    readers.push(reader)
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const decoded = decoder.decode(value, { stream: true })
        text[channel] += opts.onText ? opts.onText(channel, decoded) : decoded
        if (opts.maxChars !== undefined && text[channel].length >= opts.maxChars) {
          // **必须 cancel，不能只 break。** 读端还开着的话写端写满就阻塞，
          // 进程永远退不出——那等于把输出上限变成一个新的挂死点。
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      const tail = opts.onEnd?.(channel)
      if (tail) text[channel] += tail
    }
  }

  const pumping = Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')])

  // 超时与中断都走**树杀**：我们起的是一个 shell 或一个会派生子进程的程序，
  // 只杀它自己的话，干活的那个还活着（详见 `killTree`）。
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
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
