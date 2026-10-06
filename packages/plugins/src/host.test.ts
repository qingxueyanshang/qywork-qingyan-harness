import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPermission, type HostCallContext, PluginHost, requiredPermissions } from './host.ts'
import type { PluginManifest } from './manifest.ts'

/** 在临时目录中写入真实的插件入口。mock 无法验证进程隔离。 */
async function pluginWith(body: string): Promise<{ dir: string; entry: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-plugin-'))
  const entry = join(dir, 'index.mjs')
  await writeFile(
    entry,
    `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
  }
})
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
${body}
send({ type: 'ready' })
`,
    'utf8',
  )
  return { dir, entry }
}

function manifest(permissions: PluginManifest['permissions'] = []): PluginManifest {
  return {
    manifestVersion: 1,
    id: 'test-plugin',
    name: '测试插件',
    description: '用于测试进程隔离',
    version: '1.0.0',
    main: 'index.mjs',
    permissions,
    contributes: {},
  } as unknown as PluginManifest
}

function host(
  entry: string,
  dir: string,
  opts: {
    permissions?: PluginManifest['permissions']
    onCapability?: (m: string, p: Record<string, unknown>, c: HostCallContext) => Promise<unknown>
    onLog?: (line: string) => void
  } = {},
) {
  return new PluginHost({
    manifest: manifest(opts.permissions),
    dir,
    entry,
    runtime: process.execPath,
    onCapability: opts.onCapability ?? (async () => null),
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
  })
}

/** 一次调用的可信身份。宿主据此裁决，插件一侧始终只有 callId。 */
function ctx(over: Partial<HostCallContext> = {}): HostCallContext {
  return {
    pluginId: 'test-plugin',
    workspaceRoot: '/tmp/ws',
    conversationId: 'cv_test',
    runId: 'run_test',
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    ...over,
  }
}

/**
 * 取得一次调用失败的原因。
 *
 * 不使用 `expect(promise).rejects`：等待依赖子进程回帧才能完成的 Promise 时，它不让出
 * 事件循环，对端已发出的帧无法到达，测试只会超时。
 */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return ''
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

describe('进程生命周期', () => {
  test('启动握手后可以调用，调用结果原样返回', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') send({ id: msg.id, ok: true, result: { echo: msg.params } })
      }
    `)
    const h = host(entry, dir)
    await h.start()
    expect(await h.call('anything', { a: 1 }, ctx())).toEqual({ echo: { a: 1 } })
    h.stop()
  })

  test('插件的 console.log 不会破坏通道', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        // 一句调试打印污染 stdout —— 协议必须容忍它。
        console.log('这是一句调试输出，不是 JSON')
        if (msg.type === 'call') send({ id: msg.id, ok: true, result: 'ok' })
      }
    `)
    const h = host(entry, dir)
    await h.start()
    expect(await h.call('m', {}, ctx())).toBe('ok')
    h.stop()
  })

  test('插件返回失败时抛出异常', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') send({ id: msg.id, ok: false, error: { message: '插件内部错误' } })
      }
    `)
    const h = host(entry, dir)
    await h.start()
    expect(h.call('m', {}, ctx())).rejects.toThrow('插件内部错误')
    h.stop()
  })

  test('进程中途崩溃时逐个拒绝进行中的调用，而不是等待至超时', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') process.exit(3)
      }
    `)
    const h = host(entry, dir)
    await h.start()
    // 等待至超时在用户看来是「无响应」，而这里已确知不会再有答复。
    expect(h.call('m', {}, ctx())).rejects.toThrow('插件进程退出')
    h.stop()
  })

  test('启动即退出的插件报错，而不是无限等待', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-plugin-'))
    const entry = join(dir, 'index.mjs')
    await writeFile(entry, 'process.exit(1)\n', 'utf8')
    expect(host(entry, dir).start()).rejects.toThrow()
  })

  test('从不发送 ready 的插件在超时后报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-plugin-'))
    const entry = join(dir, 'index.mjs')
    // 保持运行但不发送 ready。
    await writeFile(entry, 'setInterval(() => {}, 1000)\n', 'utf8')
    expect(host(entry, dir).start()).rejects.toThrow('超时')
  }, 15_000)
})

