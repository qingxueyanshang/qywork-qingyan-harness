/**
 * `index.ts` 的 `main` 与 `parseFlags`：子命令后的 `--help` 只打用法，`exec` 遇到不认识的参数报错退出。
 *
 * 失败形状：`qy exec --help` 把 `--help` 当成任务描述，按当前目录建工作区与会话并发出一次真实请求。
 * 这里起真进程，核对退出码、输出，以及数据目录里没有建出库文件。
 */

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, 'index.ts')

async function run(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), 'qywork-cli-args-'))
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, QYWORK_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code, db: existsSync(join(home, 'qywork.sqlite3')) }
}

test('exec --help 只打用法，不建库、不发请求', async () => {
  const r = await run(['exec', '--help'])
  expect(r.code).toBe(0)
  expect(r.out).toContain('qy exec')
  expect(r.db).toBe(false)
})

test('exec 遇到不认识的参数报错退出，不建库', async () => {
  const r = await run(['exec', '--bogus', '写一段说明'])
  expect(r.code).toBe(2)
  expect(r.err).toContain('不认识的参数：--bogus')
  expect(r.db).toBe(false)
})
