import { describe, expect, test } from 'bun:test'
import {
  BASH_PATH_ENV,
  buildBwrapArgv,
  buildSeatbeltArgv,
  buildSeatbeltProfile,
  collectProcess,
  commandShell,
  defaultMaskPaths,
  detectSandbox,
  killTree,
  makeOutputDecoder,
  resolveBashPath,
  resolveCommandShell,
  spawnGuarded,
} from './sandbox.ts'

/** 从 argv 中提取 `flag src dst` 三元组，便于按语义而不是按下标断言。 */
function binds(argv: readonly string[], flag: string): { src: string; dst: string }[] {
  const out: { src: string; dst: string }[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined && argv[i + 2] !== undefined) {
      out.push({ src: argv[i + 1] as string, dst: argv[i + 2] as string })
    }
  }
  return out
}

function tmpfsTargets(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tmpfs' && argv[i + 1] !== undefined) out.push(argv[i + 1] as string)
  }
  return out
}

const inner = ['/bin/sh', '-c', 'echo hi']
const never = () => false
const always = () => true

describe('bash 路径解析', () => {
  const has =
    (...ok: string[]) =>
    (p: string) =>
      ok.includes(p)
  const noGitBash = () => null

  test('环境变量优先于所有平台默认位置', () => {
    const got = resolveBashPath({
      env: { [BASH_PATH_ENV]: 'D:/msys64/usr/bin/bash.exe' },
      platform: 'win32',
      exists: has('D:/msys64/usr/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'),
      gitBash: () => 'C:/Program Files/Git/bin/bash.exe',
    })
    expect(got.path).toBe('D:/msys64/usr/bin/bash.exe')
  })

  test('环境变量指向不存在的位置时视为未找到，不回退到自动查找', () => {
    // 回退后命令可以执行，但执行的并非指定的 bash，只能通过对比输出发现。
    const got = resolveBashPath({
      env: { [BASH_PATH_ENV]: 'D:/nope/bash.exe' },
      platform: 'win32',
      exists: has('C:/Program Files/Git/bin/bash.exe'),
      gitBash: () => 'C:/Program Files/Git/bin/bash.exe',
    })
    expect(got.path).toBeNull()
    // 原因必须指明哪个变量指向错误，否则用户只看到「没有 bash」，而机器上实际装有 bash。
    expect(got.reason).toContain(BASH_PATH_ENV)
    expect(got.reason).toContain('D:/nope/bash.exe')
  })

  test('macOS 上 Homebrew 的 bash 排在自带的 /bin/bash 前面', () => {
    // 系统自带的是 bash 3.2，不支持 declare -A / mapfile / ${x,,}。
    const got = resolveBashPath({
      env: {},
      platform: 'darwin',
      exists: has('/opt/homebrew/bin/bash', '/bin/bash'),
      gitBash: noGitBash,
    })
    expect(got.path).toBe('/opt/homebrew/bin/bash')
  })

  test('只有 /bin/bash 时使用它', () => {
    expect(
      resolveBashPath({
        env: {},
        platform: 'linux',
        exists: has('/bin/bash'),
        gitBash: noGitBash,
      }).path,
    ).toBe('/bin/bash')
  })

  test('未找到 bash 时返回 null 与原因，这一层不回退到 sh 或 PowerShell', () => {
    // 锁定两点：这一层只回答是否有 bash（回退到哪个 shell 由 resolveCommandShell 决定），
    // 以及「没有」是可上报的状态而不是崩溃：服务必须能启动，才能把这一状态告知用户。
    const win = resolveBashPath({ env: {}, platform: 'win32', exists: never, gitBash: noGitBash })
    expect(win.path).toBeNull()
    expect(win.reason).toContain('Git for Windows')
    const linux = resolveBashPath({ env: {}, platform: 'linux', exists: never, gitBash: noGitBash })
    expect(linux.path).toBeNull()
    expect(linux.reason).toContain('/bin/bash')
  })
})

/**
 * 三级 shell 探测。
 *
 * **本机只可能命中其中一级**（开发机装有 Git Bash，第一步即返回），
 * 因此顺序、每一级的 argv 与语法提示全部依靠注入测试：真机上无法执行到的两级
 * 出现遗漏时不会有任何测试失败。
 */
