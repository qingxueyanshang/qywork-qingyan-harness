import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { ToolRegistry } from '@qywork/agent'
import { registerBuiltinTools } from './index.ts'
import {
  displayPath,
  isProtectedPath,
  normalizeAdditionalDirectories,
  PathEscapeError,
  resolveInWorkspace,
  resolveWritablePath,
} from './paths.ts'

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-test-'))
  await writeFile(join(dir, 'a.txt'), 'hello\nworld\n', 'utf8')
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'main.ts'), 'export const answer = 42\n', 'utf8')
  return dir
}

function ctx(root: string, approve = true): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => approve,
  }
}

function registry(): ToolRegistry {
  const r = new ToolRegistry()
  registerBuiltinTools(r)
  return r
}

describe('路径约束', () => {
  test('拒绝 .. 回溯', async () => {
    const root = await workspace()
    await expect(resolveInWorkspace(root, '../../../etc/passwd')).rejects.toBeInstanceOf(
      PathEscapeError,
    )
  })

  test('拒绝双重 URL 编码的回溯', async () => {
    const root = await workspace()
    await expect(resolveInWorkspace(root, '%252e%252e%252fescaped')).rejects.toBeInstanceOf(
      PathEscapeError,
    )
  })

  test('拒绝指向工作区外的符号链接', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8')
    try {
      await symlink(outside, join(root, 'link'))
    } catch {
      return // Windows 上无权限建符号链接时跳过
    }
    await expect(
      resolveInWorkspace(root, 'link/secret.txt', { mustExist: true }),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })

  test('放行工作区内的绝对路径', async () => {
    const root = await workspace()
    const abs = await resolveInWorkspace(root, join(root, 'a.txt'), { mustExist: true })
    expect(abs).toContain('a.txt')
  })
})

