#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const parent = join(root, '.tmp', 'tests')
await mkdir(parent, { recursive: true })
const testTemp = await mkdtemp(join(parent, 'run-'))

let exitCode = 1
try {
  /*
   * 按文件分进程并行运行，进程数缺省为 CPU 核数。2026-10-31 实测全量：串行约 354 秒，8 进程约 56 秒。
   * 各进程的 `QYWORK_HOME` 由 `test-setup.ts` 按进程分开。
   */
  const child = Bun.spawn(
    [process.execPath, 'test', '--conditions', 'browser', '--parallel', ...process.argv.slice(2)],
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
