import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
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

  test('工作区的 .qy 保护不受额外目录影响', async () => {
    const { root, extra } = await withExtra()
    await expect(
      resolveWritablePath({ workspaceRoot: root, additional: [extra] }, '.qy/mcp.json'),
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
 * `.qy/` 的写保护。
 *
 * 这一条挡的不是**越权**，是**自我提权**：`.qy/mcp.json` 决定模型能拿到哪些工具，
 * `.qy/plugins/` 决定装什么插件。模型完全合法地能写工作区内的文件，
 * 于是它可以通过写一个自己有权限写的文件，给自己加工具。
 *
 * 所以两种权限模式都要挡——`full` 的意思是「不裁决这次操作」，
 * 不是「可以修改裁决规则本身」。
 */
describe('受保护目录', () => {
  test('.qy 下的写入被拒，且理由说清是为什么', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.qy/mcp.json')).rejects.toThrow(/权限|扩展配置/)
    await expect(resolveWritablePath(dir, '.qy/plugins/evil/qywork.plugin.json')).rejects.toThrow()
  })

  /** 绕过尝试：`..` 回绕、大小写、分隔符混用。判定基于已解析的绝对路径，都该挡住。 */
  test('绕不过去', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    const backslash = String.fromCharCode(92)
    for (const p of ['./.qy/x.json', 'sub/../.qy/x.json', `.qy${backslash}x.json`]) {
      await expect(resolveWritablePath(dir, p)).rejects.toThrow()
    }
  })

  test('工作区里其它地方照常能写', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, 'src/a.ts')).resolves.toContain('a.ts')
    // 名字里带 .qy 但不是那个目录的，不能误伤。
    await expect(resolveWritablePath(dir, '.qyx/a.ts')).resolves.toContain('a.ts')
    await expect(resolveWritablePath(dir, 'docs/.qy.md')).resolves.toContain('.qy.md')
  })

  /** 读不受限制：模型需要能看懂现有配置才能给出合理建议，看不等于改。 */
  test('只挡写，不挡读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    expect(isProtectedPath(dir, join(dir, '.qy', 'mcp.json'))).toBe(true)
    expect(isProtectedPath(dir, join(dir, 'src', 'a.ts'))).toBe(false)
  })
})
