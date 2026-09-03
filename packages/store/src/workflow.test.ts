/**
 * 覆盖 `workflow.ts`：从父会话的 step 账本取回 workflow 调用记录，以及从记录里
 * 认出哪几条是首派。**这是 workflow 唯一的恢复权威**，没有第二份运行表。
 */
import { describe, expect, test } from 'bun:test'
import type { ConversationId } from '@qywork/core'
import { Store } from './db.ts'
import {
  appendStep,
  createConversation,
  createRun,
  settleToolStep,
  upsertWorkspace,
} from './repos.ts'
import { listWorkflowRecords, workflowIdsOf } from './workflow.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conversation = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
  })
  const run = createRun(store, {
    conversationId: conversation.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'req_1',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  return { store, conversation, run }
}

const START_ARGS = {
  goal: '两个候选',
  nodes: [
    { id: 'a', kind: 'temp', name: 'a', task: '做 A' },
    { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
  ],
}

describe('workflow 调用记录', () => {
  test('只取 workflow 工具的 step，并按传入的 stepId 排除当前那一步', () => {
    const { store, conversation, run } = fresh()
    const first = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_1',
      status: 'running',
      payload: { kind: 'tool_call', args: START_ARGS },
    })
    settleToolStep(store, first.id, 'success', {
      kind: 'tool_result',
      args: START_ARGS,
      outcome: { status: 'success', executed: true, message: '等待审查' },
    })
    appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: 'call_2',
      status: 'success',
      payload: { kind: 'tool_call', args: {} },
    })
    const current = appendStep(store, {
      runId: run.id,
      seq: 3,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_3',
      status: 'running',
      payload: {
        kind: 'tool_call',
        args: { workflowId: first.id, checkpointId: 'cp', decision: 'approve' },
      },
    })

    expect(listWorkflowRecords(store, conversation.id).map((r) => r.stepId)).toEqual([
      first.id,
      current.id,
    ])
    // 正在执行的那一步还没有结果，取进来等于把请求当成事实。
    expect(listWorkflowRecords(store, conversation.id, current.id).map((r) => r.stepId)).toEqual([
      first.id,
    ])
    expect(listWorkflowRecords(store, conversation.id)[0]?.status).toBe('success')
    store.close()
  })

  test('被打断的调用把节点子会话 id 一并带出', () => {
    const { store, conversation, run } = fresh()
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_1',
      status: 'running',
      payload: { kind: 'tool_call', args: START_ARGS },
    })
    settleToolStep(store, step.id, 'failure', {
      kind: 'tool_result',
      args: START_ARGS,
      children: { a: 'cv_a' as ConversationId },
      outcome: { status: 'failure', executed: true, message: '执行期间被中断，结果未知' },
    })
    expect(listWorkflowRecords(store, conversation.id)[0]).toMatchObject({
      status: 'failure',
      children: { a: 'cv_a' },
    })
    store.close()
  })

  test('首派认的是「参数能解析成首派」，不是「有没有 workflowId 这个键」', () => {
    const { store, conversation, run } = fresh()
    const first = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_1',
      status: 'running',
      // strict wire 会给非本分支的字段补 null；补了仍是首派。
      payload: {
        kind: 'tool_call',
        args: { ...START_ARGS, workflowId: null, checkpointId: null, decision: null },
      },
    })
    appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_2',
      status: 'running',
      payload: {
        kind: 'tool_call',
        args: { workflowId: first.id, checkpointId: 'cp', decision: 'revise' },
      },
    })

    expect(workflowIdsOf(listWorkflowRecords(store, conversation.id))).toEqual([first.id])
    store.close()
  })
})
