import { describe, expect, test } from 'bun:test'
import {
  BASH_PATH_ENV,
  buildBwrapArgv,
  buildSeatbeltArgv,
  buildSeatbeltProfile,
  commandShell,
  defaultMaskPaths,
  detectSandbox,
  killTree,
  resolveBashPath,
} from './sandbox.ts'

/** 把 argv 里 `flag src dst` 这种三元组抽出来，方便按语义断言而不是按下标。 */
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

  test('环境变量优先于一切平台位置', () => {
    const got = resolveBashPath({
      env: { [BASH_PATH_ENV]: 'D:/msys64/usr/bin/bash.exe' },
      platform: 'win32',
      exists: has('D:/msys64/usr/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'),
      gitBash: () => 'C:/Program Files/Git/bin/bash.exe',
    })
    expect(got.path).toBe('D:/msys64/usr/bin/bash.exe')
  })

  test('环境变量指到不存在的位置就当没有，不回落到搜索', () => {
    // 回落的后果是「跑起来了，但跑的不是我指的那个」——那要靠对比输出才发现。
    const got = resolveBashPath({
      env: { [BASH_PATH_ENV]: 'D:/nope/bash.exe' },
      platform: 'win32',
      exists: has('C:/Program Files/Git/bin/bash.exe'),
      gitBash: () => 'C:/Program Files/Git/bin/bash.exe',
    })
    expect(got.path).toBeNull()
    // 理由要说得出是哪个变量指错了，否则用户只知道「没有 bash」而机器上明明有一个。
    expect(got.reason).toContain(BASH_PATH_ENV)
    expect(got.reason).toContain('D:/nope/bash.exe')
  })

  test('macOS 上 Homebrew 的 bash 排在自带的 /bin/bash 前面', () => {
    // 自带的是 bash 3.2，没有 declare -A / mapfile / ${x,,}。
    const got = resolveBashPath({
      env: {},
      platform: 'darwin',
      exists: has('/opt/homebrew/bin/bash', '/bin/bash'),
      gitBash: noGitBash,
    })
    expect(got.path).toBe('/opt/homebrew/bin/bash')
  })

  test('只有 /bin/bash 时就用它', () => {
    expect(
      resolveBashPath({
        env: {},
        platform: 'linux',
        exists: has('/bin/bash'),
        gitBash: noGitBash,
      }).path,
    ).toBe('/bin/bash')
  })

  test('找不到 bash 就报 null 加原因，不落回 PowerShell 也不落回 sh', () => {
    // 两件事一起锁：**没有第二种 shell**（兜底回来方言就是两套），
    // 以及**「没有」是一种可上报的状态而不是崩溃**——服务得起得来才能把这句话说给用户听。
    const win = resolveBashPath({ env: {}, platform: 'win32', exists: never, gitBash: noGitBash })
    expect(win.path).toBeNull()
    expect(win.reason).toContain('Git for Windows')
    const linux = resolveBashPath({ env: {}, platform: 'linux', exists: never, gitBash: noGitBash })
    expect(linux.path).toBeNull()
    expect(linux.reason).toContain('/bin/bash')
  })
})

