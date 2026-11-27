/**
 * 覆盖 `shell.ts`（`run_command`、`background_command`），以及 `run_command` 的 `files` 经由的 `files.ts` 的 `writeWholeFile`。
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  batchRemaining,
  chargeBatchBudget,
  openBatchBudget,
  Ports,
  provide,
  type ToolContext,
  ToolRegistry,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from './index.ts'
import { BASH_PATH_ENV, commandShell } from './process/command-shell.ts'
import { CommandPort } from './shell/port.ts'
import { backgroundCommandTool, commandEnv, makeShellTool, RecentOutput } from './shell.ts'

const shell = { path: 'unused', argv: [], hint: '测试 shell。' }

test('同一轮内安装 Git 后已创建的工具仍使用声明的 PowerShell，新创建的工具切换到 Bash', async () => {
  if (process.platform !== 'win32') return
  const installed = commandShell()
  if (!installed?.scriptArgv) throw new Error('本回归测试需要 Git Bash')
  const root = await mkdtemp(join(tmpdir(), 'qywork-shell-install-'))
  const previous = process.env[BASH_PATH_ENV]
  const restore = () => {
    if (previous === undefined) delete process.env[BASH_PATH_ENV]
    else process.env[BASH_PATH_ENV] = previous
  }
  const ctx = () =>
    ({
      workspaceRoot: root,
      signal: new AbortController().signal,
      conversationId: 'cv_shell',
      emit: () => {},
      sink: null,
      port: () => null,
      density: DEFAULT_DENSITY,
      contextWindow: 200_000,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    }) as unknown as ToolContext
  try {
    process.env[BASH_PATH_ENV] = join(root, 'missing-bash.exe')
    const powershell = commandShell()
    if (!powershell || powershell.scriptArgv) throw new Error('未找到 PowerShell')
    const tool = makeShellTool(powershell)
    const args = { command: "Write-Output 'environment-ok'" }
    expect((await tool.fn(args, ctx())).data?.stdout).toContain('environment-ok')
    restore()
    expect(commandShell()?.path).toBe(installed.path)
    const continued = await tool.fn(args, ctx())
    expect(continued.status).toBe('success')
    expect(continued.data?.stdout).toContain('environment-ok')
    const next = makeShellTool(commandShell()!)
    expect(next.description.startsWith(installed.hint)).toBe(true)
    const switched = await next.fn({ command: "printf '%s' bash-ok" }, ctx())
    expect(switched.status).toBe('success')
    expect(switched.data?.stdout).toBe('bash-ok')
  } finally {
    restore()
  }
})

describe('run_command 参数校验', () => {
  test('probe_url 校验失败发生在启动命令之前，明确回报未执行', async () => {
    const tool = makeShellTool(shell)
    const outcome = await tool.fn({ command: 'echo ok', probe_url: 'null' }, {
      workspaceRoot: process.cwd(),
      signal: new AbortController().signal,
    } as ToolContext)

    expect(outcome).toMatchObject({
      status: 'failure',
      executed: false,
      message: 'probe_url 不是合法 URL：null',
      errorKind: 'bad_request',
    })
  })

  test('空命令同样明确回报未执行', async () => {
    const tool = makeShellTool(shell)
    const outcome = await tool.fn({}, {
      workspaceRoot: process.cwd(),
      signal: new AbortController().signal,
    } as ToolContext)
    expect(outcome).toMatchObject({ status: 'failure', executed: false, message: '命令为空' })
  })

  test('files 不是数组或某项缺少 path、content 时不写入也不启动命令，明确回报未执行', async () => {
    const tool = makeShellTool(shell)
    const ctx = {
      workspaceRoot: process.cwd(),
      signal: new AbortController().signal,
      port: () => null,
    } as unknown as ToolContext
    expect(await tool.fn({ command: 'echo ok', files: 'a.txt' }, ctx)).toMatchObject({
      status: 'failure',
      executed: false,
      message: 'files 必须是数组，每项为 {path, content}',
      errorKind: 'bad_request',
    })
    expect(
      await tool.fn(
        { command: 'echo ok', files: [{ path: 'a.txt', content: 'x' }, { path: 'b.txt' }] },
        ctx,
      ),
    ).toMatchObject({
      status: 'failure',
      executed: false,
      message: 'files 第 2 项必须包含字符串 path 与 content',
      errorKind: 'bad_request',
    })
  })

  /** 原始失败形状：模型把 cwd 写成字符串 "null"，回执只有「路径不存在：null」，无法判断是哪个参数。 */
  test('工作目录不存在时报错写明参数 cwd', async () => {
    const tool = makeShellTool(shell)
    await expect(
      tool.fn({ command: 'echo ok', cwd: 'null' }, {
        workspaceRoot: process.cwd(),
        signal: new AbortController().signal,
      } as ToolContext),
    ).rejects.toThrow('参数 cwd 的路径不存在：「null」')
  })
})

