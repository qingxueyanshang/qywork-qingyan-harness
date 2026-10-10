import { describe, expect, test } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { openBatchBudget, sanitizeToolName, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
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
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () =>
      approve ? { allowed: true } : { allowed: false, reason: '夹具拒绝' },
  }
}

function registry(): ToolRegistry {
  const r = new ToolRegistry()
  registerBuiltinTools(r)
  return r
}

test('内置工具名全部符合 provider 约束', () => {
  const r = registry()
  for (const tool of r.list()) expect(sanitizeToolName(tool.name)).toBe(tool.name)
})

/**
 * 在「本机没有 bash」的状态下执行一段代码。
 *
 * 通过把 `QYWORK_BASH_PATH` 指向一个不存在的位置构造此状态：它是探测的第一优先级，
 * 因此同时验证两件事：路径错误即视为不存在，以及探测每次实时执行（若有缓存，此处取得的
 * 仍是上一轮的结果）。
 *
 * 工具注册时选择解释器，执行时使用同一份结果。此处保持探测环境一致，
 * 安装过程中解释器变化的回归由 shell.test.ts 单独覆盖。
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
 * 越界被拒绝后，模型收到的结果决定它下一步的行为。
 *
 * 复现的原始失败：读取桌面上某个项目被拒绝，结果只有一句「工具 read_file
 * 执行出错: 路径越界」，模型将其当作偶发故障，转而用 `run_command` 绕过
 * （shell 只限定 cwd，命令正文中的 `cd` 可以离开工作区），全程未告知用户。
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

  test('不使用「执行出错」的通用包装，errorKind 指明类别', async () => {
    const out = await denial()
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('path_out_of_workspace')
    expect(out.message).not.toContain('执行出错')
    // 未产生任何副作用：`executed: true` 会使崩溃恢复按「可能有副作用」处理。
    expect(out.executed).toBe(false)
  })

  /**
   * 两种解决方式都必须给出：切换到「完全访问」可以解除限制（该模式下不设路径边界），
   * 添加 `additionalDirectories` 则不放开全部权限、只开放该目录。
   * 只给出一种，等于迫使用户选择它。
   */
  test('结果给出两种解决方式，不承诺命令裁决会拒绝同一路径', async () => {
    const out = await denial()
    expect(out.message).toContain('完全访问')
    expect(out.message).toContain('additionalDirectories')
    expect(out.message).toContain('命令权限规则另行裁决')
    expect(out.message).not.toContain('同一份根目录清单拦')
  })
})

/**
 * 「完全访问」即全部权限，路径边界也由它决定。
 *
 * 原始失败（会话 `cv_0msw3jst9`）：用户开启完全访问，`read_file` 读取桌面上的
 * 项目被路径层拒绝，而同一模式下 `run_command` 全部放行，模型因此通过
 * `cd /c/Users/.../qywork && head -c 6000 README.md` 读取了同一个文件，
 * 全程未告知用户。只放开权限检查而保留路径层，结果不是更安全，而是形成两套账。
 */