describe('额外根目录', () => {
  async function withExtra(): Promise<{ root: string; extra: string }> {
    const root = await workspace()
    const extra = await mkdtemp(join(tmpdir(), 'qywork-extra-'))
    await writeFile(join(extra, 'notes.md'), '# notes\n', 'utf8')
    return { root, extra }
  }

  test('清单内的绝对路径可读可写', async () => {
    const { root, extra } = await withExtra()
    const roots = { workspaceRoot: root, additional: [extra] }
    await expect(
      resolveInWorkspace(roots, join(extra, 'notes.md'), { mustExist: true }),
    ).resolves.toContain('notes.md')
    await expect(resolveWritablePath(roots, join(extra, 'out.txt'))).resolves.toContain('out.txt')
  })

  test('清单**外**的路径仍然拒绝', async () => {
    // 这条是整个特性的反向对照：加了额外目录不等于边界没了。
    const { root, extra } = await withExtra()
    const other = await mkdtemp(join(tmpdir(), 'qywork-other-'))
    await expect(
      resolveInWorkspace({ workspaceRoot: root, additional: [extra] }, join(other, 'x.txt')),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })

  test('不配额外目录时行为完全不变', async () => {
    const { root, extra } = await withExtra()
    await expect(resolveInWorkspace(root, join(extra, 'notes.md'))).rejects.toBeInstanceOf(
      PathEscapeError,
    )
  })

  test('相对路径的基准永远是工作区，不会落到额外目录里', async () => {
    // 否则 `read_file("notes.md")` 变成「在几个根里挨个碰运气」，
    // 命中哪一个取决于目录内容——同一句话两次可能读到不同的文件。
    const { root, extra } = await withExtra()
    await expect(
      resolveInWorkspace({ workspaceRoot: root, additional: [extra] }, 'notes.md', {
        mustExist: true,
      }),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })

  test('额外目录里的软链逃不出去', async () => {
    // 只按字面比较的话，额外目录里一个指向别处的软链能把整棵树带出来。
    // 额外根目录必须走与工作区**完全相同**的 realpath 判定。
    const { root, extra } = await withExtra()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-escape-'))
    await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8')
    try {
      await symlink(outside, join(extra, 'link'))
    } catch {
      return // Windows 上无权限建符号链接时跳过
    }
    await expect(
      resolveInWorkspace(
        { workspaceRoot: root, additional: [extra] },
        join(extra, 'link/secret.txt'),
        {
          mustExist: true,
        },
      ),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })

  test('额外目录不存在时只是不生效，不会让整次解析炸掉', async () => {
    const { root } = await withExtra()
    const roots = { workspaceRoot: root, additional: [join(tmpdir(), 'qywork-not-here-at-all')] }
    await expect(resolveInWorkspace(roots, 'a.txt', { mustExist: true })).resolves.toContain(
      'a.txt',
    )
  })

  test('工作区的 .qy / .agents 保护不受额外目录影响', async () => {
    const { root, extra } = await withExtra()
    await expect(
      resolveWritablePath({ workspaceRoot: root, additional: [extra] }, '.qy/team.json'),
    ).rejects.toThrow(/权限|扩展配置/)
    await expect(
      resolveWritablePath({ workspaceRoot: root, additional: [extra] }, '.agents/mcp.json'),
    ).rejects.toThrow(/权限|扩展配置/)
  })

  test('相对路径的配置项被拒，并且说得出为什么', async () => {
    const bad = normalizeAdditionalDirectories(['notes', './x'])
    expect(bad.dirs).toEqual([])
    expect(bad.problems).toHaveLength(2)
    expect(bad.problems[0]).toContain('绝对路径')
  })

  test('规范化会去重', async () => {
    const abs = process.platform === 'win32' ? 'C:\\data\\notes' : '/data/notes'
    const { dirs } = normalizeAdditionalDirectories([abs, abs, ''])
    expect(dirs).toHaveLength(1)
  })

  test('displayPath 对工作区外的文件给绝对路径', async () => {
    // 算成 `../../别处/x.ts` 的话，模型读不懂，拿去回填还会因为基准不同指向别处。
    const { root, extra } = await withExtra()
    expect(displayPath(root, join(extra, 'notes.md'))).toBe(join(extra, 'notes.md'))
    expect(displayPath(root, join(root, 'a.txt'))).toBe('a.txt')
  })
})

describe('文件工具', () => {
  test('读取返回带行号的正文', async () => {
    const root = await workspace()
    const out = await registry().execute('read_file', { path: 'a.txt' }, ctx(root))
    expect(out.status).toBe('success')
    expect(String(out.data?.content)).toContain('1\thello')
  })

  test('未读先写：拒绝覆盖已存在文件', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'write_file',
      { path: 'a.txt', content: 'clobbered' },
      ctx(root),
    )
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('stale_write')
    // 磁盘内容必须原封不动。
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  test('读过之后允许覆盖，并报告行级增删', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'a.txt' }, c)
    const out = await r.execute('write_file', { path: 'a.txt', content: 'hello\nthere\n' }, c)
    expect(out.status).toBe('success')
    expect(out.fileChanges?.[0]?.changeType).toBe('modified')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
  })

  test('新建文件不需要先读', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'write_file',
      { path: 'nested/deep/new.txt', content: 'x' },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect(out.fileChanges?.[0]?.changeType).toBe('created')
  })

  test('edit 命中多处且未开 replace_all 时失败，且不落盘', async () => {
    const root = await workspace()
    await writeFile(join(root, 'dup.txt'), 'x\nx\n', 'utf8')
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'dup.txt' }, c)
    const out = await r.execute(
      'edit_file',
      { path: 'dup.txt', old_string: 'x', new_string: 'y' },
      c,
    )
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('ambiguous_match')
    expect(await readFile(join(root, 'dup.txt'), 'utf8')).toBe('x\nx\n')
  })

  test('edit 唯一命中时替换成功', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'src/main.ts' }, c)
    const out = await r.execute(
      'edit_file',
      { path: 'src/main.ts', old_string: '42', new_string: '43' },
      c,
    )
    expect(out.status).toBe('success')
    expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('export const answer = 43\n')
  })
})

describe('权限闸', () => {
  test('拒绝授权时不执行，且 executed=false', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'write_file',
      { path: 'blocked.txt', content: 'x' },
      ctx(root, false),
    )
    expect(out.executed).toBe(false)
    expect(out.errorKind).toBe('permission_denied')
    expect(await readFile(join(root, 'blocked.txt'), 'utf8').catch(() => null)).toBeNull()
  })
})

describe('注册表', () => {
  test('未知工具 fail-closed，不伪装成功', async () => {
    const root = await workspace()
    const out = await registry().execute('no_such_tool', {}, ctx(root))
    expect(out.status).toBe('failure')
    expect(out.executed).toBe(false)
    expect(out.errorKind).toBe('unknown_tool')
  })

  test('重名注册直接抛，不静默覆盖', () => {
    const r = registry()
    expect(() => registerBuiltinTools(r)).toThrow(/重复注册/)
  })

  test('schema 按名排序输出（前缀缓存的前提）', () => {
    const names = registry()
      .schemas()
      .map((s) => s.name)
    expect(names).toEqual([...names].sort())
  })
})

