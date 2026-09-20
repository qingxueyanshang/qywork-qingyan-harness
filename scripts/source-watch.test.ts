/** 覆盖 source-watch.ts 的真实文件通知及其接入 reload-supervisor.ts 后的重载行为。 */
import { expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReloadSupervisor, isWebSourceChange } from './reload-supervisor.ts'
import { watchSource } from './source-watch.ts'

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

test('频繁读取设置源码和修改访问时间不重启，真实编辑仍等运行结束后重启', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-watch-'))
  const file = join(root, 'Settings.tsx')
  writeFileSync(file, 'export const value = 1\n')
  let running = false
  let restarts = 0
  const supervisor = createReloadSupervisor({
    busy: () => running,
    restart: async () => {
      restarts++
    },
    debounceMs: 20,
    idlePollMs: 20,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    log: () => {},
  })
  const watcher = watchSource(root, isWebSourceChange, () => supervisor.onChange())
  try {
    const mtime = statSync(file).mtime
    for (let i = 0; i < 20; i++) {
      readFileSync(file)
      utimesSync(file, new Date(1_600_000_000_000 + i * 1000), mtime)
      await Bun.sleep(5)
    }
    // 相同内容重写也不改变正在运行的源码。
    writeFileSync(file, 'export const value = 1\n')
    await Bun.sleep(100)
    expect(restarts).toBe(0)

    running = true
    writeFileSync(file, 'export const value = 2\n')
    await Bun.sleep(100)
    expect(restarts).toBe(0)
    running = false
    await until(() => restarts === 1)
  } finally {
    watcher.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('新增、删除、目录重命名会重载，测试文件不会重载', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-watch-'))
  const dir = join(root, 'components')
  mkdirSync(dir)
  writeFileSync(join(dir, 'Settings.tsx'), 'export const value = 1\n')
  const dependency = join(root, 'node_modules', 'example', 'src')
  mkdirSync(dependency, { recursive: true })
  writeFileSync(join(dependency, 'index.ts'), 'export const value = 1\n')
  let changes = 0
  const watcher = watchSource(root, isWebSourceChange, () => changes++)
  try {
    writeFileSync(join(root, 'Settings.test.tsx'), 'test')
    writeFileSync(join(dependency, 'index.ts'), 'export const value = 2\n')
    await Bun.sleep(100)
    expect(changes).toBe(0)

    const added = join(dir, 'extra.css')
    writeFileSync(added, '.extra { color: red; }')
    await until(() => changes > 0)
    let before = changes
    rmSync(added)
    await until(() => changes > before)
    before = changes
    renameSync(dir, join(root, 'settings'))
    await until(() => changes > before)
  } finally {
    watcher.close()
    rmSync(root, { recursive: true, force: true })
  }
})
