/**
 * 分支名数据源的边界。
 *
 * 覆盖 `git.ts` 的两件事：**detached HEAD 回 null 而不是一个叫 HEAD 的分支**，
 * 以及**这台机器上没装 git 时的形状**。
 * 其余由 git 自己保证，复刻一遍它的行为没有意义。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentBranch, switchTo } from './git.ts'

async function repoWithCommit(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-git-'))
  const run = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
  run('init', '-q', '-b', 'main', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  await Bun.write(join(dir, 'a.txt'), 'x')
  run('add', '.')
  run('commit', '-qm', 'x')
  return dir
}

describe('当前分支名', () => {
  test('在分支上就是分支名', async () => {
    expect(await currentBranch(await repoWithCommit())).toBe('main')
  })

  /**
   * detached HEAD。**必须是 null，不能是字符串 `HEAD`**——
   * `rev-parse --abbrev-ref HEAD` 在这个状态下回的正是后者，界面会把它当成
   * 一个叫 HEAD 的分支挂在输入框上方。
   */
  test('detached HEAD 回 null', async () => {
    const dir = await repoWithCommit()
    const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString().trim()
    Bun.spawnSync(['git', 'checkout', '-q', sha], { cwd: dir })
    expect(await currentBranch(dir)).toBeNull()
  })

  test('不是仓库回 null', async () => {
    expect(await currentBranch(await mkdtemp(join(tmpdir(), 'qy-nogit-')))).toBeNull()
  })
})

describe('这台机器上没装 git', () => {
  /**
   * **不能抛，只能报「不是仓库」。**
   *
   * 原始失败形状是实测撞出来的：把 PATH 剥到只剩 System32 起一次服务，
   * `Bun.spawn(['git', …])` 同步抛 ENOENT，而 `server.ts` 的 `pollGit` 是
   * `void publishGitState(...)`——浮动 promise 没人接，于是启动时糊一屏栈、
   * 之后每 4 秒再来一次。
   *
   * 判据是「git 跑不跑得起来」本来就属于 `git()` 的返回类型（它有 `ok: false` 这一档），
   * 所以接在那里而不是给 `pollGit` 加 `.catch`——后者是在下游堵症状。
   *
   * 用清空 PATH 制造这个状态：Bun 按 PATH 解析可执行文件，空 PATH 就是「没装」。
   */
  test('git 不在 PATH 上时回 null，而不是抛', async () => {
    const prev = process.env.PATH
    process.env.PATH = ''
    try {
      expect(await currentBranch(process.cwd())).toBeNull()
    } finally {
      process.env.PATH = prev
    }
  })
})

/**
 * 被拒时的那句话。**只测形状不测措辞**：断言里出现的是文件名和「未提交」这类关键字，
 * 换个说法不该让测试红。
 */
describe('切不过去时说人话', () => {
  async function dirtyBlocked(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'qy-git-sw-'))
    const run = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
    run('init', '-q', '-b', 'main', '.')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    await Bun.write(join(dir, 'a.txt'), 'main')
    run('add', '.')
    run('commit', '-qm', 'main')
    run('switch', '-qc', 'dev')
    await Bun.write(join(dir, 'a.txt'), 'dev')
    run('commit', '-qam', 'dev')
    run('switch', '-q', 'main')
    // 这一份既没提交、又正好是两条分支不一样的那个文件——git 一定拒。
    await Bun.write(join(dir, 'a.txt'), '我自己改的')
    const r = await switchTo(dir, 'dev')
    expect(r.ok).toBe(false)
    return r.message
  }

  test('点名是哪个文件，且不吐英文', async () => {
    const msg = await dirtyBlocked()
    expect(msg).toContain('a.txt')
    expect(msg).toContain('未提交')
    // 原来是四行英文加缩进，现在必须是一行。
    expect(msg).not.toContain('\n')
    expect(msg).not.toContain('overwritten')
  })

  test('没有这条分支时不去跑 git', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-git-none-'))
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main', '.'], { cwd: dir })
    const r = await switchTo(dir, '--output=pwned')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('没有这条本地分支')
  })
})
