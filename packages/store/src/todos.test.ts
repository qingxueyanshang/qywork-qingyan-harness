/**
 * 待办读取的行为回归。**覆盖范围**：`todos.ts`。
 *
 * 锁定「父会话整表提交是唯一完成权威」这一账本投影：子任务回执可供验收，
 * 但不能代替父会话标记完成。工具、提示词与历史接口不得各自推测。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationId } from '@qywork/core'
import { Store } from './db.ts'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  upsertWorkspace,
} from './repos.ts'
import { latestTodos } from './todos.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    title: 't',
  })
  return { store, ws, conversationId: conv.id as ConversationId }
}

function newRun(store: Store, conversationId: ConversationId, workspaceId: string, key: string) {
  return createRun(store, {
    conversationId,
    workspaceId: workspaceId as never,
    model: 'm',
    clientRequestId: key,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
}

/** 记录一条 `write_todos` 的 step，结构与 loop 写入数据库的 step 一致。 */
function submit(
  store: Store,
  runId: string,
  seq: number,
  contents: string[],
  status: 'success' | 'failure' = 'success',
) {
  submitItems(
    store,
    runId,
    seq,
    contents.map((content) => ({ content, status: 'pending' as const })),
    status,
  )
}

function submitItems(
  store: Store,
  runId: string,
  seq: number,
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>,
  status: 'success' | 'failure' = 'success',
) {
  appendStep(store, {
    runId: runId as never,
    seq,
    kind: 'tool_action',
    toolName: 'write_todos',
    status,
    payload: {
      kind: 'tool_result',
      args: { todos },
    } as never,
  })
}

function delegate(
  store: Store,
  runId: string,
  seq: number,
  parentTodo: string | null,
  status: 'success' | 'failure' = 'success',
) {
  appendStep(store, {
    runId: runId as never,
    seq,
    kind: 'tool_action',
    toolName: 'subagent',
    status,
    payload: {
      kind: 'tool_result',
      args: { task: '交给子 agent', ...(parentTodo ? { parentTodo } : {}) },
    } as never,
  })
}