describe('搜索与命令', () => {
  test('grep 能定位内容', async () => {
    const root = await workspace()
    const out = await registry().execute('grep', { pattern: 'answer' }, ctx(root))
    expect(out.status).toBe('success')
    expect((out.data?.matches as string[]).join('\n')).toContain('src/main.ts')
  })

  test('glob 能按模式找文件', async () => {
    const root = await workspace()
    const out = await registry().execute('glob', { pattern: '**/*.ts' }, ctx(root))
    expect(out.status).toBe('success')
    expect(out.data?.files).toContain('src/main.ts')
  })

  test('非零退出码报告为 failure 但仍带回输出', async () => {
    const root = await workspace()
    const cmd = process.platform === 'win32' ? 'exit 3' : 'exit 3'
    const out = await registry().execute('run_command', { command: cmd }, ctx(root))
    expect(out.status).toBe('failure')
    expect(out.data?.exitCode).toBe(3)
  })
})

/**
 * 凭证不进上下文。
 *
 * `read_file` 这条路原来完全没接脱敏：shell 的输出有 createStreamRedactor，
 * 而它把磁盘字节直接交给模型。一头拦一头不拦等于没拦——模型拿不到
 * `cat .env` 的输出，换 `read_file` 就拿到了，而它并不是在绕过什么，
 * 只是选了个更顺手的工具。
 */
describe('read_file 的凭证脱敏', () => {
  test('工作区里的私钥读不出明文', async () => {
    const root = await workspace()
    const body = 'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn'
    await writeFile(
      join(root, 'leaked.pem'),
      `-----BEGIN RSA PRIVATE KEY-----
${body}
-----END RSA PRIVATE KEY-----`,
      'utf8',
    )
    const out = await registry().execute('read_file', { path: 'leaked.pem' }, ctx(root))
    expect(out.status).toBe('success')
    expect(String(out.data?.content)).not.toContain(body)
  })

  test('.env 里的 token 读不出明文', async () => {
    const root = await workspace()
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz12'
    await writeFile(
      join(root, '.env'),
      `GITHUB_TOKEN=${token}
PORT=3000
`,
      'utf8',
    )
    const out = await registry().execute('read_file', { path: '.env' }, ctx(root))
    // 变量名和其余内容照常可见，只有值被屏蔽——模型仍然看得懂这个文件的结构。
    const content = String(out.data?.content)
    expect(content).not.toContain(token)
    expect(content).toContain('GITHUB_TOKEN')
    expect(content).toContain('PORT=3000')
  })

  /** 普通代码一个字都不许动，否则模型读到的和磁盘上的对不上，编辑就会失败。 */
  test('普通文件原样返回', async () => {
    const root = await workspace()
    const out = await registry().execute('read_file', { path: 'src/main.ts' }, ctx(root))
    expect(String(out.data?.content)).toContain('answer')
  })
})

/**
 * `probe_url`：起服务 → 等就绪 → 抓一次响应 → 关掉，一次调用内完成。
 *
 * 存在的理由是「起个服务看看页面能不能打开」在本仓**形状上做不到**：
 * `run_command` 是同步的，起一个不会自己退出的服务器就是阻塞到超时——
 * 与权限模式无关（实测：开了完全访问照样只等到 output_truncated）。
 *
 * 这一组先测边界再测功能：边界写错的代价是多一条绕开 SSRF 闸的出网通道，
 * 比功能不好使严重得多。
 */
