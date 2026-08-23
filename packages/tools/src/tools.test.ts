import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { ToolRegistry } from '@qywork/agent'
import { registerBuiltinTools } from './index.ts'
import {
  displayPath,
  isProtectedPath,
  normalizeAdditionalDirectories,
  PathEscapeError,
  PathNotFoundError,
  ProtectedPathError,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
} from './paths.ts'
import { startCommandRunner } from './runner.ts'
import { BASH_PATH_ENV, commandShell, setCommandRunner } from './sandbox.ts'

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
    contextWindow: 200_000,
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

/**
 * 在「这台机器没有 bash」的状态里跑一段。
 *
 * 用 `QYWORK_BASH_PATH` 指到一个不存在的位置来制造这个状态——那是探测的第一顺位，
 * 所以它同时验了两件事：**指错即无**，以及**探测是每次现跑的**（缓存的话这里拿到的
 * 还是上一轮的结果）。
 *
 * **整段执行都要留在这个状态里**，所以它是 async 的：`spawnGuarded` 起进程时会自己
 * 重新探一次 shell，提前把环境变量还回去的话，注册按 PowerShell 算、真正执行的却是
 * bash——而那种测试永远是绿的，测的却不是它声称的那件事。
 */
async function withoutBash<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env[BASH_PATH_ENV]
  process.env[BASH_PATH_ENV] = join(tmpdir(), 'qywork-there-is-no-bash-here')
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env[BASH_PATH_ENV]
    else process.env[BASH_PATH_ENV] = prev
  }
}

/**
 * 越界被拒之后，模型手里那条回话决定它下一步干什么。
 *
 * 复现的原始失败形状：读桌面上某个项目被拒，回话只有一句「工具 read_file
 * 执行出错: 路径越界」——模型把它当成偶发故障，转头用 `run_command` 绕过去
 * （shell 只锁 cwd，命令正文里 `cd` 得出去），全程没告诉用户发生了什么。
 */
describe('越界拒绝是判定，不是崩溃', () => {
  const denial = async () => {
    const root = await workspace()
    return registry().execute(
      'read_file',
      { path: join(tmpdir(), 'somewhere-else', 'README.md') },
      ctx(root),
    )
  }

  test('不套「执行出错」的壳，errorKind 说清是哪一类', async () => {
    const out = await denial()
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('path_out_of_workspace')
    expect(out.message).not.toContain('执行出错')
    // 什么都没发生过——`executed: true` 会让崩溃恢复以为可能有副作用。
    expect(out.executed).toBe(false)
  })

  /**
   * 两条出路都要给全：切「完全访问」是真的能解开（那个模式下路径边界整个不设），
   * 加 `additionalDirectories` 则是不放开全部权限、只开这一个目录。
   * 少说一条就是把用户往另一条上逼。
   */
  test('回话给得出两条出路，且不诱导绕过', async () => {
    const out = await denial()
    expect(out.message).toContain('完全访问')
    expect(out.message).toContain('additionalDirectories')
    expect(out.message).toContain('不要改用 run_command')
  })
})

/**
 * 「完全访问」= 全部权限，**路径边界也归它管**。
 *
 * 原始失败形状（会话 `cv_0msw3jst9`）：用户开着完全访问，`read_file` 桌面上的
 * 项目被路径层拒，而同一个模式下 `run_command` 是全放行的——模型于是
 * `cd /c/Users/.../qywork && head -c 6000 README.md` 读到了同一个文件，
 * 全程没告诉用户。只放开权限闸、留着路径层，得到的不是更安全，是两套账。
 */
