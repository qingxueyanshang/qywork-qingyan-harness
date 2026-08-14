import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOST_CAPABILITIES, makeCapabilityHandler } from './capabilities.ts'

/** 「把某个环境变量原样打出来」。命令一律跑 bash（`commandShell()`），所以只有一种写法。 */
const echoEnv = (name: string) => `echo "[$${name}]"`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qywork-cap-'))
  await writeFile(join(root, 'a.txt'), '甲乙丙', 'utf8')
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'sub', 'b.txt'), 'b', 'utf8')
  const call = makeCapabilityHandler({ workspaceRoot: root, storageRoot: join(root, '.store') })
  return {
    root,
    call: (m: string, p: Record<string, unknown> = {}, id = 'test.plugin') => call(m, p, id),
  }
}

describe('fs 能力', () => {
  test('读文本', async () => {
    const { call } = await fixture()
    expect(await call('fs.read', { path: 'a.txt' })).toEqual({
      content: '甲乙丙',
      encoding: 'utf8',
    })
  })

  test('读二进制走 base64', async () => {
    const { call } = await fixture()
    const r = (await call('fs.read', { path: 'a.txt', encoding: 'base64' })) as any
    expect(Buffer.from(r.content, 'base64').toString('utf8')).toBe('甲乙丙')
  })

  test('列目录标出类型', async () => {
    const { call } = await fixture()
    const r = (await call('fs.list', { path: '.' })) as any
    expect(r.entries.find((e: any) => e.name === 'sub').kind).toBe('dir')
    expect(r.entries.find((e: any) => e.name === 'a.txt').kind).toBe('file')
    expect(r.truncated).toBe(false)
  })

  test('写入后能读回，父目录自动创建', async () => {
    const { root, call } = await fixture()
    await call('fs.write', { path: 'deep/nested/c.txt', content: 'x' })
    expect(await readFile(join(root, 'deep/nested/c.txt'), 'utf8')).toBe('x')
  })

  test('append 追加而不是覆盖', async () => {
    const { root, call } = await fixture()
    await call('fs.write', { path: 'a.txt', content: '丁', append: true })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('甲乙丙丁')
  })

  test('删文件可以，删目录被拒 —— 后果差着数量级', async () => {
    const { call } = await fixture()
    expect(await call('fs.delete', { path: 'sub/b.txt' })).toMatchObject({ deleted: 'sub/b.txt' })
    expect(call('fs.delete', { path: 'sub' })).rejects.toThrow('拒绝删除目录')
  })

  test('stat 给类型与大小', async () => {
    const { call } = await fixture()
    expect(await call('fs.stat', { path: 'a.txt' })).toMatchObject({ kind: 'file', size: 9 })
  })
})

describe('工作区边界 —— 权限说「能读工作区」不等于能读 ~/.ssh', () => {
  for (const method of ['fs.read', 'fs.stat', 'fs.delete']) {
    test(`${method} 挡住 ..`, async () => {
      const { call } = await fixture()
      expect(call(method, { path: '../../../etc/passwd' })).rejects.toThrow()
    })
  }

  test('fs.write 挡住 ..（目标还不存在也要挡）', async () => {
    const { call } = await fixture()
    expect(call('fs.write', { path: '../escaped.txt', content: 'x' })).rejects.toThrow()
  })

  test('挡住双重 URL 编码', async () => {
    const { call } = await fixture()
    expect(call('fs.read', { path: '%252e%252e%252fescaped' })).rejects.toThrow()
  })

  test('挡住绝对路径', async () => {
    const { call } = await fixture()
    expect(call('fs.read', { path: 'C:/Windows/win.ini' })).rejects.toThrow()
  })

  test('exec 的 cwd 也过同一道闸', async () => {
    const { call } = await fixture()
    expect(call('exec.run', { command: 'echo x', cwd: '../..' })).rejects.toThrow()
  })
})

