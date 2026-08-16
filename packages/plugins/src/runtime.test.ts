/**
 * 运行时解析与沙箱。
 *
 * 这一组里最重要的两条都不是「功能对不对」：
 *
 * - **不能拿 `process.execPath` 当默认运行时。** 发布产物是单文件二进制，
 *   那个路径是 qy 自己，拿它跑插件只会打出用法说明——插件在开发机上一直好好的，
 *   装了包的用户那里一个都起不来。
 * - **隔离的范围要如实报，而且要分维度报。** 沙箱（`--permission`）与出网闸
 *   （`netguard.ts`）的成立条件不同——版本要求不同，bun 上一个都没有。
 *   合并成一句「已隔离」就是把知情同意换成了一个不成立的承诺。
 *
 * 所以这里有两类断言，缺一不可：**上报口径对不对**（`netGuarded` 什么时候该是
 * false），和**实际挡不挡得住**（逐条逃逸路径真的跑一遍）。
 * 只测前者会得到一个诚实但没用的闸，只测后者会得到一个有用但会骗人的上报。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PluginHost } from './host.ts'
import type { PluginManifest, PluginPermission } from './manifest.ts'
import { resolvePluginRuntime, sandboxArgs } from './runtime.ts'

const req = (permissions: PluginPermission[] = []) => ({
  workspaceRoot: '/ws',
  pluginDir: '/ws/.qy/plugins/p',
  permissions,
})

describe('沙箱参数', () => {
  test('Node 23+ 用 --permission', () => {
    expect(sandboxArgs(24, req())?.args[0]).toBe('--permission')
  })

  test('Node 20~22 用 --experimental-permission —— 旗名给错进程直接起不来', () => {
    expect(sandboxArgs(22, req())?.args[0]).toBe('--experimental-permission')
  })

  test('Node 18 没有权限模型，返回 null 而不是编一组旗子', () => {
    expect(sandboxArgs(18, req())).toBeNull()
  })

  test('插件目录永远可读 —— 否则连入口文件都加载不了', () => {
    expect(sandboxArgs(24, req())?.args).toContain('--allow-fs-read=/ws/.qy/plugins/p')
  })

  test('没声明 workspace:read 就读不到工作区', () => {
    expect(sandboxArgs(24, req())?.args).not.toContain('--allow-fs-read=/ws')
  })

  test('声明了才给，读写分开', () => {
    const read = sandboxArgs(24, req(['workspace:read']))!.args
    expect(read).toContain('--allow-fs-read=/ws')
    expect(read.some((a) => a.startsWith('--allow-fs-write'))).toBe(false)

    const write = sandboxArgs(24, req(['workspace:write']))!.args
    expect(write).toContain('--allow-fs-write=/ws')
  })

  test('process:exec 才给 --allow-child-process', () => {
    expect(sandboxArgs(24, req())?.args).not.toContain('--allow-child-process')
    expect(sandboxArgs(24, req(['process:exec']))?.args).toContain('--allow-child-process')
  })

  /**
   * worker 能另起一套绕开权限模型，原生插件直接进内核态调用。
   * 插件没有任何正当理由需要它们，所以哪个权限都不换来这两个旗子。
   */
  test('永不给 --allow-worker / --allow-addons', () => {
    const all: PluginPermission[] = [
      'workspace:read',
      'workspace:write',
      'process:exec',
      'network',
      'storage',
    ]
    const args = sandboxArgs(24, req(all))!.args
    expect(args.some((a) => a.includes('worker') || a.includes('addons'))).toBe(false)
  })

  test('说明里必须交代出网这一面 —— 不管是拦住了还是没拦住', () => {
    for (const perms of [[], ['network'], ['process:exec']] as PluginPermission[][]) {
      const note = sandboxArgs(24, req(perms))?.note ?? ''
      expect(note).toMatch(/出网/)
    }
  })
})

/**
 * 出网闸的**上报**，与它实际挡不挡得住分开测。
 *
 * 这一组全是「说的和做的是不是一回事」——这个项目在插件隔离上犯过的错
 * 正是文档比实现乐观，所以宁可多几条断言盯着上报口径。
 */