describe('run_command 的子进程环境', () => {
  /** 三个变量分别由 bash、cmd 与 POSIX 工具链读取，使用哪一个由子进程决定，因此三个都必须指向同一目录。 */
  test('临时目录指向本会话的临时目录，且目录已预先创建', async () => {
    const found = commandShell()
    if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-'))
    const binDir = await mkdtemp(join(tmpdir(), 'qywork-shell-bin-'))
    const script = join(binDir, 'env.ts').replaceAll('\\', '/')
    await writeFile(
      script,
      'console.log(JSON.stringify([process.env.TMP, process.env.TEMP, process.env.TMPDIR]))\n',
    )

    const outcome = await makeShellTool(found).fn({ command: `bun "${script}"` }, {
      workspaceRoot: root,
      signal: new AbortController().signal,
      conversationId: 'cv_shell',
      emit: () => {},
      sink: null,
      port: () => null,
      density: DEFAULT_DENSITY,
      contextWindow: 200_000,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    } as unknown as ToolContext)

    expect(outcome.status).toBe('success')
    const dir = join(root, '.tmp', 'cv_shell')
    expect(String(outcome.data?.stdout).trim()).toBe(JSON.stringify([dir, dir, dir]))
    expect(existsSync(dir)).toBe(true)
  })

  /**
   * 原始失败：模型脚本 `json.load(open(p))` 读取 UTF-8 文件，在 Windows 上按 GBK 解码抛出 UnicodeDecodeError。
   * 两种权限模式都设置 UTF-8 模式；PATH 只有一个键，沿用环境中原有的写法。
   */
  test('两种权限模式都开启 python 的 UTF-8 模式，PATH 键不重复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-utf8-'))
    for (const unrestrictedPaths of [false, true]) {
      const env = await commandEnv({
        workspaceRoot: root,
        conversationId: 'cv_shell',
        unrestrictedPaths,
      })
      expect(env.PYTHONUTF8).toBe('1')
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(
        Object.keys(process.env).filter((k) => k.toUpperCase() === 'PATH'),
      )
    }
  })

  /** 工作区 Python 环境由 runtime 创建；此处直接用 venv 创建同样的目录，验证命令中的 python 取自它。 */
  const python = Bun.which(process.platform === 'win32' ? 'python.exe' : 'python3')
  test.skipIf(!python || /WindowsApps/i.test(python))(
    'auto 模式下工作区 Python 环境存在时，命令中的 python 为该环境；不存在时与完全访问模式下不改变 PATH',
    async () => {
      const found = commandShell()
      if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
      const ctx = (root: string, full = false) =>
        ({
          workspaceRoot: root,
          signal: new AbortController().signal,
          conversationId: 'cv_shell',
          emit: () => {},
          sink: null,
          port: () => null,
          density: DEFAULT_DENSITY,
          contextWindow: 200_000,
          state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
          ...(full ? { unrestrictedPaths: true } : {}),
        }) as unknown as ToolContext
      const command = 'python -c "import sys; print(sys.prefix)"'
      const root = await mkdtemp(join(tmpdir(), 'qywork-shell-py-'))
      const without = await makeShellTool(found).fn({ command }, ctx(root))
      expect(String(without.data?.stdout).trim()).not.toBe(join(root, '.tmp', 'python'))

      const venv = Bun.spawn(
        [
          python!,
          '-m',
          'venv',
          '--system-site-packages',
          '--without-pip',
          join(root, '.tmp', 'python'),
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      )
      expect(await venv.exited).toBe(0)
      const outcome = await makeShellTool(found).fn({ command }, ctx(root))
      expect(outcome.status).toBe('success')
      expect(String(outcome.data?.stdout).trim()).toBe(join(root, '.tmp', 'python'))

      // 完全访问模式：安装到全局还是工作区由模型选择，命令中的 python 仍为全局解释器。
      const full = await makeShellTool(found).fn({ command }, ctx(root, true))
      expect(full.status).toBe('success')
      expect(String(full.data?.stdout).trim()).toBe(String(without.data?.stdout).trim())
    },
  )

  test.skipIf(!python || /WindowsApps/i.test(python))(
    '命令中的 python 不指定 encoding 打开 UTF-8 文件，两种权限模式都按 UTF-8 读取',
    async () => {
      const found = commandShell()
      if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
      const root = await mkdtemp(join(tmpdir(), 'qywork-shell-utf8-'))
      await writeFile(join(root, 'a.json'), JSON.stringify({ k: '精创视觉升级' }), 'utf8')
      const command = `python -c "import json; print(json.load(open('a.json'))['k'])"`
      for (const full of [false, true]) {
        const outcome = await makeShellTool(found).fn({ command }, {
          workspaceRoot: root,
          signal: new AbortController().signal,
          conversationId: 'cv_shell',
          emit: () => {},
          sink: null,
          port: () => null,
          density: DEFAULT_DENSITY,
          contextWindow: 200_000,
          state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
          ...(full ? { unrestrictedPaths: true } : {}),
        } as unknown as ToolContext)
        expect(outcome.status).toBe('success')
        expect(String(outcome.data?.stdout).trim()).toBe('精创视觉升级')
      }
    },
  )
})

