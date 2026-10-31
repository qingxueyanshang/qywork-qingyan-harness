/**
 * 覆盖 `TodoList.tsx`：五种状态各有标记，受阻条目在名称下方显示受阻类别与所需条件，失败条目显示原因与尝试。
 *
 * DOM 在本文件内注册、用后注销，使用动态 import 的理由同 `settings/LoadState.test.tsx`。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { TodoItem } from '@qywork/core'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mount(todos: TodoItem[]) {
  const { render } = await import('solid-js/web')
  const { TodoList } = await import('./TodoList.tsx')
  const host = document.createElement('div')
  const dispose = render(() => <TodoList todos={todos} />, host as unknown as HTMLElement)
  return { host, dispose }
}

describe('待办清单', () => {
  /** 受阻原因是本轮停下等待用户的依据，只显示状态而不显示原因时，用户无从得知需要做什么。 */
  test('受阻条目带受阻标记，并在名称下方显示受阻类别与所需条件', async () => {
    const { host, dispose } = await mount([
      { id: 'todo_1', content: '生成样张', status: 'completed' },
      {
        id: 'todo_2',
        content: '生成其余 17 页',
        status: 'blocked',
        blocker: 'review',
        need: '用户查看样张并认可风格',
      },
      { id: 'todo_3', content: '合成 PPT', status: 'pending' },
    ])
    const rows = host.querySelectorAll('.todo-item')
    expect(rows).toHaveLength(3)
    expect(rows[1]!.classList.contains('blocked')).toBe(true)
    expect(rows[1]!.querySelector('.todo-need')?.textContent).toBe(
      '等待用户查看：用户查看样张并认可风格',
    )
    expect(rows[0]!.querySelector('.todo-need')).toBeNull()
    expect(rows[2]!.querySelector('.todo-need')).toBeNull()
    expect(rows[2]!.querySelector('.todo-dot')).not.toBeNull()
    dispose()
  })

  test('失败条目带失败标记，并在名称下方显示失败原因与做过的尝试', async () => {
    const { host, dispose } = await mount([
      {
        id: 'todo_1',
        content: '生成第 4 页',
        status: 'failed',
        cause: 'HTTP 429 限流',
        attempts: '系统在 30 秒、2 分钟、5 分钟后各重试一次',
      },
    ])
    const row = host.querySelector('.todo-item')!
    expect(row.classList.contains('failed')).toBe(true)
    expect(row.querySelector('.todo-need')?.textContent).toBe(
      '失败：HTTP 429 限流，已尝试：系统在 30 秒、2 分钟、5 分钟后各重试一次',
    )
    dispose()
  })
})