describe('出网闸的上报口径', () => {
  test('版本够就装上，且 netGuarded 为 true', () => {
    const r = sandboxArgs(24, req(['workspace:read']), 13)!
    expect(r.netGuarded).toBe(true)
    expect(r.args).toContain('--import')
  })

  /**
   * `module.registerHooks` 是 22.15 / 23.5 才有的。版本不够时**不装半截的闸**：
   * 只删全局 fetch 而模块照样 require，比不装更糟——上报说「已拦截」，
   * 实际一 `require('net')` 就出去了。
   */
  test('版本不够时不装，也不谎报', () => {
    for (const [major, minor] of [
      [22, 14],
      [23, 4],
      [20, 99],
    ]) {
      const r = sandboxArgs(major!, req(), minor)!
      expect(r.netGuarded).toBe(false)
      expect(r.args).not.toContain('--import')
      expect(r.note).toContain('22.15')
    }
  })

  test('版本刚好够的边界上要装', () => {
    expect(sandboxArgs(22, req(), 15)!.netGuarded).toBe(true)
    expect(sandboxArgs(23, req(), 5)!.netGuarded).toBe(true)
  })

  /**
   * 能起子进程就能跑 curl。这不是漏洞是定义——授予执行权就是授予
   * 「做任何本机能做的事」。所以这时候 `netGuarded` **必须报 false**，
   * 哪怕闸确实注入了。报 true 会让权限清单看起来比实际严。
   */
  test('持有 process:exec 时如实报 false —— 闸装了也不算挡住', () => {
    const r = sandboxArgs(24, req(['process:exec']), 13)!
    expect(r.args).toContain('--import')
    expect(r.netGuarded).toBe(false)
    expect(r.note).toContain('process:exec')
  })

  /** 引导脚本自己也在权限模型底下，读不到它的话插件直接起不来。 */
  test('给引导脚本所在目录单独放行', () => {
    const r = sandboxArgs(24, req(), 13)!
    const guardArg = r.args.find((a) => a.startsWith('--import'))
    expect(guardArg).toBeDefined()
    expect(r.args.filter((a) => a.startsWith('--allow-fs-read=')).length).toBeGreaterThanOrEqual(2)
  })

  /**
   * **Windows 上 `--import` 不接受裸盘符路径**，报的是
   * `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`——它把 `C:` 当协议名。
   * 类 Unix 上传绝对路径能过，所以这条只在 Windows 炸，
   * 而且表现是「插件启动即退出」，跟出网闸看不出任何关系。
   */
  test('--import 传的是 file:// URL，不是裸路径', () => {
    const args = sandboxArgs(24, req(), 13)!.args
    const value = args[args.indexOf('--import') + 1]!
    expect(value.startsWith('file://')).toBe(true)
  })
})

describe('运行时解析', () => {
  test('显式指定就用它，不再猜', () => {
    const rt = resolvePluginRuntime({ ...req(), override: '/opt/custom-node' })
    expect(rt.command).toBe('/opt/custom-node')
    expect(rt.args).toEqual([])
    expect(rt.sandboxed).toBe(false)
  })

  /**
   * 自动解析必须落到一个**真的能执行 JS** 的东西上。
   * 单文件二进制里 `process.execPath` 是 qy 自己，选中它等于插件全部起不来。
   */
  test('自动解析出的运行时是 node 或 bun，绝不是宿主二进制', () => {
    const rt = resolvePluginRuntime(req(['workspace:read']))
    const name = basename(rt.command).toLowerCase()
    expect(name.startsWith('node') || name.startsWith('bun')).toBe(true)
  })

  test('解析到 node 时沙箱开着并如实说明；解析到 bun 时明说没有', () => {
    const rt = resolvePluginRuntime(req(['workspace:read']))
    if (basename(rt.command).toLowerCase().startsWith('node')) {
      expect(rt.sandboxed).toBe(true)
      expect(rt.args).toContain('--allow-fs-read=/ws')
    } else {
      // bun 没有权限模型。这时候**必须**报 false —— 含糊比没有更糟。
      expect(rt.sandboxed).toBe(false)
      expect(rt.note).toContain('node')
    }
  })
})