describe('bwrap 参数生成', () => {
  test('整机只读打底，工作区单独开写', () => {
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    // `--ro-bind / /` 是「写边界」的地基：先把整机盖成只读，再逐个开口子。
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

  test('相对路径的额外根目录被丢掉，不会拼成一个意外的绝对路径', () => {
    // 相对路径的基准是进程 cwd。放进去的话，同一份配置在不同目录启动
    // 会 bind 到不同的地方——那比拒绝它糟得多。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', writableRoots: ['notes'] }, inner, {
      exists: never,
    })
    expect(argv.join(' ')).not.toContain('notes')
  })

  test('重复的根目录只出现一次（bwrap 会因为重复 bind 报错）', () => {
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

  test('额外根目录里的 .qy 也要盖成只读', () => {
    // 不盖的话，把某个目录加进 additionalDirectories 就等于在那儿开了一条
    // 「模型可以给自己加工具」的路——而用户配这条时想的是「让它读我的笔记」。
    const argv = buildBwrapArgv(
      { workspaceRoot: '/ws', writableRoots: ['/data'], readOnlySubdirs: ['.qy'] },
      inner,
      { exists: never },
    )
    const ro = binds(argv, '--ro-bind-try').map((x) => x.dst)
    expect(ro.some((p) => p.includes('/data') && p.includes('.qy'))).toBe(true)
  })

  test('凭证目录不存在时**不能**生成 --tmpfs', () => {
    // 实测：`--tmpfs /root/.aws` 在该目录不存在、父目录只读时会让 bwrap 直接退出
    // （Can't mkdir …: Read-only file system）。也就是说一台没有 ~/.aws 的机器上
    // 盲目屏蔽它会让**每一条命令**都起不来。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', maskPaths: ['/home/u/.aws'] }, inner, {
      exists: never,
    })
    expect(tmpfsTargets(argv)).not.toContain('/home/u/.aws')
  })

  test('凭证目录存在时要屏蔽', () => {
    const argv = buildBwrapArgv({ workspaceRoot: '/ws', maskPaths: ['/home/u/.aws'] }, inner, {
      exists: always,
    })
    expect(tmpfsTargets(argv)).toContain('/home/u/.aws')
  })

  test('/tmp 总是换成 tmpfs', () => {
    // 宿主 /tmp 里可能躺着别的进程写下的临时凭证文件。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    expect(tmpfsTargets(argv)).toContain('/tmp')
  })

  test('不 unshare 网络', () => {
    // 刻意的：断网的 agent 装不了依赖、拉不了代码。按域名过滤要一整套代理，
    // 记在 docs/permissions.md 的「已知边界」里，不能靠这里悄悄改。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    expect(argv).not.toContain('--unshare-net')
  })

  test('隔离 PID 命名空间并挂新的 /proc', () => {
    // 宿主的 /proc/<pid>/environ 里有别的进程的环境变量，
    // 而我们刚在自己这边把凭证从子进程环境里剥干净——不挡这条等于白剥。
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })
    expect(argv).toContain('--unshare-pid')
    expect(binds(argv, '--proc').length + (argv.includes('--proc') ? 1 : 0)).toBeGreaterThan(0)
  })

  test('命令放在 -- 之后，且原样不变', () => {
    const cmd = ['/bin/sh', '-c', 'echo "a; b" && ls']
    const argv = buildBwrapArgv({ workspaceRoot: '/ws' }, cmd, { exists: never })
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(cmd)
  })
})

describe('平台判定', () => {
  test('结论与本机平台一致，且一定给得出理由', () => {
    const s = detectSandbox()
    expect(s.platform).toBe(process.platform)
    // 「没有沙箱」也必须说清楚为什么、下一步怎么办——
    // 一句「不支持」对用户没有任何可操作性。
    expect(s.reason.length).toBeGreaterThan(10)
    // `active` 与 `backend` 不能互相矛盾——两个字段说不同的话，
    // 读的人会各取一个，于是同一份状态得出两种结论。
    if (s.backend === 'none') expect(s.active).toBe(false)
    if (s.active) expect(['bwrap', 'seatbelt']).toContain(s.backend)
  })

  test('每个平台要么给出后端，要么给出下一步', () => {
    /*
     * 这条原来写的是「原生 Windows 一律报没有内核边界」——**把某个平台今天的
     * 实现进度写进了断言**。实现一往前走它就红，而红的原因是好事；
     * 反过来实现退回去（Windows 那条最后决定不做，ROADMAP §42），它又得再改一次。
     *
     * 真正该锁的是**如实上报**这条不变量，它跟哪个平台有没有沙箱无关：
     * 有边界就说清是哪个后端，没有就说清下一步怎么办——
     * 两种情况都不能只丢一句「不支持」。
     */
    const s = detectSandbox()
    if (s.active) {
      expect(s.backend).not.toBe('none')
      expect(s.reason).toContain('实测')
    } else {
      expect(s.backend).toBe('none')
      // 「没有」必须带着可操作的下一步：装什么、开什么、或者去哪儿跑。
      expect(s.reason).toMatch(/装|升级|WSL2|运行|启用/)
    }
  })

  test('探测结果缓存，不会每条命令都去起一次进程', () => {
    // 自检要真的执行一次子进程。不缓存的话，每条 run_command 前面
    // 都多一次进程启动——那是一条谁都不会去量、但一直在付的成本。
    expect(detectSandbox()).toBe(detectSandbox())
  })
})

describe('默认屏蔽清单', () => {
  test('覆盖常见凭证目录，并且包含 qywork 自己的配置目录', () => {
    const paths = defaultMaskPaths('/home/u')
    expect(paths).toContain('/home/u/.ssh')
    expect(paths).toContain('/home/u/.aws')
    // ~/.qywork 里就是 provider 的 API Key 明文。漏掉它的话，
    // 环境变量剥得再干净，一句 cat 就全拿走了。
    expect(paths).toContain('/home/u/.qywork')
  })

  test('不屏蔽整个家目录', () => {
    // 整个盖掉的话 ~/.gitconfig、~/.npmrc、nvm/rustup 全消失，
    // 于是 git commit 没有作者、node 可能根本找不到——那种沙箱用户开一次就关了。
    expect(defaultMaskPaths('/home/u')).not.toContain('/home/u')
  })
})