describe('命令 shell 三级探测', () => {
  const foundBash = (p: string) => () => ({ path: p, reason: '' })
  const noBash = () => ({ path: null, reason: '这台机器没装 Git for Windows' })
  const noWhich = () => null
  const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' }
  /** 5.1 是系统组件，按固定位置查找；pwsh 7 的候选路径以 `pwsh.exe` 结尾，不会被误判为 5.1。 */
  const has51 = (p: string) => p.toLowerCase().endsWith('powershell.exe')
  const hasPwsh7 = (p: string) => p.toLowerCase().endsWith('pwsh.exe')

  test('有 bash 时使用 bash，不检查另外两级', () => {
    const shell = resolveCommandShell({
      bash: foundBash('C:/Program Files/Git/bin/bash.exe'),
      // 三者都已安装时同样如此：POSIX 是模型的默认语法，改用其他 shell 后每一条命令都需要纠正。
      which: () => 'C:/Program Files/PowerShell/7/pwsh.exe',
      exists: () => true,
      env,
    })
    expect(shell?.path).toBe('C:/Program Files/Git/bin/bash.exe')
    expect(shell?.argv).toEqual(['C:/Program Files/Git/bin/bash.exe', '-c'])
    expect(shell?.hint).toContain('bash -c')
  })

  test('没有 bash 时回退到 PATH 上的 pwsh 7', () => {
    const shell = resolveCommandShell({
      bash: noBash,
      which: (n) => (n === 'pwsh.exe' ? 'D:/tools/pwsh.exe' : null),
      exists: never,
      env,
    })
    expect(shell?.path).toBe('D:/tools/pwsh.exe')
  })

  test('pwsh 7 不在 PATH 中时也识别默认安装位置', () => {
    const shell = resolveCommandShell({ bash: noBash, which: noWhich, exists: hasPwsh7, env })
    expect(shell?.path.toLowerCase()).toContain('pwsh.exe')
    expect(shell?.path).toContain('PowerShell')
  })

  /**
   * **7 优先于 5.1 源于功能差异，不是偏好。** 5.1 上 `&&` / `||` 是解析错误，
   * 三元运算、`??`、`?.`、`ConvertFrom-Json -AsHashtable` 均不支持：
   * 两者都已安装却选择 5.1 时，模型写的每一条组合命令都会失败。
   */
  test('两者都存在时选择 7', () => {
    const shell = resolveCommandShell({ bash: noBash, which: noWhich, exists: () => true, env })
    expect(shell?.path.toLowerCase()).toContain('pwsh.exe')
  })

  test('只有 5.1 时使用它，位置由 SystemRoot 确定', () => {
    // 系统盘不一定是 C:，写死 C:\Windows 时会在这类机器上误判为没有任何 shell。
    const shell = resolveCommandShell({
      bash: noBash,
      which: noWhich,
      exists: has51,
      env: { SystemRoot: 'D:\\Windows' },
    })
    expect(shell?.path).toContain('D:')
    expect(shell?.path.toLowerCase()).toContain('powershell.exe')
  })

  test('三级均未找到时返回 null，run_command 因此不注册', () => {
    expect(resolveCommandShell({ bash: noBash, which: noWhich, exists: never, env })).toBeNull()
  })

  /** 用户 profile 会修改别名、函数与 `$ErrorActionPreference`，而它在其他机器上的内容无法预知。 */
  test('两级 PowerShell 的 argv 都包含 -NoProfile 与 -NonInteractive', () => {
    const seven = resolveCommandShell({ bash: noBash, which: noWhich, exists: hasPwsh7, env })
    const five = resolveCommandShell({ bash: noBash, which: noWhich, exists: has51, env })
    for (const shell of [seven, five]) {
      expect(shell?.argv).toContain('-NoProfile')
      expect(shell?.argv).toContain('-NonInteractive')
      expect(shell?.argv.at(-1)).toBe('-Command')
      expect(shell?.argv[0]).toBe(shell?.path)
    }
  })

  /**
   * **非 bash 时第一句必须说明「不是 bash」。**
   *
   * `run_command` 的名称不携带语法信息，模型默认输出 bash 语法，因此语法信息只有
   * 工具描述这一个来源，而描述从开头读起。
   */
  test('非 bash 的语法提示在开头即说明不是 bash', () => {
    for (const exists of [hasPwsh7, has51]) {
      const hint = resolveCommandShell({ bash: noBash, which: noWhich, exists, env })?.hint ?? ''
      expect(hint.slice(0, 40)).toContain('没有 bash')
      expect(hint).toContain('不是 bash')
    }
  })

  /**
   * 5.1 的限制必须**逐条**列出。
   *
   * 不列出时，模型会按 PowerShell 7 的语法编写，
   * 每条组合命令都在解析阶段整体失败。
   */
  test('5.1 的语法提示逐条列出 7 支持而 5.1 不支持的写法', () => {
    const hint = resolveCommandShell({ bash: noBash, which: noWhich, exists: has51, env })?.hint
    expect(hint).toContain('5.1')
    for (const missing of ['&&', '||', '? :', '??', '?.', 'ConvertFrom-Json -AsHashtable']) {
      expect(hint).toContain(missing)
    }
    // 只说「不能用」不够，须给出替代写法，否则模型只能推测。
    expect(hint).toContain('if ($?)')
  })
})