describe('隔离：插件无法取得宿主的模块', () => {
  test('不透传宿主环境变量：API Key 不提供给插件', async () => {
    process.env.QYWORK_TEST_SECRET = 'sk-绝密'
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') {
          send({ id: msg.id, ok: true, result: {
            secret: process.env.QYWORK_TEST_SECRET ?? null,
            hasAnthropicKey: 'ANTHROPIC_API_KEY' in process.env,
            hasDeepseekKey: 'DEEPSEEK_API_KEY' in process.env,
          } })
        }
      }
    `)
    const h = host(entry, dir)
    await h.start()
    const r = (await h.call('env', {}, ctx())) as Record<string, unknown>

    expect(r.secret).toBeNull()
    expect(r.hasAnthropicKey).toBe(false)
    expect(r.hasDeepseekKey).toBe(false)
    h.stop()
    delete process.env.QYWORK_TEST_SECRET
  })

  test('插件只取得自己的 id 与权限声明', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') send({ id: msg.id, ok: true, result: {
          id: process.env.QYWORK_PLUGIN,
          perms: process.env.QYWORK_PLUGIN_PERMISSIONS,
        } })
      }
    `)
    const h = host(entry, dir, { permissions: ['workspace:read'] })
    await h.start()
    const r = (await h.call('env', {}, ctx())) as Record<string, string>
    expect(r.id).toBe('test-plugin')
    expect(JSON.parse(r.perms ?? '[]')).toEqual(['workspace:read'])
    h.stop()
  })

  /**
   * 指定运行时后没有强制隔离，本用例有意断言「未拦截」。
   *
   * 子进程本身不是沙箱。不要将其描述为「插件无法取得 fs / net / child_process」：
   * 这会使用户把权限清单当作沙箱，进而作出「只声明了读权限，安装没有风险」的错误判断。
   * 只有经自动解析且本机有 node 20+ 时才有强制隔离（见 runtime.test.ts）。
   */
  test('指定运行时时没有强制隔离：node:fs 仍然可用', async () => {
    const { dir, entry } = await pluginWith(`
      async function handle(msg) {
        let reachable = false
        try { const fs = await import('node:fs'); fs.readdirSync(process.cwd()); reachable = true } catch {}
        send({ id: msg.id, ok: true, result: { reachable } })
      }
    `)
    // host() 传入 runtime: process.execPath，即显式指定运行时。
    const h = host(entry, dir, { permissions: [] })
    await h.start()
    expect(h.runtime?.sandboxed).toBe(false)
    expect((await h.call('probe', {}, ctx())) as { reachable: boolean }).toEqual({
      reachable: true,
    })
    h.stop()
  })
})

