import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostCallContext } from '@qywork/plugins'
import { HOST_CAPABILITIES, makeCapabilityHandler } from './capabilities.ts'

/** 原样输出某个环境变量的命令。命令一律由 bash 执行（`commandShell()`），因此只有一种写法。 */
const echoEnv = (name: string) => `echo "[$${name}]"`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qywork-cap-'))
  await writeFile(join(root, 'a.txt'), '甲乙丙', 'utf8')
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'sub', 'b.txt'), 'b', 'utf8')
  const call = makeCapabilityHandler({ workspaceRoot: root, storageRoot: join(root, '.store') })
  return {
    root,
    call: (m: string, p: Record<string, unknown> = {}, over: Partial<HostCallContext> = {}) =>
      call(m, p, context(root, over)),
  }
}

/** 一次调用的可信身份。宿主能力只读取该身份，不读取插件参数中自行声明的身份。 */
function context(root: string, over: Partial<HostCallContext> = {}): HostCallContext {
  return {
    pluginId: 'test.plugin',
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'run_test',
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    ...over,
  }
}

/*
 * 各项能力的返回值。
 *
 * `CapabilityHandler` 的返回类型是 `Promise<unknown>`，且**有意如此**：它是一条 JSON RPC
 * 边界，每个方法返回的形状不同，插件侧也只能取得 JSON。因此断言前在此处收窄类型：
 * 收窄写错时，下方的断言会失败，这正是测试应有的作用。
 */
interface FsRead {
  content: string
}
interface FsList {
  entries: { name: string; kind: string }[]
  truncated: boolean
}
interface ExecRun {
  exitCode: number
  stdout: string
}
interface StorageGet {
  value: unknown
}

describe('fs 能力', () => {
  test('读取文本', async () => {
    const { call } = await fixture()
    expect(await call('fs.read', { path: 'a.txt' })).toEqual({
      content: '甲乙丙',
      encoding: 'utf8',
    })
  })

  test('读取二进制使用 base64', async () => {
    const { call } = await fixture()
    const r = (await call('fs.read', { path: 'a.txt', encoding: 'base64' })) as FsRead
    expect(Buffer.from(r.content, 'base64').toString('utf8')).toBe('甲乙丙')
  })

  test('列出目录时标明类型', async () => {
    const { call } = await fixture()
    const r = (await call('fs.list', { path: '.' })) as FsList
    expect(r.entries.find((e) => e.name === 'sub')?.kind).toBe('dir')
    expect(r.entries.find((e) => e.name === 'a.txt')?.kind).toBe('file')
    expect(r.truncated).toBe(false)
  })

  test('写入后可读取，父目录自动创建', async () => {
    const { root, call } = await fixture()
    await call('fs.write', { path: 'deep/nested/c.txt', content: 'x' })
    expect(await readFile(join(root, 'deep/nested/c.txt'), 'utf8')).toBe('x')
  })

  test('append 追加而不是覆盖', async () => {
    const { root, call } = await fixture()
    await call('fs.write', { path: 'a.txt', content: '丁', append: true })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('甲乙丙丁')
  })

  test('允许删除文件，拒绝删除目录：两者的后果相差数个量级', async () => {
    const { call } = await fixture()
    expect(await call('fs.delete', { path: 'sub/b.txt' })).toMatchObject({ deleted: 'sub/b.txt' })
    expect(call('fs.delete', { path: 'sub' })).rejects.toThrow('拒绝删除目录')
  })

  test('stat 返回类型与大小', async () => {
    const { call } = await fixture()
    expect(await call('fs.stat', { path: 'a.txt' })).toMatchObject({ kind: 'file', size: 9 })
  })
})

describe('工作区边界：可读取工作区的权限不等于可读取 ~/.ssh', () => {
  for (const method of ['fs.read', 'fs.stat', 'fs.delete']) {
    test(`${method} 拒绝 ..`, async () => {
      const { call } = await fixture()
      expect(call(method, { path: '../../../etc/passwd' })).rejects.toThrow()
    })
  }

  test('fs.write 拒绝 ..（目标尚不存在时同样拒绝）', async () => {
    const { call } = await fixture()
    expect(call('fs.write', { path: '../escaped.txt', content: 'x' })).rejects.toThrow()
  })

  test('拒绝双重 URL 编码', async () => {
    const { call } = await fixture()
    expect(call('fs.read', { path: '%252e%252e%252fescaped' })).rejects.toThrow()
  })

  test('拒绝绝对路径', async () => {
    const { call } = await fixture()
    expect(call('fs.read', { path: 'C:/Windows/win.ini' })).rejects.toThrow()
  })

  test('exec 的 cwd 经过同一项边界检查', async () => {
    const { call } = await fixture()
    expect(call('exec.run', { command: 'echo x', cwd: '../..' })).rejects.toThrow()
  })
})

describe('配额', () => {
  test('拒绝读取超大文件，不先读入内存', async () => {
    const { root, call } = await fixture()
    await writeFile(join(root, 'big.bin'), Buffer.alloc(5 * 1024 * 1024), 'utf8')
    expect(call('fs.read', { path: 'big.bin' })).rejects.toThrow('上限')
  })

  test('超大写入被拒', async () => {
    const { call } = await fixture()
    expect(call('fs.write', { path: 'x', content: 'y'.repeat(9 * 1024 * 1024) })).rejects.toThrow(
      '上限',
    )
  })
})

