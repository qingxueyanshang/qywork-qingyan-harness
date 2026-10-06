/**
 * 覆盖 `workflow.ts`：从父会话的 step 账本取回 workflow 调用记录，以及从记录中
 * 识别首次派发。这些 step 是 workflow 唯一的恢复权威，没有第二份运行表。
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
import { latestSubagentPhases, listWorkflowRecords, workflowIdsOf } from './workflow.ts'

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

describe('子 agent 最后一次的节点状态', () => {
  test('按 step 顺序后者覆盖前者，键是子 agent 的会话 id', () => {
    const { store, conversation, run } = fresh()
    const step = (seq: number, toolName: 'workflow' | 'subagent', nodes: Record<string, unknown>) =>
      appendStep(store, {
        runId: run.id,
        seq,
        kind: 'tool_action',
        toolName,
        toolCallId: `c${seq}`,
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: {},
          nodes,
          outcome: { status: 'success', executed: true, message: '' },
        } as never,
      })
    step(1, 'workflow', { a: { phase: 'failed', label: 'a', subagentId: 'cv_a' } })
    step(2, 'workflow', { a: { phase: 'done', label: 'a', subagentId: 'cv_a' } })
    step(3, 'subagent', { child: { phase: 'working', label: 'b', subagentId: 'cv_b' } })
    expect([...latestSubagentPhases(store, conversation.id)]).toEqual([
      ['cv_a', 'done'],
      ['cv_b', 'working'],
    ])
    store.close()
  })
})

describe('workflow 调用记录', () => {
  test('只取 workflow 工具的 step，并按传入的 stepId 排除当前 step', () => {
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
    // 正在执行的 step 尚无结果，读取它等于将请求当作事实。
    expect(listWorkflowRecords(store, conversation.id, current.id).map((r) => r.stepId)).toEqual([
      first.id,
    ])
    expect(listWorkflowRecords(store, conversation.id)[0]?.status).toBe('success')
    store.close()
  })

  test('被中断的调用一并返回节点的子会话 id', () => {
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
      nodes: { a: { phase: 'interrupted', label: 'a', subagentId: 'cv_a' as ConversationId } },
      outcome: { status: 'failure', executed: true, message: '执行期间被中断，结果未知' },
    })
    expect(listWorkflowRecords(store, conversation.id)[0]).toMatchObject({
      status: 'failure',
      nodes: { a: { phase: 'interrupted', subagentId: 'cv_a' } },
    })
    store.close()
  })

  test('首次派发按参数能否解析为首次派发判定，而不是按是否存在 workflowId 键', () => {
    const { store, conversation, run } = fresh()
    const first = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'call_1',
      status: 'running',
      // strict wire 会为非本分支的字段补 null；补 null 后仍是首次派发。
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
