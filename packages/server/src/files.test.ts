/**
 * 覆盖 `files.ts`：`listTree` / `createEntry` / `renameEntry` / `deleteEntry` /
 * `findByName` / `classify` / `preview` / `openRaw`；以及 `api/workspace-fs.ts` 的路径解析
 * 与原始字节接口。
 *
 * 锁定以下行为：文件树不遗漏任何条目（依赖树、构建产物、以点开头的条目全部列出，
 * 界面隐藏某个条目即等同于该条目不存在）、新建与改名均不覆盖、删除不存在的条目必须抛出
 * （不静默成功）、搜索跳过噪音目录（与文件树的规则不同，属于有意设计）、分类的回退规则、
 * 预览只读取上限以内的字节，以及接口按字面值解析路径、删除软链接只删除目录项本身。
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

/** 文件树的入口参数：工作区根的绝对路径与其显示路径。 */
async function root(): Promise<[string, string]> {
  return [await workspace(), '']
}

describe('文件树', () => {
  /**
   * 不过滤任何条目：依赖树、构建产物、`.git`、以点开头的配置全部保留。
   *
   * 模型侧的 `list_dir` / `glob` / `grep` 仍按 `IGNORED_DIRS` 跳过噪音目录，该规则出于
   * token 预算；界面文件树是用户核对磁盘内容的位置，隐藏某个条目即等同于该条目不存在。
   * 两侧不一致时，只允许界面显示得更多。
   */
  test('磁盘上存在的条目全部进入文件树', async () => {
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

  /** 达到 depth 后不再展开，也不展开为空数组：空数组会使界面渲染出一个虚假的空目录。 */
  test('depth=1 时目录没有 children 字段', async () => {
    const nodes = await listTree(...(await root()), 1)
    expect(nodes.find((n) => n.name === 'src')?.children).toBeUndefined()
  })
})

describe('新建', () => {
  test('新建的文件为空，中间目录一并创建', async () => {
    const dir = await workspace()
    const node = await createEntry(join(dir, 'docs/notes/a.md'), 'docs/notes/a.md', 'file')
    expect(node).toMatchObject({ name: 'a.md', path: 'docs/notes/a.md', kind: 'file', size: 0 })
    expect(await readFile(join(dir, 'docs/notes/a.md'), 'utf8')).toBe('')
  })

  test('新建的目录中可以继续新建条目', async () => {
    const dir = await workspace()
    expect((await createEntry(join(dir, 'pkg'), 'pkg', 'dir')).kind).toBe('dir')
    expect((await createEntry(join(dir, 'pkg/x.ts'), 'pkg/x.ts', 'file')).path).toBe('pkg/x.ts')
  })

  /** 覆盖不可撤销，因此「已存在」必须报错，不能静默成功。 */
  test('重名一律报错，文件和目录都不覆盖', async () => {
    const dir = await workspace()
    expect(createEntry(join(dir, 'a.ts'), 'a.ts', 'file')).rejects.toThrow(EntryExistsError)
    expect(createEntry(join(dir, 'src'), 'src', 'dir')).rejects.toThrow(EntryExistsError)
    // 原内容未被改动
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })
})

describe('改名与删除', () => {
  test('改名只更改名称，路径仍在原目录层级', async () => {
    const dir = await workspace()
    const node = await renameEntry(join(dir, 'src/main.ts'), 'src/main.ts', 'entry.ts')
    expect(node).toMatchObject({ name: 'entry.ts', path: 'src/entry.ts', kind: 'file' })
    expect(await readFile(join(dir, 'src/entry.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  test('改为已存在的名称时报错，不覆盖', async () => {
    const dir = await workspace()
    await createEntry(join(dir, 'src/entry.ts'), 'src/entry.ts', 'file')
    expect(renameEntry(join(dir, 'src/main.ts'), 'src/main.ts', 'entry.ts')).rejects.toThrow(
      EntryExistsError,
    )
    expect(await readFile(join(dir, 'src/main.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  test('删除目录时一并删除其内容；删除不存在的条目必须抛出，不静默成功', async () => {
    const dir = await workspace()
    await deleteEntry(join(dir, 'src'))
    expect((await listTree(dir, '', 1)).map((n) => n.name)).not.toContain('src')
    expect(deleteEntry(join(dir, 'src'))).rejects.toThrow()
  })
})

describe('按名称搜索', () => {
  test('子串匹配、不区分大小写，目录也计为命中', async () => {
    const dir = await workspace()
    const { matches } = await findByName(dir, 'MAIN')
    expect(matches.map((m) => m.path)).toContain('src/main.ts')
    expect((await findByName(dir, 'src')).matches).toContainEqual({ path: 'src', kind: 'dir' })
  })

  /**
   * 搜索跳过噪音目录，文件树不跳过，两处规则不同属于有意设计：文件树不过滤，第一层即有
   * `node_modules`，搜索若也遍历其中，遍历预算会在依赖树中耗尽，用户无法取得任何命中。
   * 该边界必须在界面上说明。
   */
  test('不进入噪音目录，但目录本身可被搜索到', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'node_modules', 'main-helper.ts'), '// 依赖\n', 'utf8')
    const paths = (await findByName(dir, 'main')).matches.map((m) => m.path)
    expect(paths).toContain('src/main.ts')
    expect(paths).not.toContain('node_modules/main-helper.ts')
  })

  test('空查询返回空结果，不返回整棵树', async () => {
    expect(await findByName(await workspace(), '')).toEqual({ matches: [], truncated: false })
  })

  test('提供筛选时只返回其接受的文件、不返回目录；空查询列出其接受的全部文件，有查询时两个条件都须满足', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'src', 'cover.png'), 'png')
    const images = (p: string) => p.endsWith('.png') || p === 'src'
    expect((await findByName(dir, '', undefined, images)).matches).toEqual([
      { path: 'src/cover.png', kind: 'file' },
    ])
    expect((await findByName(dir, 'main', undefined, images)).matches).toEqual([])
  })

  test('接口传入 kinds 时按画布文件类别列出，查询允许为空；类别不合法时返回 422', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'generated'), { recursive: true })
    await writeFile(join(dir, 'generated', 'a.mp4'), 'mp4')
    await writeFile(join(dir, 'generated', 'b.png'), 'png')
    await writeFile(join(dir, 'notes.md'), '# 笔记')
    const find = async (query: string) => {
      const url = new URL(`http://x/api/files/find?${query}`)
      return (await handleWorkspaceFsApi(url, new Request(url.href), {
        workspaceRoot: dir,
      } as never)) as Response
    }
    const paths = async (query: string) =>
      ((await (await find(query)).json()) as { matches: { path: string }[] }).matches.map(
        (m) => m.path,
      )
    expect(await paths('kinds=video')).toEqual(['generated/a.mp4'])
    expect((await paths('kinds=image,video,text')).sort()).toEqual([
      'generated/a.mp4',
      'generated/b.png',
      'notes.md',
    ])
    expect(await paths('q=b&kinds=image,video')).toEqual(['generated/b.png'])
    expect(await paths('q=')).toEqual([])
    expect((await find('kinds=video,exe')).status).toBe(422)
  })
})

