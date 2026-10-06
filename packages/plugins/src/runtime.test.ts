/**
 * 运行时解析与沙箱。
 *
 * 本组最重要的两条断言都不针对功能是否正确：
 *
 * - 不能把 `process.execPath` 用作默认运行时。发布产物是单文件二进制，
 *   该路径指向 qy 本身，用它运行插件只会输出用法说明：插件在开发机上正常，
 *   在安装了发布包的用户机器上全部无法启动。
 * - 隔离范围必须如实上报，且分维度上报。沙箱（`--permission`）与网络访问限制
 *   （`netguard.ts`）的成立条件不同：版本要求不同，bun 上两者均不具备。
 *   合并为一句「已隔离」会给出一个不成立的承诺，用户的知情同意因此失去依据。
 *
 * 因此这里有两类断言，缺一不可：上报口径是否正确（`netGuarded` 何时应为
 * false），以及实际能否拦截（逐条执行逃逸路径）。
 * 只测前者会得到如实上报但无效的限制，只测后者会得到有效但失实的上报。
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
  test('Node 23+ 使用 --permission', () => {
    expect(sandboxArgs(24, req())?.args[0]).toBe('--permission')
  })

  test('Node 20~22 使用 --experimental-permission，标志名错误时进程无法启动', () => {
    expect(sandboxArgs(22, req())?.args[0]).toBe('--experimental-permission')
  })

  test('Node 18 没有权限模型，返回 null 而不是构造一组参数', () => {
    expect(sandboxArgs(18, req())).toBeNull()
  })

  test('插件目录始终可读，否则无法加载入口文件', () => {
    expect(sandboxArgs(24, req())?.args).toContain('--allow-fs-read=/ws/.qy/plugins/p')
  })

  test('未声明 workspace:read 时无法读取工作区', () => {
    expect(sandboxArgs(24, req())?.args).not.toContain('--allow-fs-read=/ws')
  })

  test('声明后才授予，读写分开授予', () => {
    const read = sandboxArgs(24, req(['workspace:read']))!.args
    expect(read).toContain('--allow-fs-read=/ws')
    expect(read.some((a) => a.startsWith('--allow-fs-write'))).toBe(false)

    const write = sandboxArgs(24, req(['workspace:write']))!.args
    expect(write).toContain('--allow-fs-write=/ws')
  })

  test('只有 process:exec 授予 --allow-child-process', () => {
    expect(sandboxArgs(24, req())?.args).not.toContain('--allow-child-process')
    expect(sandboxArgs(24, req(['process:exec']))?.args).toContain('--allow-child-process')
  })

  /**
   * worker 可另起一套运行环境绕过权限模型，原生插件可直接发起系统调用。
   * 插件没有正当理由需要它们，因此任何权限都不授予这两个参数。
   */
  test('从不授予 --allow-worker / --allow-addons', () => {
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

  test('说明必须包含网络访问的状态，无论是否已拦截', () => {
    for (const perms of [[], ['network'], ['process:exec']] as PluginPermission[][]) {
      const note = sandboxArgs(24, req(perms))?.note ?? ''
      expect(note).toMatch(/网络访问/)
    }
  })
})

/**
 * 网络访问限制的上报与实际拦截效果分开测试。
 *
 * 本组检查上报与实际行为是否一致：文档比实现乐观是插件隔离最常见的错误形状，
 * 因此对上报口径设置较多断言。
 */
