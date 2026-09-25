/**
 * 覆盖 `workspace-watch.ts`：执行窗口内的路径归集、忽略判定与收尾判型。
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChange } from '@qywork/core'
import { gitProcessCount, openChangeWindow, settleEvents } from './workspace-watch.ts'

async function settle(): Promise<void> {
  await Bun.sleep(250)
}

/** 观察器已交齐此前的事件。临时文件不进结果的前提是观察器在它消失之前 stat 到过它。 */
async function observed(root: string): Promise<void> {
  expect(await settleEvents(root)).toBe(true)
}

/** 忽略判定问的是真的 git，夹具就得是真的仓库。 */
async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-watch-'))
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: root })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr.toString()}`)
  }
  run('init', '-q', '-b', 'main', '.')
  run('config', 'user.email', 't@t')
  run('config', 'user.name', 't')
  return root
}

function typeOf(changes: FileChange[]): Map<string, string> {
  return new Map(changes.map((c) => [c.path, c.changeType]))
}

describe('执行窗口内的工作区变更', () => {
  test('新建 / 修改 / 删除各判其类；临时文件与噪音目录不进结果', async () => {
    const root = await gitRepo()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'old.ts'), 'a\n')
    await writeFile(join(root, 'gone.txt'), 'x\n')
    // 让「创建时间在窗口之前」成立：文件系统的时间戳精度以毫秒计。
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'src', 'new.ts'), 'b\n')
    await writeFile(join(root, 'src', 'old.ts'), 'a\nb\n')
    await rm(join(root, 'gone.txt'))
    await writeFile(join(root, 'tmp.swp'), 't')
    await observed(root)
    await rm(join(root, 'tmp.swp'))
    // 新建的二进制不数行
    await writeFile(join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]))
    await settle()
    const got = await window.close()

    const byPath = typeOf(got.changes)
    expect(byPath.get('src/new.ts')).toBe('created')
    expect(byPath.get('src/old.ts')).toBe('modified')
    expect(byPath.get('gone.txt')).toBe('deleted')
    expect(byPath.has('tmp.swp')).toBe(false)
    expect(got.incomplete).toBe(false)
    // 新建的文本按内容数行，口径同文件工具（'b\n' 切成两段）；改过的与删掉的拿不到旧内容，不带行数
    const byFull = new Map(got.changes.map((c) => [c.path, c]))
    expect(byFull.get('src/new.ts')).toEqual({
      path: 'src/new.ts',
      changeType: 'created',
      additions: 2,
      deletions: 0,
    })
    expect(byFull.get('shot.png')).toEqual({ path: 'shot.png', changeType: 'created' })
    expect(byFull.get('src/old.ts')?.additions).toBeUndefined()
    expect(byFull.get('gone.txt')?.additions).toBeUndefined()
  })

  /**
   * 原始失败形状：`.github/workflows`、`.gitignore`、`.editorconfig` 与用户自己的点目录
   * 都是项目文件，按点前缀排除会把它们一起丢掉。忽略与否只由 Git 裁决。
   */
  test('项目点路径进结果，被忽略的产物与 .tmp 不进', async () => {
    const root = await gitRepo()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, '.github', 'workflows'), { recursive: true })
    await mkdir(join(root, '.custom'))
    await mkdir(join(root, '.chk', 'prof'), { recursive: true })
    await mkdir(join(root, '.tmp', 'scratch'), { recursive: true })
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'src', 'x.ts'), 'export const x = 1\n')
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
    await writeFile(join(root, '.gitignore'), '.chk/\n')
    await writeFile(join(root, '.editorconfig'), 'root = true\n')
    await writeFile(join(root, '.custom', 'notes.md'), '# notes\n')
    // 浏览器 profile 由项目自己的忽略规则挡住，不靠点前缀；.tmp 是本项目的临时产物目录。
    await writeFile(join(root, '.chk', 'prof', 'Local State'), '{}')
    await writeFile(join(root, '.tmp', 'scratch', 'junk.txt'), 'junk')
    await settle()
    const got = await window.close()

    const seen = new Set(got.changes.map((c) => c.path))
    expect([...seen].sort()).toEqual([
      '.custom/notes.md',
      '.editorconfig',
      '.github/workflows/ci.yml',
      '.gitignore',
      'src/x.ts',
    ])
    expect(got.incomplete).toBe(false)
  })

  /**
   * 已跟踪的文件即使命中忽略模式也要报：`git check-ignore` 默认查索引，
   * 跟踪中的路径不在它的输出里，这里不另写一层跟踪判断。
   */
  test('tracked-but-ignored 仍报告；同一个目录里未跟踪的不报告', async () => {
    const root = await gitRepo()
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'dep', 'keep.js'), 'module.exports = 1\n')
    Bun.spawnSync(['git', 'add', 'node_modules/dep/keep.js'], { cwd: root })
    await writeFile(join(root, '.gitignore'), 'node_modules/\n')
    await Bun.sleep(20)
    const before = { ...gitProcessCount }

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'node_modules', 'dep', 'keep.js'), 'module.exports = 2\n')
    await writeFile(join(root, 'node_modules', 'dep', 'cached.js'), 'cache\n')
    await settle()
    const got = await window.close()

    expect(got.changes.map((c) => [c.path, c.changeType])).toEqual([
      ['node_modules/dep/keep.js', 'modified'],
    ])
    // 目录被剪掉才会去查索引，一次。
    expect(gitProcessCount.lsFiles - before.lsFiles).toBe(1)
    expect(got.incomplete).toBe(false)
  })

  /**
   * 索引里还挂着、磁盘上已经没有的文件不报 deleted。
   *
   * 它归不到任何一个窗口：被剪目录里没有事件可依，而索引残留在每一次收尾都会被取回来，
   * 报出去就是每条命令往账本灌一条假删除，直到用户跑 `git rm`。
   */
  test('被剪目录里的索引残留不报 deleted', async () => {
    const root = await gitRepo()
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist', 'bundle.js'), 'bundled\n')
    Bun.spawnSync(['git', 'add', 'dist/bundle.js'], { cwd: root })
    await rm(join(root, 'dist', 'bundle.js'))
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'kept.ts'), 'export const a = 1\n')
    await settle()
    const got = await window.close()

    expect(got.changes.map((c) => c.path)).toEqual(['kept.ts'])
    expect(got.incomplete).toBe(false)
  })

  /** 索引里一条都没有的运行产物目录：查一次索引补不出内容，目录本身不进收尾扫描。 */
  test('运行产物目录里未跟踪的文件不报告，收尾扫描不进入该目录', async () => {
    const root = await gitRepo()
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(root, 'dist'))
    await Bun.sleep(20)
    const before = { ...gitProcessCount }

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'kept.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    await writeFile(join(root, 'dist', 'bundle.js'), 'bundled\n')
    await settle()
    const got = await window.close()

    expect(got.changes.map((c) => c.path)).toEqual(['kept.ts'])
    expect(gitProcessCount.lsFiles - before.lsFiles).toBe(1)
    expect(got.incomplete).toBe(false)
  })

  test('删除、原子保存与嵌套目录', async () => {
    const root = await gitRepo()
    await writeFile(join(root, 'gone.txt'), 'x\n')
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await rm(join(root, 'gone.txt'))
    await mkdir(join(root, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(root, 'a', 'b', 'c', 'deep.ts'), 'deep\n')
    await writeFile(join(root, 'atomic.txt.part'), 'v1\n')
    // 改名之前观察器要已经 stat 到临时文件，否则它会被判成 deleted。
    await observed(root)
    await rename(join(root, 'atomic.txt.part'), join(root, 'atomic.txt'))
    await settle()
    const got = await window.close()

    const byPath = typeOf(got.changes)
    expect(byPath.get('gone.txt')).toBe('deleted')
    expect(byPath.get('a/b/c/deep.ts')).toBe('created')
    expect(byPath.get('atomic.txt')).toBe('created')
    expect(byPath.has('atomic.txt.part')).toBe(false)
  })

  /**
   * `-z` 让路径原样进出。换成默认的行分隔格式，非 ASCII 路径会被 git 加引号并转义成
   * 八进制，回来的字符串对不上候选，被忽略的文件反而会报出去。
   */
  test('中文与带空格的文件名照常判定', async () => {
    const root = await gitRepo()
    await mkdir(join(root, '缓存 目录'))
    await writeFile(join(root, '.gitignore'), '缓存 目录/\n')
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, '文档 一.md'), '# 一\n')
    await writeFile(join(root, '缓存 目录', '临时 文件.bin'), 'x')
    await settle()
    const got = await window.close()

    expect(got.changes.map((c) => c.path)).toEqual(['文档 一.md'])
    expect(got.incomplete).toBe(false)
  })

  /** 忽略判定是收尾时的一次批量调用，不跟着 fs 事件走；没有被剪目录就不查索引。 */
  test('一个窗口内多次 fs 事件只起一次 check-ignore，不起 ls-files', async () => {
    const root = await gitRepo()
    const before = { ...gitProcessCount }

    const window = openChangeWindow(root)
    await settle()
    for (let i = 0; i < 12; i++) await writeFile(join(root, `f${i}.txt`), String(i))
    await settle()
    const got = await window.close()

    expect(gitProcessCount.checkIgnore - before.checkIgnore).toBe(1)
    expect(gitProcessCount.lsFiles - before.lsFiles).toBe(0)
    expect(got.changes.length).toBe(12)
  })

  /**
   * Git 判定跑不成时候选一条不丢，并且把「观察范围不完整」交出去——
   * 静默按零改动收场的话，一次没跑完的过滤和一次真的没有改动分不开。
   */
  test('Git 判定失败标记观察范围不完整且不丢候选', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-watch-'))
    await writeFile(join(root, '.git'), 'gitdir: /qywork-no-such-repo\n')
    await mkdir(join(root, '.chk'))
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'a.txt'), '1')
    await writeFile(join(root, '.chk', 'state'), '1')
    await settle()
    const got = await window.close()

    expect(got.incomplete).toBe(true)
    expect(new Set(got.changes.map((c) => c.path))).toEqual(new Set(['a.txt', '.chk/state']))
  })

  /** 非 Git 目录没有忽略规则可依，只挡运行产物目录，点路径照报。 */
  test('非 Git 目录按运行产物目录排除，不起 git 进程', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-watch-'))
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
    await mkdir(join(root, '.cache'))
    await mkdir(join(root, '.config'))
    await mkdir(join(root, '.tmp'))
    await Bun.sleep(20)
    const before = { ...gitProcessCount }

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, '.editorconfig'), 'root = true\n')
    await writeFile(join(root, '.config', 'app.json'), '{}')
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), '1')
    await writeFile(join(root, '.cache', 'blob'), '1')
    await writeFile(join(root, '.tmp', 'junk'), '1')
    await settle()
    const got = await window.close()

    expect(new Set(got.changes.map((c) => c.path))).toEqual(
      new Set(['.editorconfig', '.config/app.json']),
    )
    expect(gitProcessCount).toEqual(before)
    expect(got.incomplete).toBe(false)
  })

  /**
   * 递归 watch 对整个目录被删只给目录一条事件（Windows 实测），收尾扫描又扫不到
   * 已经不存在的文件，所以深一层的文件只能靠本轮已报路径对账才报得出来。
   */
  test('整个目录被删：按本轮已报路径对账，其中的文件报出删除', async () => {
    const root = await gitRepo()
    const reported = new Set<string>()
    const track = (changes: FileChange[]) => {
      for (const c of changes) {
        if (c.changeType === 'deleted') reported.delete(c.path)
        else reported.add(c.path)
      }
    }
    await Bun.sleep(20)

    const first = openChangeWindow(root, { reported })
    await settle()
    await mkdir(join(root, 'd', 'sub'), { recursive: true })
    await writeFile(join(root, 'd', 'a.txt'), 'a\n')
    await writeFile(join(root, 'd', 'sub', 'b.txt'), 'b\n')
    await writeFile(join(root, 'd', 'sub', 'c.txt'), 'c\n')
    await settle()
    track((await first.close()).changes)

    const second = openChangeWindow(root, { reported })
    await settle()
    await writeFile(join(root, 'd', 'sub', 'b.txt'), 'b2\n')
    await settle()
    track((await second.close()).changes)
    expect([...reported].sort()).toEqual(['d/a.txt', 'd/sub/b.txt', 'd/sub/c.txt'])

    const third = openChangeWindow(root, { reported })
    await settle()
    await rm(join(root, 'd'), { recursive: true, force: true })
    await settle()
    const got = await third.close()

    // 三个文件都报删除，三个目录自己一个都不报。
    expect(got.changes.map((c) => [c.path, c.changeType]).sort()).toEqual([
      ['d/a.txt', 'deleted'],
      ['d/sub/b.txt', 'deleted'],
      ['d/sub/c.txt', 'deleted'],
    ])
    expect(got.incomplete).toBe(false)
  })

  /**
   * 不给已报路径就只剩事件与扫描两条来源，目录里的文件只有事件看得见。Windows 上整个目录
   * 被删时，深一层文件的删除事件多数不交出、少数交出，浅一层的同样可能丢。两种结果都正确，
   * **不要断言哪个文件报得出或报不出**；目录被删时逐个报出其中的文件靠已报路径对账，见上一条。
   */
  test('不传已报路径时，目录被删只按收到的事件报删除，不判为未读全', async () => {
    const root = await gitRepo()
    await mkdir(join(root, 'd', 'sub'), { recursive: true })
    await writeFile(join(root, 'd', 'a.txt'), 'a\n')
    await writeFile(join(root, 'd', 'sub', 'b.txt'), 'b\n')
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await rm(join(root, 'd'), { recursive: true, force: true })
    await settle()
    const got = await window.close()

    expect(got.changes.every((c) => c.changeType === 'deleted')).toBe(true)
    expect(got.incomplete).toBe(false)
  })

  /**
   * 原始失败形状：收尾那一刻删除事件还在途。删除只有事件看得见，收尾不等在途事件交齐的话
   * 最后几步里的删除不进结果。macOS 的 FSEvents 按 50 ms 合批交付，在途时间最长。
   */
  test('删除后立即收尾，删除照常报出', async () => {
    const root = await gitRepo()
    await writeFile(join(root, 'gone.txt'), 'x\n')
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await rm(join(root, 'gone.txt'))
    const got = await window.close()

    expect(got.changes).toEqual([{ path: 'gone.txt', changeType: 'deleted' }])
    expect(got.incomplete).toBe(false)
  })

  /** 收尾前发生、收尾时还在途的事件属于正在收尾的窗口，不能落到排在后面的窗口里。 */
  test('两个窗口同时开着时，前一个收尾时在途的事件仍归它', async () => {
    const root = await gitRepo()
    await writeFile(join(root, 'a.txt'), 'a\n')
    await writeFile(join(root, 'b.txt'), 'b\n')
    await Bun.sleep(20)

    const first = openChangeWindow(root)
    const second = openChangeWindow(root)
    await settle()
    await rm(join(root, 'a.txt'))
    const firstChanges = await first.close()
    await rm(join(root, 'b.txt'))
    const secondChanges = await second.close()

    expect(firstChanges.changes).toEqual([{ path: 'a.txt', changeType: 'deleted' }])
    expect(secondChanges.changes).toEqual([{ path: 'b.txt', changeType: 'deleted' }])
  })

  /** 标记写不进去就无从确认事件已交齐，结果按观察范围不完整交出，扫描得到的改动照报。 */
  test('屏障标记写不进去时标记观察范围不完整', async () => {
    const root = await gitRepo()
    await writeFile(join(root, '.tmp'), 'not a directory')
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'a.txt'), '1')
    const got = await window.close()

    expect(got.incomplete).toBe(true)
    expect(got.changes.map((c) => c.path)).toEqual(['a.txt'])
  })

  test('两个窗口同时开着时，事件归最早打开的那个', async () => {
    const root = await gitRepo()
    const first = openChangeWindow(root)
    const second = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'a.txt'), '1')
    await settle()
    const firstChanges = await first.close()
    await writeFile(join(root, 'b.txt'), '2')
    await settle()
    const secondChanges = await second.close()

    expect(firstChanges.changes.map((c) => c.path)).toEqual(['a.txt'])
    expect(secondChanges.changes.map((c) => c.path)).toEqual(['b.txt'])
  })
})