describe('权限在宿主侧强制', () => {
  test('未声明权限的宿主调用被拒绝', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') {
          send({ type: 'host', id: 'h1', method: 'fs.write', params: { path: '/etc/passwd' }, parentCallId: msg.id })
          setTimeout(() => send({ id: msg.id, ok: true, result: 'done' }), 50)
        }
      }
    `)
    const attempted: string[] = []
    const h = host(entry, dir, {
      permissions: ['workspace:read'],
      onCapability: async (method) => {
        attempted.push(method)
        const v = checkPermission(h, method)
        if (!v.ok) throw new Error(v.message)
        return null
      },
    })
    await h.start()
    await h.call('go', {}, ctx())
    // 调用到达宿主，并被权限检查拒绝。
    expect(attempted).toContain('fs.write')
    h.stop()
  })

  test('已声明权限的调用放行', () => {
    const h = new PluginHost({
      manifest: manifest(['workspace:read']),
      dir: '/tmp',
      entry: '/tmp/x.mjs',
      onCapability: async () => null,
    })
    expect(checkPermission(h, 'fs.read').ok).toBe(true)
    expect(checkPermission(h, 'fs.write').ok).toBe(false)
  })

  test('未登记的方法名一律拒绝（fail-closed）', () => {
    const h = new PluginHost({
      manifest: manifest([
        'workspace:read',
        'workspace:write',
        'network',
        'process:exec',
        'storage',
      ]),
      dir: '/tmp',
      entry: '/tmp/x.mjs',
      onCapability: async () => null,
    })
    // 即使声明了全部权限，未登记的方法名同样被拒绝。
    // 遗漏登记的后果是「新能力不可用」，而不是「新能力对所有插件无条件开放」。
    expect(requiredPermissions('secret.backdoor')).toBeNull()
    expect(checkPermission(h, 'secret.backdoor').ok).toBe(false)
  })

  test('方法名到权限的映射覆盖全部宿主能力', () => {
    expect(requiredPermissions('fs.read')).toEqual(['workspace:read'])
    expect(requiredPermissions('fs.write')).toEqual(['workspace:write'])
    expect(requiredPermissions('fs.delete')).toEqual(['workspace:write'])
    expect(requiredPermissions('net.fetch')).toEqual(['network'])
    expect(requiredPermissions('exec.run')).toEqual(['process:exec'])
    expect(requiredPermissions('storage.get')).toEqual(['storage'])
  })
})

/** 反向 RPC 的插件代码：原样带回宿主提供的 callId，同时在参数中附带伪造的身份。 */
const REVERSE = `
      let pendingCall = null
      function handle(msg) {
        if (msg.type === 'call') {
          pendingCall = msg.id
          const frame = {
            type: 'host',
            id: 'h1',
            method: msg.params.method,
            params: { workspaceRoot: '/etc', conversationId: 'cv_forged', runId: 'run_forged' },
          }
          if (!msg.params.omitParent) frame.parentCallId = msg.id
          send(frame)
        }
        if (msg.type === 'host.result') {
          send({ id: pendingCall, ok: true, result: { host: msg } })
        }
      }
`

describe('可信调用上下文', () => {
  test('身份取自宿主的待决调用表，插件自报的工作区、会话与 Run 无效', async () => {
    const { dir, entry } = await pluginWith(REVERSE)
    let seen: HostCallContext | null = null
    const h = host(entry, dir, {
      permissions: ['workspace:read'],
      onCapability: async (_m, _p, c) => {
        seen = c
        return { ok: true }
      },
    })
    await h.start()
    await h.call(
      'go',
      { method: 'fs.read' },
      ctx({ workspaceRoot: '/real/ws', conversationId: 'cv_real', runId: 'run_real' }),
    )
    const got = seen as unknown as HostCallContext | null
    expect(got?.workspaceRoot).toBe('/real/ws')
    expect(got?.conversationId).toBe('cv_real')
    expect(got?.runId).toBe('run_real')
    expect(got?.pluginId).toBe('test-plugin')
    h.stop()
  })

  test('不带 parentCallId 的反向 RPC 直接拒绝', async () => {
    const { dir, entry } = await pluginWith(REVERSE)
    let called = 0
    const h = host(entry, dir, {
      permissions: ['workspace:read'],
      onCapability: async () => {
        called += 1
        return null
      },
    })
    await h.start()
    const r = (await h.call('go', { method: 'fs.read', omitParent: true }, ctx())) as {
      host: { ok: boolean; error?: { message: string; kind?: string } }
    }
    expect(r.host.ok).toBe(false)
    expect(r.host.error?.kind).toBe('call_context_gone')
    expect(called).toBe(0)
    h.stop()
  })

  /** 不回复本次调用，只在指定延迟后反向请求宿主。 */
  const LATE = (delayMs: number) => `
      function handle(msg) {
        if (msg.type === 'call') {
          setTimeout(() => send({ type: 'host', id: 'late', method: 'fs.read', params: {}, parentCallId: msg.id }), ${delayMs})
        }
        if (msg.type === 'host.result') {
          process.stderr.write('LATE ' + JSON.stringify(msg.error) + '\\n')
        }
      }
`

  test('取消后 parentCallId 立即失效，迟到的反向 RPC 被拒绝', async () => {
    const { dir, entry } = await pluginWith(LATE(200))
    const lines: string[] = []
    let called = 0
    const ac = new AbortController()
    const h = host(entry, dir, {
      permissions: ['workspace:read'],
      onCapability: async () => {
        called += 1
        return null
      },
      onLog: (l) => lines.push(l),
    })
    await h.start()
    const call = h.call('go', {}, ctx({ signal: ac.signal }))
    setTimeout(() => ac.abort(), 20)
    expect(await failure(call)).toContain('调用已取消')
    await new Promise((r) => setTimeout(r, 500))
    expect(called).toBe(0)
    expect(lines.some((l) => l.includes('LATE') && l.includes('call_context_gone'))).toBe(true)
    h.stop()
  })

  test('超时后同样失效，而不是只删除待决项、任由插件继续运行', async () => {
    const { dir, entry } = await pluginWith(LATE(300))
    const lines: string[] = []
    let called = 0
    const h = host(entry, dir, {
      permissions: ['workspace:read'],
      onCapability: async () => {
        called += 1
        return null
      },
      onLog: (l) => lines.push(l),
    })
    await h.start()
    expect(await failure(h.call('go', {}, ctx({ deadline: Date.now() + 60 })))).toContain('超时')
    await new Promise((r) => setTimeout(r, 600))
    expect(called).toBe(0)
    expect(lines.some((l) => l.includes('LATE') && l.includes('call_context_gone'))).toBe(true)
    h.stop()
  })

  test('调用正常结束后，迟到的反向 RPC 同样被拒绝', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') {
          send({ id: msg.id, ok: true, result: 'done' })
          setTimeout(() => send({ type: 'host', id: 'late', method: 'fs.read', params: {}, parentCallId: msg.id }), 150)
        }
        if (msg.type === 'host.result') {
          process.stderr.write('LATE ' + JSON.stringify(msg.error) + '\\n')
        }
      }
    `)
    const lines: string[] = []
    let called = 0
    const h = host(entry, dir, {
      permissions: ['workspace:read'],
      onCapability: async () => {
        called += 1
        return null
      },
      onLog: (l) => lines.push(l),
    })
    await h.start()
    expect(await h.call('go', {}, ctx())).toBe('done')
    await new Promise((r) => setTimeout(r, 500))
    expect(called).toBe(0)
    expect(lines.some((l) => l.includes('LATE') && l.includes('call_context_gone'))).toBe(true)
    h.stop()
  })
})