describe('完全访问：路径边界一并放开', () => {
  test('工作区外的绝对路径照常读取', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-outside-'))
    await writeFile(join(outside, 'note.md'), '界外的正文\n', 'utf8')

    // 经由 `rootsOf`，一并覆盖 ToolContext 的 `unrestrictedPaths` 到根目录清单的转换。
    const roots = rootsOf({ workspaceRoot: root, unrestrictedPaths: true })
    await expect(
      resolveInWorkspace(roots, join(outside, 'note.md'), { mustExist: true }),
    ).resolves.toContain('note.md')
    // 同一路径在自动审批下仍被拒绝：放开的是模式，而不是这条判定本身。
    await expect(
      resolveInWorkspace({ workspaceRoot: root }, join(outside, 'note.md'), { mustExist: true }),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })

  /**
   * `.agents/` 规则拦截的是「为自己添加工具」，而完全访问下模型的 `run_command`
   * 全部放行，一行 `echo > .agents/x` 即可写入。保留该规则只会再形成一处
   * 「文件工具拦截、shell 不拦截」的不一致。
   */
  test('受保护目录的写入也一并放开', async () => {
    const root = await workspace()
    await expect(
      resolveWritablePath({ workspaceRoot: root, unrestricted: true }, '.agents/mcp.json'),
    ).resolves.toBeDefined()
    await expect(resolveWritablePath(root, '.agents/mcp.json')).rejects.toBeInstanceOf(
      ProtectedPathError,
    )
  })

  /**
   * 放开的是归属判定，而不是解析本身：返回的仍是 realpath 之后的路径。
   * 返回字面路径时，调用方用它记录「本轮是否读过」，软链根下的新鲜度判定会始终出错。
   */
  test('仍返回 realpath 之后的路径，而不是字面路径', async () => {
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
      return // Windows 上无权限创建符号链接时跳过
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

  test('清单外的路径仍被拒绝', async () => {
    // 本测试是该特性的反向对照：添加额外目录不等于取消边界。
    const { root, extra } = await withExtra()
    const other = await mkdtemp(join(tmpdir(), 'qywork-other-'))
    await expect(
      resolveInWorkspace({ workspaceRoot: root, additional: [extra] }, join(other, 'x.txt')),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })

  test('未配置额外目录时行为完全不变', async () => {
    const { root, extra } = await withExtra()
    await expect(resolveInWorkspace(root, join(extra, 'notes.md'))).rejects.toBeInstanceOf(
      PathEscapeError,
    )
  })

  test('相对路径的基准始终是工作区，不会解析到额外目录中', async () => {
    // 否则 `read_file("notes.md")` 将在多个根目录中逐个尝试，
    // 命中哪一个取决于目录内容：同一请求两次可能读取到不同的文件。
    //
    // 报告的是「不存在」而不是「越界」：该相对路径解析后位于工作区内，
    // 只是该位置不存在此文件。报告为越界时，模型收到的是一条它无法执行的权限说明
    // （「请用户切换到完全访问」），而实际原因是文件名有误。
    const { root, extra } = await withExtra()
    await expect(
      resolveInWorkspace({ workspaceRoot: root, additional: [extra] }, 'notes.md', {
        mustExist: true,
      }),
    ).rejects.toBeInstanceOf(PathNotFoundError)
    // 额外目录中的同名文件未被用作替代，这是本测试锁定的行为。
    expect(await stat(join(extra, 'notes.md')).then(() => true)).toBe(true)
  })

  test('额外目录中的软链无法越出边界', async () => {
    // 只按字面比较时，额外目录中一个指向别处的软链可以把整棵目录树带出边界。
    // 额外根目录必须使用与工作区完全相同的 realpath 判定。
    const { root, extra } = await withExtra()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-escape-'))
    await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8')
    try {
      await symlink(outside, join(extra, 'link'))
    } catch {
      return // Windows 上无权限创建符号链接时跳过
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

  test('额外目录不存在时仅不生效，不会使整次解析抛错', async () => {
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

  test('相对路径的配置项被拒绝，并说明原因', async () => {
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

  test('displayPath 对工作区外的文件返回绝对路径', async () => {
    // 计算为 `../../别处/x.ts` 时，模型无法理解，回填时还会因基准不同指向错误位置。
    const { root, extra } = await withExtra()
    expect(displayPath(root, join(extra, 'notes.md'))).toBe(join(extra, 'notes.md'))
    expect(displayPath(root, join(root, 'a.txt'))).toBe('a.txt')
  })
})

describe('只读根目录', () => {
  async function withSkills(): Promise<{ root: string; skills: string }> {
    const root = await workspace()
    const skills = await mkdtemp(join(tmpdir(), 'qywork-skills-'))
    await writeFile(join(skills, 'SKILL.md'), '# skill\n', 'utf8')
    return { root, skills }
  }

  test('读取放行，写入与命令工作目录拒绝', async () => {
    const { root, skills } = await withSkills()
    const c = { ...ctx(root), readOnlyRoots: [skills] }
    await expect(
      resolveInWorkspace(rootsOf(c), join(skills, 'SKILL.md'), { mustExist: true }),
    ).resolves.toContain('SKILL.md')
    await expect(resolveWritablePath(rootsOf(c), join(skills, 'out.md'))).rejects.toBeInstanceOf(
      PathEscapeError,
    )
    const out = await registry().execute('run_command', { command: 'echo x', cwd: skills }, c)
    expect(out.status).toBe('failure')
    expect(out.executed).toBe(false)
  })

  test('只读根中指向界外的软链不放行', async () => {
    const { root, skills } = await withSkills()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-escape-'))
    await writeFile(join(outside, 'secret.txt'), 'nope', 'utf8')
    try {
      await symlink(outside, join(skills, 'link'))
    } catch {
      return // Windows 上无权限创建符号链接时跳过
    }
    await expect(
      resolveInWorkspace(
        { workspaceRoot: root, readOnly: [skills] },
        join(skills, 'link/secret.txt'),
        {
          mustExist: true,
        },
      ),
    ).rejects.toBeInstanceOf(PathEscapeError)
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
   * 无法解析为整数的 offset 是失败，而不是一次读到 0 行的成功。
   *
   * 原始失败：模型把行区间写成一个字符串（`offset: "1,4000"`），
   * `Math.max(1, Number(...))` 得到 NaN，`slice(NaN, NaN)` 是空数组，
   * `truncated` 与 NaN 比较也为假，返回给模型的是
   * 「success / 0 行 / 未截断 / 文件有 349 行」四条互相矛盾的事实。
   */
  test('offset 无法解析为整数时失败，而不是成功读到 0 行', async () => {
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

  test('字符串形式的整数照常接受，越界的整数仍限定为第一行', async () => {
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
      { path: 'a.txt', mode: 'overwrite', content: 'clobbered' },
      ctx(root),
    )
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('stale_write')
    expect(out.message).toContain('read_file')
    expect(out.message).not.toContain('list_dir')
    // 磁盘内容必须保持不变。
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  test.each(['.', 'nested output'])(
    'on_conflict=error 重名后按回执列目录再新建：%s',
    async (parent) => {
      const root = await workspace()
      const r = registry()
      const c = ctx(root)
      const target = (name: string) => (parent === '.' ? name : `${parent}/${name}`)
      await mkdir(join(root, parent), { recursive: true })
      await writeFile(join(root, parent, 'output.html'), 'original page', 'utf8')
      await writeFile(join(root, parent, 'output-2.html'), 'another page', 'utf8')

      const conflict = await r.execute(
        'write_file',
        { path: target('output.html'), mode: 'create', on_conflict: 'error', content: 'new page' },
        c,
      )
      expect(conflict.status).toBe('failure')
      expect(conflict.errorKind).toBe('file_exists')
      expect(conflict.executed).toBe(false)
      expect(conflict.message).not.toContain('read_file')
      const directoryArgs = conflict.message.match(/list_dir (\{[^\n]+?\}) /)?.[1]
      expect(directoryArgs).toBeDefined()
      expect(JSON.parse(directoryArgs!)).toEqual({ path: parent })
      const listed = await r.execute('list_dir', JSON.parse(directoryArgs!), c)
      expect(listed.status).toBe('success')
      const entries = listed.data?.entries as string[]
      expect(entries).toContain('output.html')
      expect(entries).toContain('output-2.html')
      expect(JSON.stringify(listed)).not.toContain('original page')
      expect(JSON.stringify(listed)).not.toContain('another page')

      // 列目录只查询名称，不授予覆盖已有文件的读取凭据。
      const overwrite = await r.execute(
        'write_file',
        { path: target('output.html'), mode: 'overwrite', content: 'new page' },
        c,
      )
      expect(overwrite.status).toBe('failure')
      expect(overwrite.errorKind).toBe('stale_write')
      const available = ['output.html', 'output-2.html', 'output-3.html'].find(
        (name) => !entries.includes(name),
      )!
      const created = await r.execute(
        'write_file',
        { path: target(available), mode: 'create', content: 'new page' },
        c,
      )
      expect(created.status).toBe('success')
      expect(created.fileChanges?.[0]?.changeType).toBe('created')
      expect(await readFile(join(root, parent, available), 'utf8')).toBe('new page')
      expect(await readFile(join(root, parent, 'output.html'), 'utf8')).toBe('original page')
      expect(await readFile(join(root, parent, 'output-2.html'), 'utf8')).toBe('another page')
    },
  )

  test('读过之后允许覆盖，并报告行级增删', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'a.txt' }, c)
    const out = await r.execute(
      'write_file',
      { path: 'a.txt', mode: 'overwrite', content: 'hello\nthere\n' },
      c,
    )
    expect(out.status).toBe('success')
    expect(out.fileChanges?.[0]?.changeType).toBe('modified')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
  })

  test('新建文件无需先读取', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'write_file',
      { path: 'nested/deep/new.txt', mode: 'create', content: 'x' },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect(out.fileChanges?.[0]?.changeType).toBe('created')
  })

  test('读取过的文件在新建模式（on_conflict=error）下仍报告重名，不能覆盖', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'a.txt' }, c)
    const out = await r.execute(
      'write_file',
      { path: 'a.txt', mode: 'create', on_conflict: 'error', content: 'new' },
      c,
    )
    expect(out.errorKind).toBe('file_exists')
    expect(out.message).toContain('list_dir')
    expect(out.message).not.toContain('read_file')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  test('允许自由命名时复用内容新建，回执和读取凭据指向实际文件', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root)
    await mkdir(join(root, '作品'), { recursive: true })
    await writeFile(join(root, '作品', 'page.html'), 'existing')
    await writeFile(join(root, '作品', 'page-2.html'), 'another')
    await r.execute('read_file', { path: '作品/page.html' }, c)
    const content = '<h1>新作品</h1>\n'.repeat(1000)
    const out = await r.execute(
      'write_file',
      {
        path: '作品/page.html',
        mode: 'create',
        on_conflict: 'rename',
        content,
      },
      c,
    )
    expect(out.status).toBe('success')
    expect(out.data?.path).toBe('作品/page-3.html')
    expect(out.fileChanges?.[0]?.path).toBe(String(out.data?.path))
    expect(out.fileChanges?.[0]?.changeType).toBe('created')
    expect(out.message).toContain('作品/page-3.html')
    expect(await readFile(join(root, '作品', 'page-3.html'), 'utf8')).toBe(content)
    expect(await readFile(join(root, '作品', 'page.html'), 'utf8')).toBe('existing')
    expect(await readFile(join(root, '作品', 'page-2.html'), 'utf8')).toBe('another')
    const edited = await r.execute(
      'edit_file',
      {
        path: out.data?.path,
        edits: [{ old_string: '新作品', new_string: '调整标题', replace_all: true }],
      },
      c,
    )
    expect(edited.status).toBe('success')
  })

  test('并发新建同名文件在本地选名，所有内容分别完整落盘', async () => {
    const root = await workspace()
    const r = registry()
    const contents = Array.from({ length: 12 }, (_, i) => `作品 ${i}\n`.repeat(1000))
    const outcomes = await Promise.all(
      contents.map((content) =>
        r.execute(
          'write_file',
          {
            path: 'page.html',
            mode: 'create',
            on_conflict: 'rename',
            content,
          },
          ctx(root),
        ),
      ),
    )
    const paths = outcomes.map((out) => String(out.data?.path))
    expect(new Set(paths).size).toBe(contents.length)
    expect(paths).toContain('page.html')
    expect(paths).toContain('page-12.html')
    for (const [i, out] of outcomes.entries()) {
      expect(out.status).toBe('success')
      expect(out.fileChanges?.[0]?.changeType).toBe('created')
      expect(await readFile(join(root, paths[i]!), 'utf8')).toBe(contents[i]!)
    }
  })

  /**
   * 原始失败：用户要求「新建一个 notes.md」而该文件已存在，模型按「固定文件名用 error」停止并询问用户。
   * 不传 on_conflict 时新建重名文件自动改名写入，回执写明原名已被占用与实际路径。
   */
  test('不传 on_conflict 时新建重名自动改名，回执写明原名已存在与实际路径', async () => {
    const root = await workspace()
    await writeFile(join(root, 'notes.md'), '原内容')
    const out = await registry().execute(
      'write_file',
      { path: 'notes.md', mode: 'create', content: '今天的计划' },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect(out.data?.path).toBe('notes-2.md')
    expect(out.message).toBe('notes.md 已存在，已创建 notes-2.md')
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('原内容')
    expect(await readFile(join(root, 'notes-2.md'), 'utf8')).toBe('今天的计划')
    const fresh = await registry().execute(
      'write_file',
      { path: 'other.md', mode: 'create', content: 'x' },
      ctx(root),
    )
    expect(fresh.message).toBe('创建 other.md')
  })

  test('on_conflict=error 时固定名称并发新建只有一个成功，其余报告重名且不覆盖', async () => {
    const root = await workspace()
    const r = registry()
    const contents = ['first', 'second', 'third']
    const outcomes = await Promise.all(
      contents.map((content) =>
        r.execute(
          'write_file',
          {
            path: 'fixed.txt',
            mode: 'create',
            on_conflict: 'error',
            content,
          },
          ctx(root),
        ),
      ),
    )
    expect(outcomes.filter((out) => out.status === 'success')).toHaveLength(1)
    for (const out of outcomes.filter((out) => out.status !== 'success')) {
      expect(out.errorKind).toBe('file_exists')
      expect(out.executed).toBe(false)
    }
    const winner = outcomes.findIndex((out) => out.status === 'success')
    expect(await readFile(join(root, 'fixed.txt'), 'utf8')).toBe(contents[winner]!)
  })

  test.each(['error', 'rename'])(
    '悬挂软链占用文件名，新建不沿链接落盘：%s',
    async (on_conflict) => {
      const root = await workspace()
      const target = join(root, 'missing-target.html')
      await symlink(target, join(root, 'page.html'), 'file')
      const out = await registry().execute(
        'write_file',
        {
          path: 'page.html',
          mode: 'create',
          on_conflict,
          content: 'new page',
        },
        ctx(root),
      )
      if (on_conflict === 'error') {
        expect(out.errorKind).toBe('file_exists')
        expect(out.executed).toBe(false)
        expect(out.message).toContain('list_dir')
      } else {
        expect(out.status).toBe('success')
        expect(out.data?.path).toBe('page-2.html')
        expect(await readFile(join(root, 'page-2.html'), 'utf8')).toBe('new page')
      }
      expect(await stat(target).catch(() => null)).toBeNull()
      expect((await lstat(join(root, 'page.html'))).isSymbolicLink()).toBe(true)
    },
  )

  test('新建仍拒绝通过父目录软链越界', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-create-outside-'))
    await symlink(outside, join(root, 'linked'), 'junction')
    const out = await registry().execute(
      'write_file',
      {
        path: 'linked/page.html',
        mode: 'create',
        on_conflict: 'rename',
        content: 'new page',
      },
      ctx(root),
    )
    expect(out.errorKind).toBe('path_out_of_workspace')
    expect(await stat(join(outside, 'page.html')).catch(() => null)).toBeNull()
  })

  test('覆盖模式不新建文件；读取后内容发生变化时仍拒绝覆盖', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root)
    const missing = await r.execute(
      'write_file',
      {
        path: 'missing/new.txt',
        mode: 'overwrite',
        content: 'new',
      },
      c,
    )
    expect(missing.errorKind).toBe('path_not_found')
    expect(await stat(join(root, 'missing')).catch(() => null)).toBeNull()
    await r.execute('read_file', { path: 'a.txt' }, c)
    await writeFile(join(root, 'a.txt'), 'changed externally')
    const stale = await r.execute(
      'write_file',
      {
        path: 'a.txt',
        mode: 'overwrite',
        content: 'clobbered',
      },
      c,
    )
    expect(stale.errorKind).toBe('stale_write')
    expect(stale.message).toContain('read_file')
    expect(stale.message).not.toContain('list_dir')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('changed externally')
  })

  test.each([
    {},
    { mode: 'unknown' },
    { mode: 'create', on_conflict: 'unknown' },
    { mode: 'overwrite', on_conflict: 'rename' },
  ])('没有明确的合法写入语义时不落盘：%j', async (args) => {
    const root = await workspace()
    const out = await registry().execute(
      'write_file',
      {
        path: 'new.txt',
        content: 'new',
        ...args,
      },
      ctx(root),
    )
    expect(out.errorKind).toBe('invalid_tool_arguments')
    expect(out.executed).toBe(false)
    expect(await stat(join(root, 'new.txt')).catch(() => null)).toBeNull()
  })

  /**
   * 增删数按位置计算。
   *
   * 以下每一项都是按文本是否出现过计数的算法会计算错误的情形：结果都为 0。
   */
  describe('行级增删', () => {
    const rewrite = async (before: string, after: string) => {
      const root = await workspace()
      const r = registry()
      const c = ctx(root)
      await writeFile(join(root, 'f.txt'), before, 'utf8')
      await r.execute('read_file', { path: 'f.txt' }, c)
      const out = await r.execute(
        'write_file',
        { path: 'f.txt', mode: 'overwrite', content: after },
        c,
      )
      expect(out.status).toBe('success')
      return out.fileChanges?.[0]
    }

    test('插入的空行计为新增', async () => {
      expect(await rewrite('a\n\nb\n', 'a\n\n\n\nb\n')).toMatchObject({
        additions: 2,
        deletions: 0,
      })
    })

    test('旧文件的其他位置有相同的行时，仍计为新增', async () => {
      // 旧文件中已有一个 `}`；新增段落也含一个，该行应计为新增。
      expect(await rewrite('f()\n}\n', 'f()\n}\ng()\n}\n')).toMatchObject({
        additions: 2,
        deletions: 0,
      })
    })

    test('整块移动时两端都计入', async () => {
      expect(await rewrite('a\nb\nc\nd\n', 'c\nd\na\nb\n')).toMatchObject({
        additions: 2,
        deletions: 2,
      })
    })

    test('内容未变时为 0', async () => {
      expect(await rewrite('a\nb\nc\n', 'a\nb\nc\n')).toMatchObject({
        additions: 0,
        deletions: 0,
      })
    })

    test('整份替换：新内容全部计为新增，旧内容全部计为删除', async () => {
      expect(await rewrite('a\nb\nc\n', 'x\ny\n')).toMatchObject({ additions: 2, deletions: 3 })
    })

    /**
     * 达到上限的情形。差异超过 MAX_EDIT 时按全量报告，而不是回退到其他算法。
     * 一万行全部不同时，报告 10000/10000 即为正确。
     */
    test('差异超出上限时按全量报告增删，且执行时间短', async () => {
      const old = Array.from({ length: 10_000 }, (_, i) => `旧 ${i}`).join('\n')
      const now = Array.from({ length: 10_000 }, (_, i) => `新 ${i}`).join('\n')
      const started = performance.now()
      expect(await rewrite(old, now)).toMatchObject({ additions: 10_000, deletions: 10_000 })
      expect(performance.now() - started).toBeLessThan(3000)
    })
  })

  /**
   * 读取记录的生命周期由装配方决定，此处只验证两端。
   *
   * 上一轮读取、本轮直接修改是正常用法。记录存放在 run 内的临时状态中时
   * 每轮清零一次，因此该用法必然先失败一次「本轮未读取过」。
   *
   * 接入会话级 port 后不再需要重新读取；未接入时行为完全不变（更严格的一侧），
   * 因此两种情况都测试。
   */
  describe('跨轮读取记录', () => {
    /** 最小的会话级 port：两个 run 共用同一份，与 runtime 注入的结构相同。 */
    function sessionReads() {
      const m = new Map<string, string>()
      return {
        seen: (p: string) => m.get(p) ?? null,
        mark: (p: string, h: string) => void m.set(p, h),
      }
    }

    test('接入会话级记录后，上一轮读取过的文件本轮可直接修改', async () => {
      const root = await workspace()
      const r = registry()
      const reads = sessionReads()
      // 第一轮读取。第二轮使用另一个 ToolContext（run 之间必须重建）。
      await r.execute('read_file', { path: 'a.txt' }, { ...ctx(root), reads })
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', edits: [{ old_string: 'world', new_string: 'there' }] },
        { ...ctx(root), reads },
      )
      expect(out.status).toBe('success')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
    })

    test('未接入 port 时仍要求本 run 读取过：退回更严格的一侧', async () => {
      const root = await workspace()
      const r = registry()
      await r.execute('read_file', { path: 'a.txt' }, ctx(root))
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', edits: [{ old_string: 'world', new_string: 'there' }] },
        ctx(root),
      )
      expect(out.status).toBe('failure')
      expect(out.errorKind).toBe('stale_write')
    })

    test('会话级记录同样能拦截「读取之后文件被修改」', async () => {
      const root = await workspace()
      const r = registry()
      const reads = sessionReads()
      await r.execute('read_file', { path: 'a.txt' }, { ...ctx(root), reads })
      // 其他方（用户、另一个进程）修改了磁盘上的内容。
      await writeFile(join(root, 'a.txt'), 'hello\nworld\nplus\n', 'utf8')
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', edits: [{ old_string: 'world', new_string: 'there' }] },
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
      { path: 'dup.txt', edits: [{ old_string: 'x', new_string: 'y' }] },
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
      { path: 'src/main.ts', edits: [{ old_string: '42', new_string: '43' }] },
      c,
    )
    expect(out.status).toBe('success')
    expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('export const answer = 43\n')
  })

  test('一次调用按顺序执行多处替换，后一项在前一项的结果上执行', async () => {
    const root = await workspace()
    await writeFile(join(root, 'units.md'), '单元1 时长 6 秒\n单元2 时长 7 秒\n单元3 时长 8 秒\n')
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'units.md' }, c)
    const out = await r.execute(
      'edit_file',
      {
        path: 'units.md',
        edits: [
          { old_string: '单元1 时长 6 秒', new_string: '单元1 时长 30 秒' },
          { old_string: '单元3 时长 8 秒', new_string: '单元3 时长 26 秒' },
          { old_string: '时长 30 秒', new_string: '时长 30 秒（已确认）' },
        ],
      },
      c,
    )
    expect(out.status).toBe('success')
    expect(out.fileChanges?.[0]).toMatchObject({ path: 'units.md', changeType: 'modified' })
    expect(await readFile(join(root, 'units.md'), 'utf8')).toBe(
      '单元1 时长 30 秒（已确认）\n单元2 时长 7 秒\n单元3 时长 26 秒\n',
    )
    // 写入后读取记录随之更新，下一次调用无须重新读取。
    const again = await r.execute(
      'edit_file',
      { path: 'units.md', edits: [{ old_string: '时长 7 秒', new_string: '时长 28 秒' }] },
      c,
    )
    expect(again.status).toBe('success')
  })

  test('部分项未命中时写入其余项，回执逐项列出未写入的项', async () => {
    const root = await workspace()
    await writeFile(join(root, 'units.md'), 'a1\nb1\nc1\nc1\n')
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'units.md' }, c)
    const out = await r.execute(
      'edit_file',
      {
        path: 'units.md',
        edits: [
          { old_string: 'a1', new_string: 'a2' },
          { old_string: 'zz', new_string: 'yy' },
          { old_string: 'b1', new_string: 'b2' },
          { old_string: 'c1', new_string: 'c2' },
        ],
      },
      c,
    )
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('no_match')
    expect(out.message).toContain('2/4 项已写入')
    expect(out.message).toContain('第 2 项未写入：old_string 未在文件中找到')
    expect(out.message).toContain('第 4 项未写入：old_string 命中 2 处')
    expect(out.fileChanges?.[0]?.path).toBe('units.md')
    expect(await readFile(join(root, 'units.md'), 'utf8')).toBe('a2\nb2\nc1\nc1\n')
    // 只重新提交未写入的项即可完成，不需要重新读取。
    const retry = await r.execute(
      'edit_file',
      { path: 'units.md', edits: [{ old_string: 'c1', new_string: 'c2', replace_all: true }] },
      c,
    )
    expect(retry.status).toBe('success')
    expect(await readFile(join(root, 'units.md'), 'utf8')).toBe('a2\nb2\nc2\nc2\n')
  })

  test('全部项未命中时不写入，也不记录文件改动', async () => {
    const root = await workspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'src/main.ts' }, c)
    const out = await r.execute(
      'edit_file',
      {
        path: 'src/main.ts',
        edits: [
          { old_string: 'missing', new_string: 'x' },
          { old_string: 'absent', new_string: 'y' },
        ],
      },
      c,
    )
    expect(out.status).toBe('failure')
    expect(out.fileChanges).toBeUndefined()
    expect(out.message).toBe(
      '第 1 项未写入：old_string 未在文件中找到\n第 2 项未写入：old_string 未在文件中找到',
    )
    expect(await readFile(join(root, 'src', 'main.ts'), 'utf8')).toBe('export const answer = 42\n')
  })
})