describe('bwrap 参数生成', () => {
  test('整机默认只读，工作区单独开放写入', () => {
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    // `--ro-bind / /` 是写边界的基础：先把整机挂载为只读，再逐个开放可写目录。
    expect(binds(argv, '--ro-bind')).toContainEqual({ src: '/', dst: '/' })
    expect(binds(argv, '--bind')).toContainEqual({ src: '/ws', dst: '/ws' })
  })

  test('额外根目录逐个 bind', () => {
    const argv = buildBwrapArgv(
      { workspaceRoot: '/ws', writableRoots: ['/data/notes', '/data/out'] },
      inner,
      { exists: never },
    )
    const b = binds(argv, '--bind')
    expect(b).toContainEqual({ src: '/data/notes', dst: '/data/notes' })
    expect(b).toContainEqual({ src: '/data/out', dst: '/data/out' })
  })

  test('相对路径的额外根目录被丢弃，不会拼接成意外的绝对路径', () => {
    // 相对路径的基准是进程 cwd。若保留，同一份配置在不同目录启动
    // 会 bind 到不同位置，后果比拒绝严重得多。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', writableRoots: ['notes'] }, inner, {
      exists: never,
    })
    expect(argv.join(' ')).not.toContain('notes')
  })

  test('重复的根目录只出现一次（bwrap 遇到重复 bind 会报错）', () => {
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', writableRoots: ['/ws', '/ws/'] }, inner, {
      exists: never,
    })
    expect(binds(argv, '--bind').filter((x) => x.dst === '/ws')).toHaveLength(1)
  })

  test('.qy 的只读覆盖必须排在可写 bind 之后', () => {
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', readOnlySubdirs: ['.qy'] }, inner, {
      exists: never,
    })
    const bindAt = argv.findIndex((a, i) => a === '--bind' && argv[i + 1] === '/ws')
    const roAt = argv.findIndex((a, i) => a === '--ro-bind-try' && argv[i + 1]?.includes('.qy'))
    expect(bindAt).toBeGreaterThanOrEqual(0)
    expect(roAt).toBeGreaterThan(bindAt)
  })

  test('额外根目录中的 .qy 同样挂载为只读', () => {
    // 否则把某个目录加入 additionalDirectories 就等于允许模型在该处为自身添加工具，
    // 而用户配置该项只是为了让模型访问该目录。
    const argv = buildBwrapArgv(
      { workspaceRoot: '/ws', writableRoots: ['/data'], readOnlySubdirs: ['.qy'] },
      inner,
      { exists: never },
    )
    const ro = binds(argv, '--ro-bind-try').map((x) => x.dst)
    expect(ro.some((p) => p.includes('/data') && p.includes('.qy'))).toBe(true)
  })

  test('凭证目录不存在时不能生成 --tmpfs', () => {
    // 实测：该目录不存在且父目录只读时，`--tmpfs /root/.aws` 会使 bwrap 直接退出
    // （Can't mkdir …: Read-only file system）。在没有 ~/.aws 的机器上
    // 无条件屏蔽它会使每一条命令都无法启动。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', maskPaths: ['/home/u/.aws'] }, inner, {
      exists: never,
    })
    expect(tmpfsTargets(argv)).not.toContain('/home/u/.aws')
  })

  test('凭证目录存在时必须屏蔽', () => {
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', maskPaths: ['/home/u/.aws'] }, inner, {
      exists: always,
    })
    expect(tmpfsTargets(argv)).toContain('/home/u/.aws')
  })

  test('/tmp 始终替换为 tmpfs', () => {
    // 宿主 /tmp 中可能留有其他进程写入的临时凭证文件。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    expect(tmpfsTargets(argv)).toContain('/tmp')
  })

  test('默认不隔离网络', () => {
    // 有意为之：断网的 agent 无法安装依赖、拉取代码。按域名过滤需要整套代理，
    // 已记录在 docs/permissions.md 的「已知边界」中，不能在此处静默修改。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    expect(argv).not.toContain('--unshare-net')
  })

  test('隔离 PID 命名空间并挂载新的 /proc', () => {
    // 宿主的 /proc/<pid>/environ 中有其他进程的环境变量，
    // 而凭证已在本进程侧从子进程环境中剥离；不拦截这一路径，剥离就失去意义。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    expect(argv).toContain('--unshare-pid')
    expect(binds(argv, '--proc').length + (argv.includes('--proc') ? 1 : 0)).toBeGreaterThan(0)
  })

  test('不把命名空间的生命周期绑在 bwrap 外层进程上', () => {
    // `--die-with-parent` 使命名空间的 init 随外层进程退出而结束：shell 退出后，
    // 命令留下的后台进程全部被内核结束，结果中没有任何说明。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    expect(argv).not.toContain('--die-with-parent')
  })

  test('命令位于 -- 之后，且保持原样', () => {
    const cmd = ['/bin/sh', '-c', 'echo "a; b" && ls']
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, cmd, { exists: never })
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(cmd)
  })
})