/**
 * 原始失败形状：中止监听在启动进程的若干次 await 之后才注册，注册时信号已经中止，监听不再触发，
 * 命令运行到自行退出为止。`sleep` 在 bash 与 PowerShell 中都可用。
 */
describe('run_command 的中止', () => {
  const base = (root: string, signal: AbortSignal) => ({
    workspaceRoot: root,
    signal,
    conversationId: 'cv_shell',
    emit: () => {},
    sink: null,
    port: () => null,
    density: DEFAULT_DENSITY,
    contextWindow: 200_000,
  })

  test('调用时信号已中止：不启动命令，立即以中止原因结束', async () => {
    const found = commandShell()
    if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-abort-'))
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const outcome = makeShellTool(found).fn({ command: 'sleep 5' }, {
      ...base(root, controller.signal),
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    } as unknown as ToolContext)
    expect(
      await outcome.then(
        () => null,
        (err: unknown) => err,
      ),
    ).toBe(controller.signal.reason)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 20_000)

  test('启动命令期间收到中止：进程随即终止', async () => {
    const found = commandShell()
    if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-abort-'))
    const controller = new AbortController()
    const state = openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0)
    const started = Date.now()
    await makeShellTool(found).fn({ command: 'sleep 5' }, {
      ...base(root, controller.signal),
      // 本轮状态在打开观察窗口时首次读取，位于启动之前的检查与启动进程之间：在此中止即落在两者之间。
      get state() {
        controller.abort()
        return state
      },
    } as unknown as ToolContext)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 20_000)
})

describe('run_command 的用量记账', () => {
  /** 命令已执行、摘录已投递；不记录这笔用量，同一决策中后续的读取工具会按不存在的余额准入。 */
  test('额度不足时仍记录用量，同一决策中后续的读取工具读取到余额为 0', async () => {
    const found = commandShell()
    if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-budget-'))
    const binDir = await mkdtemp(join(tmpdir(), 'qywork-shell-budget-bin-'))
    const script = join(binDir, 'flood.ts').replaceAll('\\', '/')
    await writeFile(script, "console.log('x'.repeat(200_000))\n")

    const ctx = {
      workspaceRoot: root,
      signal: new AbortController().signal,
      conversationId: 'cv_shell',
      contextWindow: 200_000,
      density: DEFAULT_DENSITY,
      state: openBatchBudget(new Map<string, unknown>(), 1000, 25_000),
      sink: null,
      port: () => null,
      emit: () => {},
    } as unknown as ToolContext
    expect(chargeBatchBudget(ctx, 980).ok).toBe(true)
    expect(batchRemaining(ctx)).toBe(20)

    const outcome = await makeShellTool(found).fn({ command: `bun "${script}"` }, ctx)

    expect(outcome.status).toBe('success')
    expect(batchRemaining(ctx)).toBe(0)
    expect(chargeBatchBudget(ctx, 100).ok).toBe(false)
  })
})

/**
 * 原始失败：`refit_lines.py … | tail -3 && layered_run …` 中前段抛出 KeyError，tail 成功，
 * 整条命令报告成功并继续执行后一条。开启 pipefail 后前段失败即整条失败；前段被 head 提前结束不计为失败。
 * 只有 bash 有 pipefail，本机回退到 PowerShell 时跳过。
 */
describe('run_command 的管道退出码', () => {
  const bash = commandShell()?.prelude ? commandShell() : null
  const python = Bun.which(process.platform === 'win32' ? 'python.exe' : 'python3')
  const noPython = !python || /WindowsApps/i.test(python)
  const run = async (command: string) => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-pipe-'))
    return makeShellTool(bash!).fn({ command }, {
      workspaceRoot: root,
      signal: new AbortController().signal,
      conversationId: 'cv_shell',
      emit: () => {},
      sink: null,
      port: () => null,
      density: DEFAULT_DENSITY,
      contextWindow: 200_000,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    } as unknown as ToolContext)
  }

  test.skipIf(!bash)('前段被 head 提前结束（SIGPIPE，退出码 141）不计为失败', async () => {
    const out = await run('seq 1 100000 | head -n 5')
    expect(out.status).toBe('success')
    expect(out.data?.exitCode).toBe(0)
    expect(String(out.data?.stdout).trim().split(/\r?\n/)).toEqual(['1', '2', '3', '4', '5'])
    expect(out.message).toContain('不计为失败')
  })

  test.skipIf(!bash || noPython)(
    'python 被 head 提前结束（写入已关闭的管道）不计为失败',
    async () => {
      const out = await run('python -c "for i in range(10**6): print(i)" | head -n 3')
      expect(out.status).toBe('success')
      expect(String(out.data?.stdout).trim().split(/\r?\n/)).toEqual(['0', '1', '2'])
    },
  )

  test.skipIf(!bash || noPython)('前段失败、后段成功：报告失败与前段的退出码', async () => {
    const out = await run('python -c "import sys; sys.exit(3)" | tail -n 1')
    expect(out.status).toBe('failure')
    expect(out.data?.exitCode).toBe(3)
    expect(out.message).toContain('命令退出码 3（管道各段退出码依次为 3、0）')
  })

  test.skipIf(!bash)('前段失败时 && 之后的命令不执行', async () => {
    const out = await run('false | cat && echo next')
    expect(out.status).toBe('failure')
    expect(out.data?.exitCode).toBe(1)
    expect(String(out.data?.stdout)).not.toContain('next')
  })

  test.skipIf(!bash)(
    '命令自身的退出码不来自最后一条管道时按原样报告；设置文件与记录文件随后删除',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'qywork-shell-pipe-'))
      const out = await makeShellTool(bash!).fn({ command: 'seq 1 100000 | head -n 1; exit 7' }, {
        workspaceRoot: root,
        signal: new AbortController().signal,
        conversationId: 'cv_shell',
        emit: () => {},
        sink: null,
        port: () => null,
        density: DEFAULT_DENSITY,
        contextWindow: 200_000,
        state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
      } as unknown as ToolContext)
      expect(out.status).toBe('failure')
      expect(out.data?.exitCode).toBe(7)
      expect(out.message).not.toContain('管道')
      expect(await readdir(join(root, '.tmp', 'cv_shell'))).toEqual([])
    },
  )
})