describe('权限检查', () => {
  test('拒绝授权时不执行，且 executed=false', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'write_file',
      { path: 'blocked.txt', mode: 'create', content: 'x' },
      ctx(root, false),
    )
    expect(out.executed).toBe(false)
    expect(out.errorKind).toBe('permission_denied')
    expect(await readFile(join(root, 'blocked.txt'), 'utf8').catch(() => null)).toBeNull()
  })
})

describe('注册表', () => {
  test('注册表未命中 fail-closed，不伪装成功', async () => {
    const root = await workspace()
    const out = await registry().execute('no_such_tool', {}, ctx(root))
    expect(out.status).toBe('failure')
    expect(out.executed).toBe(false)
    expect(out.errorKind).toBe('unregistered_tool_call')
  })

  test('重名注册直接抛错，不静默覆盖', () => {
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
   * 单个文件命中过多时必须报告截断，且两种引擎使用同一个上界。
   *
   * 原始失败：ripgrep 路径有每文件上限，而 `truncated` 只按总条数（200）计算。
   * 实测在本仓库 `packages/ai` 中搜索 `cache`：实际 168 行、取回 159 行、报告 `truncated: false`，
   * 丢失 9 行，模型据此认为搜索完整。降级路径则完全没有每文件上限，
   * 同一查询在是否安装 rg 的机器上结果不同。
   *
   * 第二个模式带前瞻断言：rg 的引擎不支持（退出码 2），因此必然使用降级遍历。
   */
  test('单个文件命中超过每文件上限时报告截断，两种引擎使用同一个上界', async () => {
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
   * 起点是一个文件时同样能搜索到结果。
   *
   * 原始失败：`grep(pattern, path="js/game.js")` 返回 `success` + 0 命中。
   * rg 路径以文件作为 `cwd` 调用 spawn 直接抛错，降级路径对文件调用 `readdir` 也抛错且错误被忽略，
   * 两条路径均无结果。模型据此判定「这个符号不存在」，转而读取整个文件。
   */
  test('grep 的起点可以是一个文件，不限于目录', async () => {
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
   * 命中路径始终相对于工作区根，不随搜索起点变化。
   *
   * rg 输出的是相对搜索起点的路径：`path="src"` 时它给出 `main.ts`，
   * 而模型会按该字符串调用 `read_file`，得到「文件不存在」。
   * 两种实现路径也必须给出同一种路径格式，否则同一个工具的输出会随是否安装 rg 而变化。
   */
  test('grep 的命中路径相对工作区根，与搜索起点无关', async () => {
    const root = await workspace()
    for (const path of ['.', 'src', 'src/main.ts']) {
      const out = await registry().execute('grep', { pattern: 'answer', path }, ctx(root))
      expect((out.data?.matches as string[])[0]).toStartWith('src/main.ts:1:')
    }
  })

  /**
   * 降级遍历给出与 rg 相同格式的结果，起点是文件时也一样。
   *
   * 触发方式是前瞻断言：rg 的引擎不支持 look-around，会以退出码 2 失败，
   * 而 JS 的 `RegExp` 支持，因此本测试在是否安装 rg 的机器上都使用降级路径。
   * 是否安装 rg 是机器差异，而工具的返回格式不应随机器变化。
   */
  test('rg 无法执行的正则降级到内置遍历，路径格式不变', async () => {
    const root = await workspace()
    const out = await registry().execute(
      'grep',
      { pattern: '(?=export)export const answer', path: 'src/main.ts' },
      ctx(root),
    )
    expect(out.data?.engine).toBe('builtin')
    expect(out.data?.matches).toEqual(['src/main.ts:1:export const answer = 42'])
  })

  test('glob 能按模式查找文件', async () => {
    const root = await workspace()
    const out = await registry().execute('glob', { pattern: '**/*.ts' }, ctx(root))
    expect(out.status).toBe('success')
    expect(out.data?.files).toContain('src/main.ts')
  })

  /**
   * 工具说明中必须写明实际执行命令的 shell，且写在第一句。
   *
   * `run_command` 这一名称不携带语法信息，模型默认输出 bash 语法：语法信息只能来自描述，
   * 而描述从头读取。放在第三句即失去作用：账本中有过只被告知「平台：win32」
   * 即写出 POSIX 组合命令、在 PowerShell 上完全未执行的调用。
   * 锁定的是「说明与执行一致」，而不是某句文案。
   */
  test('run_command 的说明第一句是语法提示，且指明实际的可执行文件', () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const spec = registry()
      .list()
      .find((t) => t.name === 'run_command')
    expect(spec?.description.startsWith(shell.hint)).toBe(true)
    // 三档共用一条断言：提示中必须出现实际被 spawn 的可执行文件名。
    const exe = basename(shell.path).toLowerCase().replace('.exe', '')
    expect(shell.hint.toLowerCase()).toContain(exe)
  })

  /**
   * 只有在没有任何 shell 时才不提供 `run_command`，而不是提供一个必然失败的工具。
   *
   * 隐藏 bash 后本机使用哪一档，取决于本机安装的 shell，因此两种情况都断言：
   * - 使用 PowerShell：仍然注册，且能成功执行一条命令。注册后无法执行比不注册危害更大。
   * - 无可用 shell：工具表中不含该工具，其余工具完整保留。
   */
  test('隐藏 bash 后：有 PowerShell 时仍注册且能成功执行，无可用 shell 时不注册', async () => {
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
    // 其余工具必须完整保留：shell 一项只影响 run_command。
    expect(names).toContain('read_file')
    expect(names).toContain('grep')

    if (shell === null) {
      expect(names).not.toContain('run_command')
      return
    }
    expect(names).toContain('run_command')
    // 非 bash 的语法提示必须明确声明不是 bash，否则模型按 POSIX 语法编写。
    expect(shell.hint).toContain('不是 bash')
    const out = await withoutBash(() =>
      registry().execute('run_command', { command: 'echo qywork-shell-ok' }, ctx(root)),
    )
    expect(out.status).toBe('success')
    expect(String(out.data?.stdout)).toContain('qywork-shell-ok')
  }, 20_000)

  /**
   * 顺序执行两条命令，使用当前 shell 的语法。
   *
   * 测试的是原始失败：bash 与 pwsh 7 使用 `&&`，而 Windows PowerShell 5.1 上
   * `&&` 是解析错误、整条命令完全不执行，该档只能使用 `;`。
   * 按可执行文件名区分：这正是 `resolveCommandShell` 选择该 shell 时使用的依据。
   */
  test('当前 shell 的组合命令能成功执行', async () => {
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
   * 原始失败：命令执行完毕、shell 也正常退出，但其遗留的后台进程继承了
   * stdout 的写端且未关闭，因此管道始终不到达 EOF。账本中的实例是 `run.ps1 start`
   * （在后台启动 node 服务，这正是脚本的用途）：界面上该 `run_command`
   * 停留在「正在执行」371 秒，超过默认超时 120 秒的两倍：超时触发的进程树终止无法覆盖
   * 已脱离父子关系的孙进程，而超时返回分支又排在等待 EOF 之后，因此始终不会执行。
   * 影响不限于该次调用：`runs.unregister` 不执行，整个会话此后拒绝所有新任务。
   *
   * 锁定两件事：按时返回，以及说明后台仍留有进程。只锁定前者时，
   * 一条未复现该情形的命令也能使本测试通过。
   *
   * PowerShell 一档的写法未在本机验证（本机有 bash，使用的是另一档）。
   */
  test('遗留的后台进程持有管道时，命令仍按时返回并说明情况', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const root = await workspace()
    // 按 argv 区分而不是按可执行文件名：`-Command` 是两档 PowerShell 共有的参数，
    // 而按名称判断需同时识别 powershell.exe 和 pwsh.exe。
    const command = shell.argv.includes('-Command')
      ? "Write-Output started; Start-Process -NoNewWindow -FilePath cmd.exe -ArgumentList '/c','ping -n 21 127.0.0.1'"
      : 'echo started; sleep 20 &'

    const started = Date.now()
    const out = await registry().execute('run_command', { command }, ctx(root))
    const elapsed = Date.now() - started

    expect(out.status).toBe('success')
    expect(String(out.data?.stdout)).toContain('started')
    // 若挂起，此处至少需要 20 秒；改为等待 EOF 时永远不会返回。
    expect(elapsed).toBeLessThan(5_000)
    expect(out.message).toContain('后台进程仍在运行并持有输出管道')
  }, 30_000)

  /**
   * 同一行为在 runner 路径上也必须成立：产品实际使用该路径。
   *
   * `qy serve` 的命令一律由 runner 代为执行（它是先于监听端口启动的父进程），
   * 上一条测试使用的却是直接 spawn。两条路径的差别正在于该提示：runner 一侧若在
   * 收到退出码时即关闭流，读端立即收到 EOF，`backgroundHeld` 始终为 false，
   * 该提示在实际运行的产品中永远不会发出，而两条路径的测试都会通过。
   */
  test('runner 代为执行时同样能报告后台进程', async () => {
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
      // 该变量是进程级的，不恢复会使本文件后续的命令都改由 runner 执行。
      setCommandRunner(null)
      runner.stop()
    }
  }, 30_000)

  /**
   * 工作区观察窗口先于进程打开。进程无法启动时窗口必须关闭：未关闭的窗口始终排在最前，
   * 此后每条命令的事件都归属于它，结果中不会有任何文件改动。
   */
  test('进程无法启动时关闭观察窗口，下一条命令的文件改动照常报告', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const root = await workspace()
    setCommandRunner({
      spawn: async () => {
        throw new Error('命令 runner 已退出')
      },
      stop() {},
    })
    try {
      const failed = await registry().execute('run_command', { command: 'echo x' }, ctx(root))
      expect(failed.status).toBe('failure')
    } finally {
      setCommandRunner(null)
    }

    // 删除只能由事件观察到，收尾扫描无法补充：窗口未关闭时删除无法报告。先短暂等待再删除，
    // 是为了使删除发生在 macOS 的事件流开始之后：事件流在 `watch()` 返回之后才开始投递。
    const command = shell.argv.includes('-Command')
      ? 'Start-Sleep -Milliseconds 300; Remove-Item a.txt; Set-Content made.txt made'
      : 'sleep 0.3; rm a.txt && echo made > made.txt'
    const out = await registry().execute('run_command', { command }, ctx(root))
    expect(out.status).toBe('success')
    expect(out.fileChanges?.map((c) => [c.path, c.changeType]).sort()).toEqual([
      ['a.txt', 'deleted'],
      ['made.txt', 'created'],
    ])
  }, 30_000)

  /**
   * 原始失败：Linux 的 bwrap 沙箱在 shell 退出时结束命名空间中的全部进程，`npm run dev &`
   * 等后台服务随命令返回一并终止，结果中没有任何说明。本测试锁定进程保留：命令返回之后，
   * 它仍能写入文件。
   */
  test('命令返回之后，它留下的后台进程继续运行', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('这台机器一个可用的 shell 都没有，这条测不了')
    const root = await workspace()
    const command = shell.argv.includes('-Command')
      ? "Start-Process -NoNewWindow -FilePath cmd.exe -ArgumentList '/c','ping -n 2 127.0.0.1 >nul & echo alive>bg.txt'"
      : '(sleep 1; echo alive > bg.txt) &'

    const out = await registry().execute('run_command', { command }, ctx(root))
    expect(out.status).toBe('success')

    let body = ''
    for (let i = 0; i < 50 && !body; i++) {
      await Bun.sleep(100)
      body = await readFile(join(root, 'bg.txt'), 'utf8').catch(() => '')
    }
    expect(body).toContain('alive')
  }, 30_000)

  /**
   * 用户点击停止后，命令必须停止。
   *
   * 与上一条测试同一根因：中断只是对信号调用 abort，无法终止一个不返回的 `await`。
   * 命令派生了脱离进程树的后台进程时，进程树终止只能结束前台部分、无法结束该孤儿进程，
   * 因此等待 EOF 的调用继续挂起，停止操作不生效。
   *
   * 前台部分有意设为较长的 30 秒，并保留孤儿进程：两部分同时存在时，本测试才能验证中断的效果。
   */
  test('中断时立即返回，即使有孤儿进程持有管道', async () => {
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

    // 不断言状态：被终止进程的退出码由平台决定。要锁定的是调用已返回。
    expect(out).toBeTruthy()
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)
})

/**
 * 凭证不进入上下文。
 *
 * `read_file` 路径不接入脱敏时，磁盘字节会直接交给模型。只拦截一侧等于没有拦截：
 * 模型无法取得 `cat .env` 的输出，改用 `read_file` 即可取得，
 * 而模型并非有意绕过，只是更换了工具。
 */
describe('read_file 的凭证脱敏', () => {
  test('工作区中的私钥无法读出明文', async () => {
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

  test('.env 中的 token 无法读出明文', async () => {
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
    // 变量名与其余内容照常可见，只有值被屏蔽：模型仍能理解文件结构。
    const content = String(out.data?.content)
    expect(content).not.toContain(token)
    expect(content).toContain('GITHUB_TOKEN')
    expect(content).toContain('PORT=3000')
  })

  /** 普通代码不得有任何改动，否则模型读到的内容与磁盘不一致，编辑会失败。 */
  test('普通文件原样返回', async () => {
    const root = await workspace()
    const out = await registry().execute('read_file', { path: 'src/main.ts' }, ctx(root))
    expect(String(out.data?.content)).toContain('answer')
  })
})

/**
 * `probe_url`：启动服务 → 等待就绪 → 获取一次响应 → 关闭，在一次调用内完成。
 *
 * 该工具的必要性在于：「启动服务并检查页面能否打开」在本仓库的执行方式下无法完成：
 * `run_command` 是同步的，启动一个不会自行退出的服务器会阻塞直至超时，
 * 与权限模式无关（实测：开启完全访问后仍只等到 output_truncated）。
 *
 * 本组先测边界再测功能：边界写错的代价是多出一条绕开 SSRF 防护的网络访问通道，
 * 比功能不可用严重得多。
 */
describe('probe_url', () => {
  const run = (root: string, command: string, probe_url: string, timeout_ms = 15_000) =>
    registry().execute('run_command', { command, probe_url, timeout_ms }, ctx(root))

  /**
   * 只允许回环地址。`web_fetch` 有意拒绝本机地址（127.0.0.1 上可能运行 qy
   * 自身的 API），此处方向相反、边界也相反。任何放宽都会形成第二条网络访问通道。
   */
  test('非回环地址一律拒绝，且不启动进程', async () => {
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

  /** IPv6 的等价写法按数值判定，不按字面量：`::ffff:127.0.0.1` 也是回环地址。 */
  test('回环地址的各种写法都被接受', async () => {
    const root = await workspace()
    // 选择一个必然无人监听的端口：此处只验证未被边界拒绝，探测失败是预期结果。
    for (const url of [
      'http://localhost:19801/',
      'http://127.0.0.1:19801/',
      'http://[::1]:19801/',
    ]) {
      const out = await run(root, 'exit 0', url, 1500)
      expect(out.errorKind).not.toBe('bad_request')
    }
  }, 20_000)

  test('非 http/https 协议被拒绝', async () => {
    const root = await workspace()
    const out = await run(root, 'exit 0', 'file:///etc/passwd')
    expect(out.errorKind).toBe('bad_request')
  })

  /** 启动真实服务、实际探测并关闭：这是整个功能的验收。 */
  test('启动服务、获取响应、进程随调用结束而退出', async () => {
    const root = await workspace()
    const port = 19807
    // 服务源码写入文件：放入 `node -e` 时需要按 shell 的引号规则转义，POSIX 与 Windows 写法不同。
    // 后缀使用 `.cjs`：临时目录位于仓库中，上层 package.json 的 `"type": "module"` 会使 `.js` 按 ESM 加载。
    await writeFile(
      join(root, 'server.cjs'),
      `require('http').createServer((_,r)=>{r.writeHead(200);r.end('hello from probe')}).listen(${port},'127.0.0.1');setInterval(()=>{},1000)`,
    )
    const out = await run(root, 'node server.cjs', `http://127.0.0.1:${port}/`)

    expect(out.status).toBe('success')
    const probe = out.data?.probe as { status: number; body: string }
    expect(probe.status).toBe(200)
    expect(probe.body).toContain('hello from probe')

    // 进程必须已经退出。这是该功能的全部承诺：进程的生命周期不超出本次调用。
    // 仍能连接说明遗留了孤儿进程，它会占用端口，导致下一次运行失败。
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
   * 无法连接时必须带回进程自身的输出。
   *
   * 端口被占用、模块缺失等原因只输出到服务器的 stderr；只报告「无法连接」
   * 时模型只能推测，而它通常推测为应当重试。
   */
  test('探测失败带回进程输出', async () => {
    const root = await workspace()
    // 三层引号（shell / JS 源码 / 字符串字面量）嵌套极易出错，
    // 因此使用不含引号的消息，经 process.stderr.write 输出。
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
 * 该层拦截的不是越权，而是自我提权：`.agents/mcp.json` 决定模型能获得哪些
 * 工具，`.qy/team.json` 决定派发任务前哪些角色需要用户批准。模型可以合法写入工作区内的
 * 文件，因此它能通过写入一个有权限写入的文件，为自己添加工具。
 *
 * 判据是「是否会为自己添加工具」。技能与记忆同在 `.agents/` 下却不受保护：
 * 一篇 SKILL.md 是一段提示词，一条记忆是一句事实，两者都不提供新能力。
 * 按整个目录拦截它们的实测后果：设置页的「新增技能」把请求转交给模型，
 * 而模型无法写入该文件，该按钮点击后无响应。
 *
 * `full` 下这一层不设（`resolveWritablePath` 的 `unrestricted`）：该模式下
 * `run_command` 全部放行，只拦截文件工具就形成两套账。
 */
describe('受保护目录', () => {
  test('.qy 下的写入被拒绝，且说明理由', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.qy/team.json')).rejects.toThrow(/权限|扩展配置/)
  })

  /*
   * 保护范围必须覆盖项目层 MCP 配置的实际位置 `.agents/`。
   * 保护指向其他目录时只覆盖一个空目录，而这在外观上与有效保护无法区分。
   */
  test('会添加工具的配置被拒绝：mcp.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.agents/mcp.json')).rejects.toThrow(/权限|扩展配置/)
  })

  /**
   * 复现的失败：「新增技能」按钮把请求转交给模型，而模型写入
   * `.agents/skills/x/SKILL.md` 时被保护规则拒绝，该按钮点击后无响应。
   * 技能是提示词，不提供任何新能力，不应受保护。
   */
  test('技能与记忆不受保护：它们不提供新能力', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.agents/skills/发版/SKILL.md')).resolves.toContain(
      'SKILL.md',
    )
    await expect(resolveWritablePath(dir, '.agents/memory/x.md')).resolves.toContain('x.md')
  })

  /** 逐段比较而不是比较字符串前缀：`.qyX` 不在 `.qy` 目录下。 */
  test('名称以受保护目录名为前缀的目录不受影响', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.qyX/a.md')).resolves.toContain('a.md')
  })

  /** 绕过尝试：`..` 回退、大小写、分隔符混用。判定基于已解析的绝对路径，均应被拦截。 */
  test('绕过尝试均被拦截', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    const backslash = String.fromCharCode(92)
    const attempts = [
      './.qy/x.json',
      'sub/../.qy/x.json',
      `.qy${backslash}x.json`,
      './.agents/mcp.json',
      'sub/../.agents/mcp.json',
      `.agents${backslash}mcp.json`,
    ]
    for (const p of attempts) {
      await expect(resolveWritablePath(dir, p)).rejects.toThrow()
    }
  })

  test('工作区中的其他位置照常可写', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, 'src/a.ts')).resolves.toContain('a.ts')
    // 名称中含 .qy 但不是该目录的路径不得被误拦截。
    await expect(resolveWritablePath(dir, '.qyx/a.ts')).resolves.toContain('a.ts')
    await expect(resolveWritablePath(dir, 'docs/.qy.md')).resolves.toContain('.qy.md')
    await expect(resolveWritablePath(dir, '.agentsx/a.ts')).resolves.toContain('a.ts')
  })

  /** 读取不受限制：模型需要理解现有配置才能给出合理建议，读取不等于修改。 */
  test('只拦截写入，不拦截读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    expect(isProtectedPath(dir, join(dir, '.qy', 'team.json'))).toBe(true)
    expect(isProtectedPath(dir, join(dir, '.agents', 'mcp.json'))).toBe(true)
    expect(isProtectedPath(dir, join(dir, 'src', 'a.ts'))).toBe(false)
  })
})

describe('噪音目录', () => {
  /**
   * 复现原始失败：噪音目录清单各自维护一份（界面文件树 / glob·grep / list_dir）
   * 会出现偏差，实测曾分别为 13 / 12 / 11 条。`coverage` 不是点目录，不受任何
   * 点前缀规则覆盖，因此它是唯一实际暴露出来的目录：
   * 文件树中不显示，模型 `list_dir` 却能列出，`grep` 又搜索不到。
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
   * 原始失败：`resolveInWorkspace(mustExist:false)` 只解析目标已存在的祖先，
   * 却返回未解析的字面路径。工作区中放置一条指向界外的软链后，
   * 边界检查的是工作区，实际写入的是软链指向的位置。
   *
   * 此处直接复现该情形，包括悬挂软链（目标尚不存在），
   * 悬挂软链是新建文件路径上的实际漏洞。
   */
  test('指向界外的软链（含悬挂软链）不能写入', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-ws-'))
    const outside = await mkdtemp(join(tmpdir(), 'qy-out-'))

    // 1. 悬挂软链：目标尚不存在，realpath 会失败，但写入仍会跟随它。
    await symlink(join(outside, '还不存在.txt'), join(root, 'dangling'))
    expect(resolveInWorkspace(root, 'dangling')).rejects.toThrow(PathEscapeError)

    // 2. 已存在的软链。
    await writeFile(join(outside, '已存在.txt'), 'x', 'utf8')
    await symlink(join(outside, '已存在.txt'), join(root, 'existing'))
    expect(resolveInWorkspace(root, 'existing')).rejects.toThrow(PathEscapeError)

    // 3. 中间目录是软链，同样拒绝。
    await symlink(outside, join(root, 'dir'))
    expect(resolveInWorkspace(root, 'dir/新文件.txt')).rejects.toThrow(PathEscapeError)
  })

  /** 不要过度拒绝：工作区内尚不存在的新文件必须能正常解析。 */
  test('工作区内的新文件正常放行，且返回解析后的路径', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-ws-')))
    const abs = await resolveInWorkspace(root, '子目录/新文件.txt')
    expect(abs).toBe(join(root, '子目录', '新文件.txt'))
  })

  /**
   * 读与写必须解析为同一个键。
   *
   * 两者不同时，`files.ts` 的「本轮是否读过」在软链根下始终无法取得值，
   * 覆盖已存在的文件会被一律拒绝（macOS 的 /tmp → /private/tmp 即属此类）。
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
 * grep 的两种引擎必须使用同一个上界。
 *
 * 复现的是一次真实记录（会话 `cv_0mt0x92q10000mx0dff`）：一次不限文件类型的 grep
 * 命中 152 行，其中 151 行不足 600 字符，其余一行是 `three.min.js` 的第 6 行，
 * 共 603,378 个字符，约 17 万 token。它随工具结果进入上下文后再未移出，
 * 此后每一轮都重复计费，还使请求超出长上下文档位的价格线，一轮费用 $3.49。
 *
 * 成因是两种引擎使用两套标准：内置遍历截断到 400，ripgrep 只限条数不限长度。
 * 因此断言不能只测试「有截断」，而要测试两种引擎给出同一个上界：
 * 只测试一种时，出问题的可能恰好是另一种。
 */
describe('grep 的单条上界', () => {
  const MINIFIED = `!function(t){"use strict";${'x'.repeat(50_000)}/* bug */}(this)`

  const bothEngines = async (root: string) => {
    const { grepTool } = await import('./search.ts')
    const viaRg = await grepTool.fn!({ pattern: 'bug', path: '.' }, ctx(root))
    // 清空 PATH 迫使其使用内置遍历：未找到 rg 时的降级路径即由此触发。
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

  test('压缩过的整行不会完整进入上下文，两种引擎使用同一个上界', async () => {
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
      // 单条正文被截断：未截断时 ripgrep 路径上的单条正文超过 50,000 字符。
      const longest = Math.max(...matches.map((m) => m.length))
      expect(longest, name).toBeLessThan(600)
      // 路径与行号必须完整保留：模型依据它们调用 read_file 读取原文。
      expect(matches[0], name).toMatch(/^vendor\.min\.js:\d+:/)
    }
  })
})

/**
 * grep 必须计入本次决策的投递额度。
 *
 * `agent/loop/tool-wave.ts` 在每次下发一批工具之前调用 `resetBatchBudget`，理由写在该文件中：「压缩只留一个入口」
 * 的前提正是两次检查之间的增量有上界。grep 不记账时，单次 200 条 × 400 字符
 * 最坏约 32,000 token，已超过单次上界 25,000；它又是 `parallelSafe`，
 * 一批五个即为整批上界的三倍多。
 *
 * 断言的是截断而不是拒绝：该工具已有截断约定，超出预算时使用同一处理方式。
 */
describe('grep 计入投递额度', () => {
  test('超出剩余额度时减少条数并标记 truncated，而不是失败', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-budget-')))
    // 每行都命中且都达到单条上界，总量远超额度。
    const line = `bug ${'y'.repeat(500)}`
    await writeFile(join(root, 'noisy.txt'), Array.from({ length: 200 }, () => line).join('\n'))

    const { grepTool } = await import('./search.ts')
    const tiny = { ...ctx(root), state: openBatchBudget(new Map(), 1000) }
    const out = await grepTool.fn!({ pattern: 'bug', path: '.' }, tiny)

    expect(out.status).toBe('success')
    const data = out.data as { matches: string[]; truncated: boolean }
    expect(data.truncated).toBe(true)
    expect(data.matches.length).toBeLessThan(200)
    expect(out.message).toContain('已按上下文剩余空间截断')
  })

  /** 正常体量的搜索不受影响：额度只在确实越界时生效。 */
  test('可以容纳时完整返回，不标记截断', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-small-')))
    await writeFile(join(root, 'a.txt'), 'bug one\nbug two\nbug three\n')

    const { grepTool } = await import('./search.ts')
    const out = await grepTool.fn!({ pattern: 'bug', path: '.' }, ctx(root))
    const data = out.data as { matches: string[]; truncated: boolean }
    expect(data.matches.length).toBe(3)
    expect(data.truncated).toBe(false)
    expect(out.message).not.toContain('已按本轮剩余容量截断')
  })
})

