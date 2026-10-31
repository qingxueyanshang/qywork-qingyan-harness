#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const parent = join(root, '.tmp', 'tests')
await mkdir(parent, { recursive: true })
const testTemp = await mkdtemp(join(parent, 'run-'))

let exitCode = 1
try {
  /*
   * 按文件分进程并行运行，进程数取 CPU 核数的一半。不要改为按核数全开：机器另有负载时，按真实时间
   * 等待的用例因争用而超时。2026-10-31 实测（16 核）全量：串行约 354 秒；16 进程、后台负载约 45% 时
   * 两次分别有 9 项与 12 项超时；8 进程、后台负载约 57% 时全部通过，58 秒。
   * 各进程的 `QYWORK_HOME` 由 `test-setup.ts` 按进程分开。
   */
  const workers = Math.max(1, Math.floor(availableParallelism() / 2))
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      '--conditions',
      'browser',
      `--parallel=${workers}`,
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      env: { ...process.env, QYWORK_TEST_TEMP: testTemp },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  exitCode = await child.exited
} finally {
  await rm(testTemp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

process.exit(exitCode)