describe('probe_url', () => {
  const run = (root: string, command: string, probe_url: string, timeout_ms = 15_000) =>
    registry().execute('run_command', { command, probe_url, timeout_ms }, ctx(root))

  /**
   * **只准回环。** `web_fetch` 那条路刻意挡掉本机（127.0.0.1 后面可能是 qy
   * 自己的 API），这条方向相反、边界也相反。放宽一点它就是第二条出网通道。
   */
  test('非回环地址一律拒绝，且不起进程', async () => {
    const root = await workspace()
    for (const url of [
      'http://example.com/',
      'http://8.8.8.8/',
      'http://192.168.1.10/',
      // 主机名不做 DNS 解析：解析结果由外部决定，等于没有边界。
      'http://dev.example.com/',
    ]) {
      const out = await run(root, 'echo 不该跑到这里', url)
      expect(out.status).toBe('failure')
      expect(out.errorKind).toBe('bad_request')
      expect(out.message).toContain('回环')
    }
  })

  /** IPv6 的等价写法按数值判，不按字面量——`::ffff:127.0.0.1` 也是回环。 */
  test('回环的各种写法都认', async () => {
    const root = await workspace()
    // 端口挑一个必然没人听的：这里只验「没被边界拒掉」，探测失败是预期的。
    for (const url of [
      'http://localhost:19801/',
      'http://127.0.0.1:19801/',
      'http://[::1]:19801/',
    ]) {
      const out = await run(root, 'exit 0', url, 1500)
      expect(out.errorKind).not.toBe('bad_request')
    }
  }, 20_000)

  test('非 http/https 拒绝', async () => {
    const root = await workspace()
    const out = await run(root, 'exit 0', 'file:///etc/passwd')
    expect(out.errorKind).toBe('bad_request')
  })

  /** 起真服务、真探测、真关掉——这条是整个功能的验收。 */
  test('起服务、抓到响应、进程随调用结束而消失', async () => {
    const root = await workspace()
    const port = 19807
    const server = `require('http').createServer((_,r)=>{r.writeHead(200);r.end('hello from probe')}).listen(${port},'127.0.0.1');setInterval(()=>{},1000)`
    const cmd = process.platform === 'win32' ? `node -e "${server}"` : `node -e '${server}'`
    const out = await run(root, cmd, `http://127.0.0.1:${port}/`)

    expect(out.status).toBe('success')
    const probe = out.data?.probe as { status: number; body: string }
    expect(probe.status).toBe(200)
    expect(probe.body).toContain('hello from probe')

    // **进程必须已经没了。** 这是这个形状的全部承诺：不跨出这次调用。
    // 还连得上就说明留了个孤儿，而孤儿会占着端口坑下一次运行。
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) {
      await Bun.sleep(100)
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
      } catch {
        gone = true
      }
    }
    expect(gone).toBe(true)
  }, 30_000)

  /**
   * 连不上要把**进程自己的输出**带回来。
   *
   * 端口被占、模块缺失这类原因只写在服务器的 stderr 里；只报一句「没连上」
   * 等于让模型去猜，而它猜的方向通常是再试一次。
   */
  test('探测失败带回进程输出', async () => {
    const root = await workspace()
    // 三层引号（shell / JS 源码 / 字符串字面量）嵌起来极易写错，
    // 用一个不含引号的消息，靠 process.stderr.write 输出。
    const marker = 'PORT_TAKEN_MARKER'
    const cmd =
      process.platform === 'win32'
        ? `node -e "process.stderr.write('${marker}')"`
        : `node -e "process.stderr.write('${marker}')"`
    const out = await run(root, cmd, 'http://127.0.0.1:19809/', 2000)
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('probe_failed')
    expect(JSON.stringify(out.data)).toContain(marker)
  }, 20_000)
})

/**
 * `.qy/` 与 `.agents/` 的写保护。
 *
 * 这一条挡的不是**越权**，是**自我提权**：`.agents/mcp.json` 决定模型能拿到哪些
 * 工具、`.agents/plugins/` 决定装什么插件、`.agents/skills/` 决定跑什么流程。
 * 模型完全合法地能写工作区内的文件，于是它可以通过写一个自己有权限写的文件，
 * 给自己加工具。
 *
 * 所以两种权限模式都要挡——`full` 的意思是「不裁决这次操作」，
 * 不是「可以修改裁决规则本身」。
 */
describe('受保护目录', () => {
  test('.qy 下的写入被拒，且理由说清是为什么', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.qy/team.json')).rejects.toThrow(/权限|扩展配置/)
  })

  /*
   * 用户层的技能 / MCP / 插件搬到 `.agents/` 之后，保护必须跟着搬。
   * 不搬的话这条防线就只剩一个空目录名——而空目录名看起来和防线一模一样。
   */
  test('.agents 下的写入同样被拒 —— 它现在装着技能、MCP、插件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.agents/mcp.json')).rejects.toThrow(/权限|扩展配置/)
    await expect(
      resolveWritablePath(dir, '.agents/plugins/evil/qywork.plugin.json'),
    ).rejects.toThrow()
    await expect(resolveWritablePath(dir, '.agents/skills/evil/SKILL.md')).rejects.toThrow()
  })

  /** 绕过尝试：`..` 回绕、大小写、分隔符混用。判定基于已解析的绝对路径，都该挡住。 */
  test('绕不过去', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    const backslash = String.fromCharCode(92)
    const attempts = [
      './.qy/x.json',
      'sub/../.qy/x.json',
      `.qy${backslash}x.json`,
      './.agents/x.json',
      'sub/../.agents/x.json',
      `.agents${backslash}x.json`,
    ]
    for (const p of attempts) {
      await expect(resolveWritablePath(dir, p)).rejects.toThrow()
    }
  })

  test('工作区里其它地方照常能写', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, 'src/a.ts')).resolves.toContain('a.ts')
    // 名字里带 .qy 但不是那个目录的，不能误伤。
    await expect(resolveWritablePath(dir, '.qyx/a.ts')).resolves.toContain('a.ts')
    await expect(resolveWritablePath(dir, 'docs/.qy.md')).resolves.toContain('.qy.md')
    await expect(resolveWritablePath(dir, '.agentsx/a.ts')).resolves.toContain('a.ts')
  })

  /** 读不受限制：模型需要能看懂现有配置才能给出合理建议，看不等于改。 */
  test('只挡写，不挡读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    expect(isProtectedPath(dir, join(dir, '.qy', 'team.json'))).toBe(true)
    expect(isProtectedPath(dir, join(dir, '.agents', 'mcp.json'))).toBe(true)
    expect(isProtectedPath(dir, join(dir, 'src', 'a.ts'))).toBe(false)
  })
})