describe('后台命令的工具形态', () => {
  /**
   * 一个只记录调用的端口：任务表本身由服务端实现，此处只验证工具一侧的取舍。
   * `respond` 给出写入一段输入之后追加到 stdout 的内容；`input` 为 false 表示该命令没有输入管道。
   */
  function fakePort(
    running: Record<
      string,
      {
        command: string
        stdout: string
        stderr: string
        dropped?: { stdout: number; stderr: number }
        input?: false
        closed?: boolean
        respond?: (text: string) => string
      }
    >,
    waits: { ended?: Record<string, Promise<boolean>>; steered?: Promise<void> } = {},
  ) {
    const stopped: string[] = []
    const writes: { id: string; text: string; end: boolean }[] = []
    const port: CommandPort = {
      steered: () => waits.steered ?? new Promise(() => {}),
      // 不在 running 中而 `ended` 中有的编号是已结束、已移出任务表的命令。
      ended: (id) => waits.ended?.[id] ?? (running[id] ? new Promise(() => {}) : null),
      adopt: () => {
        throw new Error('本组用例不应启动命令')
      },
      list: () => Object.entries(running).map(([id, r]) => ({ id, command: r.command })),
      output: (id) => (running[id] ? { dropped: { stdout: 0, stderr: 0 }, ...running[id] } : null),
      stop: (id) => {
        if (!running[id]) return null
        stopped.push(id)
        return running[id].command
      },
      write: (id, text, end) => {
        const r = running[id]
        if (!r) return null
        if (r.input === false) return 'no_input'
        if (r.closed) return 'closed'
        writes.push({ id, text, end })
        if (end) r.closed = true
        // 程序稍后作出回应：写入之后 200 ms 追加输出。
        const reply = r.respond?.(text) ?? ''
        if (reply) {
          setTimeout(() => {
            r.stdout += reply
          }, 200)
        }
        return 'written'
      },
    }
    return { port, stopped, writes }
  }

  function ctxWith(port: CommandPort | undefined): ToolContext {
    return {
      workspaceRoot: process.cwd(),
      signal: new AbortController().signal,
      conversationId: 'cv_bg',
      stepId: 'st_bg',
      sink: null,
      density: DEFAULT_DENSITY,
      contextWindow: 200_000,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
      port: new Ports(port ? [provide(CommandPort, port)] : []).get,
    } as unknown as ToolContext
  }

  test('说明把 background 定义为不自行退出的命令所用，并给出启动图形应用的写法', () => {
    const spec = makeShellTool(shell, { background: true })
    const background = (spec.parameters as { properties: { background: { description: string } } })
      .properties.background.description
    expect(background).toContain('不自行退出的命令')
    expect(background).toContain('会自行结束的命令优先不指定')
    expect(background).not.toContain('长时间命令')
    expect(spec.description).toContain('启动图形应用')
    expect(spec.description).toContain(
      process.platform === 'win32'
        ? 'Start-Process'
        : process.platform === 'darwin'
          ? 'open -a'
          : 'nohup',
    )
    // 没有后台命令通道时写法仍在：启动图形应用不依赖 background。
    expect(makeShellTool(shell).description).toContain('启动图形应用')
  })

  /**
   * 说明中的示例程序名在 bash 外层下解析为可执行文件。解析即可判定，不启动窗口。
   * 原始失败形状：bash 外层的 PATH 以 Git 的 `usr/bin` 开头，`Start-Process notepad` 解析到其中无扩展名的
   * `notepad` 脚本，以 InvalidOperationException 失败。
   */
  test.skipIf(process.platform !== 'win32' || !commandShell()?.prelude)(
    'Windows 上启动图形应用的示例在 bash 外层下解析为 .exe',
    () => {
      const bash = commandShell()!
      const name = /Start-Process '([^']+)'/.exec(makeShellTool(bash).description)?.[1] ?? ''
      const resolved = Bun.spawnSync(
        [...bash.argv, `powershell -NoProfile -Command "(Get-Command '${name}').Source"`],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      expect(resolved.stdout.toString().trim()).toMatch(/\.exe$/i)
    },
  )

  test('没有后台命令通道时规格不含 background，也不注册 background_command', () => {
    const plain = makeShellTool(shell)
    expect(Object.keys((plain.parameters as { properties: object }).properties)).not.toContain(
      'background',
    )
    expect(plain.description).not.toContain('background_command')
    const withPort = makeShellTool(shell, { background: true })
    expect(Object.keys((withPort.parameters as { properties: object }).properties)).toContain(
      'background',
    )

    if (!commandShell()) return
    const without = new ToolRegistry()
    registerBuiltinTools(without)
    expect(without.has('background_command')).toBe(false)
    const withCommands = new ToolRegistry()
    registerBuiltinTools(withCommands, new Ports([provide(CommandPort, fakePort({}).port)]))
    expect(withCommands.has('background_command')).toBe(true)
  })

  test('background 与 probe_url 同时提供时不启动命令，明确回报未执行', async () => {
    const { port } = fakePort({})
    const outcome = await makeShellTool(shell, { background: true }).fn(
      { command: 'echo ok', background: true, probe_url: 'http://127.0.0.1:3000/' },
      ctxWith(port),
    )
    expect(outcome).toMatchObject({ status: 'failure', executed: false, errorKind: 'bad_request' })
  })

  test('wait_seconds 只在有后台命令通道时提供；不是正数或与 background、probe_url 同时提供时不启动命令', async () => {
    const keys = (spec: ReturnType<typeof makeShellTool>) =>
      Object.keys((spec.parameters as { properties: object }).properties)
    expect(keys(makeShellTool(shell))).not.toContain('wait_seconds')
    expect(keys(makeShellTool(shell, { background: true }))).toContain('wait_seconds')

    const { port } = fakePort({})
    const tool = makeShellTool(shell, { background: true })
    for (const args of [
      { command: 'echo ok', wait_seconds: 0 },
      { command: 'echo ok', wait_seconds: '30' },
      { command: 'echo ok', wait_seconds: 30, background: true },
      { command: 'echo ok', wait_seconds: 30, probe_url: 'http://127.0.0.1:3000/' },
    ]) {
      const outcome = await tool.fn(args, ctxWith(port))
      expect(outcome).toMatchObject({
        status: 'failure',
        executed: false,
        errorKind: 'bad_request',
      })
    }
  })

  test('按任务编号读取至今的输出；编号不在本会话时列出运行中的命令', async () => {
    const { port, stopped } = fakePort({
      cmd_1: { command: 'npm run dev', stdout: 'ready on 3000\n', stderr: '' },
    })
    const read = await backgroundCommandTool.fn({ task_id: 'cmd_1' }, ctxWith(port))
    expect(read.status).toBe('success')
    expect(read.message).toContain('仍在运行')
    expect(read.data?.stdout).toBe('ready on 3000\n')
    expect(stopped).toEqual([])

    const missing = await backgroundCommandTool.fn({ task_id: 'cmd_9' }, ctxWith(port))
    expect(missing.status).toBe('failure')
    expect(missing.message).toContain('cmd_1（npm run dev）')
  })

  test('已结束、移出任务表的命令：读取、等待与停止都答复已结束或已被停止，不答复没有该命令', async () => {
    const { port } = fakePort(
      {},
      { ended: { cmd_2: Promise.resolve(true), cmd_3: Promise.resolve(false) } },
    )
    for (const args of [
      { task_id: 'cmd_2' },
      { task_id: 'cmd_2', wait_seconds: 30 },
      { task_id: 'cmd_2', stop: true },
    ]) {
      expect(await backgroundCommandTool.fn(args, ctxWith(port))).toMatchObject({
        status: 'success',
        message: '后台命令 cmd_2 已结束，结果见回执消息',
      })
    }
    expect(await backgroundCommandTool.fn({ task_id: 'cmd_3' }, ctxWith(port))).toMatchObject({
      status: 'success',
      message: '后台命令 cmd_3 已被停止，没有回执',
    })
  })

  test('stop 为真时停止该命令，并返回停止前的输出', async () => {
    const { port, stopped } = fakePort({
      cmd_1: { command: 'npm run dev', stdout: 'ready on 3000\n', stderr: 'warn\n' },
    })
    const out = await backgroundCommandTool.fn({ task_id: 'cmd_1', stop: true }, ctxWith(port))
    expect(out.status).toBe('success')
    expect(out.message).toContain('已停止后台命令 cmd_1')
    expect(out.data?.stderr).toBe('warn\n')
    expect(stopped).toEqual(['cmd_1'])
  })

  test('wait_seconds 等待命令结束后返回，不带输出；被停止的命令写明没有回执', async () => {
    const running = { command: 'bash wait.sh', stdout: 'tick\n', stderr: '' }
    const done = Promise.withResolvers<boolean>()
    const { port } = fakePort({ cmd_1: running }, { ended: { cmd_1: done.promise } })
    // 调用 `steered` 时等待已建立：此后能使它结束的只有 `done`、600 秒计时与中止信号，三者都未发生。
    const entered = Promise.withResolvers<void>()
    const watched: CommandPort = {
      ...port,
      steered: (signal) => {
        entered.resolve()
        return port.steered(signal)
      },
    }
    let settled = false
    const waiting = backgroundCommandTool
      .fn({ task_id: 'cmd_1', wait_seconds: 600 }, ctxWith(watched))
      .finally(() => {
        settled = true
      })
    await entered.promise
    await Bun.sleep(0)
    expect(settled).toBe(false)
    done.resolve(true)
    const out = await waiting
    expect(out.status).toBe('success')
    expect(out.message).toContain('已结束，结果见下一条回执消息')
    expect(out.data?.stdout).toBeUndefined()

    const halted = fakePort({ cmd_1: running }, { ended: { cmd_1: Promise.resolve(false) } })
    const stopped = await backgroundCommandTool.fn(
      { task_id: 'cmd_1', wait_seconds: 600 },
      ctxWith(halted.port),
    )
    expect(stopped.message).toContain('已被停止，没有回执')
  })

  test('wait_seconds 等待期间用户发来消息或到达秒数时返回至今的输出，命令不被停止', async () => {
    const running = { cmd_1: { command: 'bash wait.sh', stdout: 'tick\n', stderr: '' } }
    const steered = fakePort(running, { steered: Promise.resolve() })
    const onMessage = await backgroundCommandTool.fn(
      { task_id: 'cmd_1', wait_seconds: 600 },
      ctxWith(steered.port),
    )
    expect(onMessage.message).toContain('用户发来调整方向的消息')
    expect(onMessage.data?.stdout).toBe('tick\n')
    expect(steered.stopped).toEqual([])

    const quiet = fakePort(running)
    const onTimeout = await backgroundCommandTool.fn(
      { task_id: 'cmd_1', wait_seconds: 0.03 },
      ctxWith(quiet.port),
    )
    expect(onTimeout.message).toContain('没有结束，仍在运行')
    expect(onTimeout.data?.stdout).toBe('tick\n')
    expect(quiet.stopped).toEqual([])
  })

  test('wait_seconds 与 stop 同时提供或不是正数时不等待也不停止', async () => {
    const { port, stopped } = fakePort({
      cmd_1: { command: 'bash wait.sh', stdout: '', stderr: '' },
    })
    for (const args of [
      { task_id: 'cmd_1', wait_seconds: 60, stop: true },
      { task_id: 'cmd_1', wait_seconds: 0 },
    ]) {
      const out = await backgroundCommandTool.fn(args, ctxWith(port))
      expect(out).toMatchObject({ status: 'failure', executed: false, errorKind: 'bad_request' })
    }
    expect(stopped).toEqual([])
  })

  /** 原始失败形状：后台命令只能读取、等待或停止，交互程序无法根据输出写入下一次输入。 */
  test('input 写入后台命令的标准输入，等待输出稳定后返回包含回应的输出', async () => {
    const { port, writes } = fakePort({
      cmd_1: {
        command: 'python -i',
        stdout: '>>> ',
        stderr: '',
        respond: (text) => (text === '2+2\n' ? '4\n>>> ' : ''),
      },
    })
    const out = await backgroundCommandTool.fn({ task_id: 'cmd_1', input: '2+2\n' }, ctxWith(port))
    expect(out.status).toBe('success')
    expect(out.message).toContain('已写入，输出已稳定')
    expect(out.data?.stdout).toBe('>>> 4\n>>> ')
    expect(writes).toEqual([{ id: 'cmd_1', text: '2+2\n', end: false }])
  })

  test('close_input 在写入之后关闭输入；输入已关闭或命令没有输入管道时不写入并说明原因', async () => {
    const { port, writes } = fakePort({
      cmd_1: { command: 'sort', stdout: '', stderr: '' },
      cmd_2: { command: 'npm run dev', stdout: '', stderr: '', input: false },
    })
    const closed = await backgroundCommandTool.fn(
      { task_id: 'cmd_1', input: 'b\na\n', close_input: true },
      ctxWith(port),
    )
    expect(closed.message).toContain('已写入并关闭输入')
    expect(writes).toEqual([{ id: 'cmd_1', text: 'b\na\n', end: true }])

    const again = await backgroundCommandTool.fn({ task_id: 'cmd_1', input: 'c\n' }, ctxWith(port))
    expect(again).toMatchObject({ status: 'failure', executed: false, errorKind: 'bad_request' })
    expect(again.message).toContain('标准输入已关闭')

    const none = await backgroundCommandTool.fn({ task_id: 'cmd_2', input: 'x\n' }, ctxWith(port))
    expect(none).toMatchObject({ status: 'failure', executed: false, errorKind: 'bad_request' })
    expect(none.message).toContain('没有输入通道')
    expect(writes).toHaveLength(1)
  })

  test('input 与 stop 同时提供时不写入也不停止', async () => {
    const { port, stopped, writes } = fakePort({
      cmd_1: { command: 'python -i', stdout: '', stderr: '' },
    })
    const out = await backgroundCommandTool.fn(
      { task_id: 'cmd_1', input: 'exit()\n', stop: true },
      ctxWith(port),
    )
    expect(out).toMatchObject({ status: 'failure', executed: false, errorKind: 'bad_request' })
    expect(stopped).toEqual([])
    expect(writes).toEqual([])
  })

  test('丢弃过输出时读取结果写明各流丢弃的字符数；没有丢弃时不附加说明', async () => {
    const { port } = fakePort({
      cmd_1: {
        command: 'npm run dev',
        stdout: 'tail\n',
        stderr: '',
        dropped: { stdout: 2048, stderr: 0 },
      },
      cmd_2: { command: 'npm run watch', stdout: 'ok\n', stderr: '' },
    })
    const read = await backgroundCommandTool.fn({ task_id: 'cmd_1' }, ctxWith(port))
    expect(read.message).toContain('stdout 已丢弃最早的 2048 个字符')
    expect(read.message).not.toContain('stderr 已丢弃')
    const whole = await backgroundCommandTool.fn({ task_id: 'cmd_2' }, ctxWith(port))
    expect(whole.message).not.toContain('已丢弃')
  })
})

