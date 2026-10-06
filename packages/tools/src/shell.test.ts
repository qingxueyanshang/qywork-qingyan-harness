import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { batchRemaining, chargeBatchBudget, openBatchBudget, type ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { BASH_PATH_ENV, commandShell } from './sandbox.ts'
import { makeShellTool } from './shell.ts'

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
      emit: () => {},
      sink: null,
      density: DEFAULT_DENSITY,
      contextWindow: 200_000,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
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
    const outcome = await tool.fn({}, { workspaceRoot: process.cwd() } as ToolContext)
    expect(outcome).toMatchObject({ status: 'failure', executed: false, message: '命令为空' })
  })
})

describe('run_command 的子进程环境', () => {
  /** 三个变量分别由 bash、cmd 与 POSIX 工具链读取，使用哪一个由子进程决定，因此三个都必须指向同一目录。 */
  test('临时目录指向工作区的 .tmp，且目录已预先创建', async () => {
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
      emit: () => {},
      sink: null,
      density: DEFAULT_DENSITY,
      contextWindow: 200_000,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    } as unknown as ToolContext)

    expect(outcome.status).toBe('success')
    const dir = join(root, '.tmp')
    expect(String(outcome.data?.stdout).trim()).toBe(JSON.stringify([dir, dir, dir]))
    expect(existsSync(dir)).toBe(true)
  })
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
      contextWindow: 200_000,
      density: DEFAULT_DENSITY,
      state: openBatchBudget(new Map<string, unknown>(), 1000),
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
