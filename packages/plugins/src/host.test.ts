import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPermission, PluginHost, requiredPermission } from './host.ts'
import type { PluginManifest } from './manifest.ts'

/** 写一个真实的插件进程到临时目录。用假 mock 验不出进程隔离。 */
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
    onCapability?: (m: string, p: Record<string, unknown>) => Promise<unknown>
  } = {},
) {
  return new PluginHost({
    manifest: manifest(opts.permissions),
    dir,
    entry,
    runtime: process.execPath,
    onCapability: opts.onCapability ?? (async () => null),
  })
}

describe('进程生命周期', () => {
  test('启动握手后可以调用，调用结果原样回来', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') send({ id: msg.id, ok: true, result: { echo: msg.params } })
      }
    `)
    const h = host(entry, dir)
    await h.start()
    expect(await h.call('anything', { a: 1 })).toEqual({ echo: { a: 1 } })
    h.stop()
  })

  test('插件的 console.log 不会搞崩通道', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        // 一句调试打印污染 stdout —— 协议必须容忍它。
        console.log('这是一句调试输出，不是 JSON')
        if (msg.type === 'call') send({ id: msg.id, ok: true, result: 'ok' })
      }
    `)
    const h = host(entry, dir)
    await h.start()
    expect(await h.call('m')).toBe('ok')
    h.stop()
  })

  test('插件返回失败时以异常上抛', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') send({ id: msg.id, ok: false, error: { message: '插件内部错误' } })
      }
    `)
    const h = host(entry, dir)
    await h.start()
    expect(h.call('m')).rejects.toThrow('插件内部错误')
    h.stop()
  })

  test('进程中途崩溃时在飞的调用被逐个拒绝，不是挂到超时', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') process.exit(3)
      }
    `)
    const h = host(entry, dir)
    await h.start()
    // 挂到超时对用户表现为「卡住」，而这里明确知道不会再有答复了。
    expect(h.call('m')).rejects.toThrow('插件进程退出')
    h.stop()
  })

  test('启动即退出的插件报错而不是无限等', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-plugin-'))
    const entry = join(dir, 'index.mjs')
    await writeFile(entry, 'process.exit(1)\n', 'utf8')
    expect(host(entry, dir).start()).rejects.toThrow()
  })

  test('从不发 ready 的插件在超时后报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-plugin-'))
    const entry = join(dir, 'index.mjs')
    // 挂住不动，不发 ready。
    await writeFile(entry, 'setInterval(() => {}, 1000)\n', 'utf8')
    expect(host(entry, dir).start()).rejects.toThrow('超时')
  }, 15_000)
})

describe('隔离：插件拿不到宿主的东西', () => {
  test('宿主环境变量不透传 —— API Key 不该白送给插件', async () => {
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
    const r = (await h.call('env')) as Record<string, unknown>

    expect(r.secret).toBeNull()
    expect(r.hasAnthropicKey).toBe(false)
    expect(r.hasDeepseekKey).toBe(false)
    h.stop()
    delete process.env.QYWORK_TEST_SECRET
  })

  test('插件只拿到自己的 id 与权限声明', async () => {
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
    const r = (await h.call('env')) as Record<string, string>
    expect(r.id).toBe('test-plugin')
    expect(JSON.parse(r.perms ?? '[]')).toEqual(['workspace:read'])
    h.stop()
  })

  /**
   * 指定了运行时就没有强制隔离——这条**故意断言「没挡住」**。
   *
   * 子进程本身不是沙箱。别把它说成「插件拿不到 fs / net / child_process」——
   * 那会让用户把权限清单当沙箱看，于是「它只声明了读，装了没风险」这个判断是错的。
   * 只有走自动解析、且机器上有 node 20+ 时才有强制隔离（见 runtime.test.ts）。
   */
  test('指定运行时时没有强制隔离：node:fs 仍然可用', async () => {
    const { dir, entry } = await pluginWith(`
      async function handle(msg) {
        let reachable = false
        try { const fs = await import('node:fs'); fs.readdirSync(process.cwd()); reachable = true } catch {}
        send({ id: msg.id, ok: true, result: { reachable } })
      }
    `)
    // host() 传的是 runtime: process.execPath，即显式指定。
    const h = host(entry, dir, { permissions: [] })
    await h.start()
    expect(h.runtime?.sandboxed).toBe(false)
    expect((await h.call('probe')) as { reachable: boolean }).toEqual({ reachable: true })
    h.stop()
  })
})

describe('权限在宿主侧强制', () => {
  test('未声明权限的宿主调用被拒', async () => {
    const { dir, entry } = await pluginWith(`
      function handle(msg) {
        if (msg.type === 'call') {
          send({ type: 'host', id: 'h1', method: 'fs.write', params: { path: '/etc/passwd' } })
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
    await h.call('go')
    // 调用到达了宿主，但被权限闸拒了 —— 插件自己根本没有 fs。
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

  test('未登记的方法名一律拒绝 —— fail-closed', () => {
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
    // 就算声明了全部权限，没登记的方法名也进不来。
    // 忘了登记的后果是「新能力用不了」，不是「新能力对所有插件无条件开放」。
    expect(requiredPermission('secret.backdoor')).toBeNull()
    expect(checkPermission(h, 'secret.backdoor').ok).toBe(false)
  })

  test('方法名到权限的映射覆盖全部能力轴', () => {
    expect(requiredPermission('fs.read')).toBe('workspace:read')
    expect(requiredPermission('fs.write')).toBe('workspace:write')
    expect(requiredPermission('fs.delete')).toBe('workspace:write')
    expect(requiredPermission('net.fetch')).toBe('network')
    expect(requiredPermission('exec.run')).toBe('process:exec')
    expect(requiredPermission('storage.get')).toBe('storage')
  })
})
