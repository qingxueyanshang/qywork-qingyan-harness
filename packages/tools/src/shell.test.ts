import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@qywork/agent'
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
