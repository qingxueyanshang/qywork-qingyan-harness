import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applySource, git } from './git.ts'
import type { SourceHandoff } from './handoff.ts'

if (import.meta.main) {
  const request = JSON.parse(
    Buffer.from(process.argv[2] ?? '', 'base64').toString(),
  ) as SourceHandoff
  const resultPath = join(request.root, '.tmp', 'update', 'result.json')
  const alive = () => {
    try {
      process.kill(request.parentPid, 0)
      return true
    } catch {
      return false
    }
  }
  if (!Number.isInteger(request.parentPid) || request.parentPid <= 0)
    throw new Error('启动进程无效')
  process.send?.('ready')
  process.disconnect?.()
  const deadline = Date.now() + 30_000
  while (alive() && Date.now() < deadline) await Bun.sleep(200)
  let failure: string | null = null
  try {
    if (alive()) throw new Error('原应用没有退出，更新已取消')
    await applySource(request.root, request.target, request.head)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${failure}\n`)
  }
  await writeFile(resultPath, JSON.stringify({ target: request.target, failure, at: Date.now() }))
  if (!alive()) {
    const log = openSync(join(request.root, '.tmp', 'update', 'restart.log'), 'w')
    try {
      // 合并失败时原源码仍可启动；依赖失败时保留明确的启动日志，不重写用户分支。
      const head = await git(request.root, ['rev-parse', 'HEAD'])
      if (head !== request.target && head !== request.head)
        throw new Error('源码已由其他进程修改，请手动启动')
      const child = spawn(
        process.execPath,
        [
          join(request.root, 'scripts', 'dev.ts'),
          ...(request.mode === 'web' ? ['--web', '--no-open'] : []),
        ],
        {
          cwd: request.root,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', log, log],
        },
      )
      child.once(
        'error',
        (error) =>
          void writeFile(
            resultPath,
            JSON.stringify({ target: request.target, failure: error.message, at: Date.now() }),
          ),
      )
      child.unref()
    } finally {
      closeSync(log)
    }
  }
}