/**
 * seatbelt（macOS）。
 *
 * 这些断言全是纯函数上的——**本机不是 macOS，跑不了 `sandbox-exec`**。
 * 所以真正保证「它在 Mac 上确实生效」的不是这一组，是 `detectSandbox()` 里的
 * 自检：它在用户的机器上真的执行一次，失败就降级报 `none`。
 * 换句话说，这一组锁的是 profile 的形状，运行期那条锁的是它到底能不能用。
 */
describe('seatbelt profile', () => {
  const P = (p: Parameters<typeof buildSeatbeltProfile>[0]) =>
    buildSeatbeltProfile(p, { exists: () => true })

  test('先全放行再收紧写权限', () => {
    // 反过来（deny default）要枚举出一个能跑起 node/git 的完整白名单，
    // 而那份名单一定会漏——漏的表现是「某个工具莫名其妙起不来」。
    const s = P({ workspaceRoot: '/ws' })
    expect(s.indexOf('(allow default)')).toBeLessThan(s.indexOf('(deny file-write*)'))
  })

  test('可写根目录开在写禁令之后', () => {
    const s = P({ workspaceRoot: '/ws', writableRoots: ['/data'] })
    expect(s.indexOf('(deny file-write*)')).toBeLessThan(s.indexOf('(subpath "/ws")'))
    expect(s).toContain('(allow file-write* (subpath "/data"))')
  })

  test('.qy 的写禁令排在可写根之后——SBPL 是最后匹配的赢', () => {
    // 与 bwrap 的挂载顺序是同一个道理，反了同样不报错。
    const s = P({ workspaceRoot: '/ws', readOnlySubdirs: ['.qy'] })
    expect(s.indexOf('(allow file-write* (subpath "/ws"))')).toBeLessThan(
      s.indexOf('(deny file-write* (subpath "/ws/.qy"))'),
    )
  })

  test('凭证目录连读都拒——seatbelt 没有「盖成空目录」这回事', () => {
    const s = P({ workspaceRoot: '/ws', maskPaths: ['/Users/u/.ssh'] })
    expect(s).toContain('(deny file-read* (subpath "/Users/u/.ssh"))')
  })

  test('不存在的凭证目录不写进 profile', () => {
    const s = buildSeatbeltProfile(
      { workspaceRoot: '/ws', maskPaths: ['/Users/u/.aws'] },
      { exists: () => false },
    )
    expect(s).not.toContain('.aws')
  })

  test('不限制网络', () => {
    // 与 bwrap 那边同一个决定：断网的 agent 装不了依赖、拉不了代码。
    expect(P({ workspaceRoot: '/ws' })).not.toContain('deny network')
  })

  test('临时目录可写（macOS 的真实 TMPDIR 在 /private/var/folders）', () => {
    const s = P({ workspaceRoot: '/ws' })
    expect(s).toContain('/private/var/folders')
  })

  test('路径里的引号必须转义——否则文件名能改写沙箱策略', () => {
    // 这不是格式化是安全边界：一个 `"` 能让后面的规则整个跑出字符串外，
    // 变成 profile 的一部分。macOS 的文件名允许引号和反斜杠。
    const s = P({ workspaceRoot: '/ws/a"b' })
    expect(s).toContain('"/ws/a\\"b"')
    // 转义后整份 profile 的引号必须成对：逐字符扫，跳过被反斜杠转义的那些。
    // （用负向后顾正则写这条踩过一次——`\\` 在不同层里被吃掉，
    //   写出来的是一个语法都不对的正则。）
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

  test('反斜杠也要转义', () => {
    // 反斜杠按码点构造：写成字面量的话，源码里到底有几层转义看不出来，
    // 而这条断言的全部内容就是「有几层转义」。
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

describe('两个后端承诺同一件事', () => {
  /*
   * bwrap 与 seatbelt 形状完全不同（一个是挂载，一个是规则），但
   * `docs/permissions.md` 只有一张表。两边的承诺一旦分叉，那份文档就得按平台
   * 拆开写，而拆开的文档没人维护得住——所以这里把「同一句话」钉成断言。
   */
  const policy: Parameters<typeof buildBwrapArgv>[0] = {
    workspaceRoot: '/ws',
    writableRoots: ['/data'],
    readOnlySubdirs: ['.qy'],
    maskPaths: ['/home/u/.ssh'],
  }
  const bw = buildBwrapArgv(policy, ['/bin/true'], { exists: () => true }).join(' ')
  const sb = buildSeatbeltProfile(policy, { exists: () => true })

  test('两边都放开工作区与额外根目录', () => {
    for (const p of ['/ws', '/data']) {
      expect(bw).toContain(p)
      expect(sb).toContain(`(allow file-write* (subpath "${p}"))`)
    }
  })

  test('两边都把 .qy 变回只读', () => {
    expect(bw).toContain('/ws/.qy')
    expect(sb).toContain('(deny file-write* (subpath "/ws/.qy"))')
  })

  test('两边都挡住凭证目录', () => {
    expect(bw).toContain('/home/u/.ssh')
    expect(sb).toContain('(deny file-read* (subpath "/home/u/.ssh"))')
  })

  test('两边都不限制网络', () => {
    expect(bw).not.toContain('--unshare-net')
    expect(sb).not.toContain('deny network')
  })
})

describe('出网开关', () => {
  /*
   * 只有两档，刻意不做域名白名单：中间态要在沙箱里起代理、沙箱外做转发、
   * 还要让 TLS 认一张自签 CA，而那套东西坏起来的表现是「网络时好时坏」。
   *
   * 下面这两组已经在 WSL2 里带对照跑过：默认 2 个网卡且网关可达，
   * denyNetwork 之后只剩 lo 且网关不可达。
   */
  test('默认不断网', () => {
    // 断网的 agent 装不了依赖、拉不了代码，而报错跟网络毫不相干
    // （包管理器只会说拉取失败），用户会先把整个沙箱关掉。
    expect(buildBwrapArgv({ workspaceRoot: '/ws' }, inner, { exists: never })).not.toContain(
      '--unshare-net',
    )
    expect(buildSeatbeltProfile({ workspaceRoot: '/ws' }, { exists: never })).not.toContain(
      '(deny network-outbound)',
    )
  })

  test('denyNetwork 在两个后端上都要生效', () => {
    expect(
      buildBwrapArgv({ workspaceRoot: '/ws', denyNetwork: true }, inner, { exists: never }),
    ).toContain('--unshare-net')
    expect(
      buildSeatbeltProfile({ workspaceRoot: '/ws', denyNetwork: true }, { exists: never }),
    ).toContain('(deny network-outbound)')
  })

  test('断网不影响文件边界', () => {
    // 两个维度互不相干。混在一起的话，关掉一个会顺手关掉另一个。
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
 * 树杀。**复现的是原始失败形状，不是「新函数被调到了」。**
 *
 * 原始形状（本机 Windows 实测，见 `killTree` 注释）：`proc.kill()` 只杀我们
 * spawn 的那个 shell，真正干活的孙进程照常监听端口，而且握着 stdout ——
 * `shell.ts` 的 pump 永远等不到 EOF，那次 `registry.execute` 再也不返回，
 * 一路传导到会话永久回绝「已有任务在执行」。
 *
 * 所以这条测试断言两件事，缺一不可：
 *
 * 1. 树杀之后**端口不再监听**（孙进程真的死了）；
 * 2. 树杀之后**stdout 拿得到 EOF**（管道关闭，pump 能结束）。
 *
 * 只断言第 1 条会漏掉那个真正致命的——会话卡死。
 *
 * 起真进程、占真端口，所以不并入纯函数那几组：它慢，而且要清理。
 */
describe('killTree', () => {
  /** 端口挑一个不太可能撞上的；撞上了这条测试会以「kill 前连不上」失败，不会误判成功。 */
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

  test('杀掉整棵树，且 stdout 随之 EOF', async () => {
    // 与 spawnGuarded 同一个形状：spawn 的是 shell，真正监听的是它的子进程。
    // shell 取 `commandShell()`，不按 platform 现判——这里复刻的就是它。
    // 脚本一律用双引号包：`SERVER` 里全是单引号，用单引号包会在第一个内层引号处断开
    // （原来的 `/bin/sh` 分支就是这么写的，那条路一次也没跑过，所以一直没暴露）。
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器没有 bash，这条端到端跑不了')
    const inner = [...shell.argv, `node -e "${SERVER}"`]
    const proc = Bun.spawn(inner, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      ...(process.platform === 'win32' ? {} : { detached: true }),
    } as never)

    try {
      // 等它把端口听起来。听不起来就不是在测树杀了，直接失败。
      let up = false
      for (let i = 0; i < 30 && !up; i++) {
        await Bun.sleep(100)
        up = await hit()
      }
      expect(up).toBe(true)

      killTree(proc)
      await proc.exited

      // 孙进程死了才算杀干净。给一点回收时间，但不能无限等——
      // 等太久会把「杀慢了」和「没杀掉」混为一谈。
      let down = false
      for (let i = 0; i < 20 && !down; i++) {
        await Bun.sleep(100)
        down = !(await hit())
      }
      expect(down).toBe(true)

      // 管道必须关闭。挂住的话这条测试会超时——那正是线上表现出来的样子。
      const drained = (async () => {
        for await (const _ of proc.stdout as ReadableStream) {
          // 丢弃，只要读到结束。
        }
        return 'eof'
      })()
      const verdict = await Promise.race([drained, Bun.sleep(5000).then(() => 'hung')])
      expect(verdict).toBe('eof')
    } finally {
      // 测试失败也要清理，否则孤儿会占着端口让下一次运行误判。
      killTree(proc)
    }
  }, 20_000)
})