describe('平台判定', () => {
  test('结论与本机平台一致，且必须给出原因', () => {
    const s = detectSandbox()
    expect(s.platform).toBe(process.platform)
    // 「没有沙箱」也必须说明原因：只写「不支持」无法让用户判断状况。
    expect(s.reason.length).toBeGreaterThan(10)
    // `active` 与 `backend` 不能互相矛盾：两个字段不一致时，
    // 不同读取方会各取其一，同一份状态因此得出两种结论。
    if (s.backend === 'none') expect(s.active).toBe(false)
    if (s.active) expect(['bwrap', 'seatbelt']).toContain(s.backend)
  })

  test('每个平台都说明约束状况，不只返回「不支持」', () => {
    /*
     * **不要把某个平台当前的实现进度写进断言**（例如「原生 Windows 一律报告没有内核
     * 边界」）：实现推进后断言就会失败，而失败的原因是改进；实现回退时又需再次修改。
     *
     * 应锁定的是**如实上报**这一不变量，它与平台是否有沙箱无关：
     * 有边界时说明验证了哪几项，没有时说明缺少哪一层约束。
     *
     * **不要求包含下一步操作。** 这段文字原样显示在设置页中，而设置页
     * 不枚举操作路径（CLAUDE.md B7）：安装 bubblewrap 的三条命令、
     * `wsl --set-version`、`sysctl` 设置都不属于状态描述。
     */
    const s = detectSandbox()
    if (s.active) {
      expect(s.backend).not.toBe('none')
      expect(s.reason).toContain('已验证')
    } else {
      expect(s.backend).toBe('none')
      expect(s.reason).toMatch(/约束/)
    }
  })

  test('探测结果被缓存，不会每条命令都启动一次进程', () => {
    // 自检需要实际执行一次子进程。不缓存时，每条 run_command 之前
    // 都多一次进程启动，这项开销不易被察觉，却持续存在。
    expect(detectSandbox()).toBe(detectSandbox())
  })
})

describe('默认屏蔽清单', () => {
  test('覆盖常见凭证目录，并包含 qywork 自身的配置目录', () => {
    const paths = defaultMaskPaths('/home/u')
    expect(paths).toContain('/home/u/.ssh')
    expect(paths).toContain('/home/u/.aws')
    // ~/.qywork 中保存着 provider 的 API Key 明文。遗漏它时，
    // 即使环境变量已完全剥离，一条 cat 命令也能读取全部密钥。
    expect(paths).toContain('/home/u/.qywork')
  })

  test('不屏蔽整个家目录', () => {
    // 整体屏蔽时 ~/.gitconfig、~/.npmrc、nvm/rustup 全部不可见，
    // git commit 因此没有作者，node 也可能无法定位；这样的沙箱用户开启一次就会关闭。
    expect(defaultMaskPaths('/home/u')).not.toContain('/home/u')
  })
})

/**
 * seatbelt（macOS）。
 *
 * 这些断言都针对纯函数：**本机不是 macOS，无法运行 `sandbox-exec`**。
 * 因此保证它在 macOS 上确实生效的不是这一组测试，而是 `detectSandbox()` 中的
 * 自检：它在用户机器上实际执行一次，失败即降级报告 `none`。
 * 这一组锁定 profile 的结构，运行期自检确认它在目标机器上是否可用。
 */