describe('配额', () => {
  test('超大文件拒绝读，而不是读进内存再说', async () => {
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

describe('exec —— 绝不透传宿主环境变量', () => {
  test('能跑命令并拿到退出码与输出', async () => {
    const { call } = await fixture()
    const r = (await call('exec.run', { command: 'echo hello' })) as any
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
  })

  test('非零退出码如实回报，不当异常抛', async () => {
    const { call } = await fixture()
    expect(((await call('exec.run', { command: 'exit 3' })) as any).exitCode).toBe(3)
  })

  /**
   * 这条是整个插件隔离的成败所在。
   *
   * 宿主特意把插件进程的 env 洗干净（不给 API Key），如果插件转手能
   * exec 出一句 echo $ANTHROPIC_API_KEY 就全白做了。
   */
  test('宿主的密钥类环境变量在子进程里读不到', async () => {
    process.env.QYWORK_CAP_SECRET = 'super-secret-value'
    try {
      const { call } = await fixture()
      const cmd = echoEnv('QYWORK_CAP_SECRET')
      const r = (await call('exec.run', { command: cmd })) as any
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
  test('存了能取回', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'k', value: { n: 1 } })
    expect(await call('storage.get', { key: 'k' })).toMatchObject({
      value: { n: 1 },
      exists: true,
    })
  })

  test('没存过时 exists=false 而不是抛', async () => {
    const { call } = await fixture()
    expect(await call('storage.get', { key: '没有' })).toMatchObject({ value: null, exists: false })
  })

  test('删除后取不到', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'k', value: 1 })
    expect(await call('storage.delete', { key: 'k' })).toMatchObject({ deleted: true })
    expect(await call('storage.get', { key: 'k' })).toMatchObject({ exists: false })
  })

  test('两个插件的存储互相看不见', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'k', value: '甲的' }, 'plugin.a')
    await call('storage.set', { key: 'k', value: '乙的' }, 'plugin.b')
    expect(((await call('storage.get', { key: 'k' }, 'plugin.a')) as any).value).toBe('甲的')
    expect(((await call('storage.get', { key: 'k' }, 'plugin.b')) as any).value).toBe('乙的')
  })

  test('list 只列自己的 key', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'x', value: 1 }, 'plugin.a')
    await call('storage.set', { key: 'y', value: 1 }, 'plugin.b')
    expect(await call('storage.list', {}, 'plugin.a')).toEqual({ keys: ['x'] })
  })

  test('id 里的路径穿越直接拒绝，不试图消毒后继续', async () => {
    const { call } = await fixture()
    // 合法 id 在 manifest 解析期就限死了，能走到这里说明上游校验被绕过——
    // 那种情况下「尽力消毒后继续」是错的，应该停。
    expect(call('storage.set', { key: 'k', value: 1 }, '../../evil')).rejects.toThrow('非法插件 id')
  })

  test('斜杠被消掉而不是变成子目录', async () => {
    const { root, call } = await fixture()
    await call('storage.set', { key: 'k', value: 1 }, 'a/b')
    expect(await Bun.file(join(root, '.store', 'a_b.json')).exists()).toBe(true)
  })

  test('存储文件坏了当空处理，不让插件起不来', async () => {
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

describe('net.fetch 过 SSRF 闸', () => {
  test('内网地址被拒', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', { url: 'http://127.0.0.1:1/x' })).rejects.toThrow()
  })

  test('云元数据端点被拒 —— 这是 SSRF 最经典的目标', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', { url: 'http://169.254.169.254/latest/meta-data/' })).rejects.toThrow()
  })

  test('非 http 协议被拒', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', { url: 'file:///etc/passwd' })).rejects.toThrow()
  })

  test('缺 url 被拒', async () => {
    const { call } = await fixture()
    expect(call('net.fetch', {})).rejects.toThrow('缺少 url')
  })
})

describe('未登记的方法', () => {
  test('明确抛出，不返回 null —— 返回 null 插件会以为成功', async () => {
    const { call } = await fixture()
    expect(call('fs.chmod', { path: 'a.txt' })).rejects.toThrow('尚未实现')
  })

  test('能力清单与实现是同一份事实', async () => {
    const { call } = await fixture()
    for (const m of HOST_CAPABILITIES) {
      // 只要不是「尚未实现」就说明这条在 switch 里有分支；参数错随便报什么都行。
      const err = await call(m, {}).catch((e: Error) => e.message)
      expect(String(err)).not.toContain('尚未实现')
    }
  })
})