describe('沙箱实测：只声明 workspace:read 的插件', () => {
  async function probePlugin() {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-sb-'))
    const entry = join(dir, 'index.mjs')
    const NL = String.fromCharCode(10)
    await writeFile(
      entry,
      [
        'const send = (o) => process.stdout.write(JSON.stringify(o) + String.fromCharCode(10))',
        "let buf = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (c) => { buf += c; for(;;){ const i = buf.indexOf(String.fromCharCode(10)); if (i < 0) break; const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line) } catch { continue }; if (m.type === 'call') handle(m) } })",
        'async function handle(msg) {',
        '  const out = {}',
        "  try { const fs = await import('node:fs'); const os = await import('node:os'); fs.readdirSync(os.homedir()); out.home = 'OK' } catch { out.home = 'BLOCKED' }",
        "  try { const fs = await import('node:fs'); fs.writeFileSync(process.cwd() + '/sneaky.txt', 'x'); out.write = 'OK' } catch { out.write = 'BLOCKED' }",
        "  try { const cp = await import('node:child_process'); cp.execSync('echo hi'); out.exec = 'OK' } catch { out.exec = 'BLOCKED' }",
        "  try { const net = await import('node:net'); out.net = typeof net.createConnection === 'function' ? 'OK' : 'BLOCKED' } catch { out.net = 'BLOCKED' }",
        '  send({ id: msg.id, ok: true, result: out })',
        '}',
        "send({ type: 'ready' })",
      ].join(NL),
      'utf8',
    )

    const manifest = {
      manifestVersion: 1,
      id: 'test-sb',
      name: 'sb',
      version: '1.0.0',
      description: 'd',
      main: 'index.mjs',
      permissions: ['workspace:read'],
      contributes: {},
    } as unknown as PluginManifest

    const h = new PluginHost({
      manifest,
      dir,
      entry,
      workspaceRoot: dir,
      onCapability: async () => null,
    })
    await h.start()
    const out = (await h.call('probe')) as Record<string, string>
    const sandboxed = h.runtime?.sandboxed === true
    const netGuarded = h.runtime?.netGuarded === true
    h.stop()
    return { out, sandboxed, netGuarded }
  }

  test('沙箱生效时读不到主目录、写不了盘、起不了子进程', async () => {
    const { out, sandboxed } = await probePlugin()
    if (!sandboxed) {
      // 本机没有 node 20+。**不静默跳过**：断言「宿主如实报了没有隔离」，
      // 这样测试仍然在验一件事，而不是变成一个永远通过的空壳。
      expect(out.home).toBe('OK')
      return
    }
    expect(out.home).toBe('BLOCKED')
    expect(out.write).toBe('BLOCKED')
    expect(out.exec).toBe('BLOCKED')
  }, 20_000)

  /**
   * 出网闸装上之后，插件进程内的直接出网通道被拆掉，只剩 `host.net.fetch`。
   * 这条锁的就是那个事实——它红了说明出网闸没装上或被绕过了。
   */
  test('直接开套接字已被挡住', async () => {
    const { out, netGuarded } = await probePlugin()
    if (!netGuarded) {
      // 本机装不上闸（bun / 旧 node）。**不静默跳过**：断言宿主如实报了没有闸，
      // 并且此时网络确实还通——这样测试仍然在验一件事。
      expect(out.net).toBe('OK')
      return
    }
    expect(out.net).toBe('BLOCKED')
  }, 20_000)
})

/**
 * 逃逸路径逐条实测。
 *
 * 「挡住了」这件事只写在文档里的话，没有任何东西盯着它。
 * 这一组把每条路径变成断言：**哪条被绕开了，这里就红**。
 *
 * 全部在一个插件进程里跑完，因为起一个带权限模型的 node 要几十毫秒，
 * 逐条起进程会让这一组变成整个测试套件里最慢的部分。
 */
