/**
 * git 面板数据源的边界。
 *
 * 覆盖 `git.ts` 的 revision 参数校验、每个文件的增删行数（「没有这个数」与「零」
 * 必须分开）、**看另一条分支的改动是只读的三点差异**（那个选择器换的是看哪条分支，
 * 不是 HEAD，也不是拿它和我这边对比），
 * 以及**这台机器上没装 git 时的形状**。
 * 其余读操作的正确性由 git 自己保证，复刻一遍它的行为没有意义。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchChanges, diff, isRepo, log, status } from './git.ts'

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

describe('看另一条分支的改动', () => {
  async function repoWithBranches(): Promise<string> {
    const dir = await emptyRepo()
    Bun.spawnSync(['git', 'config', 'user.email', 't@qywork.dev'], { cwd: dir })
    Bun.spawnSync(['git', 'config', 'user.name', 'qywork'], { cwd: dir })
    await Bun.write(join(dir, 'a.txt'), 'base\n')
    await Bun.write(join(dir, 'keep.txt'), 'same\n')
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'init'], { cwd: dir })
    // other 上改 a.txt 并提交，然后回 master
    Bun.spawnSync(['git', 'checkout', '-q', '-b', 'other'], { cwd: dir })
    await Bun.write(join(dir, 'a.txt'), 'base\nfrom other\n')
    Bun.spawnSync(['git', 'commit', '-q', '-am', 'other side'], { cwd: dir })
    Bun.spawnSync(['git', 'checkout', '-q', 'master'], { cwd: dir })
    return dir
  }

  /**
   * **列的是那条分支自己做的事，不是「它和我的差异」。**
   *
   * 判据就在这个用例里：我这边本地改了 `keep.txt` 且没提交，而 `other` 没碰过它——
   * 所以 `keep.txt` **不该出现**。用两点差异（`git diff other`）实现的话它会出现，
   * 那就成了「对比」，而用户要的是「看那条分支的改动情况」。
   *
   * 顺带锁住只读：跑完还在 master 上，本地那行还在。
   */
  test('只列那条分支自己改的文件，不掺我这边的改动', async () => {
    const dir = await repoWithBranches()
    await Bun.write(join(dir, 'keep.txt'), 'my local edit\n')

    const files = await branchChanges(dir, 'other')
    expect(files.map((f) => f.path)).toEqual(['a.txt'])
    expect(files[0]).toMatchObject({ indexStatus: 'M', additions: 1, deletions: 0 })

    expect((await status(dir))?.branch).toBe('master')
    expect(await Bun.file(join(dir, 'keep.txt')).text()).toBe('my local edit\n')
  })

  test('新增与删除也带状态字母', async () => {
    const dir = await repoWithBranches()
    Bun.spawnSync(['git', 'checkout', '-q', 'other'], { cwd: dir })
    Bun.spawnSync(['git', 'rm', '-q', 'keep.txt'], { cwd: dir })
    await Bun.write(join(dir, 'added-on-other.txt'), 'new\n')
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'more on other'], { cwd: dir })
    Bun.spawnSync(['git', 'checkout', '-q', 'master'], { cwd: dir })

    const byPath = new Map((await branchChanges(dir, 'other')).map((f) => [f.path, f]))
    expect(byPath.get('keep.txt')?.indexStatus).toBe('D')
    expect(byPath.get('added-on-other.txt')?.indexStatus).toBe('A')
  })

  /** 分支名同样是不可信输入：以 `-` 开头的一律拒（理由见 `assertSafeRef`）。 */
  test('以 - 开头的 ref 被拒', async () => {
    const dir = await emptyRepo()
    expect(branchChanges(dir, '--output=x')).rejects.toThrow(/非法的 git ref/)
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
