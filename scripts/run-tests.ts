#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const parent = join(root, '.tmp', 'tests')
await mkdir(parent, { recursive: true })
const testTemp = await mkdtemp(join(parent, 'run-'))

let exitCode = 1
try {
  const child = Bun.spawn(
    [process.execPath, 'test', '--conditions', 'browser', ...process.argv.slice(2)],
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
