/**
 * 覆盖 `files.ts` 的 `listTree` 与 `classify`。
 *
 * 这个文件之前没有任何测试——界面文件树、预览分类全靠肉眼。这里只补两条：
 * **噪音目录三方一致**（它和 `tools` 的 `list_dir`/`glob` 现在共用
 * `@qywork/tools` 的 `IGNORED_DIRS`，共用之前已经漂到 13/12/11 条），
 * 以及分类的回落口径。预览的字节截断另说，不在这次改动范围内。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, listTree } from './files.ts'

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-tree-'))
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'main.ts'), 'export const b = 2\n', 'utf8')
  for (const noisy of ['coverage', 'node_modules', 'dist']) {
    await mkdir(join(dir, noisy), { recursive: true })
    await writeFile(join(dir, noisy, 'x.ts'), '// 产物\n', 'utf8')
  }
  return dir
}

describe('文件树', () => {
  test('噪音目录不进树，真实目录进', async () => {
    const nodes = await listTree(await workspace(), '', 2)
    const names = nodes.map((n) => n.name)
    expect(names).toContain('src')
    expect(names).toContain('a.ts')
    for (const noisy of ['coverage', 'node_modules', 'dist']) {
      expect(names).not.toContain(noisy)
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
