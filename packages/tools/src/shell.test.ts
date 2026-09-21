import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chargeBatchBudget, deliveryBudget, type ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { commandShell } from './sandbox.ts'
import { makeShellTool } from './shell.ts'

const shell = { path: 'unused', argv: [], hint: '测试 shell。' }

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
  /** 三个变量名分别归 bash / cmd / POSIX 工具链，取哪一个由子进程自己定，所以三个都要指对。 */
  test('临时目录指到工作区的 .tmp，且目录先建出来', async () => {
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
      state: new Map(),
    } as unknown as ToolContext)

    expect(outcome.status).toBe('success')
    const dir = join(root, '.tmp')
    expect(String(outcome.data?.stdout).trim()).toBe(JSON.stringify([dir, dir, dir]))
    expect(existsSync(dir)).toBe(true)
  })
})

describe('run_command 的用量记账', () => {
  /** 命令已经执行、摘录已经投出，这一笔不记等于让同一波后面的读取工具按一份不存在的余额作准入。 */
  test('本批剩不下时照样记账，同一波后面的读取工具看到余额 0', async () => {
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
      state: new Map<string, unknown>(),
      sink: null,
      emit: () => {},
    } as unknown as ToolContext
    const { perCall, batchCap } = deliveryBudget(200_000)
    expect(chargeBatchBudget(ctx, perCall).ok).toBe(true)
    expect(chargeBatchBudget(ctx, batchCap - perCall - 200).ok).toBe(true)
    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(200)

    const outcome = await makeShellTool(found).fn({ command: `bun "${script}"` }, ctx)

    expect(outcome.status).toBe('success')
    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(0)
    expect(chargeBatchBudget(ctx, 100).ok).toBe(false)
  })
})
