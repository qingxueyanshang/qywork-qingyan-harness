/**
 * 待办读回的行为回归。**覆盖范围**：`todos.ts`。
 *
 * 锁的是「跨 run 取到最后一次成功提交」这件事——它是动作词（创建 / 修改）
 * 唯一的判据，判错的表现是同一张卡片上动词和进度互相打架。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationId } from '@qywork/core'
import { Store } from './db.ts'
import { appendStep, createConversation, createRun, upsertWorkspace } from './repos.ts'
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
  })
}

/** 记一条 `write_todos` 的 step，形状与 loop 落库的那条一致。 */
function submit(
  store: Store,
  runId: string,
  seq: number,
  contents: string[],
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
      args: { todos: contents.map((content) => ({ content, status: 'pending' })) },
    } as never,
  })
}

describe('待办读回', () => {
  test('没提交过就是 null', () => {
    const { store, conversationId } = fresh()
    expect(latestTodos(store, conversationId)).toBeNull()
    store.close()
  })

  test('取最后一次成功提交 —— 整表语义下它就是全部事实', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    submit(store, run.id, 1, ['旧的甲', '旧的乙'])
    submit(store, run.id, 5, ['新的甲'])
    expect(latestTodos(store, conversationId)?.map((t) => t.content)).toEqual(['新的甲'])
    store.close()
  })

  /** 一轮做三条、下一轮接着做第四条是常态，所以必须跨 run 取。 */
  test('跨 run 延续 —— 上一轮提交的这一轮也读得到', () => {
    const { store, ws, conversationId } = fresh()
    const first = newRun(store, conversationId, ws.id, 'r1')
    submit(store, first.id, 1, ['上一轮列的'])
    newRun(store, conversationId, ws.id, 'r2')
    expect(latestTodos(store, conversationId)?.[0]?.content).toBe('上一轮列的')
    store.close()
  })

  /** 被拒的提交前端不显示，这里也不能算数——否则动作词按一份没被接受的清单判。 */
  test('失败的提交不算 —— 读回的是上一份成功的', () => {
    const { store, ws, conversationId } = fresh()
    const run = newRun(store, conversationId, ws.id, 'r1')
    submit(store, run.id, 1, ['好清单'])
    submit(store, run.id, 2, ['两条 in_progress 被拒的'], 'failure')
    expect(latestTodos(store, conversationId)?.[0]?.content).toBe('好清单')
    store.close()
  })

  /** 别的会话的清单不能串进来。 */
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

  /** 读不回来的旧 payload 只该让动作词退回「创建」，不该让工具调用炸掉。 */
  test('payload 坏了就当没有，不抛', () => {
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