/**
 * 原始失败形状：管道一次传入超过上限的文字（Linux 上转入后台时常见）时，整段作为一块保留，没有丢弃，保留量不受上限约束。
 */
describe('后台命令的输出缓冲', () => {
  test('一次写入超过上限的文字时同样丢弃最早的部分，保留的是结尾', () => {
    const out = new RecentOutput()
    const text = `${'x'.repeat(1_200_000)}结束`
    out.push(text)
    const kept = out.text()
    expect(out.dropped).toBeGreaterThan(0)
    expect(kept.length + out.dropped).toBe(text.length)
    expect(kept.length).toBeLessThan((1 << 20) + (1 << 17))
    expect(kept.endsWith('结束')).toBe(true)
  })

  test('未超过上限时不丢弃', () => {
    const out = new RecentOutput()
    out.push('a'.repeat(100_000))
    out.push('b')
    expect(out.dropped).toBe(0)
    expect(out.text()).toBe(`${'a'.repeat(100_000)}b`)
  })
})

/**
 * 原始失败形状：写文件与执行命令分为两个工具时，模型先在一次回复中写入脚本，下一次回复才运行它。
 * `files` 在同一次调用中写入后执行，写入经 `writeWholeFile`，约束与变更明细须与 `write_file` 相同。
 */
