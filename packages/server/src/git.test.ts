/**
 * git 面板数据源的边界。
 *
 * 覆盖 `git.ts` 的 revision 参数校验。这里只测**不可信输入**那一段：
 * 其余读操作的正确性由 git 自己保证，复刻一遍它的行为没有意义。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diff, log } from './git.ts'

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
