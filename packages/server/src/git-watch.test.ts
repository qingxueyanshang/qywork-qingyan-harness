/**
 * 覆盖 `git-watch.ts`：用户在终端里切分支，界面上那一格跟着换。
 *
 * **这是原始失败形状**。应用里切分支那条路自己会广播，测它证明不了什么；
 * 而在终端里切分支在应用里没有任何入口，先前只能靠每 4 秒问一次 git 才发现。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
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
 * 等那个分支名出现。
 *
 * 不写死一个 sleep：这条路上串着文件系统回调、120ms 的合并窗口和一次 git 子进程，
 * 三样的耗时都由机器决定。写死的那个数在别人的机器上要么白等要么不够。
 */
async function until(branches: string[], name: string, ms = 5000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (branches.includes(name)) return true
    await Bun.sleep(50)
  }
  return false
}

describe('分支名跟着 .git/HEAD 走', () => {
  test('在终端里切分支，广播新分支名', async () => {
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
   * 不是 git 仓库时**盯不上就不盯**：这台机器上没装 git、目录还没 `git init`
   * 都走这一档。抛出去的话整个服务起不来，而代价本来只是分支那一格空着。
   */
  test('不是 git 仓库也不抛', async () => {
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

  /** 停了就不再报：服务关掉之后还留着的监听会拖着整个进程不退出。 */
  test('停掉之后切分支不再广播', async () => {
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
