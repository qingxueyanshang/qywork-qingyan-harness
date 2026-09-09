/**
 * 覆盖 `workspace-watch.ts`：执行窗口内的路径归集与收尾判型。
 */
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openChangeWindow } from './workspace-watch.ts'

async function settle(): Promise<void> {
  await Bun.sleep(250)
}

describe('执行窗口内的工作区变更', () => {
  test('新建 / 修改 / 删除各判其类；临时文件与噪音目录不进结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-watch-'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
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
    await settle()
    await rm(join(root, 'tmp.swp'))
    await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'noise')
    await settle()
    const changes = await window.close()

    const byPath = new Map(changes.map((c) => [c.path, c.changeType]))
    expect(byPath.get('src/new.ts')).toBe('created')
    expect(byPath.get('src/old.ts')).toBe('modified')
    expect(byPath.get('gone.txt')).toBe('deleted')
    expect(byPath.has('tmp.swp')).toBe(false)
    expect([...byPath.keys()].some((p) => p.startsWith('node_modules'))).toBe(false)
    // 行数不可知：不带 additions / deletions
    expect(changes.every((c) => c.additions === undefined && c.deletions === undefined)).toBe(true)
  })

  test('两个窗口同时开着时，事件归最早打开的那个', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-watch-'))
    const first = openChangeWindow(root)
    const second = openChangeWindow(root)
    await settle()
    await writeFile(join(root, 'a.txt'), '1')
    await settle()
    const firstChanges = await first.close()
    await writeFile(join(root, 'b.txt'), '2')
    await settle()
    const secondChanges = await second.close()

    expect(firstChanges.map((c) => c.path)).toEqual(['a.txt'])
    expect(secondChanges.map((c) => c.path)).toEqual(['b.txt'])
  })
})
