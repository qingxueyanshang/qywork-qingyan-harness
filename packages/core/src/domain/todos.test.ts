/**
 * 待办进度的计数规则。覆盖 `domain/model.ts` 中的 `todoProgress`。
 *
 * 该函数由工具回执与输入框状态条共用。放在 core 而不是各自实现，
 * 是为了避免「工具卡显示（0/5）、状态条显示第 1 / 5 步」这种同一时刻两个数字矛盾的
 * 情况。因此本文件锁定「第几步」的计数方式。
 */

import { describe, expect, test } from 'bun:test'
import { type TodoItem, todoProgress } from './model.ts'

const list = (...statuses: TodoItem['status'][]): TodoItem[] =>
  statuses.map((status, i) => ({ id: `todo_${i + 1}`, content: `第 ${i + 1} 条`, status }))

describe('第几步', () => {
  /** 进行中的第 3 步若显示为「第 2 步」，界面会显示为停滞在上一步。 */
  test('取进行中的条目，不取已完成数', () => {
    const p = todoProgress(list('completed', 'completed', 'in_progress', 'pending'))
    expect(p.step).toBe(3)
    expect(p.done).toBe(2)
    expect(p.current?.content).toBe('第 3 条')
  })

  /** 清单刚创建、第一条正在进行：此时「完成了 0 条」属实，但用户不需要这一信息。 */
  test('第一条进行中时为第 1 步，不是第 0 步', () => {
    expect(todoProgress(list('in_progress', 'pending', 'pending')).step).toBe(1)
  })

  /** 刚勾选完成、尚未认领下一条时回落到已完成数：此时没有进行中的条目。 */
  test('没有进行中的条目时回落到已完成数', () => {
    const p = todoProgress(list('completed', 'pending', 'pending'))
    expect(p.step).toBe(1)
    expect(p.current).toBeNull()
  })

  test('全部完成时步数等于总数', () => {
    const p = todoProgress(list('completed', 'completed'))
    expect(p.step).toBe(2)
    expect(p.total).toBe(2)
    expect(p.current).toBeNull()
  })

  test('空清单不抛错', () => {
    expect(todoProgress([])).toEqual({ step: 0, total: 0, done: 0, current: null })
  })
})