describe('seatbelt profile', () => {
  const P = (p: Parameters<typeof buildSeatbeltProfile>[0]) =>
    buildSeatbeltProfile(p, { exists: () => true })

  test('先全部放行，再收紧写权限', () => {
    // 反过来（deny default）需要枚举能运行 node/git 的完整白名单，
    // 而该名单必然有遗漏，遗漏时某个工具无法启动，且报错中没有原因。
    const s = P({ workspaceRoot: '/ws' })
    expect(s.indexOf('(allow default)')).toBeLessThan(s.indexOf('(deny file-write*)'))
  })

  test('可写根目录的放行规则位于写入禁止规则之后', () => {
    const s = P({ workspaceRoot: '/ws', writableRoots: ['/data'] })
    expect(s.indexOf('(deny file-write*)')).toBeLessThan(s.indexOf('(subpath "/ws")'))
    expect(s).toContain('(allow file-write* (subpath "/data"))')
  })

  test('.qy 的写入禁止规则位于可写根之后：SBPL 以最后匹配的规则为准', () => {
    // 与 bwrap 的挂载顺序同理，顺序颠倒同样不会报错。
    const s = P({ workspaceRoot: '/ws', readOnlySubdirs: ['.qy'] })
    expect(s.indexOf('(allow file-write* (subpath "/ws"))')).toBeLessThan(
      s.indexOf('(deny file-write* (subpath "/ws/.qy"))'),
    )
  })

  test('凭证目录连读取也拒绝：seatbelt 无法把目录覆盖为空目录', () => {
    const s = P({ workspaceRoot: '/ws', maskPaths: ['/Users/u/.ssh'] })
    expect(s).toContain('(deny file-read* (subpath "/Users/u/.ssh"))')
  })

  test('不存在的凭证目录不写入 profile', () => {
    const s = buildSeatbeltProfile(
      { workspaceRoot: '/ws', maskPaths: ['/Users/u/.aws'] },
      { exists: () => false },
    )
    expect(s).not.toContain('.aws')
  })

  test('不限制网络', () => {
    // 与 bwrap 的决定相同：断网的 agent 无法安装依赖、拉取代码。
    expect(P({ workspaceRoot: '/ws' })).not.toContain('deny network')
  })

  test('临时目录可写（macOS 的真实 TMPDIR 在 /private/var/folders）', () => {
    const s = P({ workspaceRoot: '/ws' })
    expect(s).toContain('/private/var/folders')
  })

  test('路径中的引号必须转义，否则文件名可以改写沙箱策略', () => {
    // 这是安全边界而不是格式问题：一个 `"` 能使后续内容整体落到字符串之外，
    // 成为 profile 的一部分。macOS 的文件名允许包含引号与反斜杠。
    const s = P({ workspaceRoot: '/ws/a"b' })
    expect(s).toContain('"/ws/a\\"b"')
    // 转义后整份 profile 的引号必须成对：逐字符扫描，跳过被反斜杠转义的引号。
    // 不要改用负向后顾正则：反斜杠在正则与字符串两层中各被消耗一次，
    // 写出的正则语法不成立。
    let quotes = 0
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') {
        i++
        continue
      }
      if (s[i] === '"') quotes++
    }
    expect(quotes % 2).toBe(0)
  })

  test('反斜杠同样必须转义', () => {
    // 反斜杠按码点构造：写成字面量时无法从源码看出转义层数，
    // 而该断言检查的正是转义层数。
    const BS = String.fromCharCode(92)
    const s = P({ workspaceRoot: `/ws/a${BS}b` })
    expect(s).toContain(`"/ws/a${BS}${BS}b"`)
  })

  test('argv 形状是 sandbox-exec -p <profile> -- <cmd>', () => {
    const argv = buildSeatbeltArgv({ workspaceRoot: '/ws' }, ['/bin/sh', '-c', 'ls'], {
      exists: () => false,
    })
    expect(argv[0]).toBe('/usr/bin/sandbox-exec')
    expect(argv[1]).toBe('-p')
    expect(argv[3]).toBe('--')
    expect(argv.slice(4)).toEqual(['/bin/sh', '-c', 'ls'])
  })
})

describe('两个后端提供相同的承诺', () => {
  /*
   * bwrap 与 seatbelt 的实现方式完全不同（一个基于挂载，一个基于规则），但
   * `docs/permissions.md` 只有一张表。两者的承诺一旦出现分歧，该文档就必须按平台
   * 分开编写，而分开的文档难以维护，因此这里用断言锁定两者的一致性。
   */
  const policy: Parameters<typeof buildBwrapArgv>[0] = {
    workspaceRoot: '/ws',
    writableRoots: ['/data'],
    readOnlySubdirs: ['.qy'],
    maskPaths: ['/home/u/.ssh'],
  }
  const bw = buildBwrapArgv(policy, ['/bin/true'], { exists: () => true }).join(' ')
  const sb = buildSeatbeltProfile(policy, { exists: () => true })

  test('两者都开放工作区与额外根目录的写入', () => {
    for (const p of ['/ws', '/data']) {
      expect(bw).toContain(p)
      expect(sb).toContain(`(allow file-write* (subpath "${p}"))`)
    }
  })

  test('两者都把 .qy 恢复为只读', () => {
    expect(bw).toContain('/ws/.qy')
    expect(sb).toContain('(deny file-write* (subpath "/ws/.qy"))')
  })

  test('两者都拦截凭证目录', () => {
    expect(bw).toContain('/home/u/.ssh')
    expect(sb).toContain('(deny file-read* (subpath "/home/u/.ssh"))')
  })

  test('两者都不限制网络', () => {
    expect(bw).not.toContain('--unshare-net')
    expect(sb).not.toContain('deny network')
  })
})

