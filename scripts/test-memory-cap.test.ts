/**
 * 覆盖 `scripts/test-setup.ts` 中的内存上限与 `scripts/test-memory-cap.ts`：
 * 测试文件在同步循环中持续分配内存时，进程在超过上限后被结束，退出码非零，并输出该文件。
 */
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

const RUNAWAY = `import { test } from 'bun:test'
test('runaway', () => {
  const keep: number[][] = []
  while (process.memoryUsage().rss < 2 * 2 ** 30) keep.push(new Array(1e5).fill(1))
})
`

test('同步循环中持续分配内存的测试文件在超过上限后被结束，退出码非零', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-cap-'))
  const fixture = join(dir, 'runaway.test.ts')
  writeFileSync(fixture, RUNAWAY)
  const child = Bun.spawn([process.execPath, 'test', '--conditions', 'browser', fixture], {
    cwd: root,
    env: { ...process.env, QYWORK_TEST_MEMORY_LIMIT_MB: '256' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  // 看门狗失效时用例在 2 GB 处结束并通过，退出码为 0。
  expect(code).not.toBe(0)
  expect(stderr).toContain('超过上限 256 MB，已结束进程')
  expect(stderr).toContain('runaway.test.ts')
}, 60_000)