describe('run_command 的 files', () => {
  const found = commandShell()
  const ctx = (root: string, approve = true) =>
    ({
      workspaceRoot: root,
      signal: new AbortController().signal,
      conversationId: 'cv_files',
      emit: () => {},
      sink: null,
      port: () => null,
      density: DEFAULT_DENSITY,
      contextWindow: 200_000,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
      requestPermission: async () =>
        approve ? { allowed: true } : { allowed: false, reason: '夹具拒绝' },
    }) as unknown as ToolContext
  const registry = () => {
    const r = new ToolRegistry()
    registerBuiltinTools(r)
    return r
  }
  /** 工作区中预置一个脚本：运行时写入标记文件 ran.txt，据此判断命令是否执行。 */
  const withMarker = async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-files-'))
    await mkdir(join(root, 'tools'), { recursive: true })
    await writeFile(
      join(root, 'tools', 'mark.ts'),
      "require('node:fs').writeFileSync('ran.txt', 'ran')\n",
    )
    return root
  }
  const pathsOf = (changes: { path: string; changeType: string }[] | undefined) =>
    (changes ?? []).map((c) => [c.path, c.changeType])

  test('写入之后执行命令，命令读取到刚写入的内容；新建与覆盖的变更明细与 write_file 相同', async () => {
    if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
    const r = registry()
    const root = await mkdtemp(join(tmpdir(), 'qywork-shell-files-'))
    const c = ctx(root)
    const show = {
      path: 'tools/show.ts',
      content: "console.log(require('node:fs').readFileSync('data.txt', 'utf8').trim())\n",
    }
    const command = 'bun tools/show.ts'

    const first = await r.execute(
      'run_command',
      { command, files: [show, { path: 'data.txt', content: 'v1\n' }] },
      c,
    )
    expect(first.status).toBe('success')
    expect(String(first.data?.stdout).trim()).toBe('v1')
    expect(first.message).toStartWith('创建 tools/show.ts\n创建 data.txt\n命令执行成功')

    // 本会话写入过的文件可以覆盖。
    const second = await r.execute(
      'run_command',
      { command, files: [{ path: 'data.txt', content: 'v2\nmore\n' }] },
      c,
    )
    expect(second.status).toBe('success')
    expect(String(second.data?.stdout).trim()).toBe('v2\nmore')
    expect(second.message).toStartWith('写入 data.txt\n命令执行成功')

    // 同一组写入经 write_file 执行，变更明细逐项相同。
    const oc = ctx(await mkdtemp(join(tmpdir(), 'qywork-shell-files-')))
    const created = [
      await r.execute('write_file', { path: show.path, mode: 'create', content: show.content }, oc),
      await r.execute('write_file', { path: 'data.txt', mode: 'create', content: 'v1\n' }, oc),
    ]
    const modified = await r.execute(
      'write_file',
      { path: 'data.txt', mode: 'overwrite', content: 'v2\nmore\n' },
      oc,
    )
    expect(first.fileChanges).toEqual(created.flatMap((o) => o.fileChanges ?? []))
    expect(second.fileChanges).toEqual(modified.fileChanges)
    expect(second.fileChanges).toEqual([
      { path: 'data.txt', changeType: 'modified', additions: 2, deletions: 1 },
    ])
  }, 30_000)

  test('已存在且本会话未读取过的文件拒绝覆盖，其后的项不写入、命令不执行；读取之后重新调用即覆盖并执行', async () => {
    if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
    const r = registry()
    const root = await withMarker()
    await writeFile(join(root, 'data.txt'), 'original\n')
    const c = ctx(root)
    const args = {
      command: 'bun tools/mark.ts',
      files: [
        { path: 'new.txt', content: 'n\n' },
        { path: 'data.txt', content: 'changed\n' },
        { path: 'later.txt', content: 'l\n' },
      ],
    }

    const refused = await r.execute('run_command', args, c)
    expect(refused).toMatchObject({ status: 'failure', executed: true, errorKind: 'stale_write' })
    expect(refused.message).toStartWith('创建 new.txt\nfiles 第 2 项 data.txt 未写入，命令未执行：')
    expect(refused.message).toContain('尚未读取')
    expect(refused.message).toContain('read_file')
    // 已写入的第 1 项随结果返回。
    expect(pathsOf(refused.fileChanges)).toEqual([['new.txt', 'created']])
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(join(root, 'later.txt'))).toBe(false)
    expect(existsSync(join(root, 'ran.txt'))).toBe(false)

    // 首项即失败时没有任何写入，结果为未执行。
    const none = await r.execute(
      'run_command',
      { command: args.command, files: [{ path: 'data.txt', content: 'changed\n' }] },
      c,
    )
    expect(none).toMatchObject({ status: 'failure', executed: false, errorKind: 'stale_write' })
    expect(none.fileChanges).toBeUndefined()
    expect(existsSync(join(root, 'ran.txt'))).toBe(false)

    expect((await r.execute('read_file', { path: 'data.txt' }, c)).status).toBe('success')
    const retried = await r.execute('run_command', args, c)
    expect(retried.status).toBe('success')
    expect(pathsOf(retried.fileChanges).slice(0, 3)).toEqual([
      ['new.txt', 'modified'],
      ['data.txt', 'modified'],
      ['later.txt', 'created'],
    ])
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('changed\n')
    expect(existsSync(join(root, 'ran.txt'))).toBe(true)

    // 写入之后被外部修改的文件同样拒绝覆盖。
    await writeFile(join(root, 'data.txt'), 'edited elsewhere\n')
    const stale = await r.execute(
      'run_command',
      { command: args.command, files: [{ path: 'data.txt', content: 'again\n' }] },
      c,
    )
    expect(stale).toMatchObject({ status: 'failure', executed: false, errorKind: 'stale_write' })
    expect(stale.message).toContain('在读取之后已被修改')
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('edited elsewhere\n')
  }, 30_000)

  test('写入位置被拒绝时命令不执行，判定与 write_file 相同；命令被权限拒绝时不写入文件', async () => {
    if (!found) throw new Error('本机未找到 bash、pwsh 或 powershell，无法执行本测试')
    const r = registry()
    const root = await withMarker()
    const c = ctx(root)

    const guarded = await r.execute(
      'run_command',
      { command: 'bun tools/mark.ts', files: [{ path: '.qy/plugin.js', content: 'x' }] },
      c,
    )
    const direct = await r.execute(
      'write_file',
      { path: '.qy/plugin.js', mode: 'create', content: 'x' },
      c,
    )
    expect(guarded).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'protected_path',
    })
    expect(direct).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'protected_path',
    })
    expect(guarded.message).toBe(
      `files 第 1 项 .qy/plugin.js 未写入，命令未执行：${direct.message}`,
    )
    expect(existsSync(join(root, '.qy'))).toBe(false)
    expect(existsSync(join(root, 'ran.txt'))).toBe(false)

    const denied = await r.execute(
      'run_command',
      { command: 'bun tools/mark.ts', files: [{ path: 'new.txt', content: 'n\n' }] },
      ctx(root, false),
    )
    expect(denied).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'permission_denied',
    })
    expect(existsSync(join(root, 'new.txt'))).toBe(false)
    expect(existsSync(join(root, 'ran.txt'))).toBe(false)
  }, 30_000)
})