describe('完全访问：路径边界跟着一起放开', () => {
  test('工作区外的绝对路径照读', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-outside-'))
    await writeFile(join(outside, 'note.md'), '界外的正文\n', 'utf8')

    // 走 `rootsOf`，顺带覆盖 ToolContext 的 `unrestrictedPaths` → 根目录清单那一跳。
    const roots = rootsOf({ workspaceRoot: root, unrestrictedPaths: true })
    await expect(
      resolveInWorkspace(roots, join(outside, 'note.md'), { mustExist: true }),
    ).resolves.toContain('note.md')
    // 同一个路径在自动审批下仍然拒——放开的是模式，不是这条判定本身。
    await expect(
      resolveInWorkspace({ workspaceRoot: root }, join(outside, 'note.md'), { mustExist: true }),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })

  /**
   * `.agents/` 那条挡的是「给自己加工具」，而完全访问下模型手里的 `run_command`
   * 是全放行的，`echo > .agents/x` 一行就写进去了。留着只会变成又一处
   * 「文件工具拦、shell 不拦」。
   */
  test('受保护目录的写入也跟着放开', async () => {
    const root = await workspace()
    await expect(
      resolveWritablePath({ workspaceRoot: root, unrestricted: true }, '.agents/mcp.json'),
    ).resolves.toBeDefined()
    await expect(resolveWritablePath(root, '.agents/mcp.json')).rejects.toBeInstanceOf(
      ProtectedPathError,
    )
  })

  /**
   * 放开的是**归属判定**，不是解析本身：返回的仍然是 realpath 之后那一个路径。
   * 返回字面路径的话，调用方拿它记「本轮读过没有」，软链根下的新鲜度判定会恒错。
   */
  test('仍然返回 realpath 之后的路径，不是字面路径', async () => {
    const root = await workspace()
    const resolved = await resolveInWorkspace(
      { workspaceRoot: root, unrestricted: true },
      'src/../src/main.ts',
      { mustExist: true },
    )
    expect(resolved).toBe(await realpath(join(root, 'src', 'main.ts')))
  })
})

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
    //
    // 报的是**不存在**而不是**越界**：这个相对路径解析出来就在工作区里，
    // 只是那儿没有这个文件。报成越界的话，模型收到的是一句它无法执行的权限话术
    // （「让用户切到完全访问」），而真相是它把文件名记错了。
    const { root, extra } = await withExtra()
    await expect(
      resolveInWorkspace({ workspaceRoot: root, additional: [extra] }, 'notes.md', {
        mustExist: true,
      }),
    ).rejects.toBeInstanceOf(PathNotFoundError)
    // 额外目录里那一份没有被拿来顶替——这才是这条测试真正要锁的东西。
    expect(await stat(join(extra, 'notes.md')).then(() => true)).toBe(true)
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

  /**
   * 读不出整数的 offset 是**失败**，不是一次读到 0 行的成功。
   *
   * 原始失败形状：模型把行区间写成一个串（`offset: "1,4000"`），
   * `Math.max(1, Number(...))` 得到 NaN，`slice(NaN, NaN)` 是空数组，
   * `truncated` 拿 NaN 去比也为假——回给模型的是
   * 「success / 0 行 / 没截断 / 文件有 349 行」四条互相矛盾的事实。
   */
  test('offset 读不出整数时失败，而不是成功读到 0 行', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'read_file',
      { path: 'a.txt', offset: '1,4000' },
      ctx(root),
    )
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('invalid_args')
    expect(out.message).toContain('1,4000')
  })

  test('字符串写的整数照收，越界的整数仍然钳到第一行', async () => {
    const root = await workspace()
    const r = registry()
    const asText = await r.execute('read_file', { path: 'a.txt', offset: '2' }, ctx(root))
    expect(asText.status).toBe('success')
    expect(String(asText.data?.content)).toStartWith('2\tworld')
    const clamped = await r.execute('read_file', { path: 'a.txt', offset: 0 }, ctx(root))
    expect(clamped.status).toBe('success')
    expect(String(clamped.data?.content)).toStartWith('1\thello')
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

  /**
   * 增删数按**位置**算。
   *
   * 每一条都是「按文本出现过没有」那种算法会数错的形状——它们全部会被算成 0。
   */
  describe('行级增删', () => {
    const rewrite = async (before: string, after: string) => {
      const root = await workspace()
      const r = registry()
      const c = ctx(root)
      await writeFile(join(root, 'f.txt'), before, 'utf8')
      await r.execute('read_file', { path: 'f.txt' }, c)
      const out = await r.execute('write_file', { path: 'f.txt', content: after }, c)
      expect(out.status).toBe('success')
      return out.fileChanges?.[0]
    }

    test('插进去的空行算新增', async () => {
      expect(await rewrite('a\n\nb\n', 'a\n\n\n\nb\n')).toMatchObject({
        additions: 2,
        deletions: 0,
      })
    })

    test('旧文件里别处有同一行，照样算新增', async () => {
      // `}` 在旧文件里已经有一个；新增的那一段自带一个，它是真新增。
      expect(await rewrite('f()\n}\n', 'f()\n}\ng()\n}\n')).toMatchObject({
        additions: 2,
        deletions: 0,
      })
    })

    test('整块搬家两头都算', async () => {
      expect(await rewrite('a\nb\nc\nd\n', 'c\nd\na\nb\n')).toMatchObject({
        additions: 2,
        deletions: 2,
      })
    })

    test('一个字没动就是 0', async () => {
      expect(await rewrite('a\nb\nc\n', 'a\nb\nc\n')).toMatchObject({
        additions: 0,
        deletions: 0,
      })
    })

    test('整份换掉：新的全算增、旧的全算删', async () => {
      expect(await rewrite('a\nb\nc\n', 'x\ny\n')).toMatchObject({ additions: 2, deletions: 3 })
    })

    /**
     * 封顶那一档。差得比 MAX_EDIT 还远时报满——**不是回落到别的算法**。
     * 一万行全不一样，报 10000/10000 就是对的。
     */
    test('差到封顶之外报满，且不会跑很久', async () => {
      const old = Array.from({ length: 10_000 }, (_, i) => `旧 ${i}`).join('\n')
      const now = Array.from({ length: 10_000 }, (_, i) => `新 ${i}`).join('\n')
      const started = performance.now()
      expect(await rewrite(old, now)).toMatchObject({ additions: 10_000, deletions: 10_000 })
      expect(performance.now() - started).toBeLessThan(3000)
    })
  })

  /**
   * **读记录的寿命由装配方定，这里只验两端。**
   *
   * 上一轮读过、这一轮直接改，是完全正常的用法。记录挂在 run 内的便签上时
   * 每轮清零一次，于是这种用法必然先失败一次「本轮未读取过」。
   *
   * 接上会话级 port 之后不再重来；而**没接上时行为一个字不变**（更严的那一侧），
   * 所以两条都测。
   */
  describe('跨轮读记录', () => {
    /** 一个最小的会话级 port：两个 run 共用同一份，正是 runtime 注入的那种形状。 */
    function sessionReads() {
      const m = new Map<string, string>()
      return {
        seen: (p: string) => m.get(p) ?? null,
        mark: (p: string, h: string) => void m.set(p, h),
      }
    }

    test('接上会话级记录后，上一轮读过这一轮就能直接改', async () => {
      const root = await workspace()
      const r = registry()
      const reads = sessionReads()
      // 第一轮：读。第二轮是**另一个 ToolContext**（run 之间必须重建）。
      await r.execute('read_file', { path: 'a.txt' }, { ...ctx(root), reads })
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', old_string: 'world', new_string: 'there' },
        { ...ctx(root), reads },
      )
      expect(out.status).toBe('success')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
    })

    test('没接 port 时仍然要求本 run 读过 —— 退化到更严的一侧', async () => {
      const root = await workspace()
      const r = registry()
      await r.execute('read_file', { path: 'a.txt' }, ctx(root))
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', old_string: 'world', new_string: 'there' },
        ctx(root),
      )
      expect(out.status).toBe('failure')
      expect(out.errorKind).toBe('stale_write')
    })

    test('会话级记录照样拦得住「你读完之后文件被改过」', async () => {
      const root = await workspace()
      const r = registry()
      const reads = sessionReads()
      await r.execute('read_file', { path: 'a.txt' }, { ...ctx(root), reads })
      // 别人（用户、另一个进程）改了盘上的内容。
      await writeFile(join(root, 'a.txt'), 'hello\nworld\nplus\n', 'utf8')
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', old_string: 'world', new_string: 'there' },
        { ...ctx(root), reads },
      )
      expect(out.status).toBe('failure')
      expect(out.errorKind).toBe('stale_write')
    })
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

  /**
   * 单个文件命中过多时**必须报截断**，而且两条引擎给同一个上界。
   *
   * 原始失败形状：ripgrep 那条带每文件上限，而 `truncated` 只按总条数（200）算——
   * 实测本仓 `packages/ai` 搜 `cache`：真实 168 行、拿回 159 行、报 `truncated: false`。
   * 丢了 9 行，模型据此认为搜全了。降级那条则完全没有每文件上限，
   * 同一个查询在装没装 rg 的机器上结果不同。
   *
   * 第二个模式带前瞻断言：rg 的引擎不认（退出码 2），因此必然走降级遍历。
   */
  test('单个文件命中超过每文件上限时报截断，两条引擎同一个上界', async () => {
    const root = await workspace()
    const many = Array.from({ length: 60 }, (_, i) => `needle ${i}`).join('\n')
    await writeFile(join(root, 'many.txt'), many, 'utf8')
    const sizes: number[] = []
    for (const pattern of ['needle', 'needle(?= )']) {
      const out = await registry().execute('grep', { pattern, path: 'many.txt' }, ctx(root))
      expect(out.status).toBe('success')
      expect(out.data?.truncated).toBe(true)
      sizes.push((out.data?.matches as string[]).length)
    }
    expect(sizes[0]).toBe(sizes[1])
  })

  /**
   * 起点是一个**文件**时照样搜得到。
   *
   * 原始失败形状：`grep(pattern, path="js/game.js")` 回 `success` + 0 命中——
   * rg 那条拿文件当 `cwd` 去 spawn 直接抛、降级那条对文件 `readdir` 也抛被吞掉，
   * 两条一起落空。模型据此判定「这个符号不存在」，然后去读整个文件。
   */
  test('grep 的起点可以是一个文件，不只是目录', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'grep',
      { pattern: 'answer', path: 'src/main.ts' },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect(out.data?.matches).toEqual(['src/main.ts:1:export const answer = 42'])
  })

  /**
   * 命中路径**永远相对工作区根**，不随搜索起点变。
   *
   * rg 打印的是相对搜索起点的路径：`path="src"` 时它给的是 `main.ts`，
   * 而模型只会照着这个字符串去 `read_file`，拿到的是「文件不存在」。
   * 两条实现路径也必须给出同一种路径——否则同一个工具会随 rg 装没装而变。
   */
  test('grep 的命中路径相对工作区根，与搜索起点无关', async () => {
    const root = await workspace()
    for (const path of ['.', 'src', 'src/main.ts']) {
      const out = await registry().execute('grep', { pattern: 'answer', path }, ctx(root))
      expect((out.data?.matches as string[])[0]).toStartWith('src/main.ts:1:')
    }
  })

  /**
   * 降级遍历给出与 rg **同一种**结果，起点是文件时也一样。
   *
   * 触发方式是前瞻断言：rg 的引擎不支持 look-around，会以退出码 2 失败，
   * 而 JS 的 `RegExp` 认它——所以这条在装了 rg 和没装 rg 的机器上都走降级路径。
   * 装没装 rg 是机器差异，而一个工具的返回格式不该随机器变。
   */
  test('rg 跑不了的正则降级到内置遍历，路径格式不变', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'grep',
      { pattern: '(?=export)export const answer', path: 'src/main.ts' },
      ctx(root),
    )
    expect(out.data?.engine).toBe('builtin')
    expect(out.data?.matches).toEqual(['src/main.ts:1:export const answer = 42'])
  })

  test('glob 能按模式找文件', async () => {
    const root = await workspace()
    const out = await registry().execute('glob', { pattern: '**/*.ts' }, ctx(root))
    expect(out.status).toBe('success')
    expect(out.data?.files).toContain('src/main.ts')
  })

  /**
   * 工具说明里必须写明**真正在跑的那个 shell**，而且写在第一句。
   *
   * `run_command` 这个名字不携带语法，模型的默认输出是 bash——语法只剩描述这一个
   * 来源，而描述是从头读的。埋在第三句等于没说：账本里有过只被告知「平台：win32」
   * 就写出 POSIX 组合命令、在 PowerShell 上一个字都没执行的调用。
   * 锁的是「说的和跑的是同一个」，不是某句文案。
   */
  test('run_command 的说明第一句就是语法提示，且点到真正那个可执行文件', () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const spec = registry()
      .list()
      .find((t) => t.name === 'run_command')
    expect(spec?.description.startsWith(shell.hint)).toBe(true)
    // 三档共用一条断言：提示里必须出现真正被 spawn 的那个可执行文件的名字。
    const exe = basename(shell.path).toLowerCase().replace('.exe', '')
    expect(shell.hint.toLowerCase()).toContain(exe)
  })

  /**
   * **一个 shell 都没有才不给 `run_command`**，而不是有一个必然失败的工具。
   *
   * 藏起 bash 之后这台机器落到哪一档，由它自己装了什么定，所以两条路都断言：
   * - 落到 PowerShell → 照样注册，**而且真跑得通一条命令**。注册了却跑不了比不注册更糟。
   * - 一档都没有 → 工具表里少那一格，其余一个不少。
   */
  test('藏起 bash 之后：有 PowerShell 就照样注册并跑得通，一档都没有才不注册', async () => {
    const root = await workspace()
    expect(
      registry()
        .list()
        .map((t) => t.name),
    ).toContain('run_command')

    const shell = await withoutBash(() => commandShell())
    const names = await withoutBash(() =>
      registry()
        .list()
        .map((t) => t.name),
    )
    // 其余工具一个都不能少——shell 那一格只影响这一个。
    expect(names).toContain('read_file')
    expect(names).toContain('grep')

    if (shell === null) {
      expect(names).not.toContain('run_command')
      return
    }
    expect(names).toContain('run_command')
    // 非 bash 的语法提示必须自己否掉 bash，否则模型照 POSIX 写。
    expect(shell.hint).toContain('不是 bash')
    const out = await withoutBash(() =>
      registry().execute('run_command', { command: 'echo qywork-shell-ok' }, ctx(root)),
    )
    expect(out.status).toBe('success')
    expect(String(out.data?.stdout)).toContain('qywork-shell-ok')
  }, 20_000)

  /**
   * 顺序执行两条命令，用**当前这个 shell 的写法**。
   *
   * 测的是原始失败形状：bash 与 pwsh 7 上是 `&&`，而 Windows PowerShell 5.1 上
   * `&&` 是解析错误、整条命令一个字都不执行，那一档的写法只能是 `;`。
   * 分叉按可执行文件名判——那正是 `resolveCommandShell` 挑中它用的同一把钥匙。
   */
  test('当前 shell 的组合命令能跑通', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const root = await workspace()
    const sep = basename(shell.path).toLowerCase().startsWith('powershell') ? ';' : '&&'
    const out = await registry().execute(
      'run_command',
      { command: `echo a ${sep} echo b` },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect(String(out.data?.stdout)).toContain('a')
    expect(String(out.data?.stdout)).toContain('b')
  })

  test('非零退出码报告为 failure 但仍带回输出', async () => {
    const root = await workspace()
    const out = await registry().execute('run_command', { command: 'exit 3' }, ctx(root))
    expect(out.status).toBe('failure')
    expect(out.data?.exitCode).toBe(3)
  })

  /**
   * **原始失败形状**：命令跑完了、shell 也正常退出了，但它留下的后台进程继承了
   * stdout 的写端还活着，于是管道永远不 EOF。账本里那次是 `run.ps1 start`
   * （起了个 node 服务留在后台，而那正是脚本该做的事）：界面上那条 `run_command`
   * 停在「正在执行」371 秒不动，超过默认超时 120 秒两倍还多——超时到点的树杀够不着
   * 已经脱离父子关系的孙进程，而超时那条返回分支又排在等 EOF 之后，于是永远走不到。
   * 后果不止这一次调用：`runs.unregister` 不执行，整条会话此后回绝所有新任务。
   *
   * 锁两件事：**它按时回传**，以及**它说出了后台还留着进程**。只锁前者的话，
   * 一条压根没复现出这个形状的命令也能让这条测试全绿。
   *
   * PowerShell 那一档的写法**本机没验过**（这台机器有 bash，走的是另一条）。
   */
  test('留下后台进程扣住管道时，命令仍按时回传并说明情况', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const root = await workspace()
    // 按 argv 分叉而不是按可执行文件名：`-Command` 是两档 PowerShell 共有的，
    // 而名字要同时认 powershell.exe 和 pwsh.exe。
    const command = shell.argv.includes('-Command')
      ? "Write-Output started; Start-Process -NoNewWindow -FilePath cmd.exe -ArgumentList '/c','ping -n 21 127.0.0.1'"
      : 'echo started; sleep 20 &'

    const started = Date.now()
    const out = await registry().execute('run_command', { command }, ctx(root))
    const elapsed = Date.now() - started

    expect(out.status).toBe('success')
    expect(String(out.data?.stdout)).toContain('started')
    // 挂死的话这里是 20 秒起步，改回等 EOF 就永远回不来。
    expect(elapsed).toBeLessThan(5_000)
    expect(out.message).toContain('后台进程仍在运行并持有输出管道')
  }, 30_000)

  /**
   * 同一件事在 **runner 路径**上也要成立——那才是产品实际走的那条。
   *
   * `qy serve` 的命令一律由 runner 代跑（它是那个「先于监听端口出生」的父进程），
   * 上一条测的却是直接 spawn。两条路的差别恰好落在这句话上：runner 那侧一旦在
   * 收到退出码时就把流关掉，读端立刻拿到 EOF，`backgroundHeld` 恒为 false——
   * 于是这句提示在真正跑着的产品里一次也发不出来，而两条路的测试都是绿的。
   */
  test('runner 代跑时同样说得出后台进程', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const root = await workspace()
    const command = shell.argv.includes('-Command')
      ? "Write-Output started; Start-Process -NoNewWindow -FilePath cmd.exe -ArgumentList '/c','ping -n 21 127.0.0.1'"
      : 'echo started; sleep 20 &'

    const runner = startCommandRunner([
      process.execPath,
      '-e',
      `import { runCommandRunner } from ${JSON.stringify(Bun.fileURLToPath(new URL('./runner.ts', import.meta.url)))}; runCommandRunner()`,
    ])
    setCommandRunner(runner)
    try {
      const started = Date.now()
      const out = await registry().execute('run_command', { command }, ctx(root))
      expect(out.status).toBe('success')
      expect(String(out.data?.stdout)).toContain('started')
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(out.message).toContain('后台进程仍在运行并持有输出管道')
    } finally {
      // 这是个进程级变量，留着会让本文件后面的命令都改走 runner。
      setCommandRunner(null)
      runner.stop()
    }
  }, 30_000)

  /**
   * **用户点了停止，它就得停。**
   *
   * 这是上一条的同一个根因在另一面的表现：中断只是 abort 一个信号，它停不掉一个
   * 不返回的 `await`。命令派生了脱离进程树的后台进程时，树杀杀得掉前台那半、
   * 杀不掉那个孤儿，于是等 EOF 的调用继续挂着——界面上就是「点了停止但它不停」。
   *
   * 前台那半故意留长（30 秒），孤儿也留着：**两半都得停，测试才算数**。
   */
  test('中断时立刻收手，哪怕有孤儿进程扣着管道', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const root = await workspace()
    const command = shell.argv.includes('-Command')
      ? "Start-Process -NoNewWindow -FilePath cmd.exe -ArgumentList '/c','ping -n 31 127.0.0.1'; Start-Sleep -Seconds 30"
      : 'sleep 30 & sleep 30'

    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 300)
    const out = await registry().execute(
      'run_command',
      { command },
      { ...ctx(root), signal: controller.signal },
    )
    const elapsed = Date.now() - started

    // 不断言状态：被杀掉的进程退出码由平台定。要锁的是「它回来了」。
    expect(out).toBeTruthy()
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)
})

