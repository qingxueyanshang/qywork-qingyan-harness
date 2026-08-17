/**
 * git 面板数据源的边界。
 *
 * 覆盖 `git.ts` 的 revision 参数校验、每个文件的增删行数（「没有这个数」与「零」
 * 必须分开），以及**这台机器上没装 git 时的形状**。
 * 其余读操作的正确性由 git 自己保证，复刻一遍它的行为没有意义。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diff, isRepo, log, status } from './git.ts'

async function emptyRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-git-'))
  Bun.spawnSync(['git', 'init', '-q', '.'], { cwd: dir })
  return dir
}

describe('revision 参数不是可信输入', () => {
  /**
   * 原始失败形状：`ref` 作为独立 argv 传给 git，而 git 把以 `-` 开头的值当选项解析。
   * `--output=<path>` 是 diff 的输出重定向选项——一次 GET 就能往工作区外写文件。
   *
   * 这里直接复现那个形状：断言**没有文件被创建出来**，而不是只断言抛了异常。
   */
  test('以 - 开头的 ref 被拒，且不落下任何文件', async () => {
    const dir = await emptyRepo()
    const bomb = join(dir, 'pwned.txt')

    expect(log(dir, { ref: `--output=${bomb}` })).rejects.toThrow(/非法的 git ref/)
    expect(diff(dir, { ref: `--output=${bomb}` })).rejects.toThrow(/非法的 git ref/)

    // 目录里只该有 .git，一个 pwned.txt 都不该出现。
    expect((await readdir(dir)).filter((n) => n !== '.git')).toEqual([])
  })

  test('带空格或引号的 ref 一并拒掉', async () => {
    const dir = await emptyRepo()
    for (const bad of ['HEAD --output=x', 'a"b', "a'b", 'a b', '-rf']) {
      expect(log(dir, { ref: bad })).rejects.toThrow(/非法的 git ref/)
    }
  })

  /** 拒绝不能拒过头：真实 revision 语法用到 `~ ^ @{} : /`，这些必须还能用。 */
  test('合法的 revision 写法照常通过校验', async () => {
    const dir = await emptyRepo()
    for (const ok of [
      'HEAD',
      'HEAD~3',
      'HEAD^',
      'main',
      'origin/main',
      '@{u}',
      'v1.2.3',
      'abc123',
    ]) {
      // 空仓库里这些 ref 解析不出提交，log 回空数组即可——
      // 关键是**没有抛出「非法的 git ref」**，说明它过了校验这一关。
      expect(await log(dir, { ref: ok })).toEqual([])
    }
  })
})

describe('每个文件改了多少行', () => {
  /**
   * 「没有这个数」和「零」是两件事。
   *
   * 跟踪中的文件按 `git diff --numstat HEAD` 给出真实增删；未跟踪的文件不在 diff 里
   * （它没有可比的旧版本），此时两个字段**缺席**——界面据此决定不显示，而不是
   * 画一个 +0 −0 出来说「没改动」。
   */
  test('跟踪中的给出增删，未跟踪的两个字段都不给', async () => {
    const dir = await emptyRepo()
    Bun.spawnSync(['git', 'config', 'user.email', 't@qywork.dev'], { cwd: dir })
    Bun.spawnSync(['git', 'config', 'user.name', 'qywork'], { cwd: dir })
    await Bun.write(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'init'], { cwd: dir })

    // 改一行、加两行；再放一个未跟踪的文件。
    await Bun.write(join(dir, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\n')
    await Bun.write(join(dir, 'new.txt'), 'x\n')

    const s = await status(dir)
    const a = s?.files.find((f) => f.path === 'a.txt')
    const n = s?.files.find((f) => f.path === 'new.txt')
    expect(a).toMatchObject({ additions: 3, deletions: 1 })
    expect(n?.additions).toBeUndefined()
    expect(n?.deletions).toBeUndefined()
  })

  /** 空仓库里 `HEAD` 解析不了，整条 numstat 失败——不能因此让 status 也失败。 */
  test('还没有提交时 status 照常返回，只是没有增删数', async () => {
    const dir = await emptyRepo()
    await Bun.write(join(dir, 'a.txt'), 'x\n')
    const s = await status(dir)
    expect(s?.files.map((f) => f.path)).toEqual(['a.txt'])
    expect(s?.files[0]?.additions).toBeUndefined()
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
  test('git 不在 PATH 上时 isRepo 返回 false，而不是抛', async () => {
    const prev = process.env.PATH
    process.env.PATH = ''
    try {
      expect(await isRepo(process.cwd())).toBe(false)
    } finally {
      process.env.PATH = prev
    }
  })
})