describe('网络访问开关', () => {
  /*
   * 只有开、关两种状态，有意不做域名白名单：中间状态需要在沙箱内启动代理、在沙箱外转发，
   * 还要让 TLS 信任一张自签 CA，而这套组件出现故障时表现为网络时通时断。
   *
   * 以下两组已在 WSL2 中做过对照运行：默认有 2 个网卡且网关可达，
   * 开启 denyNetwork 后只剩 lo 且网关不可达。
   */
  test('默认不断开网络', () => {
    // 断网的 agent 无法安装依赖、拉取代码，而报错与网络无关
    // （包管理器只报告拉取失败），用户会先关闭整个沙箱。
    expect(buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })).not.toContain(
      '--unshare-net',
    )
    expect(buildSeatbeltProfile({ workspaceRoot: '/ws' }, { exists: never })).not.toContain(
      '(deny network-outbound)',
    )
  })

  test('denyNetwork 在两个后端上都必须生效', () => {
    expect(
      buildBwrapArgv({ workspaceRoot: '/ws', denyNetwork: true }, inner, { exists: never }),
    ).toContain('--unshare-net')
    expect(
      buildSeatbeltProfile({ workspaceRoot: '/ws', denyNetwork: true }, { exists: never }),
    ).toContain('(deny network-outbound)')
  })

  test('断网不影响文件边界', () => {
    // 两个维度相互独立。混在一起时，关闭其中一个会连带关闭另一个。
    const argv = buildBwrapArgv(
      { workspaceRoot: '/ws', readOnlySubdirs: ['.qy'], denyNetwork: true },
      inner,
      { exists: never },
    )
    expect(binds(argv, '--bind')).toContainEqual({ src: '/ws', dst: '/ws' })
    expect(binds(argv, '--ro-bind-try').map((x) => x.dst)).toContain('/ws/.qy')
  })
})

/**
 * 树杀。**复现的是原始失败形状，不是验证新函数被调用。**
 *
 * 原始形状（本机 Windows 实测，见 `killTree` 注释）：`proc.kill()` 只终止
 * spawn 出的 shell，实际执行的孙进程仍在监听端口并持有 stdout：
 * `shell.ts` 的 pump 永远等不到 EOF，该次 `registry.execute` 不再返回，
 * 最终导致会话永久拒绝新任务并提示「已有任务在执行」。
 *
 * 因此本测试断言两点，缺一不可：
 *
 * 1. 树杀之后**端口不再监听**（孙进程确已退出）；
 * 2. 树杀之后**stdout 能收到 EOF**（管道关闭，pump 能结束）。
 *
 * 只断言第 1 点会遗漏真正致命的情况：会话无响应。
 *
 * 需要启动真实进程并占用真实端口，因此不并入纯函数各组：它较慢，且需要清理。
 */
