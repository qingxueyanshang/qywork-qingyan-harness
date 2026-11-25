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
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import {
  batchCapped,
  batchRemaining,
  decideCommand,
  firstPageCap,
  openBatchBudget,
  Ports,
  provide,
  runDensity,
  sanitizeToolName,
  ToolRegistry,
} from '@qywork/agent'
import { lookupModel } from '@qywork/ai'
import { FileReadPort } from './files/port.ts'
import { registerBuiltinTools } from './index.ts'
import { openInPanelTool } from './panel.ts'
import {
  CredentialPathError,
  displayPath,
  isProtectedPath,
  normalizeAdditionalDirectories,
  PathEscapeError,
  PathNotFoundError,
  ProtectedPathError,
  resolveCommandDir,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
  type WorkspaceRoots,
} from './paths.ts'
import { BASH_PATH_ENV, commandShell } from './process/command-shell.ts'
import { setCommandRunner } from './process/spawn.ts'
import { startCommandRunner } from './runner.ts'

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-test-'))
  await writeFile(join(dir, 'a.txt'), 'hello\nworld\n', 'utf8')
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'main.ts'), 'export const answer = 42\n', 'utf8')
  return dir
}

/** 本轮密度（同 `runDensity`）：模型不接受视频时 `video` 为 null；接受时按接口能否上传确定字节上限。 */
function videoDensity(video: boolean, uploadAbove?: number) {
  return runDensity({
    spec: { ...lookupModel('test', 'openai_chat_completions'), video },
    transmits: {
      effort: false,
      video,
      ...(uploadAbove !== undefined ? { mediaUploadAbove: uploadAbove } : {}),
    },
  })
}

/** 只有索引的最小 mp4（10 秒、640×360）：能读取时长与尺寸的视频才原生发送。`bytes` 为文件总长的下限。 */
function indexedMp4(bytes = 4096): Buffer {
  const box = (type: string, ...payload: Buffer[]) => {
    const body = Buffer.concat(payload)
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length + 8, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, body])
  }
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt32BE(1000, 12)
  mvhd.writeUInt32BE(10_000, 16)
  const tkhd = Buffer.alloc(84)
  tkhd.writeInt32BE(0x10000, 40)
  tkhd.writeUInt32BE(640 * 65536, 76)
  tkhd.writeUInt32BE(360 * 65536, 80)
  const moov = box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd)))
  const ftyp = box('ftyp', Buffer.from('isom0000', 'latin1'))
  return Buffer.concat([
    ftyp,
    box('mdat', Buffer.alloc(Math.max(0, bytes - moov.length - ftyp.length - 8))),
    moov,
  ])
}

function ctx(root: string, approve = true): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: videoDensity(false),
    vision: null,
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    sink: null,
    port: () => null,
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
 * 复现的原始失败：一次越界的路径参数被拒绝，结果只有一句「工具 read_file
 * 执行出错: 路径越界」，模型将其当作偶发故障，转而用 `run_command` 绕过
 * （shell 只限定 cwd，命令正文中的 `cd` 可以离开工作区），全程未告知用户。
 */