describe('预览分类', () => {
  test('已识别的扩展名给出种类与语言，未识别的回退为 text', () => {
    expect(classify('a/b.ts')).toEqual({ kind: 'text', mime: 'text/plain', language: 'typescript' })
    expect(classify('x.png').kind).toBe('image')
    expect(classify('x.pdf').kind).toBe('pdf')
    // 回退为 text 而不是 binary：扩展名无法穷举，未知扩展名按文本读取时最多显示乱码，
    // 按二进制处理则会使可读取的内容无法显示。
    expect(classify('x.qwerty')).toEqual({ kind: 'text', mime: 'text/plain' })
  })
})

describe('预览', () => {
  /** 超过上限时只读取上限以内的字节；截断标记按文件大小判定。 */
  test('大文本只返回前 512 KiB，并标记截断', async () => {
    const dir = await workspace()
    const line = `${'x'.repeat(1023)}\n`
    await writeFile(join(dir, 'big.log'), line.repeat(1024))
    const out = await preview(join(dir, 'big.log'), 'big.log')
    expect(out.size).toBe(1024 * 1024)
    expect(out.truncated).toBe(true)
    expect(out.content).toBe(line.repeat(512))
  })

  test('上限以内原样返回，不标记截断', async () => {
    const dir = await workspace()
    const out = await preview(join(dir, 'a.ts'), 'a.ts')
    expect(out).toMatchObject({ content: 'export const a = 1\n', truncated: false })
  })

  /**
   * 原始失败形状：PDF 以 data URI 内联，打包版 CSP 的 `frame-src` 不允许 `data:`，iframe 显示空白；
   * 超过 4 MB 的 PDF、图片、视频都只显示「超出内联上限」。三类文件均不内联、不设上限，
   * 字节由 `/api/files/raw` 提供。
   */
  test('PDF、图片与视频不内联、不受内联上限约束，并返回修改时间', async () => {
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
   * 文件名中的 `%20` / `%41` 是字面字符。查询参数已由 `URLSearchParams` 解码一次，
   * 再按转义解码一次会指向另一个文件：前者导致未找到文件，后者导致校验一个文件、读取另一个文件。
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

  /** 删除的是目录项本身：删除软链接不能删除其指向的目录。 */
  test('删除指向工作区内目录的软链接时，只删除软链接本身', async () => {
    const dir = await workspace()
    try {
      await symlink(join(dir, 'src'), join(dir, 'src-link'), 'junction')
    } catch {
      return // 无权限创建链接时跳过
    }
    expect((await call(dir, '/api/files/delete', { path: 'src-link' })).status).toBe(200)
    expect(await lstat(join(dir, 'src-link')).catch(() => null)).toBeNull()
    expect(await readFile(join(dir, 'src', 'main.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  /** 文件改写后同一地址对应另一份内容，浏览器缓存会使预览停留在旧版本。 */
  test('原始字节按类型返回、禁止缓存；目录返回 404', async () => {
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
