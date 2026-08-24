/**
 * 覆盖范围：`changes.ts`——外部 CLI 跑完之后「它到底改了什么」那份一手清单。
 *
 * 这里测的全是**别的算法会答错**的形状：CLI 自己提交了、工作区跑之前就脏、
 * 工作区根本不是 git 仓库、工作区是别的仓库里被忽略的一个子目录、二进制文件。
 * 真机那半（`runCli` 把两次快照接起来）由 `scripts/smoke-cli-receipt.ts` 覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChange } from '@qywork/core'
import { beginProbe, endProbe } from './changes.ts'

const git = (dir: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
const find = (list: FileChange[], path: string) => list.find((c) => c.path === path)

/** 一个空目录：什么仓库都不是。 */
async function bare(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-chg-'))
  await writeFile(join(dir, 'keep.txt'), 'a\nb\n')
  return dir
}

/** 一个自己就是 git 仓库的工作区，已经有一次提交。 */
async function repo(): Promise<string> {
  const dir = await bare()
  git(dir, 'init', '-q', '-b', 'main', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

/** 跑一次完整量测：照基线 → 干点什么 → 再照一次。 */
async function measure(dir: string, act: () => Promise<void>) {
  const probe = await beginProbe(dir)
  expect(probe).not.toBeNull()
  await act()
  const got = await endProbe(probe!, dir)
  expect(got).not.toBeNull()
  return got!
}

describe('量改动', () => {
  test('工作区不是 git 仓库也量得到', async () => {
    const dir = await bare()
    const got = await measure(dir, async () => {
      await writeFile(join(dir, 'new.txt'), 'x\ny\n')
    })
    expect(got.total).toBe(1)
    expect(got.files[0]).toEqual({
      path: 'new.txt',
      changeType: 'created',
      additions: 2,
      deletions: 0,
    })
  })

  /**
   * 工作区是别的仓库里被 `.gitignore` 挡着的一个子目录。
   *
   * 借用外层仓库的话两次快照完全相同，回执上是「没有改动」——而文件真的写了。
   */
  test('外层仓库忽略了这个目录也量得到', async () => {
    const outer = await repo()
    await writeFile(join(outer, '.gitignore'), 'inner/\n')
    const dir = join(outer, 'inner')
    await Bun.write(join(dir, 'seed.txt'), '0\n')
    const got = await measure(dir, async () => {
      await writeFile(join(dir, 'wrote.txt'), 'hello\n')
    })
    expect(got.files.map((f) => f.path)).toEqual(['wrote.txt'])
  })

  test('没动过就是零条', async () => {
    const dir = await repo()
    expect(await measure(dir, async () => {})).toEqual({ files: [], total: 0 })
  })

  test('删掉的算「删除」', async () => {
    const dir = await repo()
    const got = await measure(dir, async () => {
      git(dir, 'rm', '-q', 'keep.txt')
    })
    expect(find(got.files, 'keep.txt')?.changeType).toBe('deleted')
  })

  /**
   * 被调度的 CLI 自己 `git commit` 是常事。按工作区脏文件算的话这里一无所获，
   * 而它明明改了。
   */
  test('CLI 自己提交了照样量得到', async () => {
    const dir = await repo()
    const got = await measure(dir, async () => {
      await writeFile(join(dir, 'keep.txt'), 'a\nb\nc\n')
      git(dir, 'add', '.')
      git(dir, 'commit', '-qm', 'cli 自己提交')
    })
    expect(find(got.files, 'keep.txt')).toEqual({
      path: 'keep.txt',
      changeType: 'modified',
      additions: 1,
      deletions: 0,
    })
  })

  /** 用户跑之前就改了一半的那些，不能记到 CLI 头上。 */
  test('跑之前就脏的改动被吃进基线', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'keep.txt'), 'a\nb\n用户自己加的\n')
    await writeFile(join(dir, 'user.txt'), '也是用户的\n')
    const got = await measure(dir, async () => {
      await writeFile(join(dir, 'keep.txt'), 'a\nb\n用户自己加的\nCLI 加的\n')
    })
    expect(got.total).toBe(1)
    expect(find(got.files, 'keep.txt')?.additions).toBe(1)
    expect(find(got.files, 'user.txt')).toBeUndefined()
  })

  /** 二进制文件 numstat 那两格是 `-`：报 0，不能报 NaN。 */
  test('二进制文件报 0 行而不是 NaN', async () => {
    const dir = await repo()
    const got = await measure(dir, async () => {
      await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    })
    expect(find(got.files, 'bin.dat')).toEqual({
      path: 'bin.dat',
      changeType: 'created',
      additions: 0,
      deletions: 0,
    })
  })

  test('工作区自己的 .gitignore 仍然挡得住', async () => {
    const dir = await repo()
    await writeFile(join(dir, '.gitignore'), 'noise/\n')
    const got = await measure(dir, async () => {
      await Bun.write(join(dir, 'noise', 'x.log'), '噪声\n')
    })
    expect(got).toEqual({ files: [], total: 0 })
  })

  /** 工作区里那个 `.git` 是另一个仓库的内脏，不能被当成一堆普通文件加进树。 */
  test('工作区自己的 .git 不进清单', async () => {
    const dir = await repo()
    const got = await measure(dir, async () => {
      await writeFile(join(dir, 'keep.txt'), 'a\nb\nc\n')
      git(dir, 'add', '.')
      git(dir, 'commit', '-qm', '动一下对象库')
    })
    expect(got.files.some((f) => f.path.startsWith('.git/'))).toBe(false)
  })

  /** 列不下的时候必须把总数说出来——只给一截还让人以为是全部，比不给更坏。 */
  test('清单封顶，总数照实说', async () => {
    const dir = await repo()
    const got = await measure(dir, async () => {
      for (let i = 0; i < 25; i++) await writeFile(join(dir, `f${i}.txt`), 'x\n'.repeat(i + 1))
    })
    expect(got.total).toBe(25)
    expect(got.files).toHaveLength(20)
    // 按改动量排：留下的是改得最多的那些。
    expect(got.files[0]?.additions).toBe(25)
  })
})
