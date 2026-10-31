/**
 * 待办进度的计数规则与受阻、失败条目的说明。覆盖 `domain/model.ts` 中的 `todoProgress` 与 `todoReason`。
 *
 * 该函数由工具回执与输入框状态条共用。放在 core 而不是各自实现，
 * 是为了避免「工具卡显示（0/5）、状态条显示第 1 / 5 步」这种同一时刻两个数字矛盾的
 * 情况。因此本文件锁定「第几步」的计数方式。
 */

import { describe, expect, test } from 'bun:test'
import { type TodoItem, type TodoStatus, todoProgress, todoReason } from './model.ts'

const list = (...statuses: TodoStatus[]): TodoItem[] =>
  statuses.map((status, i) => {
    const base = { id: `todo_${i + 1}`, content: `第 ${i + 1} 条` }
    if (status === 'blocked') return { ...base, status, blocker: 'review', need: '用户查看样张' }
    if (status === 'failed')
      return { ...base, status, cause: 'HTTP 429 限流', attempts: '重试 3 次' }
    return { ...base, status }
  })

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
    expect(todoProgress([])).toEqual({
      step: 0,
      total: 0,
      done: 0,
      blocked: 0,
      failed: 0,
      current: null,
    })
  })

  /** 受阻与失败的条目都没有完成，计入已完成数时状态条会把未完成的清单显示为接近完成。 */
  test('受阻与失败的条目分别计数，不计入已完成数', () => {
    const p = todoProgress(list('completed', 'blocked', 'blocked', 'failed'))
    expect(p.done).toBe(1)
    expect(p.blocked).toBe(2)
    expect(p.failed).toBe(1)
    expect(p.current).toBeNull()
  })
})

describe('受阻与失败的说明', () => {
  test('受阻写类别名称与所需条件，失败写原因与尝试，其余状态没有说明', () => {
    const [blocked, failed, pending] = list('blocked', 'failed', 'pending')
    expect(todoReason(blocked!)).toBe('等待用户查看：用户查看样张')
    expect(todoReason(failed!)).toBe('失败：HTTP 429 限流，已尝试：重试 3 次')
    expect(todoReason(pending!)).toBeNull()
  })
})