describe('exec：不透传宿主环境变量', () => {
  test('能执行命令并取得退出码与输出', async () => {
    const { call } = await fixture()
    const r = (await call('exec.run', { command: 'echo hello' })) as ExecRun
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
  })

  test('非零退出码如实返回，不作为异常抛出', async () => {
    const { call } = await fixture()
    expect(((await call('exec.run', { command: 'exit 3' })) as ExecRun).exitCode).toBe(3)
  })

  /**
   * 本条决定插件隔离是否成立。
   *
   * 宿主专门清理了插件进程的 env（不提供 API Key）；若插件能经由
   * exec 执行 echo $ANTHROPIC_API_KEY，这层清理即失效。
   */
  test('宿主的密钥类环境变量在子进程中无法读取', async () => {
    process.env.QYWORK_CAP_SECRET = 'super-secret-value'
    try {
      const { call } = await fixture()
      const cmd = echoEnv('QYWORK_CAP_SECRET')
      const r = (await call('exec.run', { command: cmd })) as ExecRun
      expect(r.stdout).not.toContain('super-secret-value')
      expect(r.stdout).toContain('[]')
    } finally {
      delete process.env.QYWORK_CAP_SECRET
    }
  })

  test('空命令被拒', async () => {
    const { call } = await fixture()
    expect(call('exec.run', { command: '   ' })).rejects.toThrow('命令为空')
  })
})

describe('插件私有存储', () => {
  test('写入后可取回', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'k', value: { n: 1 } })
    expect(await call('storage.get', { key: 'k' })).toMatchObject({
      value: { n: 1 },
      exists: true,
    })
  })

  test('未写入时返回 exists=false 而不是抛错', async () => {
    const { call } = await fixture()
    expect(await call('storage.get', { key: '没有' })).toMatchObject({ value: null, exists: false })
  })

  test('删除后无法取得', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'k', value: 1 })
    expect(await call('storage.delete', { key: 'k' })).toMatchObject({ deleted: true })
    expect(await call('storage.get', { key: 'k' })).toMatchObject({ exists: false })
  })

  test('两个插件的存储互相不可见', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'k', value: '甲的' }, { pluginId: 'plugin.a' })
    await call('storage.set', { key: 'k', value: '乙的' }, { pluginId: 'plugin.b' })
    expect(
      ((await call('storage.get', { key: 'k' }, { pluginId: 'plugin.a' })) as StorageGet).value,
    ).toBe('甲的')
    expect(
      ((await call('storage.get', { key: 'k' }, { pluginId: 'plugin.b' })) as StorageGet).value,
    ).toBe('乙的')
  })

  test('list 只列出本插件的 key', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'x', value: 1 }, { pluginId: 'plugin.a' })
    await call('storage.set', { key: 'y', value: 1 }, { pluginId: 'plugin.b' })
    expect(await call('storage.list', {}, { pluginId: 'plugin.a' })).toEqual({ keys: ['x'] })
  })

  test('id 中的路径穿越直接拒绝，不尝试清理后继续', async () => {
    const { call } = await fixture()
    // 合法 id 在 manifest 解析阶段已经限定，执行到此处说明上游校验被绕过；
    // 此时清理后继续执行是错误的，应当终止。
    expect(call('storage.set', { key: 'k', value: 1 }, { pluginId: '../../evil' })).rejects.toThrow(
      '非法插件 id',
    )
  })

  test('斜杠被移除而不是成为子目录', async () => {
    const { root, call } = await fixture()
    await call('storage.set', { key: 'k', value: 1 }, { pluginId: 'a/b' })
    expect(await Bun.file(join(root, '.store', 'a_b.json')).exists()).toBe(true)
  })

  test('存储文件损坏时按空处理，不导致插件无法启动', async () => {
    const { root, call } = await fixture()
    await mkdir(join(root, '.store'), { recursive: true })
    await writeFile(join(root, '.store', 'test.plugin.json'), '{ 不是 json', 'utf8')
    expect(await call('storage.list')).toEqual({ keys: [] })
  })

  test('超出存储上限被拒', async () => {
    const { call } = await fixture()
    expect(call('storage.set', { key: 'k', value: 'x'.repeat(3 * 1024 * 1024) })).rejects.toThrow(
      '上限',
    )
  })

  test('空 key 被拒', async () => {
    const { call } = await fixture()
    expect(call('storage.get', { key: '' })).rejects.toThrow('缺少 key')
  })
})

describe('net.fetch 经过 SSRF 防护', () => {
  test('内网地址被拒', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', { url: 'http://127.0.0.1:1/x' })).rejects.toThrow()
  })

  test('云元数据端点被拒：这是 SSRF 最典型的目标', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', { url: 'http://169.254.169.254/latest/meta-data/' })).rejects.toThrow()
  })

  test('非 http 协议被拒', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', { url: 'file:///etc/passwd' })).rejects.toThrow()
  })

  test('缺少 url 被拒', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', {})).rejects.toThrow('缺少 url')
  })
})

describe('未登记的方法', () => {
  test('明确抛错，不返回 null：返回 null 在插件侧表现为一次成功调用', async () => {
    const { call } = await fixture()
    expect(call('fs.chmod', { path: 'a.txt' })).rejects.toThrow('尚未实现')
  })

  test('能力清单与实现一致', async () => {
    const { call } = await fixture()
    for (const m of HOST_CAPABILITIES) {
      // 错误不是「尚未实现」即说明该方法在 switch 中有分支；参数错误时报告任何错误均可。
      const err = await call(m, {}).catch((e: Error) => e.message)
      expect(String(err)).not.toContain('尚未实现')
    }
  })
})