describe('噪音目录', () => {
  /**
   * 复现原始失败形状：`coverage/` 曾经只有 `list_dir` 会列出来。
   *
   * 那份清单抄了三份（界面文件树 / glob·grep / list_dir），漂到 13 / 12 / 11 条。
   * `coverage` 不是点目录，躲不过任何一条点开头规则，所以它是唯一真正露出来的那个：
   * 用户在文件树里看不到，模型 `list_dir` 却列得出来，`grep` 又搜不进去。
   */
  test('list_dir 与 glob 对 coverage 给出同一个答案', async () => {
    const root = await workspace()
    await mkdir(join(root, 'coverage'), { recursive: true })
    await writeFile(join(root, 'coverage', 'lcov.ts'), 'export const x = 1\n', 'utf8')

    const listed = await registry().get('list_dir')?.fn({ path: '.' }, ctx(root))
    expect((listed?.data as { entries: string[] }).entries).not.toContain('coverage/')

    const globbed = await registry().get('glob')?.fn({ pattern: '**/*.ts' }, ctx(root))
    const files = (globbed?.data as { files: string[] }).files
    expect(files).toContain('src/main.ts')
    expect(files.some((p) => p.includes('coverage'))).toBe(false)
  })
})

describe('写路径的软链边界', () => {
  /**
   * 原始失败形状：`resolveInWorkspace(mustExist:false)` 只解析目标**已存在的祖先**，
   * 却返回未解析的字面路径。工作区里放一条指向界外的软链，
   * 边界查的是工作区、写下去的是软链指向的地方。
   *
   * 这里直接复现那个形状——包括**悬挂**软链（目标还不存在），
   * 那才是「写新文件」这条路上真正的破口。
   */
  test('指向界外的软链（含悬挂）不能写进去', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'qy-out-'))

    // 1. 悬挂软链：目标尚不存在，realpath 会失败，但写入照样跟随它。
    await symlink(join(outside, '还不存在.txt'), join(root, 'dangling'))
    expect(resolveInWorkspace(root, 'dangling')).rejects.toThrow(PathEscapeError)

    // 2. 已存在的软链。
    await writeFile(join(outside, '已存在.txt'), 'x', 'utf8')
    await symlink(join(outside, '已存在.txt'), join(root, 'existing'))
    expect(resolveInWorkspace(root, 'existing')).rejects.toThrow(PathEscapeError)

    // 3. 中间目录是软链，同样不行。
    await symlink(outside, join(root, 'dir'))
    expect(resolveInWorkspace(root, 'dir/新文件.txt')).rejects.toThrow(PathEscapeError)
  })

  /** 别拒过头：工作区内还不存在的新文件必须照常解析得出来。 */
  test('工作区内的新文件正常放行，且返回解析后的路径', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-ws-')))
    const abs = await resolveInWorkspace(root, '子目录/新文件.txt')
    expect(abs).toBe(join(root, '子目录', '新文件.txt'))
  })

  /**
   * 读与写必须落在**同一个键**上。
   *
   * 两者不同的话，`files.ts` 的「本轮读过没有」在软链根下永远取不到值，
   * 覆盖已存在的文件被恒定拒绝（macOS 的 /tmp → /private/tmp 就是这个形状）。
   */
  test('读路径与写路径解析出同一个绝对路径', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-ws-')))
    await writeFile(join(root, 'a.txt'), 'hi', 'utf8')
    const read = await resolveInWorkspace(root, 'a.txt', { mustExist: true })
    const write = await resolveInWorkspace(root, 'a.txt')
    expect(write).toBe(read)
  })
})