describe('网络访问限制的上报口径', () => {
  test('版本满足时安装，且 netGuarded 为 true', () => {
    const r = sandboxArgs(24, req(['workspace:read']), 13)!
    expect(r.netGuarded).toBe(true)
    expect(r.args).toContain('--import')
  })

  /**
   * `module.registerHooks` 自 22.15 / 23.5 起提供。版本不足时不安装不完整的网络访问限制：
   * 只删除全局 fetch 而模块仍可 require，比不安装更糟：上报为「已拦截」，
   * 实际调用 `require('net')` 即可联网。
   */
  test('版本不足时不安装，也不误报', () => {
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

  test('版本恰好满足时安装', () => {
    expect(sandboxArgs(22, req(), 15)!.netGuarded).toBe(true)
    expect(sandboxArgs(23, req(), 5)!.netGuarded).toBe(true)
  })

  /**
   * 能启动子进程即可运行 curl。这是定义而不是漏洞：授予执行权即授予
   * 本机的全部操作能力。因此此时 `netGuarded` 必须上报 false，
   * 即使限制脚本确实已注入。上报 true 会使权限清单显得比实际严格。
   */
  test('持有 process:exec 时上报 false，限制脚本已注入也不视为已拦截', () => {
    const r = sandboxArgs(24, req(['process:exec']), 13)!
    expect(r.args).toContain('--import')
    expect(r.netGuarded).toBe(false)
    expect(r.note).toContain('process:exec')
  })

  /** 引导脚本同样受权限模型约束，读取被拒绝时插件无法启动。 */
  test('单独放行引导脚本所在目录', () => {
    const r = sandboxArgs(24, req(), 13)!
    const guardArg = r.args.find((a) => a.startsWith('--import'))
    expect(guardArg).toBeDefined()
    expect(r.args.filter((a) => a.startsWith('--allow-fs-read=')).length).toBeGreaterThanOrEqual(2)
  })

  /**
   * Windows 上 `--import` 不接受裸盘符路径，报
   * `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`，即把 `C:` 当作协议名。
   * 类 Unix 系统接受绝对路径，因此该错误只出现在 Windows 上，
   * 现象是插件启动即退出，与网络访问限制没有可见的关联。
   */
  test('--import 的参数是 file:// URL，不是裸路径', () => {
    const args = sandboxArgs(24, req(), 13)!.args
    const value = args[args.indexOf('--import') + 1]!
    expect(value.startsWith('file://')).toBe(true)
  })
})

describe('运行时解析', () => {
  test('显式指定时直接使用，不再推测', () => {
    const rt = resolvePluginRuntime({ ...req(), override: '/opt/custom-node' })
    expect(rt.command).toBe('/opt/custom-node')
    expect(rt.args).toEqual([])
    expect(rt.sandboxed).toBe(false)
  })

  /**
   * 自动解析必须选中能执行 JS 的运行时。
   * 单文件二进制中 `process.execPath` 是 qy 本身，选中它会使所有插件都无法启动。
   */
  test('自动解析出的运行时是 node 或 bun，不是宿主二进制', () => {
    const rt = resolvePluginRuntime(req(['workspace:read']))
    const name = basename(rt.command).toLowerCase()
    expect(name.startsWith('node') || name.startsWith('bun')).toBe(true)
  })

  test('解析到 node 时启用沙箱；解析到 bun 时说明没有沙箱', () => {
    const rt = resolvePluginRuntime(req(['workspace:read']))
    if (basename(rt.command).toLowerCase().startsWith('node')) {
      expect(rt.sandboxed).toBe(true)
      expect(rt.args).toContain('--allow-fs-read=/ws')
    } else {
      // bun 没有权限模型，此时必须上报 false：含糊的上报比不上报更糟。
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
    const out = (await h.call(
      'probe',
      {},
      {
        pluginId: manifest.id,
        workspaceRoot: dir,
        conversationId: 'cv_test',
        runId: 'run_test',
        signal: new AbortController().signal,
        deadline: Date.now() + 60_000,
      },
    )) as Record<string, string>
    const sandboxed = h.runtime?.sandboxed === true
    const netGuarded = h.runtime?.netGuarded === true
    h.stop()
    return { out, sandboxed, netGuarded }
  }

  test('沙箱生效时无法读取主目录、无法写入磁盘、无法启动子进程', async () => {
    const { out, sandboxed } = await probePlugin()
    if (!sandboxed) {
      // 本机没有 node 20+。不静默跳过：断言宿主如实上报没有隔离，
      // 使测试仍然验证一项事实，而不是恒定通过。
      expect(out.home).toBe('OK')
      return
    }
    expect(out.home).toBe('BLOCKED')
    expect(out.write).toBe('BLOCKED')
    expect(out.exec).toBe('BLOCKED')
  }, 20_000)

  /**
   * 网络访问限制安装后，插件进程内的直接网络通道被移除，只剩 `host.net.fetch`。
   * 本用例锁定这一事实：失败说明网络访问限制未安装或已被绕过。
   */
  test('直接打开套接字被拦截', async () => {
    const { out, netGuarded } = await probePlugin()
    if (!netGuarded) {
      // 本机无法安装网络访问限制（bun / 低版本 node）。不静默跳过：断言宿主如实上报没有限制，
      // 且此时网络确实可用，使测试仍然验证一项事实。
      expect(out.net).toBe('OK')
      return
    }
    expect(out.net).toBe('BLOCKED')
  }, 20_000)
})

/**
 * 逃逸路径逐条实测。
 *
 * 拦截效果只写在文档中时，没有任何检查保证它成立。
 * 本组把每条路径写成断言：任何一条被绕过，本组即失败。
 *
 * 全部在一个插件进程中执行：启动一个带权限模型的 node 需要数十毫秒，
 * 逐条启动进程会使本组成为整个测试套件中最慢的部分。
 */
describe('网络访问限制实测：每条逃逸路径', () => {
  async function escapeProbe(permissions: PluginPermission[] = ['network']) {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-ng-'))
    const entry = join(dir, 'index.mjs')
    const NL = String.fromCharCode(10)
    // 每条探针的结果为：取得 = OK，抛错 = BLOCKED。
    // 断言 BLOCKED 而不断言错误文案：文案可能修改，能否取得不会改变。
    const probes: [string, string][] = [
      ['esmNet', "const m = await import('node:net'); return typeof m.createConnection"],
      // 本条不应被网络访问限制拦截：child_process 由权限模型管理。
      // 两套机制对同一件事给出相反结论，比缺少一层防护更难排查。
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
        // 插件自行注册短路钩子放行 node:net。后注册的钩子先执行：
        // 不一并拦截 node:module 时，本条可使以上全部拦截失效。
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
      // 默认声明 network：网络访问限制对声明了网络权限的插件同样生效，
      // 目标是使 host.net.fetch（经过 SSRF 防护）成为唯一通道，
      // 而不是声明后即可任意连接。
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
    const out = (await h.call(
      'probe',
      {},
      {
        pluginId: manifest.id,
        workspaceRoot: dir,
        conversationId: 'cv_test',
        runId: 'run_test',
        signal: new AbortController().signal,
        deadline: Date.now() + 60_000,
      },
    )) as Record<string, string>
    const netGuarded = h.runtime?.netGuarded === true
    h.stop()
    return { out, netGuarded, keys: probes.map(([k]) => k) }
  }

  test('每条路径都被拦截，没有遗漏', async () => {
    const { out, netGuarded, keys } = await escapeProbe()
    if (!netGuarded) {
      // 无法安装网络访问限制的机器上不能静默通过，此时断言确实未拦截：
      // 在两种环境下都恒定通过的测试不验证任何内容。
      expect(out.esmNet).toBe('OK')
      return
    }
    // cp 由权限模型管理，不属于网络访问限制的职责范围，单独断言。
    const leaked = keys.filter((k) => k !== 'cp' && out[k] === 'OK')
    expect(leaked).toEqual([])
  }, 30_000)

  /**
   * 网络访问限制不得越过权限模型的职责范围。
   *
   * 被明确授予 `process:exec` 的插件必须能启动子进程：
   * 取得 `--allow-child-process` 参数却在模块层被拒绝，
   * 是两套机制对同一件事给出相反结论，比缺少一层防护更难排查。
   */
  test('授予 process:exec 的插件仍能启动子进程，网络访问限制不越界', async () => {
    const { out } = await escapeProbe(['process:exec'])
    expect(out.cp).toBe('OK')
    // 联网路径同样已被移除；由于 exec 可以绕过，上报时不视为已拦截。
    expect(out.esmNet).toBe('BLOCKED')
  }, 30_000)

  test('没有 process:exec 的插件无法启动子进程，由权限模型拦截', async () => {
    const { out } = await escapeProbe(['network'])
    expect(out.cp).toBe('BLOCKED')
  }, 30_000)

  /**
   * 声明 `network` 权限的插件同样被拦截。
   *
   * 该权限的含义是可以经由 host.net.fetch 访问网络，不是可以自行建立连接：
   * 前者经过 SSRF 防护与审计，后者不经过任何检查。两者容易混淆，
   * 因此单独设一条断言。
   */
  test('声明 network 权限不等于放行直接网络访问', async () => {
    const { out, netGuarded } = await escapeProbe()
    if (!netGuarded) return
    expect(out.esmNet).toBe('BLOCKED')
    expect(out.fetch).toBe('BLOCKED')
  }, 30_000)
})