/**
 * `read_file` 的图片与 PDF 两个分支。
 *
 * 两者都必须在二进制嗅探之前分派：手机照片和多数 PDF 都超过嗅探的大小阈值，
 * 分派稍晚就会先被判为二进制而拒绝。本组测试锁定的正是这一顺序。
 */
describe('read_file 识别图片', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  /**
   * 在读取时固定字节，不返回路径。
   *
   * 返回路径时，记录中保存的是「去哪里查看」而不是「看到了什么」，而模型修改页面后会重新
   * 截图并覆盖同名文件（这是对比修改前后的常规操作），此后历史中的该图片将
   * 无法取回。捕获只能在观察的时刻进行。
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

    // 覆盖同名文件后，先前取得的副本保持不变：这是不返回路径的目的。
    await writeFile(join(root, 'a.png'), Buffer.concat([PNG, Buffer.from('x')]))
    expect(data.images?.[0]?.data).toBe(PNG.toString('base64'))
  })

  /**
   * 当前模型不接受图片：在读取字节之前即拒绝，且说明中给出下一步。
   *
   * 只返回「读取失败」时，模型除了原样重读没有其他选择，而每次都会失败，
   * 形成死循环。因此断言的不只是 `failure`，还有「不要再读」这句说明。
   *
   * `null` 表示厂商规格页未写明，照常读取（判据只认 `false`）。
   */
  test('模型不接受图片：不读取字节，失败信息给出下一步', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img3-'))
    await writeFile(join(root, 'a.png'), PNG)

    const out = await registry().execute(
      'read_file',
      { path: 'a.png' },
      { ...ctx(root), vision: false },
    )
    expect(out.status).toBe('failure')
    expect(out.message).toContain('当前模型不接受图片输入')
    expect(out.message).toContain('不要再读')
    // 未读取任何字节：读取后再丢弃会浪费一次缩放，并多扣一次投递额度。
    expect(out.data).toBeUndefined()

    const ok = await registry().execute(
      'read_file',
      { path: 'a.png' },
      { ...ctx(root), vision: null },
    )
    expect(ok.status).toBe('success')
  })

  /**
   * 视频返回路径引用，发送前才读取字节；不接受原生视频且没有抽帧环境时立即拒绝并给出下一步，与图片相同。
   * 有抽帧环境的情形由 `office.test.ts` 覆盖。
   */
  test('读取视频：接受视频时返回路径引用，不接受且没有抽帧环境时拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-video-'))
    await writeFile(join(root, 'clip.mp4'), new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))

    const refused = await registry().execute('read_file', { path: 'clip.mp4' }, ctx(root))
    expect(refused.status).toBe('failure')
    expect(refused.message).toContain('不接受原生视频')
    expect(refused.message).toContain('不要再读')
    expect(refused.message).not.toContain('分段读取')

    const ok = await registry().execute(
      'read_file',
      { path: 'clip.mp4' },
      { ...ctx(root), video: true },
    )
    expect(ok.status).toBe('success')
    expect(ok.data).toEqual({
      videos: [{ path: await realpath(join(root, 'clip.mp4')), mime: 'video/mp4' }],
    })
  })

  /** 超过嗅探大小阈值的图片必须进入图片分支，不能被判为二进制而拒绝。 */
  test('大图片按图片分支读取，不提示「分段读取」', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img2-'))
    await writeFile(join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))
    const out = await registry().execute('read_file', { path: 'big.png' }, ctx(root))
    expect(out.status).toBe('success')
    expect(typeof (out.data as { images?: { data: string }[] }).images?.[0]?.data).toBe('string')
  })

  /**
   * 读取图片之后必须能够覆盖写入。
   *
   * 图片分支跳过了文本流程，若不补记一次读取记录，`write_file` 会返回
   * 「尚未读取，已拒绝覆盖修改。先 read_file 再覆盖」，而模型按提示操作后仍然无法通过。
   */
  test('读过的图片能被 write_file 覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img3-'))
    await writeFile(join(root, 'c.png'), PNG)
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'c.png' }, c)
    const w = await r.execute('write_file', { path: 'c.png', mode: 'overwrite', content: 'x' }, c)
    expect(w.status).toBe('success')
  })
})

