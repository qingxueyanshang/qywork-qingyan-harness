/**
 * 待办进度口径。覆盖 `domain/model.ts` 里的 `todoProgress`。
 *
 * 这个函数是**工具回执与输入框状态条共用的那一份**。放在 core 而不是各写各的，
 * 就是为了避免「工具卡说（0/5）、状态条说第 1 / 5 步」这种同一时刻两个数的 bug
 * ——它已经真的发生过一次。所以这里锁的是「第几步」怎么数。
 */

import { describe, expect, test } from 'bun:test'
import { type TodoItem, todoProgress } from './model.ts'

const list = (...statuses: TodoItem['status'][]): TodoItem[] =>
  statuses.map((status, i) => ({ id: `todo_${i + 1}`, content: `第 ${i + 1} 条`, status }))

describe('第几步', () => {
  /** 进行中的第 3 步报成「第 2 步」会让人以为它卡住了。 */
  test('取正在做的那一条，不是已完成数', () => {
    const p = todoProgress(list('completed', 'completed', 'in_progress', 'pending'))
    expect(p.step).toBe(3)
    expect(p.done).toBe(2)
    expect(p.current?.content).toBe('第 3 条')
  })

  /** 刚列完清单、第一条就在做：这时候「做完了 0 条」是真的，但没人想读这句。 */
  test('第一条在做就是第 1 步，不是第 0 步', () => {
    expect(todoProgress(list('in_progress', 'pending', 'pending')).step).toBe(1)
  })

  /** 打完勾还没认领下一条，回落到已完成数——此时没有「正在做的那一条」。 */
  test('没有进行中的那条时回落到已完成数', () => {
    const p = todoProgress(list('completed', 'pending', 'pending'))
    expect(p.step).toBe(1)
    expect(p.current).toBeNull()
  })

  test('全做完 —— 步数等于总数', () => {
    const p = todoProgress(list('completed', 'completed'))
    expect(p.step).toBe(2)
    expect(p.total).toBe(2)
    expect(p.current).toBeNull()
  })

  test('空清单不炸', () => {
    expect(todoProgress([])).toEqual({ step: 0, total: 0, done: 0, current: null })
  })
})
