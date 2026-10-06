/**
 * 覆盖 `workspace-watch.ts`：执行窗口内的路径归集、忽略判定与收尾时的变更类型判定。
 */
import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChange } from '@qywork/core'
import { gitProcessCount, openChangeWindow, settleEvents } from './workspace-watch.ts'

async function settle(): Promise<void> {
  await Bun.sleep(250)
}

/** 观察器已交付此前的全部事件。临时文件不进入结果的前提是观察器在它消失之前 stat 过它。 */
async function observed(root: string): Promise<void> {
  expect(await settleEvents(root)).toBe(true)
}

/** 忽略判定调用真实的 git，因此夹具必须是真实的仓库。 */
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
  test('连续打开窗口时不收入前一轮的延迟写入；恢复 mtime 的本轮修改仍保留', async () => {
    const root = await gitRepo()
    for (let i = 0; i < 4; i++) {
      const before = join(root, `before-${i}.txt`)
      const changed = join(root, `changed-${i}.txt`)
      await writeFile(before, 'before\n')
      await writeFile(changed, 'before\n')
      const prior = await stat(changed)
      const window = openChangeWindow(root)
      await observed(root)
      await writeFile(changed, 'after\n')
      await utimes(changed, prior.atime, prior.mtime)
      await observed(root)
      const got = await window.close()
      expect(got.incomplete).toBe(false)
      expect(got.changes).toEqual([{ path: `changed-${i}.txt`, changeType: 'modified' }])
    }
  })

  test('连续删除不同文件时不丢失事件，收尾屏障正常完成', async () => {
    const root = await gitRepo()
    const paths = Array.from({ length: 12 }, (_, i) => `delete-${i}.txt`)
    await Promise.all(paths.map((path) => writeFile(join(root, path), 'x\n')))
    const window = openChangeWindow(root)
    await settle()
    for (const path of paths) rmSync(join(root, path))
    const got = await window.close()

    expect(got.incomplete).toBe(false)
    expect(got.changes.map((change) => change.path).sort()).toEqual(paths.sort())
    expect(got.changes.every((change) => change.changeType === 'deleted')).toBe(true)
  })

  test('新建 / 修改 / 删除分别判定类型；临时文件与噪音目录不进入结果', async () => {
    const root = await gitRepo()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'old.ts'), 'a\n')
    await writeFile(join(root, 'gone.txt'), 'x\n')
    // 使「创建时间早于窗口」成立：文件系统的时间戳精度以毫秒计。
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'src', 'new.ts'), 'b\n')
    await writeFile(join(root, 'src', 'old.ts'), 'a\nb\n')
    await rm(join(root, 'gone.txt'))
    await writeFile(join(root, 'tmp.swp'), 't')
    await observed(root)
    await rm(join(root, 'tmp.swp'))
    // 新建的二进制文件不计算行数
    await writeFile(join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]))
    await settle()
    const got = await window.close()

    const byPath = typeOf(got.changes)
    expect(byPath.get('src/new.ts')).toBe('created')
    expect(byPath.get('src/old.ts')).toBe('modified')
    expect(byPath.get('gone.txt')).toBe('deleted')
    expect(byPath.has('tmp.swp')).toBe(false)
    expect(got.incomplete).toBe(false)
    // 新建的文本文件按内容计算行数，计算方式与文件工具相同（'b\n' 分割为两段）；修改与删除的文件无法取得旧内容，不带行数
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
   * 原始失败形状：文件时间戳按文件系统时钟的刻度取值，比 `Date.now()` 落后至多一个刻度
   * （Linux 按 HZ 为 1–10 ms）。起点取 `Date.now()` 时，打开后同一刻度内新建的文件
   * 创建时间早于起点，被判定为 modified。
   *
   * 断言不依赖事件：macOS 的事件流在 `watch()` 返回之后才开始投递，紧接打开操作的写入可能没有事件，
   * a.txt 由收尾扫描按 mtime 取得。收尾前短暂等待，是为了使屏障标记在事件流开始之后写入。
   */
  test('窗口打开后立即新建的文件判为 created', async () => {
    const root = await gitRepo()
    const window = openChangeWindow(root)
    await writeFile(join(root, 'a.txt'), 'a\n')
    await settle()
    const got = await window.close()

    expect(got.changes).toEqual([
      { path: 'a.txt', changeType: 'created', additions: 2, deletions: 0 },
    ])
    expect(got.incomplete).toBe(false)
  })

  /**
   * 反方向：打开前同一刻度内写入的文件不属于本窗口，本窗口修改它时判定为 modified。
   * 连续两条命令之间只间隔几毫秒，把起点前移以抵消刻度会使上一条命令的文件在此处重复报告或判定为 created。
   *
   * 两条断言都不依赖事件：打开前的写入早于 watcher，三个平台都不投递；kept.txt 由收尾扫描的
   * 时间下界排除，edited.txt 由收尾扫描按 mtime 取得。打开后先短暂等待再修改，是为了使修改与屏障标记
   * 都发生在 macOS 的事件流开始之后。
   */
  test('窗口打开前刚写入的文件不进入结果，打开后修改它则判为 modified', async () => {
    const root = await gitRepo()
    await writeFile(join(root, 'kept.txt'), 'k\n')
    await writeFile(join(root, 'edited.txt'), 'e\n')
    const window = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'edited.txt'), 'e\ne\n')
    const got = await window.close()

    expect(got.changes).toEqual([{ path: 'edited.txt', changeType: 'modified' }])
    expect(got.incomplete).toBe(false)
  })

  /**
   * 原始失败形状：`.github/workflows`、`.gitignore`、`.editorconfig` 与用户自建的点目录
   * 都是项目文件，按点前缀排除会将它们一并丢弃。是否忽略只由 Git 裁决。
   */
  test('项目的点路径进入结果，被忽略的产物与 .tmp 不进入', async () => {
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
    // 浏览器 profile 由项目自身的忽略规则排除，不依赖点前缀；.tmp 是本项目的临时产物目录。
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
   * 已跟踪的文件即使命中忽略模式也必须报告：`git check-ignore` 默认查询索引，
   * 已跟踪的路径不在其输出中，此处不另写一层跟踪判断。
   */
  test('tracked-but-ignored 仍报告；同一目录中未跟踪的文件不报告', async () => {
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
    // 目录被剪枝时才查询索引，且只查询一次。
    expect(gitProcessCount.lsFiles - before.lsFiles).toBe(1)
    expect(got.incomplete).toBe(false)
  })

  /**
   * 索引中仍有记录、磁盘上已不存在的文件不报告 deleted。
   *
   * 它无法归属任何窗口：被剪枝目录中没有事件可依据，而索引残留在每次收尾时都会被取回，
   * 报告后每条命令都会向账本写入一条虚假删除，直到用户执行 `git rm`。
   */
  test('被剪枝目录中的索引残留不报告 deleted', async () => {
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

  /** 索引中没有任何记录的运行产物目录：查询索引不返回任何文件，目录本身不进入收尾扫描。 */
  test('运行产物目录中未跟踪的文件不报告，收尾扫描不进入该目录', async () => {
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
    // 改名之前观察器必须已 stat 过临时文件，否则它会被判定为 deleted。
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
   * `-z` 使路径原样传递。换成默认的按行分隔格式时，非 ASCII 路径会被 git 加引号并转义为
   * 八进制，返回的字符串与候选不一致，被忽略的文件反而会被报告。
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

  /** 忽略判定是收尾时的一次批量调用，不随 fs 事件触发；没有被剪枝目录时不查询索引。 */
  test('一个窗口内的多次 fs 事件只启动一次 check-ignore，不启动 ls-files', async () => {
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
   * Git 判定执行失败时不丢弃任何候选，并报告观察范围不完整：
   * 静默按零改动结束时，一次未执行完的过滤与一次确无改动无法区分。
   */
  test('Git 判定失败时标记观察范围不完整且不丢弃候选', async () => {
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

  /** 非 Git 目录没有忽略规则可依据，只排除运行产物目录，点路径照常报告。 */
  test('非 Git 目录按运行产物目录排除，不启动 git 进程', async () => {
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
   * 整个目录被删除时，递归 watch 只为目录产生一条事件（Windows 实测），收尾扫描又无法发现
   * 已不存在的文件，因此更深一层的文件只能通过核对本轮已报告路径才能报告。
   */
  test('整个目录被删除：按本轮已报告路径核对，其中的文件报告为删除', async () => {
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

    // 三个文件都报告删除，三个目录本身都不报告。
    expect(got.changes.map((c) => [c.path, c.changeType]).sort()).toEqual([
      ['d/a.txt', 'deleted'],
      ['d/sub/b.txt', 'deleted'],
      ['d/sub/c.txt', 'deleted'],
    ])
    expect(got.incomplete).toBe(false)
  })

  /**
   * 不传入已报告路径时只剩事件与扫描两个来源，目录中的文件只能由事件观察到。Windows 上整个目录
   * 被删除时，深层文件的删除事件多数不交付、少数交付，浅层文件的事件同样可能丢失。两种结果都正确，
   * **不要断言哪个文件能否被报告**；目录被删除时逐个报告其中的文件依赖已报告路径的核对，见上一条测试。
   */
  test('不传入已报告路径时，目录被删除只按收到的事件报告删除，不标记观察范围不完整', async () => {
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
   * 原始失败形状：收尾时删除事件仍在途。删除只能由事件观察到，收尾不等待在途事件全部交付时，
   * 最后几步中的删除不进入结果。macOS 的 FSEvents 每 50 ms 合批交付一次，在途时间最长。
   */
  test('删除后立即收尾，删除照常报告', async () => {
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

  /**
   * 收尾前发生、收尾时仍在途的事件属于正在收尾的窗口，不能归入排在后面的窗口。
   * 收尾之后的步骤使用新建，验证后一个窗口的路径归属。只断言路径：排队的窗口以前一个窗口收尾时的 `Date.now()` 为起点，
   * 此后一个时间戳刻度内新建的文件判定为 modified。
   */
  test('两个窗口同时打开时，前一个窗口收尾时在途的事件仍归属该窗口', async () => {
    const root = await gitRepo()
    await writeFile(join(root, 'a.txt'), 'a\n')
    await Bun.sleep(20)

    const first = openChangeWindow(root)
    const second = openChangeWindow(root)
    await settle()
    await rm(join(root, 'a.txt'))
    const firstChanges = await first.close()
    await writeFile(join(root, 'b.txt'), 'b\n')
    const secondChanges = await second.close()

    expect(firstChanges.changes).toEqual([{ path: 'a.txt', changeType: 'deleted' }])
    expect(secondChanges.changes.map((c) => c.path)).toEqual(['b.txt'])
  })

  /** 标记无法写入时无法确认事件已全部交付，结果标记为观察范围不完整，扫描得到的改动照常报告。 */
  test('屏障标记无法写入时标记观察范围不完整', async () => {
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

  /**
   * 原始失败形状：macOS 的 FSEvents 按真实路径报告事件，watch 符号链接路径时收不到任何事件，
   * 删除无法报告，收尾的屏障等待到上限、结果判定为不完整。Windows 上使用目录联接，创建它不需要特权。
   */
  test('经符号链接打开的工作区照常收到事件，路径相对调用方传入的根', async () => {
    const real = await gitRepo()
    await writeFile(join(real, 'gone.txt'), 'x\n')
    const root = `${real}-link`
    await symlink(real, root, 'junction')
    await Bun.sleep(20)

    const window = openChangeWindow(root)
    await settle()
    await rm(join(root, 'gone.txt'))
    await writeFile(join(root, 'kept.txt'), 'k\n')
    const got = await window.close()

    expect(typeOf(got.changes)).toEqual(
      new Map([
        ['gone.txt', 'deleted'],
        ['kept.txt', 'created'],
      ]),
    )
    expect(got.incomplete).toBe(false)
  })

  /**
   * 同一目录的两种写法共用一个 watcher，窗口仍然排队；各打开一个 watcher 时，后一个窗口会收入前一个窗口的删除。
   * 前一个窗口用删除作断言：删除只能由事件观察到，与收尾扫描的时间边界无关。
   * 收尾之后的步骤使用新建、只断言路径，理由见「前一个窗口收尾时在途的事件仍归属该窗口」。
   */
  test('同一个目录经两种写法打开时共用一个 watcher', async () => {
    const real = await gitRepo()
    await writeFile(join(real, 'a.txt'), 'a\n')
    const link = `${real}-link`
    await symlink(real, link, 'junction')
    await Bun.sleep(20)

    const first = openChangeWindow(real)
    const second = openChangeWindow(link)
    await settle()
    await rm(join(real, 'a.txt'))
    const firstChanges = await first.close()
    await writeFile(join(link, 'b.txt'), 'b\n')
    const secondChanges = await second.close()

    expect(firstChanges.changes).toEqual([{ path: 'a.txt', changeType: 'deleted' }])
    expect(secondChanges.changes.map((c) => c.path)).toEqual(['b.txt'])
  })

  test('两个窗口同时打开时，事件归属最早打开的窗口', async () => {
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