describe('越界拒绝是判定，不是崩溃', () => {
  // 家目录中、工作区之外的写入目标在自动审批下越界。解析只做判定，不创建文件。
  const denial = async () => {
    const root = await workspace()
    return registry().execute(
      'write_file',
      {
        path: join(homedir(), `qywork-absent-${process.pid}`, 'README.md'),
        mode: 'create',
        content: 'x',
      },
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
 * 原始失败形状（会话 `cv_0mww5s5wo000082j3b2`）：模型在已存在的文件名之后多写了「行数？ no!」，回执只有「路径不存在：<路径>」。
 * 模型 `list_dir` 看到该文件存在，判为工具在路径后追加了内容，以同一路径连续调用三次后运行停止。
 */
describe('路径不存在的回执写明错在哪里', () => {
  test('已存在的文件名之后多出文字时，写明参数原文、缺失的一段与多出的文字', async () => {
    const root = await workspace()
    const out = await registry().execute('read_file', { path: 'src/main.ts行数？ no!' }, ctx(root))
    expect(out.errorKind).toBe('path_not_found')
    expect(out.executed).toBe(false)
    expect(out.message).toContain('「src/main.ts行数？ no!」（本次调用参数的原文）')
    expect(out.message).toContain('目录「src」中没有「main.ts行数？ no!」')
    expect(out.message).toContain('该目录中有文件「main.ts」，参数在该名称之后多出「行数？ no!」')
    expect(out.message).not.toContain('list_dir')
  })

  test('目录名之后多出文字时同样写明，并按目录称呼', async () => {
    const root = await workspace()
    const out = await registry().execute('read_file', { path: 'src进度/main.ts' }, ctx(root))
    expect(out.message).toContain('工作区根目录中没有「src进度」')
    expect(out.message).toContain('该目录中有目录「src」，参数在该名称之后多出「进度」')
  })

  test('目录中没有名称是缺失一段开头的条目时，写明已存在的部分并给出查找方式', async () => {
    const root = await workspace()
    const out = await registry().execute('read_file', { path: 'src/lib/util.ts' }, ctx(root))
    expect(out.message).toContain('目录「src」中没有「lib」')
    expect(out.message).not.toContain('多出')
    expect(out.message).toContain('用 list_dir 或 glob 确认其实际位置后重试')
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
      resolveWritablePath({ workspaceRoot: root, unrestricted: true }, '.qy/team.json'),
    ).resolves.toBeDefined()
    await expect(resolveWritablePath(root, '.qy/team.json')).rejects.toBeInstanceOf(
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

  test('工作区的 .qy 保护不受额外目录影响', async () => {
    const { root, extra } = await withExtra()
    await expect(
      resolveWritablePath({ workspaceRoot: root, additional: [extra] }, '.qy/team.json'),
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

/**
 * 原始失败形状：工作区根为目录联接或符号链接时，工具回执中工作区内的文件显示为绝对路径，
 * `open_in_panel` 随之判定该文件不在工作区中。
 */
describe('工作区根为目录联接', () => {
  test('回执中的路径相对工作区根，open_in_panel 可以打开工作区中的文件', async () => {
    const real = await realpath(await workspace())
    const base = await mkdtemp(join(tmpdir(), 'qywork-linked-root-'))
    const root = join(base, 'ws')
    await symlink(real, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(displayPath(root, join(real, 'src', 'main.ts'))).toBe('src/main.ts')
    expect(displayPath(root, join(root, 'src', 'main.ts'))).toBe('src/main.ts')
    expect(displayPath(root, real)).toBe('.')
    const listed = await registry().execute('list_dir', { path: 'src' }, ctx(root))
    expect(listed.message).toStartWith('src：')
    const opened = await openInPanelTool.fn({ path: 'a.txt' }, ctx(root))
    expect(opened).toMatchObject({ status: 'success', data: { path: 'a.txt' } })
  })
})

describe('只读根目录', () => {
  async function withSkills(): Promise<{ root: string; skills: string }> {
    const root = await workspace()
    const skills = await mkdtemp(join(tmpdir(), 'qywork-skills-'))
    await writeFile(join(skills, 'SKILL.md'), '# skill\n', 'utf8')
    return { root, skills }
  }

  /**
   * 写入与命令工作目录是否放行取决于该目录是否位于家目录中（见「写入范围」），与它是否为只读根目录无关：
   * 只读根目录不扩大写入范围。
   */
  test('读取放行；写入与命令工作目录的结论与没有只读根目录时相同', async () => {
    const { root, skills } = await withSkills()
    const c = { ...ctx(root), readOnlyRoots: [skills] }
    await expect(
      resolveInWorkspace(rootsOf(c), join(skills, 'SKILL.md'), { mustExist: true }),
    ).resolves.toContain('SKILL.md')
    const outcome = (roots: WorkspaceRoots) =>
      resolveWritablePath(roots, join(skills, 'out.md')).then(
        () => 'resolved',
        (e: Error) => e.name,
      )
    const writes = await outcome(rootsOf(ctx(root)))
    expect(await outcome(rootsOf(c))).toBe(writes)
    const dir = await resolveCommandDir(rootsOf(c), skills).then(
      () => 'resolved',
      (e: Error) => e.name,
    )
    expect(dir).toBe(writes)
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

/**
 * 子进程中经工具注册表依次执行 `QYWORK_SCOPE_CASE.calls`，输出每次调用的状态、错误类别、回执与 grep 的命中条数，
 * 以及本机内核沙箱是否生效。
 * 家目录由父进程经环境变量设定：Linux 上的 Bun 在启动时读取 HOME，运行中修改环境变量不生效。
 */
const SCOPE_CHILD = `
import { openBatchBudget, Ports, provide, runDensity, ToolRegistry } from '@qywork/agent'
import { lookupModel } from '@qywork/ai'
import { detectSandbox, MediaPort, registerBuiltinTools } from '@qywork/tools'
const { root, calls } = JSON.parse(process.env.QYWORK_SCOPE_CASE)
const registry = new ToolRegistry()
registerBuiltinTools(registry, new Ports(), { media: ['image'] })
const ctx = {
  workspaceRoot: root,
  conversationId: 'cv_test',
  runId: 'rn_test',
  model: 'test',
  contextWindow: 200000,
  density: runDensity({
    spec: { ...lookupModel('test', 'openai_chat_completions'), video: false },
    transmits: { effort: false, video: false },
  }),
  vision: null,
  state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
  sink: null,
  port: new Ports([
    provide(MediaPort, { displayName: () => undefined, generate: async () => ({ ok: false, message: '不应重新取回' }) }),
  ]).get,
  signal: new AbortController().signal,
  emit: () => {},
  requestPermission: async () => ({ allowed: true }),
}
const out = []
for (const [name, args] of calls) {
  const r = await registry.execute(name, args, ctx)
  const matches = Array.isArray(r.data?.matches) ? r.data.matches : null
  out.push({ status: r.status, errorKind: r.errorKind ?? null, message: r.message, matches })
}
console.log(JSON.stringify({ sandbox: detectSandbox().active, out }))
`

interface ScopeResult {
  status: string
  errorKind: string | null
  message: string
  matches: string[] | null
}

/** 以 `home` 为家目录启动子进程执行 `calls`，不读取或修改用户真实的家目录。`env` 覆盖子进程的其余环境变量。 */
function runScope(
  home: string,
  root: string,
  calls: unknown[],
  env: Record<string, string> = {},
): { sandbox: boolean; out: ScopeResult[] } {
  const child = Bun.spawnSync([process.execPath, '-e', SCOPE_CHILD], {
    cwd: join(import.meta.dir, '..', '..', '..'),
    env: {
      ...process.env,
      ...env,
      HOME: home,
      USERPROFILE: home,
      QYWORK_SCOPE_CASE: JSON.stringify({ root, calls }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (child.exitCode !== 0) throw new Error(child.stderr.toString())
  return JSON.parse(child.stdout.toString())
}

const outcome = ({ status, errorKind }: ScopeResult) => ({ status, errorKind })

/**
 * 自动审批下的写入范围与命令裁决相同：根目录之外、且不在家目录或系统目录中的位置可写。
 *
 * 原始失败形状：文件工具拒绝一切根目录之外的写入，而 `run_command` 放行家目录与系统目录之外的写入，
 * 同一位置两侧结论不同；名称以两个点开头的子项（`..cache`）被判为越界。
 */
describe('写入范围', () => {
  // 文件系统根目录下不存在的目录：在任何机器上都不位于家目录或系统目录中。解析只做判定，不创建文件。
  const elsewhere = join(resolve('/'), `qywork-absent-${process.pid}`, 'a.txt')

  test('家目录与系统目录之外的位置可写；服务端直接传入工作区路径的读写仍限于根目录', async () => {
    const root = await workspace()
    await expect(resolveWritablePath(rootsOf(ctx(root)), elsewhere)).resolves.toBe(elsewhere)
    await expect(resolveWritablePath(root, elsewhere)).rejects.toBeInstanceOf(PathEscapeError)
    await expect(resolveInWorkspace(root, elsewhere)).rejects.toBeInstanceOf(PathEscapeError)
  })

  test('家目录中、根目录之外的位置拒绝写入，包括 ~/.qywork', async () => {
    const root = await workspace()
    for (const target of [
      join(homedir(), `qywork-absent-${process.pid}`, 'a.txt'),
      join(homedir(), '.qywork', 'mcp-approvals.json'),
    ]) {
      await expect(resolveWritablePath(rootsOf(ctx(root)), target)).rejects.toBeInstanceOf(
        PathEscapeError,
      )
    }
    await expect(
      resolveWritablePath(rootsOf(ctx(root)), join(homedir(), '.qywork', 'config.json')),
    ).rejects.toBeInstanceOf(CredentialPathError)
  })

  /**
   * 包含家目录的位置按家目录处理，位于家目录的上级之中、但不包含家目录的位置
   * （如 `C:/Users/Public/a.txt`）不因此被拒绝。解析只做判定，不创建文件。
   */
  test('家目录的上级本身拒绝写入；其中不包含家目录的位置可写', async () => {
    const root = await workspace()
    const parent = dirname(homedir())
    await expect(resolveWritablePath(rootsOf(ctx(root)), parent)).rejects.toBeInstanceOf(
      PathEscapeError,
    )
    const besideHome = join(parent, `qywork-absent-${process.pid}`, 'a.txt')
    await expect(resolveWritablePath(rootsOf(ctx(root)), besideHome)).resolves.toBe(besideHome)
  })

  /**
   * `run_command` 的工作目录与写入范围相同，与命令文本中 `cd` 之后相对路径写入的判定一致。
   * 原始失败形状：`cwd` 参数限于根目录，而命令文本中的 `cd D:/x` 放行。
   */
  test('run_command 的工作目录：家目录拒绝，家目录与系统目录之外的位置允许', async () => {
    const root = await workspace()
    const other =
      process.platform === 'win32' ? (process.env.ProgramData ?? 'C:\\ProgramData') : '/usr'
    const r = registry()
    const far = await r.execute('run_command', { command: 'echo x', cwd: other }, ctx(root))
    expect(far.status).toBe('success')
    const home = await r.execute('run_command', { command: 'echo x', cwd: homedir() }, ctx(root))
    expect(home).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'path_out_of_workspace',
    })
  }, 30_000)

  test('名称以两个点开头的子项位于工作区内', async () => {
    const root = await realpath(await workspace())
    const expected = join(root, '..cache', 'a.txt')
    await expect(resolveInWorkspace(root, '..cache/a.txt')).resolves.toBe(expected)
    await expect(resolveWritablePath(root, '..cache/a.txt')).resolves.toBe(expected)
    expect(displayPath(root, expected)).toBe('..cache/a.txt')
  })

  /**
   * `retrieve_media` 一项：产物经写入范围落盘在家目录之外，取回时按同一范围判定其仍在原位置，直接交付。
   * 按读取范围判定时，该产物被判为已移走，记录随之删除。
   */
  test('write_file 写入家目录之外的位置成功；写入家目录中的位置、经目录链接进入家目录均拒绝；read_file 读取工作区外成功；落在家目录之外的生成产物可以取回', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'qywork-scope-')))
    const home = join(base, 'home')
    const root = join(home, 'a', 'ws')
    const outside = join(base, 'elsewhere')
    await mkdir(root, { recursive: true })
    await mkdir(join(home, 'other'), { recursive: true })
    await symlink(
      join(home, 'other'),
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const media = join(base, 'media')
    await mkdir(media, { recursive: true })
    await writeFile(join(media, 'x.png'), 'png')
    const record = join(media, 'x.task.json')
    await writeFile(
      record,
      JSON.stringify({
        type: 'image',
        provider: 'p',
        model: 'm',
        output: join(media, 'x'),
        submittedAt: '2026-11-15T00:00:00.000Z',
        landed: { files: [{ path: join(media, 'x.png'), mime: 'image/png', bytes: 3 }] },
      }),
    )
    const calls = [
      ['write_file', { path: join(outside, 'a.txt'), mode: 'create', content: 'elsewhere' }],
      ['write_file', { path: join(home, 'other', 'a.txt'), mode: 'create', content: 'home' }],
      ['write_file', { path: join(home, '.qywork', 'config.json'), mode: 'create', content: '{}' }],
      [
        'write_file',
        { path: 'linked/page.html', mode: 'create', on_conflict: 'rename', content: 'page' },
      ],
      ['read_file', { path: join(outside, 'a.txt') }],
      ['retrieve_media', { path: record }],
    ]
    const denied = { status: 'failure', errorKind: 'path_out_of_workspace' }
    const credential = { status: 'failure', errorKind: 'credential_path' }
    const ok = { status: 'success', errorKind: null }
    expect(runScope(home, root, calls).out.map(outcome)).toEqual([
      ok,
      denied,
      credential,
      denied,
      ok,
      ok,
    ])
    expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('elsewhere')
    // 交付后删除记录，产物保留在原位置。
    expect(await stat(record).catch(() => null)).toBeNull()
    expect(await readFile(join(media, 'x.png'), 'utf8')).toBe('png')
    for (const absent of [join(home, 'other', 'a.txt'), join(home, 'other', 'page.html')]) {
      expect(await stat(absent).catch(() => null)).toBeNull()
    }
    expect(await stat(join(home, '.qywork')).catch(() => null)).toBeNull()
  }, 30_000)

  /**
   * 全局数据目录由 `QYWORK_HOME` 指向家目录之外，并经目录联接指向别处。文件工具的结论与命令裁决相同：
   * 其中的 `config.json` 与 `mcp.json` 不可读，其余位置不可写，其余文件在没有内核沙箱的平台上可读；
   * 经联接与经真实路径结论相同。
   *
   * 原始失败形状：凭证判定只识别 `.qywork/` 下的写法，位置判定只比较家目录。`read_file` 读取了其中的明文 key，
   * `write_file` 写入其中的插件目录与 MCP 启动确认。
   */
  test('QYWORK_HOME 指向家目录之外的全局数据目录：配置文件拒绝读取，其中的位置拒绝写入', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'qywork-data-home-')))
    const home = join(base, 'home')
    const root = join(home, 'a', 'ws')
    const real = join(base, 'data-real')
    const link = join(base, 'data')
    await mkdir(root, { recursive: true })
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'config.json'), '{"apiKey":"sk-data-home-test"}\n')
    await writeFile(join(real, 'mcp.json'), '{"servers":{}}\n')
    await writeFile(join(real, 'notes.md'), 'notes\n')
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    const calls = [
      ['read_file', { path: join(link, 'config.json') }],
      ['read_file', { path: join(real, 'config.json') }],
      ['read_file', { path: join(real, 'mcp.json') }],
      ['read_file', { path: join(real, 'notes.md') }],
      [
        'write_file',
        { path: join(real, 'plugins', 'p', 'index.js'), mode: 'create', content: 'x' },
      ],
      ['write_file', { path: join(link, 'mcp-approvals.json'), mode: 'create', content: '{}' }],
      ['write_file', { path: join(base, 'elsewhere', 'a.txt'), mode: 'create', content: 'x' }],
    ]
    const denied = { status: 'failure', errorKind: 'path_out_of_workspace' }
    const credential = { status: 'failure', errorKind: 'credential_path' }
    const ok = { status: 'success', errorKind: null }
    const { sandbox, out } = runScope(home, root, calls, { QYWORK_HOME: link })
    // 内核沙箱生效时全局数据目录按实际位置整个被屏蔽，其中的其余文件同样拒绝读取。
    const masked = sandbox ? credential : ok
    expect(out.map(outcome)).toEqual([
      credential,
      credential,
      credential,
      masked,
      denied,
      denied,
      ok,
    ])
    expect(out.map((r) => r.message).join('\n')).not.toContain('sk-data-home-test')
    for (const absent of [join(real, 'plugins'), join(real, 'mcp-approvals.json')]) {
      expect(await stat(absent).catch(() => null)).toBeNull()
    }
  }, 30_000)
})

/**
 * 自动审批下模型工具的读取范围与命令裁决相同：根目录之外的位置可读，凭证文件除外；
 * 内核沙箱生效的平台上，沙箱屏蔽的凭证目录同样不可读。服务端直接传入工作区路径的读取仍限于根目录。
 *
 * 原始失败形状：`read_file` 读取根目录之外的文件被拒，而 `run_command` 的 `cat` 能读取同一文件，
 * 模型随即改用 shell 读取，同一模式下两套账。
 */
describe('读取范围', () => {
  async function scopeTree() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'qywork-read-scope-')))
    const home = join(base, 'home')
    const root = join(home, 'a', 'ws')
    const outside = join(base, 'elsewhere')
    const qywork = join(home, '.qywork')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(qywork, { recursive: true })
    await mkdir(join(home, '.gnupg'), { recursive: true })
    await writeFile(join(outside, 'a.txt'), 'elsewhere\n')
    await writeFile(join(home, 'notes.txt'), 'notes\n')
    await writeFile(join(qywork, 'config.json'), '{"apiKey":"sk-scope-test"}\n')
    await writeFile(join(qywork, 'mcp.json'), '{"servers":{"apiKey":"x"}}\n')
    await writeFile(join(home, '.gnupg', 'pubring.kbx'), 'keyring\n')
    await symlink(qywork, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    return { base, home, root, outside, qywork }
  }

  test('read_file 读取工作区外的普通文件成功；凭证文件经直接路径、.. 写法与目录联接均拒绝，回执不说明文件是否存在；grep 不返回凭证文件的内容', async () => {
    const { home, root, outside, qywork } = await scopeTree()
    const calls = [
      ['read_file', { path: join(outside, 'a.txt') }],
      ['read_file', { path: join(home, 'notes.txt') }],
      ['read_file', { path: join(qywork, 'config.json') }],
      ['read_file', { path: '../../.qywork/config.json' }],
      ['read_file', { path: 'linked/config.json' }],
      ['read_file', { path: join(qywork, 'mcp.json') }],
      ['read_file', { path: join(home, '.ssh', 'id_rsa') }],
      ['grep', { pattern: 'apiKey', path: qywork }],
      // 前瞻断言使 rg 以退出码 2 失败，转入内置遍历。
      ['grep', { pattern: '(?=api)apiKey', path: 'linked' }],
      ['read_file', { path: join(home, '.gnupg', 'pubring.kbx') }],
    ]
    const { sandbox, out } = runScope(home, root, calls)
    const ok = { status: 'success', errorKind: null }
    const credential = { status: 'failure', errorKind: 'credential_path' }
    // 内核沙箱生效时 `~/.qywork` 与 `~/.gnupg` 整个目录被屏蔽，以它们为起点的读取同样拒绝。
    const masked = sandbox ? credential : ok
    expect(out.map(outcome)).toEqual([
      ok,
      ok,
      credential,
      credential,
      credential,
      credential,
      credential,
      masked,
      masked,
      masked,
    ])
    // 存在的 config.json 与不存在的 id_rsa 回执只有路径不同。
    const shape = (r: ScopeResult, attempted: string) => r.message.replace(attempted, '<path>')
    expect(shape(out[2]!, join(qywork, 'config.json'))).toBe(
      shape(out[6]!, join(home, '.ssh', 'id_rsa')),
    )
    if (!sandbox) {
      expect(out[7]?.matches).toEqual([])
      expect(out[8]?.matches).toEqual([])
    }
  }, 30_000)

  /**
   * 两侧对同一组路径的结论逐项一致。命令一侧按命令全文判定，文件工具按解析出的真实路径判定，
   * 两侧调用同一个凭证判定。路径都写成绝对路径或相对工作区的写法，判定不访问用户真实的家目录。
   *
   * 经目录联接指向凭证文件的路径不在表中：命令文本中不出现凭证文件的名称，命令一侧无法据文本判定，
   * 文件工具按真实路径拒绝（见上一个用例）。
   */
  test('文件工具与命令裁决对同一组路径的读取结论一致', async () => {
    const { home, root, outside, qywork } = await scopeTree()
    const system =
      process.platform === 'win32'
        ? join(resolve('/'), 'Windows', 'win.ini')
        : join(resolve('/'), 'etc', 'hosts')
    const rows: [string, 'allow' | 'deny'][] = [
      [join(outside, 'a.txt'), 'allow'],
      [join(home, 'notes.txt'), 'allow'],
      [system, 'allow'],
      [join(qywork, 'config.json'), 'deny'],
      [join(qywork, 'mcp.json'), 'deny'],
      ['../../.qywork/config.json', 'deny'],
      [join(home, '.ssh', 'id_rsa'), 'deny'],
      [join(home, '.aws', 'credentials'), 'deny'],
      ['.npmrc', 'deny'],
    ]
    for (const [path, expected] of rows) {
      const file = await resolveInWorkspace(rootsOf(ctx(root)), path).then(
        () => 'allow',
        (e: Error) => (e instanceof CredentialPathError ? 'deny' : e.name),
      )
      const command = decideCommand(`cat '${path}'`, { workspaceRoot: root }).kind
      expect({ path, file, command }).toEqual({ path, file: expected, command: expected })
    }
  })

  test('服务端直接传入工作区路径的读取仍限于根目录', async () => {
    const { root, outside } = await scopeTree()
    await expect(resolveInWorkspace(root, join(outside, 'a.txt'))).rejects.toBeInstanceOf(
      PathEscapeError,
    )
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
   * 无法解析为整数的 offset 是失败，而不是一次读取到 0 行的成功。
   *
   * 原始失败：模型把行区间写成一个字符串（`offset: "1,4000"`），
   * `Math.max(1, Number(...))` 得到 NaN，`slice(NaN, NaN)` 是空数组，
   * `truncated` 与 NaN 比较也为假，返回给模型的是
   * 「success / 0 行 / 未截断 / 文件有 349 行」四条互相矛盾的事实。
   */
  test('offset 无法解析为整数时失败，而不是成功读取到 0 行', async () => {
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

  /**
   * 未指定范围、文件又无法整份读取时，第一次只返回不超过 `firstPageCap` 的开头部分，不记为触及上限，
   * 下一次决策之前不被收纳；指定 offset 续读时按 `deliveryCap` 读满并记为触及上限。
   */
  test('未指定范围且无法整份读取时只返回开头部分，指定 offset 续读时读满单次上限', async () => {
    const root = await workspace()
    const line = `第一行之后的正文 ${'x'.repeat(60)}`
    await writeFile(join(root, 'novel.txt'), Array.from({ length: 20_000 }, () => line).join('\n'))
    const budget = () => ({
      ...ctx(root),
      state: openBatchBudget(new Map(), 100_000, 20_000),
    })
    const r = registry()

    const first = budget()
    const opening = await r.execute('read_file', { path: 'novel.txt' }, first)
    expect(opening.status).toBe('success')
    const head = opening.data as { startLine: number; endLine: number; nextOffset: number }
    expect(head.startLine).toBe(1)
    expect(head.nextOffset).toBe(head.endLine + 1)
    expect(opening.message).toContain('先返回开头部分')
    expect(opening.message).toContain(`offset=${head.endLine + 1}`)
    expect(100_000 - batchRemaining(first)).toBeLessThanOrEqual(firstPageCap(budget()))
    expect(batchCapped(first.state)).toBe(false)

    const next = budget()
    const more = await r.execute('read_file', { path: 'novel.txt', offset: head.nextOffset }, next)
    expect(more.status).toBe('success')
    const tail = more.data as { startLine: number; endLine: number }
    expect(tail.startLine).toBe(head.endLine + 1)
    expect(more.message).toContain('超出上下文剩余空间')
    expect(tail.endLine - tail.startLine + 1).toBeGreaterThan(4 * head.endLine)
    expect(batchCapped(next.state)).toBe(true)
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

  test('读取之后允许覆盖，并报告行级增删', async () => {
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
      await r.execute(
        'read_file',
        { path: 'a.txt' },
        { ...ctx(root), port: new Ports([provide(FileReadPort, reads)]).get },
      )
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', edits: [{ old_string: 'world', new_string: 'there' }] },
        { ...ctx(root), port: new Ports([provide(FileReadPort, reads)]).get },
      )
      expect(out.status).toBe('success')
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello\nthere\n')
    })

    test('未接入 port 时仍要求本 run 读取过：采用更严格的一侧', async () => {
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
      await r.execute(
        'read_file',
        { path: 'a.txt' },
        { ...ctx(root), port: new Ports([provide(FileReadPort, reads)]).get },
      )
      // 其他方（用户、另一个进程）修改了磁盘上的内容。
      await writeFile(join(root, 'a.txt'), 'hello\nworld\nplus\n', 'utf8')
      const out = await r.execute(
        'edit_file',
        { path: 'a.txt', edits: [{ old_string: 'world', new_string: 'there' }] },
        { ...ctx(root), port: new Ports([provide(FileReadPort, reads)]).get },
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

  test('部分项未命中时写入其余项，回执写明已写入与未写入的项', async () => {
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
    expect(out.message).toContain('编辑 units.md：已写入第 1、3 项，共 4 项')
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

  /**
   * 原始失败形状：模型复述超过 400 字的段落时把「胸前」写成「胸口」，回执只写未找到，
   * 模型以含同一处差异的内容连续重发。回执须指出从哪里开始不一致。
   */
  test('未命中时指出 old_string 与原文开始不一致的行与片段；前缀过短时不给出位置', async () => {
    const root = await workspace()
    await writeFile(
      join(root, 'shot.md'),
      '# 第一集\n0-5秒：近景过肩，等效40毫米，胸前卡槽打开。\n5-13秒：中景。\n',
    )
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'shot.md' }, c)
    const out = await r.execute(
      'edit_file',
      {
        path: 'shot.md',
        edits: [
          { old_string: '0-5秒：近景过肩，等效40毫米，胸口卡槽打开。\n5-13秒', new_string: 'x' },
          { old_string: '0-9秒：远景', new_string: 'y' },
        ],
      },
      c,
    )
    expect(out.message).toBe(
      '第 1 项未写入：old_string 未在文件中找到。前 18 字与原文一致，第 2 行此后的原文为 "前卡槽打开。\\n5-13秒：中景。\\n"，old_string 为 "口卡槽打开。\\n5-13秒"\n' +
        '第 2 项未写入：old_string 未在文件中找到',
    )
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

  /**
   * 停止后 grep 结束，不转入降级遍历：rg 被终止后按执行失败返回，降级遍历会再完整遍历一次目录。
   * 起点在根目录之外时目录可以很大（家目录、整个盘），不响应停止的搜索会使本轮一直等待。
   */
  test('grep 在已停止的执行中结束，两种引擎都不继续遍历', async () => {
    const root = await workspace()
    const stop = new AbortController()
    stop.abort()
    for (const pattern of ['answer', '(?=answer)answer']) {
      const out = await registry().execute(
        'grep',
        { pattern },
        { ...ctx(root), signal: stop.signal },
      )
      expect(out.status).toBe('failure')
    }
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
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
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
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
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
   * 影响不限于该次调用：`runs.release` 不执行，整个会话此后拒绝所有新任务。
   *
   * 锁定两件事：按时返回，以及说明后台仍留有进程。只锁定前者时，
   * 一条未复现该情形的命令也能使本测试通过。
   *
   * PowerShell 一档的写法未在本机验证（本机有 bash，使用的是另一档）。
   */
  test('遗留的后台进程持有管道时，命令仍按时返回并说明情况', async () => {
    const shell = commandShell()
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
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
   * 原始失败：一套 25 页 PPT 的重建脚本逐页处理，运行 15–20 分钟，按总时长在 600 秒时被终止，
   * 模型连续四次重新运行后改为放到后台轮询。三条命令：持续输出、总时长超过时限的命令正常结束；
   * 不输出但一直占用 CPU 的命令也正常结束（输出接到 `| tail` 时即属此类）；不输出也不占用 CPU
   * 的命令到时限后终止。三项都锁定：只锁定前两项时，删除全部时限也能通过。
   */
  async function idleJudged(root: string) {
    const shell = commandShell()
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
    const ps = shell.argv.includes('-Command')
    const talking = ps
      ? '1..6 | ForEach-Object { Write-Output $_; Start-Sleep -Milliseconds 400 }'
      : 'for i in 1 2 3 4 5 6; do echo $i; sleep 0.4; done'
    const computing = ps
      ? "$e = (Get-Date).AddSeconds(6); while ((Get-Date) -lt $e) {}; 'finished'"
      : 'end=$((SECONDS+6)); while [ $SECONDS -lt $end ]; do :; done; echo finished'
    const silent = ps ? 'Start-Sleep -Seconds 20' : 'sleep 20'

    const started = Date.now()
    const ok = await registry().execute(
      'run_command',
      { command: talking, timeout_ms: 1500 },
      ctx(root),
    )
    expect(ok.status).toBe('success')
    expect(String(ok.data?.stdout)).toContain('6')
    expect(Date.now() - started).toBeGreaterThan(1500)

    const busy = await registry().execute(
      'run_command',
      { command: computing, timeout_ms: 1500 },
      ctx(root),
    )
    expect(busy.status).toBe('success')
    expect(String(busy.data?.stdout)).toContain('finished')

    const stuck = await registry().execute(
      'run_command',
      { command: silent, timeout_ms: 1500 },
      ctx(root),
    )
    expect(stuck.status).toBe('failure')
    expect(stuck.errorKind).toBe('timeout')
    expect(stuck.message).toContain('没有占用 CPU')
  }

  test('timeout_ms 判定停滞：仍在输出或仍在计算的命令运行超过时限照常结束，既不输出也不计算的命令按时终止', async () => {
    await idleJudged(await workspace())
  }, 60_000)

  /** 产品经 runner 执行命令：runner 若在命令退出后才转发输出，无输出判定会把持续输出的命令当作停滞。 */
  test('runner 代为执行时同样按无输出判定', async () => {
    const root = await workspace()
    const runner = startCommandRunner([
      process.execPath,
      '-e',
      `import { runCommandRunner } from ${JSON.stringify(Bun.fileURLToPath(new URL('./runner.ts', import.meta.url)))}; runCommandRunner()`,
    ])
    setCommandRunner(runner)
    try {
      await idleJudged(root)
    } finally {
      setCommandRunner(null)
      runner.stop()
    }
  }, 60_000)

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
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
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
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
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
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
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
    if (shell === null) throw new Error('本机没有可用的 shell，无法执行本测试')
    const root = await workspace()
    // 首次输出之后才中断：Windows 上的输出由孤儿进程 ping 写出，POSIX 上 echo 在后台进程启动之后执行。
    const command = shell.argv.includes('-Command')
      ? "Start-Process -NoNewWindow -FilePath cmd.exe -ArgumentList '/c','ping -n 31 127.0.0.1'; Start-Sleep -Seconds 30"
      : 'sleep 30 & echo started; sleep 30'

    const controller = new AbortController()
    let abortedAt = 0
    const out = await registry().execute(
      'run_command',
      { command },
      {
        ...ctx(root),
        signal: controller.signal,
        emit: () => {
          if (controller.signal.aborted) return
          abortedAt = Date.now()
          controller.abort()
        },
      },
    )
    const elapsed = Date.now() - abortedAt

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
  test('工作区中的私钥无法读取到明文', async () => {
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

  test('.env 中的 token 无法读取到明文', async () => {
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

  /** 普通代码不得有任何改动，否则模型读取到的内容与磁盘不一致，编辑会失败。 */
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
 * 与权限模式无关（实测：开启完全访问后仍只取得 output_truncated）。
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
      const out = await run(root, 'echo 不应执行到此处', url)
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
   * 项目层 MCP 配置不受路径保护：其中的服务经用户确认后才启动（runtime 的 `mcp-approvals.ts`），
   * 任何途径写入的新内容都回到待确认。
   */
  test('项目层 mcp.json 可以写入，其中的服务由启动确认约束', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    await expect(resolveWritablePath(dir, '.agents/mcp.json')).resolves.toContain('mcp.json')
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
    const attempts = ['./.qy/x.json', 'sub/../.qy/x.json', `.qy${backslash}x.json`]
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

  /**
   * 原始失败形状：受保护目录按字面的工作区根判定，目标却已展开符号链接，两者的相对路径以 `..` 开头，
   * 工作区根为目录联接时 `.qy/team.json` 的写入被放行。
   */
  test('工作区根为目录联接或符号链接时，.qy 下的写入同样被拒绝', async () => {
    const base = await mkdtemp(join(tmpdir(), 'qy-protected-link-'))
    const real = join(base, 'real')
    const link = join(base, 'link')
    await mkdir(join(real, '.qy'), { recursive: true })
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveWritablePath(link, '.qy/team.json')).rejects.toBeInstanceOf(
      ProtectedPathError,
    )
    await expect(resolveWritablePath(rootsOf(ctx(link)), '.qy/team.json')).rejects.toBeInstanceOf(
      ProtectedPathError,
    )
    await expect(resolveWritablePath(link, 'src/a.ts')).resolves.toBe(
      join(await realpath(real), 'src', 'a.ts'),
    )
  })

  /** 读取不受限制：模型需要理解现有配置才能给出合理建议，读取不等于修改。 */
  test('只拦截写入，不拦截读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-protected-'))
    expect(isProtectedPath(dir, join(dir, '.qy', 'team.json'))).toBe(true)
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

  /*
   * 带前瞻断言的模式 rg 不支持（退出码 2），必然使用内置遍历；两个模式命中同一行。
   * 不要改为清空 PATH：Windows 上清空进程内的 PATH 之后仍能启动 rg，两次调用都经由 ripgrep。
   */
  const bothEngines = async (root: string) => {
    const { grepTool } = await import('./search.ts')
    return {
      viaRg: await grepTool.fn!({ pattern: 'bug', path: '.' }, ctx(root)),
      viaBuiltin: await grepTool.fn!({ pattern: 'bug(?= )', path: '.' }, ctx(root)),
    }
  }

  test('压缩过的整行不会完整进入上下文，两种引擎使用同一个上界', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-')))
    await writeFile(join(root, 'vendor.min.js'), MINIFIED, 'utf8')

    const { viaRg, viaBuiltin } = await bothEngines(root)
    if (Bun.which('rg')) expect((viaRg.data as { engine: string }).engine).toBe('ripgrep')
    expect((viaBuiltin.data as { engine: string }).engine).toBe('builtin')

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
 * 原始失败形状：grep 只返回命中行，账本中 668 次 grep 之后紧接着读取不超过 80 行、且其后未修改该文件，
 * 每次多一轮模型请求。`context` 返回命中行前后的行，两种引擎输出相同。
 */
describe('grep 的上下文行', () => {
  const TEXT = ['a', 'b', 'needle 1', 'c', 'd', 'e', 'f', 'needle 2', 'g'].join('\n')

  // 带前瞻断言的模式 rg 不支持（退出码 2），必然使用内置遍历；两个模式命中相同的行。
  const bothEngines = async (root: string, args: Record<string, unknown>) => {
    const { grepTool } = await import('./search.ts')
    return {
      viaRg: await grepTool.fn!({ ...args, pattern: 'needle' }, ctx(root)),
      viaBuiltin: await grepTool.fn!({ ...args, pattern: 'needle(?= )' }, ctx(root)),
    }
  }

  test('命中行前后各补 context 行，两种引擎输出相同', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-ctx-')))
    await writeFile(join(root, 'ctx.txt'), TEXT, 'utf8')
    const { viaRg, viaBuiltin } = await bothEngines(root, { context: 1 })
    if (Bun.which('rg')) expect((viaRg.data as { engine: string }).engine).toBe('ripgrep')
    expect((viaBuiltin.data as { engine: string }).engine).toBe('builtin')
    for (const out of [viaRg, viaBuiltin]) {
      expect(out.status).toBe('success')
      expect(out.message).toStartWith('命中 2 行')
      expect((out.data as { matches: string[] }).matches).toEqual([
        'ctx.txt-2-b\nctx.txt:3:needle 1\nctx.txt-4-c',
        'ctx.txt-7-f\nctx.txt:8:needle 2\nctx.txt-9-g',
      ])
    }
  })

  test('范围重叠时合并为一段', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-ctx-')))
    await writeFile(join(root, 'ctx.txt'), TEXT, 'utf8')
    const { viaRg, viaBuiltin } = await bothEngines(root, { context: 3 })
    for (const out of [viaRg, viaBuiltin]) {
      const matches = (out.data as { matches: string[] }).matches
      expect(matches).toHaveLength(1)
      expect(matches[0]!.split('\n')).toHaveLength(9)
      expect(out.message).toStartWith('命中 2 行')
    }
  })

  test('context 超出 0–10 时不执行搜索，报告参数错误', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-grep-ctx-')))
    const { grepTool } = await import('./search.ts')
    const out = await grepTool.fn!({ pattern: 'needle', context: 11 }, ctx(root))
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('invalid_args')
  })
})

/**
 * grep 必须计入本次决策的投递额度。
 *
 * `agent/loop/tool-wave.ts` 在每次下发一批工具之前调用 `resetBatchBudget`，理由写在该文件中：「压缩只留一个入口」
 * 的前提正是两次检查之间的增量有上界。grep 不记账时，单次 200 条 × 400 字符
 * 最坏约 32,000 token，已超过单次上界 25,000；它又是 `parallelSafe`，
 * 一批五个即超过整批上界的三倍。
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
    const tiny = { ...ctx(root), state: openBatchBudget(new Map(), 1000, 25_000) }
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
   * 返回路径时，记录中保存的是图片的位置而不是图片的内容，而模型修改页面后会重新
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
   * 形成无限循环。因此断言的不只是 `failure`，还有「不要再读」这句说明。
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
    await writeFile(join(root, 'clip.mp4'), indexedMp4())

    const refused = await registry().execute('read_file', { path: 'clip.mp4' }, ctx(root))
    expect(refused.status).toBe('failure')
    expect(refused.message).toContain('不接受原生视频')
    expect(refused.message).toContain('不要再读')
    expect(refused.message).not.toContain('分段读取')

    const ok = await registry().execute(
      'read_file',
      { path: 'clip.mp4' },
      { ...ctx(root), density: videoDensity(true) },
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

  /** 一张纯白 PNG，指定位置画一块黑：缩放与截取的结果按像素核对。 */
  async function canvasPng(width: number, height: number, mark?: [number, number, number, number]) {
    const photon = await import('@silvia-odwyer/photon-node')
    const px = new Uint8Array(width * height * 4).fill(255)
    if (mark) {
      const [x0, y0, x1, y1] = mark
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) px.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3)
      }
    }
    return Buffer.from(new photon.PhotonImage(px, width, height).get_bytes())
  }

  /**
   * 缩小发送时回执写明原图与发送尺寸，并指出 region。
   *
   * 实测缩小后模型把无法辨认的白边判为「干净」：不说明其取得的是缩小图时，模型不会截取局部。
   */
  test('长边超过上限的图片：回执写明原图与发送尺寸并指出 region', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img-big-'))
    await writeFile(join(root, 'shot.png'), await canvasPng(3000, 1000))
    const out = await registry().execute('read_file', { path: 'shot.png' }, ctx(root))
    expect(out.status).toBe('success')
    expect(out.message).toContain('原图 3000×1000，缩小为 1568×523 发送')
    expect(out.message).toContain('region')

    // 在上限内的图片原样发送，回执不提缩小。
    await writeFile(join(root, 'small.png'), await canvasPng(800, 600))
    const small = await registry().execute('read_file', { path: 'small.png' }, ctx(root))
    expect(small.message).toBe('读取 small.png（图片）')
  })

  /** region 从原图截取，不从缩小图截取，并放大到长边 1568（至多 4 倍）。 */
  test('region 从原图截取并放大，回执写明截取范围与倍数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img-zoom-'))
    await writeFile(join(root, 'shot.png'), await canvasPng(3000, 1000, [1500, 500, 1510, 502]))
    const out = await registry().execute(
      'read_file',
      { path: 'shot.png', region: { left: 0.5, top: 0.5, width: 0.1, height: 0.1 } },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect(out.message).toContain('截取 x 1500–1800、y 500–600')
    expect(out.message).toContain('放大 4.0 倍发送为 1200×400')
    const img = (out.data as { images: { data: string; mime: string }[] }).images[0]!
    const photon = await import('@silvia-odwyer/photon-node')
    const got = photon.PhotonImage.new_from_byteslice(Buffer.from(img.data, 'base64'))
    expect([got.get_width(), got.get_height()]).toEqual([1200, 400])
    // 原图 10×2 的黑块放大 4 倍后约 40×8，位于左上角：截取的是原图像素。
    const px = got.get_raw_pixels()
    const dark = (x: number, y: number) => px[(y * 1200 + x) * 4]! < 128
    expect(dark(20, 4)).toBe(true)
    expect(dark(60, 4)).toBe(false)
    expect(dark(20, 12)).toBe(false)
  })

  /** 不合法的 region 与用在非图片上都拒绝：不经说明改读整图会使模型把无法辨认的细节判为不存在。 */
  test('region 不合法或用在非图片上：拒绝并说明', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-img-region-'))
    await writeFile(join(root, 'a.png'), PNG)
    await writeFile(join(root, 'a.txt'), 'x')
    const bad = await registry().execute(
      'read_file',
      { path: 'a.png', region: { left: 1.2, top: 0, width: 0.1, height: 0.1 } },
      ctx(root),
    )
    expect(bad.status).toBe('failure')
    expect(bad.message).toContain('region')
    const text = await registry().execute(
      'read_file',
      { path: 'a.txt', region: { left: 0, top: 0, width: 0.5, height: 0.5 } },
      ctx(root),
    )
    expect(text.status).toBe('failure')
    expect(text.message).toContain('只对图片有效')
  })

  /**
   * 读取图片之后必须能够覆盖写入。
   *
   * 图片分支跳过了文本流程，若不补记一次读取记录，`write_file` 会返回
   * 「尚未读取，已拒绝覆盖修改。先 read_file 再覆盖」，而模型按提示操作后仍然无法通过。
   */
  test('读取过的图片能被 write_file 覆盖', async () => {
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
