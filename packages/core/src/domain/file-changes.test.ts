/**
 * 一轮写入的净效果。覆盖 `domain/model.ts` 里的 `foldFileChanges`。
 *
 * 这个函数是**变更页的行与表头合计共用的那一份**（界面折行、服务端折合计）。
 * 放在 core 而不是各折各的，就是为了避免「行里没有、表头还算着」这种
 * 同一时刻两个数打架的形状。所以这里锁的是四条折叠规则本身。
 */

import { describe, expect, test } from 'bun:test'
import { type FileChange, foldFileChanges } from './model.ts'

const shape = (changes: FileChange[]) =>
  foldFileChanges(changes).map((f) => [f.path, f.changeType, f.additions, f.deletions, f.counted])

describe('一轮写入折成净效果', () => {
  test('建了又删的整行丢掉：它对工作区没有净效果', () => {
    expect(
      shape([
        { path: 'cache/a.bin', changeType: 'created', additions: 3, deletions: 0 },
        { path: 'cache/a.bin', changeType: 'modified' },
        { path: 'cache/a.bin', changeType: 'deleted' },
        { path: 'keep.ts', changeType: 'created', additions: 2, deletions: 0 },
      ]),
    ).toEqual([['keep.ts', 'created', 2, 0, true]])
  })

  test('改过之后被删的留着，判成已删除：那是用户原有的文件没了', () => {
    expect(
      shape([
        { path: 'notes.md', changeType: 'modified', additions: 2, deletions: 1 },
        { path: 'notes.md', changeType: 'deleted' },
      ]),
    ).toEqual([['notes.md', 'deleted', 2, 1, true]])
  })

  test('建了再改仍是新建，删掉又重建的也是新建', () => {
    expect(
      shape([
        { path: 'a.ts', changeType: 'created', additions: 1, deletions: 0 },
        { path: 'a.ts', changeType: 'modified', additions: 4, deletions: 2 },
        { path: 'b.ts', changeType: 'modified', additions: 1, deletions: 0 },
        { path: 'b.ts', changeType: 'deleted' },
        { path: 'b.ts', changeType: 'created', additions: 5, deletions: 0 },
      ]),
    ).toEqual([
      // 顺序是第一次被改到的先后，不排字典序。
      ['a.ts', 'created', 5, 2, true],
      ['b.ts', 'created', 6, 0, true],
    ])
  })

  test('行数只加已知的，一次都没带的行不算已知', () => {
    expect(
      shape([
        { path: 'x.ts', changeType: 'modified' },
        { path: 'x.ts', changeType: 'modified', additions: 3, deletions: 1 },
        { path: 'y.ts', changeType: 'modified' },
      ]),
    ).toEqual([
      ['x.ts', 'modified', 3, 1, true],
      ['y.ts', 'modified', 0, 0, false],
    ])
  })
})
