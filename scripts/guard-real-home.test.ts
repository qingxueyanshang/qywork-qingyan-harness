/**
 * `guard-real-home.ts`：执行 qy 而未设置隔离数据目录的命令被拦截，读取文件、已设置 `QYWORK_HOME` 的命令放行；
 * 以及钩子进程本身的退出码。
 */

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { runsQyAgainstRealHome } from './guard-real-home.ts'

test('执行位置上的 qy 与 bun 源码入口被拦截', () => {
  for (const cmd of [
    'bun packages/cli/src/index.ts exec --help',
    'cd /c/x && bun run packages\\cli\\src\\index.ts serve',
    'qy exec "写说明"',
    '& "D:\\qywork\\qy.exe" doctor',
    './app/qy-x86_64-pc-windows-msvc.exe exec x',
    'echo a; qy config',
  ]) {
    expect(runsQyAgainstRealHome(cmd)).toBe(true)
  }
})

test('读取、搜索入口文件与已设置 QYWORK_HOME 的命令放行', () => {
  for (const cmd of [
    'grep -n parseFlags packages/cli/src/index.ts',
    'sed -n 1,20p packages/cli/src/index.ts',
    'QYWORK_HOME="$PWD/.tmp/qy-home" bun packages/cli/src/index.ts exec x',
    "$env:QYWORK_HOME = '.tmp\\qy-home'; bun packages/cli/src/index.ts exec x",
    'git log --oneline -- packages/cli/src/index.ts',
    'echo qy is a name',
  ]) {
    expect(runsQyAgainstRealHome(cmd)).toBe(false)
  }
  expect(runsQyAgainstRealHome('qy exec x', { QYWORK_HOME: 'C:\\tmp\\home' })).toBe(false)
})

test('钩子进程：拦截时退出码为 2 并说明原因，放行时退出码为 0', async () => {
  const hook = join(import.meta.dir, 'guard-real-home.ts')
  const run = async (command: string) => {
    const env = { ...process.env }
    delete env.QYWORK_HOME
    const proc = Bun.spawn([process.execPath, hook], { stdin: 'pipe', stderr: 'pipe', env })
    proc.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))
    proc.stdin.end()
    return { code: await proc.exited, err: await new Response(proc.stderr).text() }
  }
  const blocked = await run('bun packages/cli/src/index.ts exec --help')
  expect(blocked.code).toBe(2)
  expect(blocked.err).toContain('QYWORK_HOME')
  expect((await run('grep x packages/cli/src/index.ts')).code).toBe(0)
})
