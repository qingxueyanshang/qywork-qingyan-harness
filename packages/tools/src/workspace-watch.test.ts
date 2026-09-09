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
    // 点开头的是程序自己的状态与临时标记，不报。
    await mkdir(join(root, '.chk', 'prof'), { recursive: true })
    await writeFile(join(root, '.chk', 'prof', 'Local State'), 'x')
    await writeFile(join(root, '.tmp-verify'), '1')
    // 新建的二进制不数行
    await writeFile(join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]))
    await settle()
    const changes = await window.close()

    const byPath = new Map(changes.map((c) => [c.path, c.changeType]))
    expect(byPath.get('src/new.ts')).toBe('created')
    expect(byPath.get('src/old.ts')).toBe('modified')
    expect(byPath.get('gone.txt')).toBe('deleted')
    expect(byPath.has('tmp.swp')).toBe(false)
    expect([...byPath.keys()].some((p) => p.startsWith('node_modules'))).toBe(false)
    expect([...byPath.keys()].some((p) => p.startsWith('.'))).toBe(false)
    // 新建的文本按内容数行，口径同文件工具（'b\n' 切成两段）；改过的与删掉的拿不到旧内容，不带行数
    const byFull = new Map(changes.map((c) => [c.path, c]))
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