/**
 * 凭证不进上下文。
 *
 * `read_file` 这条路不接脱敏就是把磁盘字节直接交给模型。一头拦一头不拦等于没拦
 * ——模型拿不到 `cat .env` 的输出，换 `read_file` 就拿到了，
 * 而它并不是在绕过什么，只是选了个更顺手的工具。
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
 * 工具、`.agents/plugins/` 决定装什么插件。模型完全合法地能写工作区内的文件，
 * 于是它可以通过写一个自己有权限写的文件，给自己加工具。
 *
 * **判据是「会不会给自己加工具」**：技能与记忆同在 `.agents/` 下却不在墙内——
 * 一篇 SKILL.md 是一段提示词，一条记忆是一句事实，两者都不给新能力。
 * 按目录一刀切挡过它们的代价实测付过：设置页的「新增技能」把话头递给模型，
 * 而模型写不了那个文件，那颗按钮等于点了没反应。
 *
 * `full` 下这一层不设（`resolveWritablePath` 的 `unrestricted`）：那个模式里
 * `run_command` 全放行，只拦文件工具就是两套账。
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
  test('会加工具的那两条被拒：mcp.json 与 plugins/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.agents/mcp.json')).rejects.toThrow(/权限|扩展配置/)
    await expect(
      resolveWritablePath(dir, '.agents/plugins/evil/qywork.plugin.json'),
    ).rejects.toThrow()
  })

  /**
   * 复现的失败形状：「新增技能」这颗按钮把话头递给模型，而模型一写
   * `.agents/skills/x/SKILL.md` 就被这道墙拒了——那颗按钮等于点了没反应。
   * 技能是提示词，不给任何新能力，本来就不该在墙内。
   */
  test('技能与记忆不在墙内 —— 它们不给新能力', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.agents/skills/发版/SKILL.md')).resolves.toContain(
      'SKILL.md',
    )
    await expect(resolveWritablePath(dir, '.agents/memory/x.md')).resolves.toContain('x.md')
  })

  /** 逐段比而不是字符串前缀：`pluginsX` 不是 `plugins` 下面的东西。 */
  test('名字撞了前缀的目录不受牵连', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.agents/pluginsX/a.md')).resolves.toContain('a.md')
  })

  /** 绕过尝试：`..` 回绕、大小写、分隔符混用。判定基于已解析的绝对路径，都该挡住。 */
  test('绕不过去', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    const backslash = String.fromCharCode(92)
    const attempts = [
      './.qy/x.json',
      'sub/../.qy/x.json',
      `.qy${backslash}x.json`,
      './.agents/mcp.json',
      'sub/../.agents/mcp.json',
      `.agents${backslash}plugins${backslash}x.json`,
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
   * 复现原始失败形状：噪音目录清单各抄一份（界面文件树 / glob·grep / list_dir）
   * 会漂——实测漂到过 13 / 12 / 11 条。`coverage` 不是点目录，躲不过任何一条
   * 点开头规则，所以它是唯一真正露出来的那个：
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

/**
 * grep 的两条引擎必须有同一个上界。
 *
 * 复现的是一次真账（会话 `cv_0mt0x92q10000mx0dff`）：一次不限文件类型的 grep
 * 命中 152 行，151 行都不到 600 字符，剩下那一行是 `three.min.js` 的第 6 行——
 * **603,378 个字符**，约 17 万 token。它随工具结果进上下文之后再没出去，
 * 此后每一轮都重付一遍，还把请求顶过了长上下文档的价钱，一轮 $3.49。
 *
 * 成因是两条引擎两套口径：内置遍历那条截到 400，ripgrep 那条只限条数不限长度。
 * 所以断言不能只测「有截断」，要测**两条引擎给出同一个上界**——
 * 只测一条的话，另一条正是出事的那条。
 */
describe('grep 的单条上界', () => {
  const MINIFIED = `!function(t){"use strict";${'x'.repeat(50_000)}/* bug */}(this)`

  const bothEngines = async (root: string) => {
    const { grepTool } = await import('./search.ts')
    const viaRg = await grepTool.fn!({ pattern: 'bug', path: '.' }, ctx(root))
    // 把 PATH 清空逼它走内置遍历：找不到 rg 时的降级路径就是这么触发的。
    const prevPath = process.env.PATH
    process.env.PATH = ''
    let viaBuiltin: Awaited<ReturnType<NonNullable<typeof grepTool.fn>>>
    try {
      viaBuiltin = await grepTool.fn!({ pattern: 'bug', path: '.' }, ctx(root))
    } finally {
      process.env.PATH = prevPath
    }
    return { viaRg, viaBuiltin }
  }

  test('压缩过的一整行不会整段进上下文，两条引擎同一个上界', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-')))
    await writeFile(join(root, 'vendor.min.js'), MINIFIED, 'utf8')

    const { viaRg, viaBuiltin } = await bothEngines(root)

    for (const [name, out] of [
      ['ripgrep', viaRg],
      ['builtin', viaBuiltin],
    ] as const) {
      expect(out.status, name).toBe('success')
      const matches = (out.data as { matches: string[] }).matches
      expect(matches.length, name).toBeGreaterThan(0)
      // 单条正文被截住：旧代码在 ripgrep 这条路上是 50,000+ 字符。
      const longest = Math.max(...matches.map((m) => m.length))
      expect(longest, name).toBeLessThan(600)
      // 路径与行号一个字节不能少——模型要靠它们去 read_file 取原文。
      expect(matches[0], name).toMatch(/^vendor\.min\.js:\d+:/)
    }
  })
})

/**
 * grep 必须计入批级投递预算。
 *
 * `loop.ts` 每下发一波之前 `resetBatchBudget`，理由写在那里：「压缩只留一个入口」
 * 的前提正是**两次检查之间的跳变有上界**。grep 从前完全不进这本账——单次
 * 200 条 × 400 字符最坏约 32,000 token，已经越过单次上界 25,000；
 * 它又是 `parallelSafe`，一波五个就是整波上界的三倍多。
 *
 * 断言的是「裁而不是拒」：这个工具本来就有截断契约，超预算走同一条路。
 */
describe('grep 计入投递预算', () => {
  test('超出预算时少给几条并标 truncated，不是失败', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-budget-')))
    // 每行都命中、每行都吃满单条上界，堆到远超预算。
    const line = `bug ${'y'.repeat(500)}`
    await writeFile(join(root, 'noisy.txt'), Array.from({ length: 200 }, () => line).join('\n'))

    const { grepTool } = await import('./search.ts')
    // 小窗口把预算压到很小：单次 = 窗口的 1/8。
    const tiny = { ...ctx(root), contextWindow: 8_000 }
    const out = await grepTool.fn!({ pattern: 'bug', path: '.' }, tiny)

    expect(out.status).toBe('success')
    const data = out.data as { matches: string[]; truncated: boolean }
    expect(data.truncated).toBe(true)
    expect(data.matches.length).toBeLessThan(200)
    expect(out.message).toContain('已按投递预算截断')
  })

  /** 正常体量的搜索不受影响——预算只在真的越界时才动手。 */
  test('装得下时一条不少，也不标截断', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-small-')))
    await writeFile(join(root, 'a.txt'), 'bug one\nbug two\nbug three\n')

    const { grepTool } = await import('./search.ts')
    const out = await grepTool.fn!({ pattern: 'bug', path: '.' }, ctx(root))
    const data = out.data as { matches: string[]; truncated: boolean }
    expect(data.matches.length).toBe(3)
    expect(data.truncated).toBe(false)
    expect(out.message).not.toContain('已按投递预算截断')
  })
})