describe('killTree', () => {
  /** 选用不易冲突的端口；冲突时本测试以「kill 前无法连接」失败，不会误判为成功。 */
  const PORT = 18947
  const SERVER = `require('http').createServer((_,r)=>r.end('alive')).listen(${PORT},'127.0.0.1');setInterval(()=>console.log('tick'),200)`

  const hit = async (): Promise<boolean> => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) })
      return r.ok
    } catch {
      return false
    }
  }

  test('终止整个进程树，且 stdout 随之 EOF', async () => {
    // 与 spawnGuarded 的结构相同：spawn 的是 shell，实际监听的是其子进程。
    // shell 取自 `commandShell()`，不按 platform 判定，以复现 spawnGuarded 的选择。
    // 脚本一律用双引号包裹：`SERVER` 中全是单引号，用单引号包裹会在第一个内层引号处断开
    // （这种错误在未执行过的分支中不会暴露）。
    // `& wait` 使 shell 保持为父进程：`-c` 只有一条简单命令时 bash 直接 exec 它，
    // 被终止的就是监听端口的进程本身，无法验证树杀是否成立。
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器没有 bash，这条端到端跑不了')
    const inner = [...shell.argv, `node -e "${SERVER}" & wait`]
    const proc = Bun.spawn(inner, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      ...(process.platform === 'win32' ? {} : { detached: true }),
    } as never)

    try {
      // 等待端口开始监听。端口未监听时测试的已不是树杀，直接失败。
      let up = false
      for (let i = 0; i < 30 && !up; i++) {
        await Bun.sleep(100)
        up = await hit()
      }
      expect(up).toBe(true)

      killTree(proc)
      await proc.exited

      // 孙进程退出才算完全终止。留出少量回收时间，但不能无限等待：
      // 等待过久会混淆「终止较慢」与「未能终止」。
      let down = false
      for (let i = 0; i < 20 && !down; i++) {
        await Bun.sleep(100)
        down = !(await hit())
      }
      expect(down).toBe(true)

      // 管道必须关闭。管道未关闭时本测试会超时，与实际故障的表现一致。
      const drained = (async () => {
        for await (const _ of proc.stdout as ReadableStream) {
          // 丢弃内容，只需读取到结束。
        }
        return 'eof'
      })()
      const verdict = await Promise.race([drained, Bun.sleep(5000).then(() => 'hung')])
      expect(verdict).toBe('eof')
    } finally {
      // 测试失败时同样必须清理，否则孤儿进程会占用端口，导致下一次运行误判。
      killTree(proc)
    }
  }, 20_000)
})
describe('子进程输出解码', () => {
  /** 「首页」两种编码的字节。GBK 字节取自本机实测的 `powershell` 与 mingw `curl` 输出。 */
  const GBK = new Uint8Array([0xca, 0xd7, 0xd2, 0xb3])
  const UTF8 = new Uint8Array([0xe9, 0xa6, 0x96, 0xe9, 0xa1, 0xb5])

  test('UTF-8 流原样解码', () => {
    expect(makeOutputDecoder()(UTF8)).toBe('首页')
  })

  test('跨片的不完整字符不被切断：不完整的分片不得触发编码切换', () => {
    const decode = makeOutputDecoder()
    expect(decode(UTF8.slice(0, 2))).toBe('')
    expect(decode(UTF8.slice(2))).toBe('首页')
  })

  test('非法 UTF-8 不抛出异常也不丢弃，切换到本机代码页继续解码', () => {
    const decode = makeOutputDecoder()
    const got = decode(GBK)
    expect(got.length).toBeGreaterThan(0)
    // Windows 上按代码页可解出实际字符；其他平台回退为 U+FFFD，不断言字形。
    if (process.platform === 'win32') expect(got).not.toContain('\uFFFD')
  })

  test('判定后不再切换，后续分片正常解码', () => {
    const decode = makeOutputDecoder()
    decode(GBK)
    expect(decode(new Uint8Array([0x6f, 0x6b]))).toBe('ok')
  })
})
/**
 * 命令正文必须逐字节到达 shell。
 *
 * Windows 上 argv 需经过一次命令行字符串的往返，MSYS 一侧按自身规则解析，
 * 成对的反斜杠被折减一半（实测发送 1/2/3/4 个，到达 1/1/2/2 个）。账本中有实际记录：
 * 模型写的 `if ch == '\\':` 到达 python 时变成 `'\'`，导致 unterminated string
 * literal 错误，且无从得知命令在传递中被修改。
 *
 * 本测试启动真实进程：该问题发生在进程边界上，纯函数无法测出。
 */
describe('命令正文逐字节到达', () => {
  test('调用方没有选定 shell 时明确失败，不在执行阶段重新选择', async () => {
    await expect(
      spawnGuarded({
        shell: null,
        command: 'echo should-not-run',
        cwd: process.cwd(),
        policy: null,
        env: process.env as Record<string, string>,
      }),
    ).rejects.toThrow('没有可用的 shell')
  })

  test('成对的反斜杠不被折减一半', async () => {
    const bs = String.fromCharCode(92)
    // 发送 4 个反斜杠，统计到达的数量。折减一半时为 2。
    const { proc } = await spawnGuarded({
      shell: commandShell(),
      command: `printf '%s' '${bs.repeat(4)}' | wc -c`,
      cwd: process.cwd(),
      policy: null,
      env: process.env as Record<string, string>,
    })
    const got = await collectProcess(proc, { timeoutMs: 20_000 })
    expect(got.stdout.trim()).toBe('4')
  }, 30_000)

  test('原始失败形状：python 源码中的一个反斜杠字符', async () => {
    const bs = String.fromCharCode(92)
    const { proc } = await spawnGuarded({
      shell: commandShell(),
      command: [`python - <<'PYEOF'`, `print(len('${bs}${bs}'))`, 'PYEOF'].join('\n'),
      cwd: process.cwd(),
      policy: null,
      env: process.env as Record<string, string>,
    })
    const got = await collectProcess(proc, { timeoutMs: 20_000 })
    // 折减一半时此处为 SyntaxError；完整到达时 python 统计出 1 个字符。
    expect(got.stderr).not.toContain('SyntaxError')
    expect(got.stdout.trim()).toBe('1')
  }, 30_000)
})

