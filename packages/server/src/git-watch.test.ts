/**
 * 覆盖 `git-watch.ts` 与其用于定位 `HEAD` 的 `git.ts` `gitDir`：
 * 用户在终端中切换分支，界面上的分支名随之更新。
 *
 * 该用例复现原始失败形状。应用内切换分支的路径会自行广播，测试该路径无法证明监听有效；
 * 在终端中切换分支不经过应用，只能由文件系统监听发现。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@qywork/core'
import { Store, upsertWorkspace } from '@qywork/store'
import type { EventBus } from './bus.ts'
import { createGitWatch } from './git-watch.ts'

function repo(dir: string): (...args: string[]) => void {
  return (...args: string[]) => {
    Bun.spawnSync(['git', ...args], { cwd: dir })
  }
}

async function repoWithCommit(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-gitwatch-'))
  const run = repo(dir)
  run('init', '-q', '-b', 'main', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  await Bun.write(join(dir, 'a.txt'), 'x')
  run('add', '.')
  run('commit', '-qm', 'x')
  return dir
}

function fixture(root: string) {
  const store = new Store({ path: ':memory:' })
  upsertWorkspace(store, root, 'ws')
  const branches: string[] = []
  const bus = {
    publish: (ev: AgentEvent) => {
      if (ev.type === 'git.state') branches.push(ev.branch)
    },
  } as unknown as EventBus
  return { branches, watch: createGitWatch(store, bus) }
}

/**
 * 等待指定的分支名出现。
 *
 * 不使用固定时长的 sleep：该路径依次经过文件系统回调、120ms 的合并窗口与一次 git 子进程，
 * 三者的耗时都取决于机器。硬编码的数值在其他机器上要么造成无效等待，要么不足。
 */
async function until(branches: string[], name: string, ms = 5000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (branches.includes(name)) return true
    await Bun.sleep(50)
  }
  return false
}

describe('分支名跟随 HEAD', () => {
  test('在终端中切换分支，广播新分支名', async () => {
    const dir = await repoWithCommit()
    const { branches, watch } = fixture(dir)
    try {
      watch.retarget()
      expect(await until(branches, 'main')).toBe(true)

      repo(dir)('checkout', '-q', '-b', 'feature')
      expect(await until(branches, 'feature')).toBe(true)
    } finally {
      watch.stop()
    }
  })

  /**
   * 项目位于链接工作树中：`<root>/.git` 是一个文件，`HEAD` 在主仓库的
   * `.git/worktrees/<名>/` 下。监听 `<root>/.git` 收不到任何事件。
   */
  test('在链接工作树中切换分支，广播新分支名', async () => {
    const dir = await repoWithCommit()
    const wt = join(await mkdtemp(join(tmpdir(), 'qy-gitwatch-wt-')), 'wt')
    repo(dir)('worktree', 'add', '-q', '-b', 'side', wt)
    const { branches, watch } = fixture(wt)
    try {
      watch.retarget()
      expect(await until(branches, 'side')).toBe(true)

      repo(wt)('switch', '-q', '-c', 'side-2')
      expect(await until(branches, 'side-2')).toBe(true)
    } finally {
      watch.stop()
    }
  })

  /** 项目位于仓库的子目录中：`<root>/.git` 不存在。 */
  test('在仓库子目录中切换分支，广播新分支名', async () => {
    const dir = await repoWithCommit()
    const sub = join(dir, 'sub')
    await mkdir(sub)
    const { branches, watch } = fixture(sub)
    try {
      watch.retarget()
      expect(await until(branches, 'main')).toBe(true)

      repo(dir)('switch', '-q', '-c', 'nested')
      expect(await until(branches, 'nested')).toBe(true)
    } finally {
      watch.stop()
    }
  })

  /**
   * 不是 git 仓库时**无法监听就不监听**：本机未安装 git、目录尚未 `git init`
   * 都属于这一情形。抛出异常会导致整个服务无法启动，而实际代价只是分支名为空。
   */
  test('不是 git 仓库时不抛出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-nogit-'))
    const { branches, watch } = fixture(dir)
    try {
      expect(() => watch.retarget()).not.toThrow()
      await Bun.sleep(300)
      expect(branches).toEqual([])
    } finally {
      watch.stop()
    }
  })

  /** 停止后不再广播：服务关闭后残留的监听会阻止进程退出。 */
  test('停止之后切换分支不再广播', async () => {
    const dir = await repoWithCommit()
    const { branches, watch } = fixture(dir)
    watch.retarget()
    expect(await until(branches, 'main')).toBe(true)
    watch.stop()
    branches.length = 0

    repo(dir)('checkout', '-q', '-b', 'later')
    await Bun.sleep(500)
    expect(branches).toEqual([])
  })
})
