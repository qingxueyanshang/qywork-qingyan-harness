/**
 * 覆盖 `files.ts` 的 `listTree` / `createEntry` / `findByName` / `classify`。
 *
 * 锁四件事：**树里一条都不少**（依赖树、构建产物、点开头的条目全列——藏一条
 * 用户就以为它不存在）、**新建不覆盖**、**搜索跳噪音目录**（与树口径不同，
 * 是有意的），以及分类的回落口径。预览的字节截断不在这里测。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, createEntry, EntryExistsError, findByName, listTree } from './files.ts'

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-tree-'))
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'main.ts'), 'export const b = 2\n', 'utf8')
  for (const noisy of ['coverage', 'node_modules', 'dist']) {
    await mkdir(join(dir, noisy), { recursive: true })
    await writeFile(join(dir, noisy, 'x.ts'), '// 产物\n', 'utf8')
  }
  await writeFile(join(dir, '.gitignore'), 'dist\n', 'utf8')
  await mkdir(join(dir, '.claude'), { recursive: true })
  await writeFile(join(dir, '.claude', 'settings.json'), '{}\n', 'utf8')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  return dir
}

describe('文件树', () => {
  /**
   * 一条都不过滤：依赖树、构建产物、`.git`、点开头的配置全在。
   *
   * 模型侧的 `list_dir` / `glob` / `grep` 仍按 `IGNORED_DIRS` 跳噪音目录，那是
   * token 预算；界面这棵树是用户核对「磁盘上到底有什么」的地方，藏一条他就以为
   * 它不存在。不一致的方向只允许是界面看得多。
   */
  test('磁盘上有的全进树', async () => {
    const names = (await listTree(await workspace(), '', 2)).map((n) => n.name)
    for (const entry of [
      'src',
      'a.ts',
      'coverage',
      'node_modules',
      'dist',
      '.git',
      '.claude',
      '.gitignore',
    ]) {
      expect(names).toContain(entry)
    }
  })

  test('目录在前，子层按 depth 展开', async () => {
    const nodes = await listTree(await workspace(), '', 2)
    expect(nodes[0]?.kind).toBe('dir')
    expect(nodes.find((n) => n.name === 'src')?.children?.map((c) => c.name)).toEqual(['main.ts'])
  })

  /** depth 到底就不再展开——不是展开成空数组，那会让界面画一个假的空目录。 */
  test('depth=1 时目录没有 children 字段', async () => {
    const nodes = await listTree(await workspace(), '', 1)
    expect(nodes.find((n) => n.name === 'src')?.children).toBeUndefined()
  })
})

describe('新建', () => {
  test('文件建出来是空的，中间目录顺带建', async () => {
    const dir = await workspace()
    const node = await createEntry(dir, 'docs/notes/a.md', 'file')
    expect(node).toMatchObject({ name: 'a.md', path: 'docs/notes/a.md', kind: 'file', size: 0 })
    expect(await readFile(join(dir, 'docs/notes/a.md'), 'utf8')).toBe('')
  })

  test('目录建出来能再往里建', async () => {
    const dir = await workspace()
    expect((await createEntry(dir, 'pkg', 'dir')).kind).toBe('dir')
    expect((await createEntry(dir, 'pkg/x.ts', 'file')).path).toBe('pkg/x.ts')
  })

  /** 覆盖是不可撤销的，所以「已存在」必须是个错，不能静默成功。 */
  test('重名一律报错，文件和目录都不覆盖', async () => {
    const dir = await workspace()
    expect(createEntry(dir, 'a.ts', 'file')).rejects.toThrow(EntryExistsError)
    expect(createEntry(dir, 'src', 'dir')).rejects.toThrow(EntryExistsError)
    // 原内容没被动过
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })
})

describe('按名搜索', () => {
  test('子串匹配、大小写不敏感，目录也算命中', async () => {
    const dir = await workspace()
    const { matches } = await findByName(dir, 'MAIN')
    expect(matches.map((m) => m.path)).toContain('src/main.ts')
    expect((await findByName(dir, 'src')).matches).toContainEqual({ path: 'src', kind: 'dir' })
  })

  /**
   * 搜索跳噪音目录，文件树不跳——两处口径不同是有意的：树不过滤之后第一层就有
   * `node_modules`，搜索要是也铺进去，遍历预算会在依赖树里烧光，用户一个命中都
   * 拿不到。这条边界要在界面上说出来。
   */
  test('不进噪音目录，但目录本身能被搜到', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'node_modules', 'main-helper.ts'), '// 依赖\n', 'utf8')
    const paths = (await findByName(dir, 'main')).matches.map((m) => m.path)
    expect(paths).toContain('src/main.ts')
    expect(paths).not.toContain('node_modules/main-helper.ts')
  })

  test('空查询回空结果，不回整棵树', async () => {
    expect(await findByName(await workspace(), '')).toEqual({ matches: [], truncated: false })
  })
})

describe('预览分类', () => {
  test('认识的扩展名给出种类与语言，不认识的回落到 text', () => {
    expect(classify('a/b.ts')).toEqual({ kind: 'text', mime: 'text/plain', language: 'typescript' })
    expect(classify('x.png').kind).toBe('image')
    expect(classify('x.pdf').kind).toBe('pdf')
    // 回落是 text 而不是 binary：新扩展名永远追不完，把没见过的当文本读
    // 最多是一屏乱码，当二进制则是「明明能读却不给看」。
    expect(classify('x.qwerty')).toEqual({ kind: 'text', mime: 'text/plain' })
  })
})