/**
 * 静默判据。**衡量的是两次输出之间的间隔，不是总时长。**
 *
 * 复现的失败形状：被调度的进程在自行执行构建与测试期间没有输出，按总时长判定时到期即
 * 终止仍在执行的进程，只留下部分输出。
 *
 * 启动真实进程，因此较慢；纯函数无法测出这一点：判据是否成立取决于管道。
 */
describe('静默计时', () => {
  /** 选用不易冲突的端口；冲突时本测试以「无法启动」失败，不会误判为成功。 */
  const PORT = 18948
  /** 每 50ms 输出一行的程序，输出 `limit` 行后停止并让进程自行退出；未传 `limit` 时持续输出。 */
  const ticker = (limit?: number) =>
    `var n=0,t=setInterval(function(){process.stdout.write('tick'+String.fromCharCode(10));` +
    `${limit === undefined ? '' : `if(++n===${limit})clearInterval(t)`}},50)`

  const hit = async (): Promise<boolean> => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) })
      return r.ok
    } catch {
      return false
    }
  }

  for (const startupMs of [0, 350]) {
    test(`每次输出重置计时，持续输出时不终止（启动延迟 ${startupMs}ms）`, async () => {
      // 启动就绪后才开始计算输出间隔；350ms 启动延迟用于锁定「启动耗时不计入静默时间」这一前提。
      const source =
        `setTimeout(()=>{process.stdout.write('ready\\n');` +
        `process.stdin.once('data',()=>{${ticker(12)}})},${startupMs})`
      const proc = Bun.spawn(['node', '-e', source], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      })
      try {
        const reader = proc.stdout.getReader()
        const startupTimer = setTimeout(() => killTree(proc), 10_000)
        let ready = ''
        try {
          const decoder = new TextDecoder()
          while (!ready.endsWith('\n')) {
            const chunk = await reader.read()
            if (chunk.done) break
            ready += decoder.decode(chunk.value, { stream: true })
          }
          expect(ready).toBe('ready\n')
        } finally {
          clearTimeout(startupTimer)
          reader.releaseLock()
        }
        // 12 行 × 50ms = 600ms，静默上限为 200ms：按总时长判定必然失败。
        const collected = collectProcess(proc, { idleMs: 200 })
        proc.stdin.write('start\n')
        proc.stdin.end()
        const got = await collected
        expect(got.timedOut).toBe(false)
        expect(got.exitCode).toBe(0)
        expect(got.stdout.split('tick').length - 1).toBe(12)
      } finally {
        if (proc.exitCode === null) killTree(proc)
      }
    }, 20_000)
  }

  test('两个计时器各自成立：仍有输出时，总时长到期同样终止进程', async () => {
    const proc = Bun.spawn(['node', '-e', ticker()], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const got = await collectProcess(proc, { idleMs: 30_000, timeoutMs: 500 })
    expect(got.timedOut).toBe(true)
  }, 20_000)

  test('写入一行后静默，到期执行树杀，孙进程随之退出', async () => {
    // 与 killTree 一组的结构相同：spawn 的是 shell，监听端口的是其子进程。
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器没有 bash，这条端到端跑不了')
    const src =
      `require('http').createServer(function(_,r){r.end('alive')}).listen(${PORT},'127.0.0.1');` +
      `process.stdout.write('started'+String.fromCharCode(10))`
    // 三个流的类型显式写出：带 spread 的字面量会被推断为 `'inherit'`，
    // 此时 `proc.stderr` 可能为 undefined，`collectProcess` 无法接受。
    const opts = {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      // 非 Windows 上自成进程组，`killTree` 才能终止整个进程组。
      ...(process.platform === 'win32' ? {} : { detached: true }),
    } as Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>
    const proc = Bun.spawn([...shell.argv, `node -e "${src}"`], opts)

    try {
      const collecting = collectProcess(proc, { idleMs: 3000 })

      // 端口未开始监听时，测试的已不是静默计时，直接失败。
      let up = false
      for (let i = 0; i < 20 && !up; i++) {
        await Bun.sleep(100)
        up = await hit()
      }
      expect(up).toBe(true)

      const got = await collecting
      expect(got.timedOut).toBe(true)
      // 终止之前写出的那一行必须保留在结果中。
      expect(got.stdout).toContain('started')

      // 必须执行树杀：只终止 shell 时，监听端口的进程仍在运行。
      let down = false
      for (let i = 0; i < 20 && !down; i++) {
        await Bun.sleep(100)
        down = !(await hit())
      }
      expect(down).toBe(true)
    } finally {
      // 测试失败时同样必须清理，否则孤儿进程会占用端口，导致下一次运行误判。
      killTree(proc)
    }
  }, 30_000)
})
