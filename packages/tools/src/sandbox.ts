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
/**
 * 自检用的最小策略：一个一定存在的可写根，没有屏蔽项。
 *
 * 刻意不用真实策略——自检要回答的是「这台机器允不允许建命名空间」，
 * 与具体放开哪些目录无关，而掺进真实路径只会让探针在某个目录恰好不存在时
 * 假红一次。
 */
const PROBE_POLICY: SandboxPolicy = { workspaceRoot: '/tmp', maskPaths: [] }

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
        '（`sandbox-exec` 被 Apple 标记为 deprecated，但 Chrome / Codex CLI 等仍在用它，' +
        '目前没有可替代的用户态接口。）',
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
   * 三个流的形态写死在类型里（`stdin: 'ignore'`、两条输出 `'pipe'`）。
   * 不写死的话 `proc.stdout` 的类型是 `number | ReadableStream | undefined`，
   * 每个调用方都得自己断言一次——而断言的地方就是将来改错了也不报错的地方。
   *
   * 这里一度抽象成过一个四成员的 `GuardedProcess` 接口，为的是让 Windows 的
   * AppContainer 那条路（走 `CreateProcessW`，拿不到 `Bun.Subprocess`）也能塞进来。
   * 那条路已经撤掉（ROADMAP §42），于是这个接口只剩一个实现——
   * **只有一个实现的接口是另一种过度设计**，退回具体类型。
   */
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  sandbox: SandboxStatus
}

/**
 * Git for Windows 自带的 bash。找不到返回 `null`。
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

/**
 * 命令交给哪个 shell，以及**模型必须知道的那条语法差异**。
 *
 * ## Windows 上优先 bash，不是 PowerShell
 *
 * 原来无条件走 `powershell.exe -Command`，而模型只被告知「平台：win32」时
 * 写的是 cmd 或 POSIX 的写法。`&&` 在 Windows PowerShell 5.1 里是**解析错误**
 * （实测 `标记「&&」不是此版本中的有效语句分隔符`）——整条命令一个字都不执行，
 * 账本里已经有这么废掉的调用（`node --version & python --version`）。
 * 那不是模型不会写 PowerShell，是**它的默认方言和这里跑的 shell 对不上**，
 * 而两边只有一边能改：换 shell 一处，纠正模型每一条命令是无穷次。
 *
 * 装了 Git 就有 bash（编码 agent 的机器上几乎恒真），没装才落回 PowerShell。
 * **落回时提示跟着换**——两种 shell 用同一句提示等于告诉模型一个假的方言。
 *
 * `hint` 会原样进 `run_command` 的工具说明，与下面 `spawnGuarded` 用的是同一份
 * argv：两处各写一遍必然漂移，而漂移的表现是**告诉模型的那个 shell 和真正执行
 * 的不是同一个**，比不告诉更糟。
 *
 * 探测在模块加载时做一次：结果在一个进程的生命周期内不会变。
 */
export const COMMAND_SHELL: { readonly argv: readonly string[]; readonly hint: string } = (() => {
  if (process.platform !== 'win32') {
    return { argv: ['/bin/sh', '-c'], hint: '命令由 `/bin/sh -c` 执行。' }
  }
  const bash = findGitBash()
  return bash
    ? {
        argv: [bash, '-c'],
        hint:
          '命令由 Git for Windows 的 `bash -c` 执行（POSIX 语法，不是 cmd/PowerShell，也不是 WSL）：' +
          '`&&`、`||`、管道、`2>/dev/null` 都可用；路径用 `/` 分隔。',
      }
    : {
        argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command'],
        hint:
          '这台机器没装 Git Bash，命令由 Windows PowerShell 执行：' +
          '`&&`、`||`、`&` 都是语法错误，多条命令用 `;` 连；' +
          '丢弃输出写 `2>$null`（不是 `2>nul`），环境变量写 `$env:NAME`。',
      }
})()

/**
 * **本项目唯一一处为模型给出的命令起子进程的地方。**
 *
 * 新增调用方之前先想清楚：绕开这里就等于绕开沙箱，而且不会有任何报错。
 */
export function spawnGuarded(input: GuardedSpawnInput): GuardedSpawn {
  const status = detectSandbox()
  const isWindows = process.platform === 'win32'

  // 命令原样交给 shell，不做「安全化」处理——立场承自 shell.ts：
  // 转义黑名单挡不住构造，真正的边界在内核那一层。
  const inner = [...COMMAND_SHELL.argv, input.command]

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

  return {
    proc: Bun.spawn(argv, {
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
    } as never),
    sandbox: effective,
  }
}

/**
 * 杀掉整棵进程树。
 *
 * ## 为什么不能只 `proc.kill()`
 *
 * 我们 spawn 的从来不是命令本身，是一个 shell（`COMMAND_SHELL.argv` + 命令串）。
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
 * **第二行比第一行严重得多。** `shell.ts` 是先 `await` 读完两条流、再等
 * `proc.exited`；管道不 EOF，那次 `registry.execute` 就永不返回，而
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
 * 两个症状一次消失——它们本来就是同一个根因。
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
