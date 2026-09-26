/**
 * 覆盖 `files.ts`：`listTree` / `createEntry` / `renameEntry` / `deleteEntry` /
 * `findByName` / `classify` / `preview` / `openRaw`；以及 `api/workspace-fs.ts` 的路径解析
 * 与原始字节接口。
 *
 * 锁这几件事：**树里一条都不少**（依赖树、构建产物、点开头的条目全列——藏一条
 * 在界面上就等于它不存在）、**新建与改名都不覆盖**、**删不存在的要抛**（不静默成功）、
 * **搜索跳噪音目录**（与树口径不同，是有意的）、分类的回落口径、预览只读上限以内的字节，
 * 以及接口按字面值解析路径、删除软链只删目录项本身。
 */

import { describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleWorkspaceFsApi } from './api/workspace-fs.ts'
import {
  classify,
  createEntry,
  deleteEntry,
  EntryExistsError,
  findByName,
  listTree,
  preview,
  renameEntry,
} from './files.ts'

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

/** 树的入口参数：工作区根的绝对路径与它的显示路径。 */
async function root(): Promise<[string, string]> {
  return [await workspace(), '']
}

describe('文件树', () => {
  /**
   * 一条都不过滤：依赖树、构建产物、`.git`、点开头的配置全在。
   *
   * 模型侧的 `list_dir` / `glob` / `grep` 仍按 `IGNORED_DIRS` 跳噪音目录，那是
   * token 预算；界面这棵树是用户核对磁盘内容的地方，藏一条在界面上就等于它
   * 不存在。不一致的方向只允许是界面看得多。
   */
  test('磁盘上有的全进树', async () => {
    const names = (await listTree(...(await root()), 2)).map((n) => n.name)
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
    const nodes = await listTree(...(await root()), 2)
    expect(nodes[0]?.kind).toBe('dir')
    expect(nodes.find((n) => n.name === 'src')?.children?.map((c) => c.name)).toEqual(['main.ts'])
  })

  /** depth 到底就不再展开——不是展开成空数组，那会让界面画一个假的空目录。 */
  test('depth=1 时目录没有 children 字段', async () => {
    const nodes = await listTree(...(await root()), 1)
    expect(nodes.find((n) => n.name === 'src')?.children).toBeUndefined()
  })
})

describe('新建', () => {
  test('文件建出来是空的，中间目录一并建', async () => {
    const dir = await workspace()
    const node = await createEntry(join(dir, 'docs/notes/a.md'), 'docs/notes/a.md', 'file')
    expect(node).toMatchObject({ name: 'a.md', path: 'docs/notes/a.md', kind: 'file', size: 0 })
    expect(await readFile(join(dir, 'docs/notes/a.md'), 'utf8')).toBe('')
  })

  test('目录建出来能再往里建', async () => {
    const dir = await workspace()
    expect((await createEntry(join(dir, 'pkg'), 'pkg', 'dir')).kind).toBe('dir')
    expect((await createEntry(join(dir, 'pkg/x.ts'), 'pkg/x.ts', 'file')).path).toBe('pkg/x.ts')
  })

  /** 覆盖是不可撤销的，所以「已存在」必须是个错，不能静默成功。 */
  test('重名一律报错，文件和目录都不覆盖', async () => {
    const dir = await workspace()
    expect(createEntry(join(dir, 'a.ts'), 'a.ts', 'file')).rejects.toThrow(EntryExistsError)
    expect(createEntry(join(dir, 'src'), 'src', 'dir')).rejects.toThrow(EntryExistsError)
    // 原内容没被动过
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })
})

