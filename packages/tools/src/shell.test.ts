import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  batchRemaining,
  type CommandPort,
  chargeBatchBudget,
  openBatchBudget,
  type ToolContext,
  ToolRegistry,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from './index.ts'
import { BASH_PATH_ENV, commandShell } from './sandbox.ts'
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

  /** 原始失败形状：模型把 cwd 写成字符串 "null"，回执只有「路径不存在：null」，看不出是哪个参数。 */
  test('工作目录不存在时报错写明参数 cwd', async () => {
    const tool = makeShellTool(shell)
    await expect(
      tool.fn({ command: 'echo ok', cwd: 'null' }, {
        workspaceRoot: process.cwd(),
        signal: new AbortController().signal,
      } as ToolContext),
    ).rejects.toThrow('参数 cwd 的路径不存在：null')
  })
})

describe('run_command 的子进程环境', () => {
  /** 三个变量分别由 bash、cmd 与 POSIX 工具链读取，使用哪一个由子进程决定，因此三个都必须指向同一目录。 */
  test('临时目录指向本会话的临时目录，且目录已预先创建', async () => {
    const found = commandShell()
    if (!found) throw new Error('这台机器上 bash / pwsh / powershell 一个都没有，跑不了本测试')
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
      if (!found) throw new Error('这台机器上 bash / pwsh / powershell 一个都没有，跑不了本测试')
      const ctx = (root: string, full = false) =>
        ({
          workspaceRoot: root,
          signal: new AbortController().signal,
          conversationId: 'cv_shell',
          emit: () => {},
          sink: null,
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

      // 完全访问模式：装入全局还是工作区由模型选择，命令中的 python 仍为全局解释器。
      const full = await makeShellTool(found).fn({ command }, ctx(root, true))
      expect(full.status).toBe('success')
      expect(String(full.data?.stdout).trim()).toBe(String(without.data?.stdout).trim())
    },
  )

  test.skipIf(!python || /WindowsApps/i.test(python))(
    '命令中的 python 不指定 encoding 打开 UTF-8 文件，两种权限模式都按 UTF-8 读取',
    async () => {
      const found = commandShell()
      if (!found) throw new Error('这台机器上 bash / pwsh / powershell 一个都没有，跑不了本测试')
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

describe('run_command 的用量记账', () => {
  /** 命令已执行、摘录已投递；不记录这笔用量，同一决策中后续的读取工具会按不存在的余额准入。 */
  test('额度不足时仍记录用量，同一决策中后续的读取工具读到余额为 0', async () => {
    const found = commandShell()
    if (!found) throw new Error('这台机器上 bash / pwsh / powershell 一个都没有，跑不了本测试')
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
  /** 一个只记录调用的端口：任务表本身由服务端实现，此处只验证工具一侧的取舍。 */
  function fakePort(
    running: Record<
      string,
      {
        command: string
        stdout: string
        stderr: string
        dropped?: { stdout: number; stderr: number }
      }
    >,
    waits: { ended?: Record<string, Promise<boolean>>; steered?: Promise<void> } = {},
  ) {
    const stopped: string[] = []
    const port: CommandPort = {
      steered: () => waits.steered ?? new Promise(() => {}),
      ended: (id) => (running[id] ? (waits.ended?.[id] ?? new Promise(() => {})) : null),
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
    }
    return { port, stopped }
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
      ...(port ? { commands: port } : {}),
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
    registerBuiltinTools(withCommands, { commands: true })
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

  test('wait_seconds 等到命令结束后返回，不带输出；被停止的命令写明没有回执', async () => {
    const running = { command: 'bash wait.sh', stdout: 'tick\n', stderr: '' }
    const done = Promise.withResolvers<boolean>()
    const { port } = fakePort({ cmd_1: running }, { ended: { cmd_1: done.promise } })
    const waiting = backgroundCommandTool.fn({ task_id: 'cmd_1', wait_seconds: 600 }, ctxWith(port))
    const early = await Promise.race([waiting, Bun.sleep(30).then(() => 'pending')])
    expect(early).toBe('pending')
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
    expect(onMessage.message).toContain('用户发来消息')
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
 * 原始失败形状：管道一次交来超过上限的文字（Linux 上转入后台时常见）时，整段作为一块保留，没有丢弃，保留量不受上限约束。
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
