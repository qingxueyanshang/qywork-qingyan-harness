import { describe, expect, test } from 'bun:test'
import { Store } from './db.ts'
import {
  appendStep,
  createConversation,
  createRun,
  finishRun,
  getConversation,
  getRun,
  listSteps,
  markRunRunning,
  markRunSuperseded,
  markStepExecuting,
  recoverStaleRuns,
  setConversationModel,
  upsertWorkspace,
} from './repos.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, { workspaceId: ws.id, model: 'claude-opus-5', title: 't' })
  return { store, ws, conv }
}

function newRun(store: Store, ws: { id: string }, conv: { id: string }) {
  return createRun(store, {
    conversationId: conv.id as never,
    workspaceId: ws.id as never,
    model: 'claude-opus-5',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
  })
}

describe('会话级模型切换', () => {
  test('写入后 getConversation 读到新模型', () => {
    const { store, conv } = fresh()
    const updated = setConversationModel(store, conv.id, 'deepseek-v4-pro')
    expect(updated?.model).toBe('deepseek-v4-pro')
    expect(getConversation(store, conv.id)?.model).toBe('deepseek-v4-pro')
    store.close()
  })

  test('会话不存在时返回 null，不静默成功', () => {
    const { store } = fresh()
    expect(setConversationModel(store, 'conv_nope' as never, 'm')).toBeNull()
    store.close()
  })
})

describe('retry / supersede', () => {
  test('已终结的 run 可以被标记接替', () => {
    const { store, ws, conv } = fresh()
    const first = newRun(store, ws, conv)
    finishRun(store, first.id, { status: 'failed', stopReason: 'provider_error' })
    const second = newRun(store, ws, conv)

    expect(markRunSuperseded(store, first.id, second.id)).toBe(true)
    expect(getRun(store, first.id)?.supersededBy).toBe(second.id)
    store.close()
  })

  test('仍在跑的 run 不能被接替 —— 否则两个 run 同时写同一个工作区', () => {
    const { store, ws, conv } = fresh()
    const first = newRun(store, ws, conv)
    markRunRunning(store, first.id)
    const second = newRun(store, ws, conv)

    expect(markRunSuperseded(store, first.id, second.id)).toBe(false)
    expect(getRun(store, first.id)?.supersededBy).toBeNull()
    store.close()
  })

  test('被接替的 run 保留，不删除 —— 那些步骤真实发生过', () => {
    const { store, ws, conv } = fresh()
    const first = newRun(store, ws, conv)
    appendStep(store, { runId: first.id, seq: 1, kind: 'text', content: '写过的字' })
    finishRun(store, first.id, { status: 'failed', stopReason: 'provider_error' })
    const second = newRun(store, ws, conv)
    markRunSuperseded(store, first.id, second.id)

    expect(getRun(store, first.id)).not.toBeNull()
    expect(listSteps(store, first.id)).toHaveLength(1)
    store.close()
  })
})

describe('崩溃恢复', () => {
  test('没进执行器的 run 判为可安全重来', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    // 有 step，但从没调用 markStepExecuting —— 确定没进执行器。
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      status: 'running',
    })

    const result = recoverStaleRuns(store)
    expect(result.recovered).toBe(1)
    expect(result.ambiguous).toBe(0)

    const after = getRun(store, run.id)!
    expect(after.status).toBe('interrupted')
    expect(after.stopReason).toBe('user_interrupt')
    store.close()
  })

  test('进了执行器却没落终态的 run 判为结果不可信', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      status: 'running',
    })
    markStepExecuting(store, step.id)

    const result = recoverStaleRuns(store)
    expect(result.ambiguous).toBe(1)

    const after = getRun(store, run.id)!
    expect(after.stopReason).toBe('internal_guard')
    // 两种情况的 stopReason 必须不同：统一了就分不出「进程崩了」和「用户点了停止」。
    expect(after.stopReason).not.toBe('user_interrupt')
    store.close()
  })

  test('卡在 running 的 step 一并落终态 —— 否则 UI 留一张永远转圈的卡', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      status: 'running',
    })
    markStepExecuting(store, step.id)

    recoverStaleRuns(store)

    const settled = listSteps(store, run.id)[0]!
    expect(settled.status).toBe('failure')
    // executed 取保守值 true：无法判定时不能向模型断言「没有副作用」。
    expect((settled.payload as Record<string, any>).outcome.executed).toBe(true)
    store.close()
  })

  test('已终结的 run 不受影响', () => {
    const { store, ws, conv } = fresh()
    const done = newRun(store, ws, conv)
    finishRun(store, done.id, { status: 'done', stopReason: 'completed' })

    expect(recoverStaleRuns(store).recovered).toBe(0)
    expect(getRun(store, done.id)?.stopReason).toBe('completed')
    store.close()
  })

  test('干净启动时是零成本的 no-op', () => {
    const { store } = fresh()
    expect(recoverStaleRuns(store)).toEqual({ recovered: 0, ambiguous: 0 })
    store.close()
  })
})