describe('出网闸实测：每条逃逸路径', () => {
  async function escapeProbe(permissions: PluginPermission[] = ['network']) {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-ng-'))
    const entry = join(dir, 'index.mjs')
    const NL = String.fromCharCode(10)
    // 每条探针都写成「拿到了 = OK，抛了 = BLOCKED」。
    // 断言 BLOCKED 而不是断言抛出的错误文案：文案会改，能不能拿到不会。
    const probes: [string, string][] = [
      ['esmNet', "const m = await import('node:net'); return typeof m.createConnection"],
      // 这条**不该**被出网闸挡：child_process 由权限模型管，不由这里管。
      // 两套机制对同一件事给出相反答案，比缺一层防护更难查。
      [
        'cp',
        "const m = await import('node:child_process'); m.execSync('echo hi'); return 'function'",
      ],
      ['esmBare', "const m = await import('net'); return typeof m.createConnection"],
      ['esmHttp', "const m = await import('node:http'); return typeof m.request"],
      ['esmTls', "const m = await import('node:tls'); return typeof m.connect"],
      ['esmDgram', "const m = await import('node:dgram'); return typeof m.createSocket"],
      ['esmDns', "const m = await import('node:dns'); return typeof m.lookup"],
      [
        'cjsNet',
        "const { createRequire } = await import('node:module'); return typeof createRequire(import.meta.url)('net').createConnection",
      ],
      ['builtin', "return typeof process.getBuiltinModule('node:net').createConnection"],
      ['fetch', 'return typeof fetch'],
      ['ws', 'return typeof WebSocket'],
      ['es', 'return typeof EventSource'],
      ['binding', "return typeof process.binding('tcp_wrap')"],
      [
        'reHook',
        // 插件自己注册一个短路钩子放行 node:net。后注册的先执行——
        // 不把 node:module 一起挡住的话，这一条能把上面全部解开。
        "const m = await import('node:module'); m.registerHooks({ resolve(s, c, n) { if (s === 'node:net') return { url: 'node:net', shortCircuit: true }; return n(s, c) } }); const net = await import('node:net'); return typeof net.createConnection",
      ],
      [
        'dataUrl',
        'const m = await import(\'data:text/javascript,export { createConnection } from \\"node:net\\"\'); return typeof m.createConnection',
      ],
    ]
    await writeFile(
      entry,
      [
        'const send = (o) => process.stdout.write(JSON.stringify(o) + String.fromCharCode(10))',
        "let buf = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (c) => { buf += c; for(;;){ const i = buf.indexOf(String.fromCharCode(10)); if (i < 0) break; const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line) } catch { continue }; if (m.type === 'call') handle(m) } })",
        'async function handle(msg) {',
        '  const out = {}',
        ...probes.map(
          ([key, body]) =>
            `  try { const v = await (async () => { ${body} })(); out.${key} = (v === 'function' || v === 'object') ? 'OK' : 'BLOCKED' } catch { out.${key} = 'BLOCKED' }`,
        ),
        '  send({ id: msg.id, ok: true, result: out })',
        '}',
        "send({ type: 'ready' })",
      ].join(NL),
      'utf8',
    )

    const manifest = {
      manifestVersion: 1,
      id: 'test-ng',
      name: 'ng',
      version: '1.0.0',
      description: 'd',
      main: 'index.mjs',
      // 默认声明 network：出网闸对**声明了网络权限的插件同样生效**，
      // 因为目标是把 host.net.fetch 做成唯一通道（它过 SSRF 闸），
      // 而不是「声明了就随便你连」。
      permissions,
      contributes: {},
    } as unknown as PluginManifest

    const h = new PluginHost({
      manifest,
      dir,
      entry,
      workspaceRoot: dir,
      onCapability: async () => null,
    })
    await h.start()
    const out = (await h.call('probe')) as Record<string, string>
    const netGuarded = h.runtime?.netGuarded === true
    h.stop()
    return { out, netGuarded, keys: probes.map(([k]) => k) }
  }

  test('每一条都挡住，一条都不许漏', async () => {
    const { out, netGuarded, keys } = await escapeProbe()
    if (!netGuarded) {
      // 装不上闸的机器上不能静默通过。断言「确实没挡住」——
      // 一个在两种环境下都恒绿的测试等于没有测试。
      expect(out.esmNet).toBe('OK')
      return
    }
    // cp 归权限模型管，不在出网闸的职责范围内，单独看。
    const leaked = keys.filter((k) => k !== 'cp' && out[k] === 'OK')
    expect(leaked).toEqual([])
  }, 30_000)

  /**
   * 出网闸不许侵占权限模型的地盘。
   *
   * 一个**被明确授予** `process:exec` 的插件必须真的能起子进程——
   * 拿到了 `--allow-child-process` 旗子却在模块层被挡掉，
   * 是两套机制对同一件事给出相反的答案，那种自相矛盾比缺一层防护更难查。
   */
  test('授予 process:exec 的插件仍然起得了子进程，出网闸不越界', async () => {
    const { out } = await escapeProbe(['process:exec'])
    expect(out.cp).toBe('OK')
    // 顺手联网的路照样拆掉了——只是因为 exec 能绕，上报时不算「已拦截」。
    expect(out.esmNet).toBe('BLOCKED')
  }, 30_000)

  test('没有 process:exec 的插件起不了子进程 —— 那是权限模型挡的', async () => {
    const { out } = await escapeProbe(['network'])
    expect(out.cp).toBe('BLOCKED')
  }, 30_000)

  /**
   * 声明了 `network` 权限也一样挡。
   *
   * 权限的含义是「可以通过 host.net.fetch 出网」，不是「可以自己连」——
   * 前者过 SSRF 闸和审计，后者什么都不过。这两件事经常被混为一谈，
   * 所以单独立一条。
   */
  test('声明 network 权限不等于放行直接出网', async () => {
    const { out, netGuarded } = await escapeProbe()
    if (!netGuarded) return
    expect(out.esmNet).toBe('BLOCKED')
    expect(out.fetch).toBe('BLOCKED')
  }, 30_000)
})
