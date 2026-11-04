/**
 * 测试进程中的删除检查，由 `bun test` 的预载安装：本仓库为 `test-setup.ts`，云端仓库为 `server/src/test-preload.ts`。
 *
 * 删除目标为空路径，或是当前目录、受保护目录本身或其上级时抛出，不执行删除。临时目录变量的初值常为空串，
 * `beforeAll` 在赋值之前失败时，`afterAll` 以空串删除；Bun 在 Windows 上对空路径递归删除会清空当前目录，
 * 而测试进程的当前目录是仓库根或 `server/`。
 *
 * 必须经 `mock.module` 替换 `node:fs` 与 `node:fs/promises`：直接修改模块对象的属性，
 * 对测试文件中的 `import { rm } from 'node:fs/promises'` 不生效。`Bun.$` 与子进程中的 `rm -rf` 不经过这里。
 * 只替换 `rm` 系列：`rmdir` 的类型定义已不接受递归选项，不带选项时只能删除空目录。
 */

import { mock } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `outer` 等于 `inner` 或是其上级目录。Windows 上 `relative` 不区分大小写。 */
function contains(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 删除目标不允许时的原因，允许时为 null。`protectedRoots` 之外，当前目录始终受保护。 */
export function rmGuardError(target: unknown, protectedRoots: readonly string[]): string | null {
  const raw = target instanceof URL ? fileURLToPath(target) : String(target ?? '')
  if (raw.trim() === '') return '测试中的删除目标为空路径'
  const absolute = resolve(raw)
  for (const root of [process.cwd(), ...protectedRoots]) {
    if (contains(absolute, resolve(root))) {
      return `测试中的删除目标是当前目录、仓库根或其上级：${absolute}`
    }
  }
  return null
}

export function installRmGuard(protectedRoots: readonly string[]): void {
  const check = (target: unknown) => {
    const error = rmGuardError(target, protectedRoots)
    if (error) throw new Error(error)
  }
  // 原函数必须在替换之前取出：`mock.module` 同样替换本文件导入的 `fs` 与 `fsp`，
  // 包装函数中写 `fsp.rm(...)` 调用的是包装函数自身，无限递归。
  const original = {
    rm: fsp.rm,
    rmSync: fs.rmSync,
    rmCallback: fs.rm as (...args: unknown[]) => void,
  }
  // 异步版本以被拒绝的 Promise 报告，与原函数相同：同步抛出时，`await rm(...).catch(...)` 接不到。
  const rm: typeof fsp.rm = async (path, options) => {
    check(path)
    return original.rm(path, options)
  }
  const promises = { ...fsp, rm }
  const rmSync: typeof fs.rmSync = (path, options) => {
    check(path)
    original.rmSync(path, options)
  }
  const rmCallback = ((path: fs.PathLike, ...rest: unknown[]) => {
    check(path)
    return original.rmCallback(path, ...rest)
  }) as typeof fs.rm
  const sync = { ...fs, rm: rmCallback, rmSync, promises }
  for (const name of ['node:fs/promises', 'fs/promises']) {
    mock.module(name, () => ({ ...promises, default: promises }))
  }
  for (const name of ['node:fs', 'fs']) {
    mock.module(name, () => ({ ...sync, default: sync }))
  }
}