/**
 * `read_file` 的图片与 PDF 两条分派。
 *
 * 两条都必须在 **1 MB 大小守卫之前**分派：手机照片和多数 PDF 都比它大，
 * 放晚一行它们会先被拒，而拿到的话术是「请用 offset/limit 分段读取」——
 * 对一张图不可执行。这一组盯的就是那个顺序。
 */
describe('read_file 认图片', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  /**
   * **字节就地定格，不给路径。**
   *
   * 给路径的话记录里存的是「去哪看」而不是「看到了什么」，而模型改完页面会重新
   * 截图覆盖同名文件——那是「对比改前改后」的自然动作，之后历史里那一张就永远
   * 取不回来了。捕获只能发生在观察的那一刻。
   */
  test('返回字节，不返回路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img-'))
    await writeFile(join(root, 'a.png'), PNG)
    const out = await registry().execute('read_file', { path: 'a.png' }, ctx(root))
    expect(out.status).toBe('success')
    const data = out.data as { images?: { data: string; mime: string }[] }
    expect(data.images?.length).toBe(1)
    expect(data.images?.[0]?.data).toBe(PNG.toString('base64'))
    expect(data.images?.[0]?.mime).toBe('image/png')

    // 覆盖同名文件之后，刚才那一份仍然完好——这就是不给路径的全部意义。
    await writeFile(join(root, 'a.png'), Buffer.concat([PNG, Buffer.from('x')]))
    expect(data.images?.[0]?.data).toBe(PNG.toString('base64'))
  })

  /**
   * 超过 1 MB 的图片必须走图片那条错误，不能落到文本那条。
   *
   * 落到文本那条的话用户看到的是「请用 offset/limit 分段读取」——
   * 而那对一张图既做不到也没意义。
   */
  test('大图报的是图片的错，不是「分段读取」', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img2-'))
    await writeFile(join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))
    const out = await registry().execute('read_file', { path: 'big.png' }, ctx(root))
    expect(out.status).toBe('success')
    expect(typeof (out.data as { images?: { data: string }[] }).images?.[0]?.data).toBe('string')
  })

  /**
   * 读过图之后必须能覆盖写。
   *
   * 图片分支跳过了文本那套流程，不补记一次读记录的话，`write_file` 会回
   * 「已存在但没读取过。先 read_file 再覆盖」——**而模型照做也永远过不去**。
   */
  test('读过的图片能被 write_file 覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img3-'))
    await writeFile(join(root, 'c.png'), PNG)
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'c.png' }, c)
    const w = await r.execute('write_file', { path: 'c.png', content: 'x' }, c)
    expect(w.status).toBe('success')
  })
})