describe('待办读取', () => {
  test('从未提交时返回 null', () => {
    const { store, conversationId } = fresh()
    expect(latestTodos(store, conversationId)).toBeNull()
    store.close()
  })

  test('取最后一次成功提交：整表语义下它即全部事实', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    submit(store, run.id, 1, ['旧的甲', '旧的乙'])
    submit(store, run.id, 5, ['新的甲'])
    expect(latestTodos(store, conversationId)?.map((t) => t.content)).toEqual(['新的甲'])
    store.close()
  })

  /** 一轮完成三项、下一轮继续第四项是常见情况，因此必须跨 run 读取。 */
  test('跨 run 延续：本轮可读取上一轮的提交', () => {
    const { store, ws, conversationId } = fresh()
    const first = newRun(store, conversationId, ws.id, 'r1')
    submit(store, first.id, 1, ['上一轮列的'])
    newRun(store, conversationId, ws.id, 'r2')
    expect(latestTodos(store, conversationId)?.[0]?.content).toBe('上一轮列的')
    store.close()
  })

  test('续接执行只读取本轮成功提交，历史展示仍读取跨轮清单', () => {
    const { store, ws, conversationId } = fresh()
    const first = newRun(store, conversationId, ws.id, 'r1')
    submit(store, first.id, 1, ['旧任务'])
    const second = newRun(store, conversationId, ws.id, 'r2')
    expect(latestTodos(store, conversationId)?.[0]?.content).toBe('旧任务')
    expect(latestTodos(store, conversationId, second.id)).toBeNull()
    submit(store, second.id, 1, ['失败提交'], 'failure')
    expect(latestTodos(store, conversationId, second.id)).toBeNull()
    submitItems(store, second.id, 2, [{ content: '接续旧任务', status: 'in_progress' }])
    expect(latestTodos(store, conversationId, second.id)?.[0]?.status).toBe('in_progress')
    expect(latestTodos(store, conversationId)?.[0]?.content).toBe('接续旧任务')
    store.close()
  })

  test('子任务与工作流回执仍接续父任务，用户追问不继承续接执行权', () => {
    const { store, ws, conversationId } = fresh()
    const first = newRun(store, conversationId, ws.id, 'parent')
    submitItems(store, first.id, 1, [{ content: '父任务待验收', status: 'in_progress' }])
    for (const origin of ['subagent', 'workflow', undefined] as const) {
      const message = appendMessage(store, {
        conversationId,
        role: 'user',
        content: '回执或用户追问',
        ...(origin ? { origin } : {}),
      })
      const run = createRun(store, {
        conversationId,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: origin ?? 'user',
        userMessageId: message.id,
        messageIdUpperBound: message.id,
        contextSnapshot: [],
      })
      if (origin) {
        expect(latestTodos(store, conversationId, run.id)?.[0]?.status).toBe('in_progress')
      } else {
        expect(latestTodos(store, conversationId, run.id)).toBeNull()
      }
    }
    store.close()
  })

  /** 被拒绝的提交前端不显示，此处也不计入：否则动作词会依据一份未被接受的清单判定。 */
  test('失败的提交不计入：读取的是上一份成功提交', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    submit(store, run.id, 1, ['好清单'])
    submit(store, run.id, 2, ['两条 in_progress 被拒的'], 'failure')
    expect(latestTodos(store, conversationId)?.[0]?.content).toBe('好清单')
    store.close()
  })

  test('成功子任务只交回待验收回执，不替父会话完成待办', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    submitItems(store, run.id, 1, [
      { content: '第一批', status: 'in_progress' },
      { content: '第二批', status: 'pending' },
      { content: '收尾', status: 'pending' },
    ])
    delegate(store, run.id, 2, '第一批')

    expect(latestTodos(store, conversationId)?.map((t) => [t.content, t.status])).toEqual([
      ['第一批', 'in_progress'],
      ['第二批', 'pending'],
      ['收尾', 'pending'],
    ])
    store.close()
  })

  test('并行的部分成功与失败都不取代父会话的验收权', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    submit(store, run.id, 1, ['第一批', '第二批', '收尾'])
    delegate(store, run.id, 2, '第一批')
    delegate(store, run.id, 3, '第二批', 'failure')

    expect(latestTodos(store, conversationId)?.map((t) => [t.content, t.status])).toEqual([
      ['第一批', 'pending'],
      ['第二批', 'pending'],
      ['收尾', 'pending'],
    ])
    store.close()
  })

  test('失败、未绑定和无法匹配的子任务都不修改父清单', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    submit(store, run.id, 1, ['保留进行中'])
    delegate(store, run.id, 2, '保留进行中', 'failure')
    delegate(store, run.id, 3, null)
    delegate(store, run.id, 4, '别的条目')

    expect(latestTodos(store, conversationId)?.map((t) => [t.content, t.status])).toEqual([
      ['保留进行中', 'pending'],
    ])
    store.close()
  })

  test('子任务返回之后只有父会话的新整表能完成或重新打开条目', () => {
    const { store, ws, conversationId } = fresh()
    const first = newRun(store, conversationId, ws.id, 'r1')
    submit(store, first.id, 1, ['旧任务'])
    delegate(store, first.id, 2, '旧任务')
    const second = newRun(store, conversationId, ws.id, 'r2')
    submitItems(store, second.id, 1, [
      { content: '旧任务', status: 'in_progress' },
      { content: '按验收意见返工', status: 'pending' },
    ])

    expect(latestTodos(store, conversationId)?.map((t) => [t.content, t.status])).toEqual([
      ['旧任务', 'in_progress'],
      ['按验收意见返工', 'pending'],
    ])
    store.close()
  })

  /** 其他会话的清单不得混入。 */
  test('按会话隔离', () => {
    const { store, ws, conversationId } = fresh()
    const other = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: 'x',
    })
    const run = newRun(store, other.id as ConversationId, ws.id, 'r-other')
    submit(store, run.id, 1, ['别人的'])
    expect(latestTodos(store, conversationId)).toBeNull()
    store.close()
  })

  /** 无法解析的旧 payload 只应使动作词回退为「创建」，不应使工具调用抛错。 */
  test('payload 无法解析时按不存在处理，不抛错', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_todos',
      status: 'success',
      payload: { kind: 'tool_result' } as never,
    })
    expect(latestTodos(store, conversationId)).toBeNull()
    store.close()
  })
})
