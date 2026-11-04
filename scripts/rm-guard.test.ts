/**
 * 覆盖范围：`rm-guard.ts`（测试进程中的删除检查）。
 * 原始失败形状在子进程中复现：子进程的当前目录是一个只含标记文件的临时目录，检查失效时被清空的是该目录，不是仓库。
 */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rmGuardError } from './rm-guard.ts'

test('空路径、当前目录、受保护目录及其上级被拒绝；受保护目录之内的路径允许', () => {
  const root = resolve('protected-root')
  expect(rmGuardError('', [root])).toBe('测试中的删除目标为空路径')
  expect(rmGuardError('  ', [root])).toBe('测试中的删除目标为空路径')
  expect(rmGuardError(process.cwd(), [])).toContain('当前目录、仓库根或其上级')
  expect(rmGuardError(root, [root])).toContain('当前目录、仓库根或其上级')
  expect(rmGuardError(resolve(root, '..'), [root])).toContain('当前目录、仓库根或其上级')
  expect(rmGuardError(join(root, '.tmp', 'case'), [root])).toBeNull()
  expect(rmGuardError(join(tmpdir(), 'case'), [root])).toBeNull()
})

test('以空路径递归删除时抛出，当前目录中的文件保留；允许的删除照常执行：三种导入写法都经过检查', () => {
  const box = join(tmpdir(), `rm-guard-${process.pid}-${Date.now()}`)
  mkdirSync(box, { recursive: true })
  const canary = join(box, 'canary.txt')
  writeFileSync(canary, 'keep')
  const guard = resolve(import.meta.dir, 'rm-guard.ts').replaceAll('\\', '/')
  writeFileSync(
    join(box, 'preload.ts'),
    `import { installRmGuard } from '${guard}'\ninstallRmGuard([])\n`,
  )
  writeFileSync(
    join(box, 'probe.test.ts'),
    [
      "import { expect, test } from 'bun:test'",
      "import { existsSync, mkdirSync, rmSync } from 'node:fs'",
      "import { rm } from 'node:fs/promises'",
      "import fs from 'node:fs'",
      "test('具名导入', async () => { await expect(rm('', { recursive: true, force: true })).rejects.toThrow('空路径') })",
      "test('同步', () => { expect(() => rmSync('', { recursive: true, force: true })).toThrow('空路径') })",
      "test('默认导入', async () => { await expect(fs.promises.rm('', { recursive: true, force: true })).rejects.toThrow('空路径') })",
      // 允许的删除必须实际执行：替换后的函数若调用自身，这里以调用栈溢出失败。
      // 路径不带 `./`：Bun 1.4.2 在 Windows 上对 `./` 开头的相对路径执行 `fs.promises.rm` 报 ENOENT，与本检查无关。
      "test('子目录照常删除', async () => {",
      "  for (const name of ['a', 'b', 'c']) mkdirSync('sub-' + name + '/inner', { recursive: true })",
      "  await rm('sub-a', { recursive: true })",
      "  rmSync('sub-b', { recursive: true })",
      "  await new Promise<void>((done, fail) => fs.rm('sub-c', { recursive: true }, (e) => (e ? fail(e) : done())))",
      "  expect(['a', 'b', 'c'].some((n) => existsSync('sub-' + n))).toBe(false)",
      '})',
      '',
    ].join('\n'),
  )
  const child = Bun.spawnSync(
    [process.execPath, 'test', '--preload', './preload.ts', './probe.test.ts'],
    {
      cwd: box,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const output = child.stdout.toString() + child.stderr.toString()
  expect(existsSync(canary)).toBe(true)
  expect(output).toContain('4 pass')
  expect(child.exitCode).toBe(0)
})
