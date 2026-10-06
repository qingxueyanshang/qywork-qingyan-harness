/**
 * 一轮写入的净效果。覆盖 `domain/model.ts` 中的 `foldFileChanges`。
 *
 * 该函数由**变更页的各行与表头合计共用**（界面折叠各行、服务端计算合计）。
 * 放在 core 而不是各自实现，是为了避免「行中已没有、表头仍计入」这种
 * 同一时刻两个数不一致的情况。因此这里验证的是四条折叠规则本身。
 */

import { describe, expect, test } from 'bun:test'
import { type FileChange, foldFileChanges } from './model.ts'

const shape = (changes: FileChange[]) =>
  foldFileChanges(changes).map((f) => [f.path, f.changeType, f.additions, f.deletions, f.counted])

describe('一轮写入折叠为净效果', () => {
  test('创建后又删除的行被丢弃：它对工作区没有净效果', () => {
    expect(
      shape([
        { path: 'cache/a.bin', changeType: 'created', additions: 3, deletions: 0 },
        { path: 'cache/a.bin', changeType: 'modified' },
        { path: 'cache/a.bin', changeType: 'deleted' },
        { path: 'keep.ts', changeType: 'created', additions: 2, deletions: 0 },
      ]),
    ).toEqual([['keep.ts', 'created', 2, 0, true]])
  })

  test('修改后被删除的行保留，判定为已删除：用户原有的文件已不存在', () => {
    expect(
      shape([
        { path: 'notes.md', changeType: 'modified', additions: 2, deletions: 1 },
        { path: 'notes.md', changeType: 'deleted' },
      ]),
    ).toEqual([['notes.md', 'deleted', 2, 1, true]])
  })

  test('创建后再修改仍为新建，删除后又重建的同样为新建', () => {
    expect(
      shape([
        { path: 'a.ts', changeType: 'created', additions: 1, deletions: 0 },
        { path: 'a.ts', changeType: 'modified', additions: 4, deletions: 2 },
        { path: 'b.ts', changeType: 'modified', additions: 1, deletions: 0 },
        { path: 'b.ts', changeType: 'deleted' },
        { path: 'b.ts', changeType: 'created', additions: 5, deletions: 0 },
      ]),
    ).toEqual([
      // 顺序按首次被修改的先后排列，不按字典序。
      ['a.ts', 'created', 5, 2, true],
      ['b.ts', 'created', 6, 0, true],
    ])
  })

  test('行数只累加已知值，从未带行数的条目不计为已知', () => {
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