describe('改名与删除', () => {
  test('改名只换名字，路径留在原来那一层', async () => {
    const dir = await workspace()
    const node = await renameEntry(join(dir, 'src/main.ts'), 'src/main.ts', 'entry.ts')
    expect(node).toMatchObject({ name: 'entry.ts', path: 'src/entry.ts', kind: 'file' })
    expect(await readFile(join(dir, 'src/entry.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  test('改成一个已经存在的名字要报错，不覆盖', async () => {
    const dir = await workspace()
    await createEntry(join(dir, 'src/entry.ts'), 'src/entry.ts', 'file')
    expect(renameEntry(join(dir, 'src/main.ts'), 'src/main.ts', 'entry.ts')).rejects.toThrow(
      EntryExistsError,
    )
    expect(await readFile(join(dir, 'src/main.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  test('删目录连里面一起删；删不存在的要抛，不静默', async () => {
    const dir = await workspace()
    await deleteEntry(join(dir, 'src'))
    expect((await listTree(dir, '', 1)).map((n) => n.name)).not.toContain('src')
    expect(deleteEntry(join(dir, 'src'))).rejects.toThrow()
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
    // 最多是一屏乱码，当二进制则是「能读却不给看」。
    expect(classify('x.qwerty')).toEqual({ kind: 'text', mime: 'text/plain' })
  })
})

describe('预览', () => {
  /** 超过上限时只读上限以内的字节；截断标记按文件大小判。 */
  test('大文本只回前 512 KiB，并标记截断', async () => {
    const dir = await workspace()
    const line = `${'x'.repeat(1023)}\n`
    await writeFile(join(dir, 'big.log'), line.repeat(1024))
    const out = await preview(join(dir, 'big.log'), 'big.log')
    expect(out.size).toBe(1024 * 1024)
    expect(out.truncated).toBe(true)
    expect(out.content).toBe(line.repeat(512))
  })

  test('上限以内原样返回，不标截断', async () => {
    const dir = await workspace()
    const out = await preview(join(dir, 'a.ts'), 'a.ts')
    expect(out).toMatchObject({ content: 'export const a = 1\n', truncated: false })
  })

  /**
   * 原始失败形状：PDF 以 data URI 内联，打包版 CSP 的 `frame-src` 不放行 `data:`，iframe 空白；
   * 超过 4 MB 的 PDF、图片、视频都只给一句「超出内联上限」。现在都不内联、不设上限，字节由 `/api/files/raw` 给。
   */
  test('PDF、图片与视频不内联、不受内联上限约束，带修改时间', async () => {
    const dir = await workspace()
    for (const [name, kind] of [
      ['big.pdf', 'pdf'],
      ['big.png', 'image'],
      ['big.mp4', 'video'],
    ] as const) {
      const abs = join(dir, name)
      await writeFile(abs, `x${'x'.repeat(5 * 1024 * 1024)}`)
      const out = await preview(abs, name)
      expect(out).toMatchObject({ kind, mtime: (await stat(abs)).mtimeMs, truncated: false })
      expect('dataUri' in out).toBe(false)
      expect(out.note).toBeUndefined()
    }
  })
})

describe('文件接口的路径解析', () => {
  async function call(dir: string, path: string, body?: Record<string, unknown>) {
    const url = new URL(
      body ? `http://x${path}` : `http://x/api/files/preview?path=${encodeURIComponent(path)}`,
    )
    const req = body
      ? new Request(url.href, { method: 'POST', body: JSON.stringify(body) })
      : new Request(url.href)
    const res = await handleWorkspaceFsApi(url, req, { workspaceRoot: dir } as never)
    return res as Response
  }

  /**
   * 文件名里的 `%20` / `%41` 是字面字符。查询参数已由 `URLSearchParams` 解码过一次，
   * 再按转义解一次会去找另一个文件：前者找不到，后者校验一个文件、读取另一个。
   */
  test('文件名含百分号转义时按字面值预览、改名、删除', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'report%20v2.md'), 'only this one')
    await writeFile(join(dir, 'a%41.txt'), 'literal')
    await writeFile(join(dir, 'aA.txt'), 'decoded twin')

    expect(await (await call(dir, 'report%20v2.md')).json()).toMatchObject({
      content: 'only this one',
    })
    expect(await (await call(dir, 'a%41.txt')).json()).toMatchObject({ content: 'literal' })

    const renamed = await call(dir, '/api/files/rename', { path: 'a%41.txt', name: 'b%42.txt' })
    expect(renamed.status).toBe(200)
    expect(await readFile(join(dir, 'b%42.txt'), 'utf8')).toBe('literal')
    expect(await readFile(join(dir, 'aA.txt'), 'utf8')).toBe('decoded twin')

    expect((await call(dir, '/api/files/delete', { path: 'report%20v2.md' })).status).toBe(200)
    expect(await stat(join(dir, 'report%20v2.md')).catch(() => null)).toBeNull()
  })

  /** 删除的是目录项本身：删软链不能删掉它指向的目录。 */
  test('删除指向工作区内目录的软链，只删软链', async () => {
    const dir = await workspace()
    try {
      await symlink(join(dir, 'src'), join(dir, 'src-link'), 'junction')
    } catch {
      return // 无权限建链接时跳过
    }
    expect((await call(dir, '/api/files/delete', { path: 'src-link' })).status).toBe(200)
    expect(await lstat(join(dir, 'src-link')).catch(() => null)).toBeNull()
    expect(await readFile(join(dir, 'src', 'main.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  /** 同一个地址在文件改写后是另一份内容，浏览器缓存会让预览停在旧版本上。 */
  test('原始字节按类型回、不许缓存；目录回 404', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'x.pdf'), '%PDF-1.4 x')
    const get = async (path: string) => {
      const url = new URL(`http://x/api/files/raw?path=${encodeURIComponent(path)}`)
      return (await handleWorkspaceFsApi(url, new Request(url.href), {
        workspaceRoot: dir,
      } as never)) as Response
    }
    const res = await get('x.pdf')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('%PDF-1.4 x')
    expect((await get('src')).status).toBe(404)
  })
})
