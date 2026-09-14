import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserPort } from '@qywork/agent'
import type { HostCallContext } from '@qywork/plugins'
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
    call: (m: string, p: Record<string, unknown> = {}, over: Partial<HostCallContext> = {}) =>
      call(m, p, context(root, over)),
  }
}

/** 一次调用的可信身份。宿主能力只读它，不读插件参数里自报的那些。 */
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
 * 这几条能力回什么。
 *
 * `CapabilityHandler` 的返回是 `Promise<unknown>` 且**有意如此**：它是一条 JSON RPC
 * 边界，每个方法回的形状不同，插件那侧也只拿得到 JSON。所以断言前在这里收窄——
 * 收窄写错了，下面那条断言就会红，这正是测试该干的事。
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
  test('读文本', async () => {
    const { call } = await fixture()
    expect(await call('fs.read', { path: 'a.txt' })).toEqual({
      content: '甲乙丙',
      encoding: 'utf8',
    })
  })

  test('读二进制走 base64', async () => {
    const { call } = await fixture()
    const r = (await call('fs.read', { path: 'a.txt', encoding: 'base64' })) as FsRead
    expect(Buffer.from(r.content, 'base64').toString('utf8')).toBe('甲乙丙')
  })

  test('列目录标出类型', async () => {
    const { call } = await fixture()
    const r = (await call('fs.list', { path: '.' })) as FsList
    expect(r.entries.find((e) => e.name === 'sub')?.kind).toBe('dir')
    expect(r.entries.find((e) => e.name === 'a.txt')?.kind).toBe('file')
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
    const r = (await call('exec.run', { command: 'echo hello' })) as ExecRun
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('hello')
  })

  test('非零退出码如实回报，不当异常抛', async () => {
    const { call } = await fixture()
    expect(((await call('exec.run', { command: 'exit 3' })) as ExecRun).exitCode).toBe(3)
  })

  /**
   * 这条是整个插件隔离的成败所在。
   *
   * 宿主特意把插件进程的 env 洗干净（不给 API Key），如果插件转手能
   * exec 出一句 echo $ANTHROPIC_API_KEY 就全部落空。
   */
  test('宿主的密钥类环境变量在子进程里读不到', async () => {
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
    await call('storage.set', { key: 'k', value: '甲的' }, { pluginId: 'plugin.a' })
    await call('storage.set', { key: 'k', value: '乙的' }, { pluginId: 'plugin.b' })
    expect(
      ((await call('storage.get', { key: 'k' }, { pluginId: 'plugin.a' })) as StorageGet).value,
    ).toBe('甲的')
    expect(
      ((await call('storage.get', { key: 'k' }, { pluginId: 'plugin.b' })) as StorageGet).value,
    ).toBe('乙的')
  })

  test('list 只列自己的 key', async () => {
    const { call } = await fixture()
    await call('storage.set', { key: 'x', value: 1 }, { pluginId: 'plugin.a' })
    await call('storage.set', { key: 'y', value: 1 }, { pluginId: 'plugin.b' })
    expect(await call('storage.list', {}, { pluginId: 'plugin.a' })).toEqual({ keys: ['x'] })
  })

  test('id 里的路径穿越直接拒绝，不试图消毒后继续', async () => {
    const { call } = await fixture()
    // 合法 id 在 manifest 解析期就限死了，能走到这里说明上游校验被绕过——
    // 那种情况下「尽力消毒后继续」是错的，应该停。
    expect(call('storage.set', { key: 'k', value: 1 }, { pluginId: '../../evil' })).rejects.toThrow(
      '非法插件 id',
    )
  })

  test('斜杠被消掉而不是变成子目录', async () => {
    const { root, call } = await fixture()
    await call('storage.set', { key: 'k', value: 1 }, { pluginId: 'a/b' })
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
  test('明确抛出，不返回 null —— 返回 null 在插件侧是一次成功调用', async () => {
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

describe('浏览器能力', () => {
  /** 记下端口收到了什么。断言的是「宿主传下去的是什么」，不是调了几次。 */
  function fakeBrowser(): { port: BrowserPort; calls: { method: string; input: unknown }[] } {
    const calls: { method: string; input: unknown }[] = []
    const note = (method: string, input: unknown) => {
      calls.push({ method, input })
    }
    const port: BrowserPort = {
      tabs: async () => {
        note('tabs', null)
        return [{ tabId: 'bt_1', url: 'https://a', title: 'A', controlled: true }]
      },
      open: async (url) => {
        note('open', url)
        return { tabId: 'bt_1', url, title: '', controlled: true }
      },
      bind: async (tabId) => {
        note('bind', tabId)
        return { tabId, url: '', title: '', controlled: true }
      },
      close: async (tabId) => note('close', tabId),
      navigate: async (input) => {
        note('navigate', input)
        return {
          tabId: input.tabId,
          url: input.url ?? '',
          title: '',
          controlled: true,
        }
      },
      observe: async (input) => {
        note('observe', input)
        return {
          tabId: input.tabId,
          url: 'https://a',
          title: 'A',
          observationId: 'ob_1',
          elements: [],
          truncated: false,
        }
      },
      act: async (input) => {
        note('act', input)
        return {}
      },
      wait: async (input) => {
        note('wait', input)
        return { found: true }
      },
      upload: async (input) => {
        note('upload', input)
        return { files: input.paths }
      },
      download: async (input) => {
        note('download', input)
        return { path: input.absolutePath, bytes: 3 }
      },
      armDownload: async () => {},
      disarmDownload: async () => false,
      release: async () => {},
    }
    return { port, calls }
  }

  test('没有端口时明确失败，不静默成功', async () => {
    const { call } = await fixture()
    expect(
      await call('browser.observe', { tabId: 'bt_1' }).catch((e: Error) => e.message),
    ).toContain('没有内置浏览器控制')
  })

  test('只放行 http 与 https', async () => {
    const { call } = await fixture()
    const { port } = fakeBrowser()
    const fail = (url: string) =>
      call('browser.open', { url }, { browser: port }).catch((e: Error) => e.message)
    expect(await fail('file:///C:/Windows/win.ini')).toContain('只支持 http 与 https')
    expect(await fail('javascript:alert(1)')).toContain('只支持 http 与 https')
    expect(await call('browser.open', { url: 'https://a/' }, { browser: port })).toMatchObject({
      tabId: 'bt_1',
    })
  })

  test('动作名与按键不认的直接拒绝，不猜一个近似的', async () => {
    const { call } = await fixture()
    const { port } = fakeBrowser()
    const err = await call(
      'browser.act',
      { tabId: 'bt_1', observationId: 'ob_1', action: 'drag', ref: 'e1' },
      { browser: port },
    ).catch((e: Error) => e.message)
    expect(String(err)).toContain('action 只能是')
  })

  test('上传路径先过工作区裁决，越界的进不到端口', async () => {
    const { root, call } = await fixture()
    const { port, calls } = fakeBrowser()
    const ok = (await call(
      'browser.upload',
      { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1', paths: ['a.txt'] },
      { browser: port },
    )) as { files: string[] }
    expect(ok.files[0]).toBe(join(realpathSync(root), 'a.txt'))
    expect(calls.at(-1)?.method).toBe('upload')

    const err = await call(
      'browser.upload',
      { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1', paths: ['../../../etc/hosts'] },
      { browser: port },
    ).catch((e: Error) => e.message)
    expect(String(err)).not.toBe('')
    // 越界那次没有走到端口。
    expect(calls.filter((c) => c.method === 'upload')).toHaveLength(1)
  })

  test('下载路径同样先裁决，端口拿到的是绝对路径', async () => {
    const { root, call } = await fixture()
    const { port, calls } = fakeBrowser()
    const got = (await call(
      'browser.download',
      { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1', path: 'out/x.bin' },
      { browser: port },
    )) as { path: string }
    expect(got.path).toBe(join(realpathSync(root), 'out', 'x.bin'))
    const sent = calls.at(-1)?.input as { absolutePath: string }
    expect(sent.absolutePath).toBe(join(realpathSync(root), 'out', 'x.bin'))

    const err = await call(
      'browser.download',
      { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1', path: '../escape.bin' },
      { browser: port },
    ).catch((e: Error) => e.message)
    expect(String(err)).not.toBe('')
    expect(calls.filter((c) => c.method === 'download')).toHaveLength(1)
  })

  test('额外根目录与完全访问的语义跟着这一轮会话走', async () => {
    const { root, call } = await fixture()
    const { port } = fakeBrowser()
    const outside = join(root, '..', 'qywork-cap-outside.bin')
    const denied = await call(
      'browser.download',
      { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1', path: outside },
      { browser: port },
    ).catch((e: Error) => e.message)
    expect(String(denied)).not.toBe('')

    const allowed = (await call(
      'browser.download',
      { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1', path: outside },
      { browser: port, unrestrictedPaths: true },
    )) as { path: string }
    expect(allowed.path).toContain('qywork-cap-outside.bin')
  })

  test('停止之后不再发起新动作', async () => {
    const { call } = await fixture()
    const { port, calls } = fakeBrowser()
    const ac = new AbortController()
    ac.abort()
    const err = await call(
      'browser.act',
      { tabId: 'bt_1', observationId: 'ob_1', action: 'click', ref: 'e1' },
      { browser: port, signal: ac.signal },
    ).catch((e: Error) => e.message)
    expect(String(err)).toContain('已停止')
    expect(calls).toHaveLength(0)
  })

  test('模型把可选参数写成 null 时按缺席处理，不当成非法值拒绝', async () => {
    const { call } = await fixture()
    const { port, calls } = fakeBrowser()
    await call(
      'browser.observe',
      { tabId: 'bt_1', frame: null, offset: null, screenshot: null },
      { browser: port },
    )
    expect(calls.at(-1)?.input).toEqual({ tabId: 'bt_1' })

    await call(
      'browser.act',
      { tabId: 'bt_1', observationId: 'ob_1', action: 'click', ref: 'e1', text: null, key: null },
      { browser: port },
    )
    expect(calls.at(-1)?.input).toEqual({
      tabId: 'bt_1',
      observationId: 'ob_1',
      action: 'click',
      ref: 'e1',
    })

    // 空文本对 fill 是有意义的：它是「清空这个输入框」。
    await call(
      'browser.act',
      { tabId: 'bt_1', observationId: 'ob_1', action: 'fill', ref: 'e1', text: '' },
      { browser: port },
    )
    expect((calls.at(-1)?.input as { text?: string }).text).toBe('')
  })

  test('等待时长有上限，不接受任意值', async () => {
    const { call } = await fixture()
    const { port, calls } = fakeBrowser()
    await call(
      'browser.wait',
      { tabId: 'bt_1', selector: '#x', timeoutMs: 9_999_999 },
      { browser: port },
    )
    expect((calls.at(-1)?.input as { timeoutMs: number }).timeoutMs).toBe(60_000)
  })
})
