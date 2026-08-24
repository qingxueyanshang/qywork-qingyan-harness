/**
 * 覆盖范围：`changes.ts`——外部 CLI 跑完之后「它到底改了什么」那份一手清单。
 *
 * 这里测的全是**别的算法会答错**的形状：CLI 自己提交了、工作区跑之前就脏、
 * 二进制文件、不是 git 仓库。真机那半（`runCli` 把两次快照接起来）由冒烟脚本覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChange } from '@qywork/core'
import { changesSince, snapshotTree, whyUnmeasurable } from './changes.ts'

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-chg-'))
  const run = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
  run('init', '-q', '-b', 'main', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  await writeFile(join(dir, 'keep.txt'), 'a\nb\n')
  run('add', '.')
  run('commit', '-qm', 'base')
  return dir
}

const git = (dir: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir })
const find = (list: FileChange[], path: string) => list.find((c) => c.path === path)

describe('量改动', () => {
  test('不是 git 仓库时两个入口都回 null——不是空清单', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-nogit-'))
    expect(await snapshotTree(dir)).toBeNull()
    // 空清单的意思是「确定没改」，那是一个具体而错误的结论。
    expect(await changesSince(dir, 'deadbeef')).toBeNull()
  })

  /** 「量不了」与「没有改动」必须分得开，所以量不了的时候要说得出为什么。 */
  test('量不了时说得出为什么', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qy-nogit-'))
    expect(await whyUnmeasurable(dir)).toBe('这个工作区不在 git 仓库里')
    expect(await whyUnmeasurable(await repo())).toBe('git 没能读出这个工作区的状态')
  })

  test('没动过就是零条', async () => {
    const dir = await repo()
    const base = (await snapshotTree(dir))!
    expect(await changesSince(dir, base)).toEqual({ files: [], total: 0 })
  })

  test('新建的文件有真实行数，且算「新增」', async () => {
    const dir = await repo()
    const base = (await snapshotTree(dir))!
    await writeFile(join(dir, 'new.txt'), 'x\ny\nz\n')
    const got = (await changesSince(dir, base))!
    expect(got.total).toBe(1)
    expect(got.files[0]).toEqual({
      path: 'new.txt',
      changeType: 'created',
      additions: 3,
      deletions: 0,
    })
  })

  test('删掉的算「删除」', async () => {
    const dir = await repo()
    const base = (await snapshotTree(dir))!
    Bun.spawnSync(['git', 'rm', '-q', 'keep.txt'], { cwd: dir })
    const got = (await changesSince(dir, base))!
    expect(find(got.files, 'keep.txt')?.changeType).toBe('deleted')
  })

  /**
   * 被调度的 CLI 自己 `git commit` 是常事。按工作区脏文件算的话这里一无所获，
   * 而它明明改了。
   */
  test('CLI 自己提交了照样量得到', async () => {
    const dir = await repo()
    const base = (await snapshotTree(dir))!
    await writeFile(join(dir, 'keep.txt'), 'a\nb\nc\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'cli 自己提交')
    const got = (await changesSince(dir, base))!
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
    const base = (await snapshotTree(dir))!
    await writeFile(join(dir, 'keep.txt'), 'a\nb\n用户自己加的\nCLI 加的\n')
    const got = (await changesSince(dir, base))!
    expect(got.total).toBe(1)
    expect(find(got.files, 'keep.txt')?.additions).toBe(1)
    expect(find(got.files, 'user.txt')).toBeUndefined()
  })

  /** 二进制文件 numstat 那两格是 `-`：报 0，不能报 NaN。 */
  test('二进制文件报 0 行而不是 NaN', async () => {
    const dir = await repo()
    const base = (await snapshotTree(dir))!
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    const got = (await changesSince(dir, base))!
    expect(find(got.files, 'bin.dat')).toEqual({
      path: 'bin.dat',
      changeType: 'created',
      additions: 0,
      deletions: 0,
    })
  })

  test('.gitignore 挡住的不算改动', async () => {
    const dir = await repo()
    await writeFile(join(dir, '.gitignore'), 'ignored/\n')
    const base = (await snapshotTree(dir))!
    await Bun.write(join(dir, 'ignored', 'x.log'), '噪声\n')
    expect(await changesSince(dir, base)).toEqual({ files: [], total: 0 })
  })

  /** 列不下的时候必须把总数说出来——只给一截还让人以为是全部，比不给更坏。 */
  test('清单封顶，总数照实说', async () => {
    const dir = await repo()
    const base = (await snapshotTree(dir))!
    for (let i = 0; i < 25; i++) await writeFile(join(dir, `f${i}.txt`), 'x\n'.repeat(i + 1))
    const got = (await changesSince(dir, base))!
    expect(got.total).toBe(25)
    expect(got.files).toHaveLength(20)
    // 按改动量排：留下的是改得最多的那些。
    expect(got.files[0]?.additions).toBe(25)
  })
})
