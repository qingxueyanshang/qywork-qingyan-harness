import { describe, expect, test } from 'bun:test'
import {
  foldWorkflow,
  parseWorkflowCall,
  type WorkflowCallRecord,
  type WorkflowTransition,
  workflowGroupId,
} from './workflow.ts'

const outcome = (data: WorkflowTransition) => ({
  status: 'success' as const,
  executed: true,
  message: 'ok',
  data: data as unknown as Record<string, unknown>,
})

describe('workflow 调用判别', () => {
  test('strict wire 的 null 仍能判成首次派发', () => {
    const got = parseWorkflowCall({
      goal: '做完',
      nodes: [
        {
          id: 'a',
          kind: null,
          task: '先做',
          agent: null,
          needs: null,
          passInput: true,
          model: null,
        },
        {
          id: 'review',
          kind: 'checkpoint',
          label: '当前会话审查',
          needs: ['a'],
          agent: null,
          task: null,
          // OpenAI strict 参数补全实测可能给 checkpoint 填默认 true；该字段无语义。
          passInput: true,
          model: null,
        },
      ],
      workflowId: null,
      checkpointId: null,
      decision: null,
      note: null,
      revisions: null,
    })
    expect(got).toEqual({
      ok: true,
      call: {
        kind: 'start',
        goal: '做完',
        nodes: [
          { id: 'a', kind: 'agent', agent: 'ad-hoc', task: '先做' },
          { id: 'review', kind: 'checkpoint', label: '当前会话审查', needs: ['a'] },
        ],
      },
    })
  })

  test('approve 与 revise 的字段互斥', () => {
    expect(
      parseWorkflowCall({
        workflowId: 's1',
        checkpointId: 'cp',
        decision: 'approve',
        revisions: null,
        goal: null,
        nodes: null,
      }),
    ).toMatchObject({ ok: true, call: { kind: 'review', decision: 'approve' } })
    expect(
      parseWorkflowCall({
        workflowId: 's1',
        checkpointId: 'cp',
        decision: 'revise',
        revisions: [],
        goal: null,
        nodes: null,
      }),
    ).toEqual({ ok: false, error: 'revise 必须带至少一条 revisions' })
  })
})

describe('workflow 投影', () => {
  test('首轮回执、返工和批准只从转移序列折叠', () => {
    const records: WorkflowCallRecord[] = [
      {
        stepId: 'wf1',
        args: {
          goal: '做完',
          nodes: [
            { id: 'a', task: '做 A' },
            { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
            { id: 'b', task: '做 B', needs: ['cp'] },
          ],
        },
        status: 'success',
        outcome: outcome({
          workflowId: 'wf1',
          phase: 'waiting_review',
          checkpointId: 'cp',
          receipts: [
            {
              nodeId: 'a',
              agent: 'ad-hoc',
              label: 'A',
              status: 'done',
              output: '错',
              durationMs: 1,
            },
          ],
        }),
      },
      {
        stepId: 'wf2',
        args: {
          workflowId: 'wf1',
          checkpointId: 'cp',
          decision: 'revise',
          note: '改正',
          revisions: [{ nodeId: 'a', instruction: '改正' }],
        },
        status: 'success',
        outcome: outcome({
          workflowId: 'wf1',
          phase: 'waiting_review',
          checkpointId: 'cp',
          review: { checkpointId: 'cp', decision: 'revise', note: '改正' },
          receipts: [
            {
              nodeId: 'a',
              agent: 'ad-hoc',
              label: 'A',
              status: 'done',
              output: '对',
              durationMs: 1,
            },
          ],
        }),
      },
      {
        stepId: 'wf3',
        args: { workflowId: 'wf1', checkpointId: 'cp', decision: 'approve', note: '通过' },
        status: 'success',
        outcome: outcome({
          workflowId: 'wf1',
          phase: 'completed',
          review: { checkpointId: 'cp', decision: 'approve', note: '通过' },
          receipts: [
            {
              nodeId: 'b',
              agent: 'ad-hoc',
              label: 'B',
              status: 'done',
              output: '完成',
              durationMs: 1,
            },
          ],
        }),
      },
    ]
    const folded = foldWorkflow(records, 'wf1')
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.phase).toBe('completed')
    expect(folded.projection.results.a?.output).toBe('对')
    expect(folded.projection.attempts.a).toBe(2)
    expect(folded.projection.approvals.cp).toContain('通过')
    expect(folded.projection.approvals.cp).toContain('对')
  })

  test('运行中的续调立刻按 args.workflowId 归回首轮', () => {
    expect(workflowGroupId({ stepId: 'current', args: { workflowId: 'anchor' } })).toBe('anchor')
  })

  test('revise 刚开始就让选中节点和本批下游失效，不显示旧回执', () => {
    const records: WorkflowCallRecord[] = [
      {
        stepId: 'wf',
        args: {
          goal: '目标',
          nodes: [
            { id: 'a', task: '研究' },
            { id: 'b', task: '复核', needs: ['a'] },
            { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['b'] },
          ],
        },
        status: 'success',
        outcome: outcome({
          workflowId: 'wf',
          phase: 'waiting_review',
          checkpointId: 'cp',
          receipts: [
            {
              nodeId: 'a',
              agent: 'ad-hoc',
              label: 'A',
              status: 'done',
              output: '旧 A',
              durationMs: 1,
            },
            {
              nodeId: 'b',
              agent: 'ad-hoc',
              label: 'B',
              status: 'done',
              output: '旧 B',
              durationMs: 1,
            },
          ],
        }),
      },
      {
        stepId: 'review',
        args: {
          workflowId: 'wf',
          checkpointId: 'cp',
          decision: 'revise',
          note: '返工',
          revisions: [{ nodeId: 'a', instruction: '补证据' }],
        },
        status: 'running',
      },
    ]
    const folded = foldWorkflow(records, 'wf')
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.phase).toBe('running')
    expect(folded.projection.results.a).toBeUndefined()
    expect(folded.projection.results.b).toBeUndefined()
    expect(folded.projection.attempts).toEqual({ a: 1, b: 1 })
  })
})