/**
 * 大于 1 MB 的文本不在读取之前整份拒绝。投递量由投递额度决定，
 * 整份读取的上限只按内存计算（20 MB，与 PDF 相同）。
 */
describe('read_file 读取大文本', () => {
  test('1.3 MB 文本按 offset=1、limit=1 能读取到第一行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-big-text-'))
    const line = 'x'.repeat(99)
    await writeFile(
      join(root, 'big.log'),
      Array.from({ length: 13_000 }, (_, i) => `${i} ${line}`).join('\n'),
    )
    const out = await registry().execute(
      'read_file',
      { path: 'big.log', offset: 1, limit: 1 },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect((out.data as { content: string }).content).toBe(`1\t0 ${line}`)
    expect((out.data as { totalLines: number }).totalLines).toBe(13_000)
  })

  test('读取过的大文本能被 edit_file 修改，外部修改后仍被拦截', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-big-edit-'))
    const body = Array.from({ length: 13_000 }, (_, i) => `row ${i} ${'y'.repeat(95)}`).join('\n')
    await writeFile(join(root, 'big.log'), body)
    const r = registry()
    const c = ctx(root)
    expect((await r.execute('read_file', { path: 'big.log', offset: 5, limit: 2 }, c)).status).toBe(
      'success',
    )
    await writeFile(join(root, 'big.log'), `${body}\nappended`)
    const edit = { path: 'big.log', edits: [{ old_string: 'row 7 ', new_string: 'row seven ' }] }
    expect((await r.execute('edit_file', edit, c)).status).toBe('failure')
    expect((await r.execute('read_file', { path: 'big.log', offset: 5, limit: 2 }, c)).status).toBe(
      'success',
    )
    expect((await r.execute('edit_file', edit, c)).status).toBe('success')
  })

  /** 文本没有大小上限：按行流式读取，内存中只保留本轮要投递的行。 */
  test('25 MB 的多行文本按范围能读取到末尾附近的行，总行数正确', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-huge-text-'))
    const rows = 250_000
    await writeFile(
      join(root, 'huge.log'),
      Array.from({ length: rows }, (_, i) => `${i} ${'z'.repeat(95)}`).join('\n'),
    )
    const out = await registry().execute(
      'read_file',
      { path: 'huge.log', offset: rows - 1, limit: 2 },
      ctx(root),
    )
    expect(out.status).toBe('success')
    const data = out.data as { content: string; totalLines: number; endLine: number }
    expect(data.totalLines).toBe(rows)
    expect(data.endLine).toBe(rows)
    expect(data.content).toBe(
      `${rows - 1}\t${rows - 2} ${'z'.repeat(95)}\n${rows}\t${rows - 1} ${'z'.repeat(95)}`,
    )
  })

  /**
   * 读取一侧在读取过程中计算哈希，编辑一侧对整份正文计算：两侧解码不同（BOM、非法字节）或分行不同（CRLF）时，
   * 读取过的文件会被判为「读取之后被修改」而始终无法编辑。
   */
  test('带 BOM、CRLF 与非法字节的文件读取后可以编辑', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-odd-bytes-'))
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('first\r\nsecond '),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(' tail\r\nthird\r\n'),
    ])
    await writeFile(join(root, 'odd.txt'), bytes)
    const r = registry()
    const c = ctx(root)
    const read = await r.execute('read_file', { path: 'odd.txt' }, c)
    expect(read.status).toBe('success')
    const content = (read.data as { content: string }).content
    expect(content).not.toContain('\r')
    expect(content.split('\n')[2]).toBe('3\tthird')
    const edit = { path: 'odd.txt', edits: [{ old_string: 'third', new_string: 'THIRD' }] }
    expect((await r.execute('edit_file', edit, c)).status).toBe('success')
  })
})
