import { describe, expect, test } from 'bun:test'
import { Store } from './db.ts'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  findRunByClientRequest,
  finishRun,
  listConversations,
  listMessages,
  listSteps,
  settleToolStep,
  upsertWorkspace,
} from './repos.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  return { store, ws }
}

describe('会话列表排序', () => {
  /**
   * 回归用例：同一毫秒创建的多个会话，updated_at 全相等。
   * 只按 updated_at DESC 排序时 SQLite 退回插入顺序，列表看起来完全是反的
   * ——实测在种子数据上撞到过。
   */
  test('updated_at 并列时仍按创建倒序', () => {
    const { store, ws } = fresh()
    const titles = ['第一个', '第二个', '第三个', '第四个']
    for (const title of titles) {
      createConversation(store, { workspaceId: ws.id, model: 'm', title })
    }
    const listed = listConversations(store, ws.id).map((c) => c.title)
    expect(listed).toEqual([...titles].reverse())
    store.close()
  })

  test('机器会话不进列表', () => {
    const { store, ws } = fresh()
    createConversation(store, { workspaceId: ws.id, model: 'm', title: '用户的' })
    createConversation(store, {
      workspaceId: ws.id,
      model: 'm',
      title: '子代理的',
      source: 'team',
    })
    expect(listConversations(store, ws.id).map((c) => c.title)).toEqual(['用户的'])
    store.close()
  })
})

describe('run 幂等', () => {
  test('同一 clientRequestId 只对应一个 run', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const key = 'req-1'
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: key,
      userMessageId: null,
      messageIdUpperBound: null,
    })
    expect(findRunByClientRequest(store, conv.id, key)?.id).toBe(run.id)
    // 重复创建必须被唯一索引挡下，而不是静默起第二个 run。
    expect(() =>
      createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: key,
        userMessageId: null,
        messageIdUpperBound: null,
      }),
    ).toThrow()
    store.close()
  })
})

describe('消息高水位', () => {
  /**
   * run 创建后、拿到执行锁前，用户可能又发了消息。那些消息不属于本 run 的历史，
   * 放进去等于让模型看到「未来」。
   */
  test('upperBound 之后的消息不进历史', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const m1 = appendMessage(store, { conversationId: conv.id, role: 'user', content: '第一条' })
    const m2 = appendMessage(store, { conversationId: conv.id, role: 'user', content: '第二条' })
    appendMessage(store, { conversationId: conv.id, role: 'user', content: '排队期间发的' })

    const scoped = listMessages(store, conv.id, m2.id).map((m) => m.content)
    expect(scoped).toEqual(['第一条', '第二条'])
    expect(listMessages(store, conv.id, m1.id).map((m) => m.content)).toEqual(['第一条'])
    store.close()
  })
})

describe('工具 step 原地更新', () => {
  test('一次调用只有一行，从 running 更新到终态', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: 'c1',
      status: 'running',
      payload: { kind: 'tool_call', args: { path: 'a.ts' } },
    })

    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args: { path: 'a.ts' },
      outcome: { status: 'success', executed: true, message: 'ok' },
    })

    const steps = listSteps(store, run.id)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.status).toBe('success')
    expect(steps[0]?.payload?.kind).toBe('tool_result')
    store.close()
  })
})

describe('run 收尾', () => {
  test('stopReason 必须落库，不存在静默完成', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
    })
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
    const found = findRunByClientRequest(store, conv.id, 'r')
    expect(found?.status).toBe('done')
    expect(found?.stopReason).toBe('completed')
    expect(found?.finishedAt).toBeGreaterThan(0)
    store.close()
  })

  test('cachedTokens 为 null 表示未回报，不被压成 0', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
    })
    const found = findRunByClientRequest(store, conv.id, 'r')
    expect(found?.usage.cachedTokens).toBeNull()
    expect(run.usage.cachedTokens).toBeNull()
    store.close()
  })
})
