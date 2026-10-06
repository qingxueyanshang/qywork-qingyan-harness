import { describe, expect, test } from 'bun:test'
import type { NodeState } from './model.ts'
import {
  DEFAULT_MAX_CONCURRENT,
  foldWorkflow,
  parseWorkflowCall,
  type WorkflowCallRecord,
  type WorkflowTransition,
  workflowGroupId,
  workflowTransitionOf,
} from './workflow.ts'

const outcome = (data: WorkflowTransition) => ({
  status: 'success' as const,
  executed: true,
  message: 'ok',
  data: data as unknown as Record<string, unknown>,
})

describe('workflow 调用判别', () => {
  test('strict wire 的 null 仍判定为首次派发', () => {
    const got = parseWorkflowCall({
      goal: '做完',
      nodes: [
        {
          id: 'a',
          kind: 'temp',
          name: 'a',
          task: '先做',
          subagent: null,
          needs: null,
          passInput: true,
          provider: null,
          model: null,
        },
        {
          id: 'review',
          kind: 'checkpoint',
          label: '当前会话审查',
          needs: ['a'],
          name: null,
          task: null,
          // 实测 OpenAI strict 参数补全可能为 checkpoint 填入默认值 true；该字段对检查点没有含义。
          passInput: true,
          provider: null,
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
          { id: 'a', kind: 'subagent', target: { kind: 'temp', name: 'a' }, task: '先做' },
          { id: 'review', kind: 'checkpoint', label: '当前会话审查', needs: ['a'] },
        ],
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
      },
    })
  })

  test('兼容端把可空字段写为 "null" 时仍按首次派发解析', () => {
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: [
          {
            id: 'a',
            task: '先做',
            needs: '[]',
            kind: 'temp',
            name: 'a',
            role: 'null',
            subagent: 'null',
          },
        ],
        workflowId: 'null',
        checkpointId: 'null',
        decision: 'null',
        note: 'null',
        revisions: 'null',
      }),
    ).toEqual({
      ok: true,
      call: {
        kind: 'start',
        goal: '做完',
        nodes: [{ id: 'a', kind: 'subagent', target: { kind: 'temp', name: 'a' }, task: '先做' }],
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
      },
    })
  })

  test('strict 兼容端给非当前分支的结构字段补空数组时按省略处理', () => {
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: [{ id: 'a', kind: 'temp', name: 'a', task: '先做' }],
        workflowId: null,
        checkpointId: null,
        decision: null,
        revisions: [],
      }),
    ).toMatchObject({ ok: true, call: { kind: 'start' } })

    expect(
      parseWorkflowCall({
        goal: '',
        nodes: [],
        workflowId: 'wf',
        checkpointId: 'cp',
        decision: 'approve',
        revisions: [],
      }),
    ).toMatchObject({ ok: true, call: { kind: 'review', decision: 'approve' } })
  })

  test('兼容端把 nodes 与 revisions 再次 JSON 编码时只在结构化入口解码一层', () => {
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: JSON.stringify([
          { id: 'a', kind: 'temp', name: 'a', task: '先做' },
          { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
        ]),
        workflowId: '',
        checkpointId: '',
        decision: '',
        revisions: '',
      }),
    ).toMatchObject({ ok: true, call: { kind: 'start', nodes: [{ id: 'a' }, { id: 'cp' }] } })

    expect(
      parseWorkflowCall({
        workflowId: 'wf',
        checkpointId: 'cp',
        decision: 'revise',
        revisions: JSON.stringify([{ nodeId: 'a', instruction: '重做' }]),
        goal: 'null',
        nodes: 'null',
      }),
    ).toMatchObject({
      ok: true,
      call: { kind: 'review', decision: 'revise', revisions: [{ nodeId: 'a' }] },
    })
  })

  test('maxConcurrent 缺省时取默认值，正整数原样保留，非正整数被拒绝', () => {
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: [{ id: 'a', kind: 'temp', name: 'a', task: '先做' }],
      }),
    ).toMatchObject({
      ok: true,
      call: { maxConcurrent: DEFAULT_MAX_CONCURRENT },
    })
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: [{ id: 'a', kind: 'temp', name: 'a', task: '先做' }],
        maxConcurrent: 5,
      }),
    ).toMatchObject({ ok: true, call: { maxConcurrent: 5 } })
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: [{ id: 'a', kind: 'temp', name: 'a', task: '先做' }],
        maxConcurrent: 0,
      }),
    ).toEqual({ ok: false, error: 'maxConcurrent 必须是正整数' })
  })

  test('审查动作填写 maxConcurrent 时被拒绝，与 goal / nodes 规则相同', () => {
    expect(
      parseWorkflowCall({
        workflowId: 'wf',
        checkpointId: 'cp',
        decision: 'approve',
        maxConcurrent: 3,
      }),
    ).toEqual({ ok: false, error: '审查动作不能填写 maxConcurrent' })
  })

  test('损坏的结构字符串仍由原有校验拒绝', () => {
    expect(parseWorkflowCall({ goal: '做完', nodes: '[{"id":' })).toEqual({
      ok: false,
      error: '图中没有任何节点',
    })
  })

  test('agent 节点把 provider 与 model 分列保留，provider 不允许单独出现', () => {
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: [
          {
            id: 'a',
            kind: 'temp',
            name: 'a',
            task: '先做',
            provider: '官方/中转',
            model: 'anthropic/claude-opus-5',
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      call: {
        nodes: [{ provider: '官方/中转', model: 'anthropic/claude-opus-5' }],
      },
    })
    expect(
      parseWorkflowCall({
        goal: '做完',
        nodes: [{ id: 'a', kind: 'temp', name: 'a', task: '先做', provider: '官方' }],
      }),
    ).toEqual({ ok: false, error: '节点 a 指定 provider 时必须同时指定 model' })
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
    ).toEqual({ ok: false, error: 'revise 必须至少填写一条 revisions' })
  })
})

const cell = (input: {
  label: string
  phase?: NodeState['phase']
  output?: string
  error?: string
  subagentId?: string
}): NodeState => ({
  phase: input.phase ?? 'done',
  label: input.label,
  durationMs: 1,
  ...(input.output ? { output: input.output } : {}),
  ...(input.error ? { error: input.error } : {}),
  ...(input.subagentId ? { subagentId: input.subagentId as never } : {}),
})

describe('workflow 投影', () => {
  /** 回执只有一个来源：节点的终态。转移中只记录派发了哪些节点、批准了什么。 */
  test('回执由节点状态折叠得出，批准把上游产出固定写入 approvals', () => {
    const records: WorkflowCallRecord[] = [
      {
        stepId: 'wf1',
        args: {
          goal: '做完',
          nodes: [
            { id: 'a', kind: 'temp', name: 'a', task: '做 A' },
            { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
            { id: 'b', kind: 'temp', name: 'b', task: '做 B', needs: ['cp'] },
          ],
        },
        status: 'success',
        outcome: outcome({ workflowId: 'wf1', dispatched: ['a'] }),
        nodes: { a: cell({ label: 'A', output: '错' }) },
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
          dispatched: ['a'],
          review: { checkpointId: 'cp', decision: 'revise', note: '改正' },
        }),
        nodes: { a: cell({ label: 'A', output: '对' }) },
      },
      {
        stepId: 'wf3',
        args: { workflowId: 'wf1', checkpointId: 'cp', decision: 'approve', note: '通过' },
        status: 'success',
        outcome: outcome({
          workflowId: 'wf1',
          dispatched: ['b'],
          review: { checkpointId: 'cp', decision: 'approve', note: '通过' },
        }),
        nodes: { b: cell({ label: 'B', output: '完成' }) },
      },
    ]
    const folded = foldWorkflow(records, 'wf1')
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.phase).toBe('completed')
    expect(folded.projection.results.a?.output).toBe('对')
    expect(folded.projection.approvals.cp).toContain('通过')
    expect(folded.projection.approvals.cp).toContain('对')
  })

  /** 派生的 phase：上游全部为终态且未批准时，该检查点即当前待审查的检查点。 */
  test('上游全部终态、检查点未批准时投影为待审查', () => {
    const folded = foldWorkflow(
      [
        {
          stepId: 'wf',
          args: {
            goal: '目标',
            nodes: [
              { id: 'a', kind: 'temp', name: 'a', task: '做' },
              { id: 'b', kind: 'temp', name: 'b', task: '也做' },
              { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b'] },
            ],
          },
          status: 'success',
          outcome: outcome({ workflowId: 'wf', dispatched: ['a', 'b'] }),
          nodes: {
            a: cell({ label: 'a', output: '甲' }),
            b: cell({ label: 'b', phase: 'failed', error: '连不上' }),
          },
        },
      ],
      'wf',
    )
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.phase).toBe('waiting_review')
    expect(folded.projection.checkpointId).toBe('cp')
    expect(folded.projection.results.b).toMatchObject({ status: 'failed', error: '连不上' })
  })

  /** 仍有节点运行时不算到达检查点：该节点没有终态，因此没有回执。 */
  test('有节点仍在运行时投影为执行中', () => {
    const folded = foldWorkflow(
      [
        {
          stepId: 'wf',
          args: {
            goal: '目标',
            nodes: [
              { id: 'a', kind: 'temp', name: 'a', task: '做' },
              { id: 'b', kind: 'temp', name: 'b', task: '也做' },
              { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b'] },
            ],
          },
          status: 'success',
          outcome: outcome({ workflowId: 'wf', dispatched: ['a', 'b'] }),
          nodes: { a: cell({ label: 'a', output: '甲' }), b: { phase: 'working', label: 'b' } },
        },
      ],
      'wf',
    )
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.phase).toBe('running')
    expect(folded.projection.checkpointId).toBeUndefined()
    expect(folded.projection.results.b).toBeUndefined()
  })

  /**
   * 编排器与投影共用 `revisionClosure`，因此本测试锁定两侧的同一行为：批准之后 revise
   * 仍然有效，且该检查点的批准被撤销。若无法撤销，卡片上会显示「已通过」而服务端正在重新执行。
   */
  test('对已批准的检查点 revise：撤销批准、只作废选中节点', () => {
    const nodes = [
      { id: 'build-glm', kind: 'temp', name: 'build-glm', task: '做 glm 版' },
      { id: 'build-qwen', kind: 'temp', name: 'build-qwen', task: '做 qwen 版' },
      {
        id: 'audit-builds',
        kind: 'checkpoint',
        label: '主会话验收',
        needs: ['build-glm', 'build-qwen'],
      },
    ]
    const records: WorkflowCallRecord[] = [
      {
        stepId: 'wf',
        args: { goal: '四个模型各做一版', nodes },
        status: 'success',
        outcome: outcome({ workflowId: 'wf', dispatched: ['build-glm', 'build-qwen'] }),
        nodes: {
          'build-glm': cell({ label: 'build-glm', output: 'glm 初稿', subagentId: 'cv_glm' }),
          'build-qwen': cell({ label: 'build-qwen', output: 'qwen 初稿', subagentId: 'cv_qwen' }),
        },
      },
      {
        stepId: 'approve',
        args: {
          workflowId: 'wf',
          checkpointId: 'audit-builds',
          decision: 'approve',
          note: '均已产生代码，现批准',
        },
        status: 'success',
        outcome: outcome({
          workflowId: 'wf',
          dispatched: [],
          review: {
            checkpointId: 'audit-builds',
            decision: 'approve',
            note: '均已产生代码，现批准',
          },
        }),
      },
      {
        stepId: 'revise',
        args: {
          workflowId: 'wf',
          checkpointId: 'audit-builds',
          decision: 'revise',
          note: '继续优化 qwen 版',
          revisions: [{ nodeId: 'build-qwen', instruction: '按 bug 列表继续改' }],
        },
        status: 'running',
      },
    ]
    const folded = foldWorkflow(records, 'wf')
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.approvals['audit-builds']).toBeUndefined()
    expect(folded.projection.results['build-qwen']).toBeUndefined()
    // 未被选中的节点结果保留：它不需要重新执行，检查点等待它的回执。
    expect(folded.projection.results['build-glm']?.output).toBe('glm 初稿')
    // 作废的节点保留子 agent id：续发是向原子 agent 继续发送，而不是新建一个子 agent。
    expect(folded.projection.states['build-qwen']).toMatchObject({
      phase: 'waiting',
      subagentId: 'cv_qwen',
    })
  })

  /**
   * 首次派发被进程退出截断时投影必须为 failed。停留在 running 时 review 只会收到
   * 「当前不是待审查状态（running）」，图上的加载状态也不会结束。
   */
  test('首次派发没有 transition 且已落失败终态时投影为 failed', () => {
    const folded = foldWorkflow(
      [
        {
          stepId: 'wf',
          args: {
            goal: '目标',
            nodes: [
              { id: 'a', kind: 'temp', name: 'a', task: '做' },
              { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
            ],
          },
          status: 'failure',
        },
      ],
      'wf',
    )
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.phase).toBe('failed')
  })

  test('被中断的节点折叠出「调用中断」回执，revise 才能找到要续接的会话', () => {
    const folded = foldWorkflow(
      [
        {
          stepId: 'wf',
          args: {
            goal: '目标',
            nodes: [
              { id: 'a', kind: 'temp', name: 'a', task: '做' },
              { id: 'b', kind: 'temp', name: 'b', task: '也做' },
              { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b'] },
            ],
          },
          status: 'success',
          outcome: outcome({ workflowId: 'wf', dispatched: ['a', 'b'] }),
          nodes: {
            a: { phase: 'interrupted', label: 'a', subagentId: 'cv_a' as never },
            b: { phase: 'interrupted', label: 'b', subagentId: 'cv_b' as never },
          },
        },
      ],
      'wf',
    )
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    // 中断也是终态：检查点因此仍可到达，图不会停滞在没有出口的状态。
    expect(folded.projection.phase).toBe('waiting_review')
    expect(folded.projection.results.a).toMatchObject({
      status: 'failed',
      error: '调用中断',
      subagentId: 'cv_a',
    })
    expect(folded.projection.results.b).toMatchObject({
      status: 'failed',
      error: '调用中断',
      subagentId: 'cv_b',
    })
  })

  /**
   * 派发后立即返回，之后任一节点执行完毕的回调随时会重建投影，而此时批准调用可能尚未落终态。
   * 不计入该调用时，同一检查点会被再次判定为就绪，回执发送两次。
   */
  test('仍在执行的批准同样计入', () => {
    const folded = foldWorkflow(
      [
        {
          stepId: 'wf',
          args: {
            goal: '目标',
            nodes: [
              { id: 'a', kind: 'temp', name: 'a', task: '做' },
              { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
              { id: 'b', kind: 'temp', name: 'b', task: '再做', needs: ['cp'] },
              { id: 'cp2', kind: 'checkpoint', label: '再审查', needs: ['b'] },
            ],
          },
          status: 'success',
          outcome: outcome({ workflowId: 'wf', dispatched: ['a'] }),
          nodes: { a: cell({ label: 'a', output: '甲' }) },
        },
        {
          stepId: 'approve',
          args: { workflowId: 'wf', checkpointId: 'cp', decision: 'approve', note: '通过' },
          status: 'running',
          nodes: { b: { phase: 'working', label: 'b' } },
        },
      ],
      'wf',
    )
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.approvals.cp).toContain('通过')
    expect(folded.projection.phase).toBe('running')
    expect(folded.projection.checkpointId).toBeUndefined()
  })

  test('运行中的续接调用立即按 args.workflowId 归入首次调用', () => {
    expect(workflowGroupId({ stepId: 'current', args: { workflowId: 'anchor' } })).toBe('anchor')
  })

  test('revise 开始时即令选中节点与本批下游失效，不显示旧回执', () => {
    const records: WorkflowCallRecord[] = [
      {
        stepId: 'wf',
        args: {
          goal: '目标',
          nodes: [
            { id: 'a', kind: 'temp', name: 'a', task: '研究' },
            { id: 'b', kind: 'temp', name: 'b', task: '复核', needs: ['a'] },
            { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['b'] },
          ],
        },
        status: 'success',
        outcome: outcome({ workflowId: 'wf', dispatched: ['a'] }),
        nodes: {
          a: cell({ label: 'A', output: '旧 A' }),
          b: cell({ label: 'B', output: '旧 B' }),
        },
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
  })

  /** revise 调用自身派发的节点不能被同一调用作废，否则重新派发的内容将立即丢失。 */
  test('revise 调用写入的节点状态覆盖作废结果', () => {
    const records: WorkflowCallRecord[] = [
      {
        stepId: 'wf',
        args: {
          goal: '目标',
          nodes: [
            { id: 'a', kind: 'temp', name: 'a', task: '研究' },
            { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
          ],
        },
        status: 'success',
        outcome: outcome({ workflowId: 'wf', dispatched: ['a'] }),
        nodes: { a: cell({ label: 'A', output: '旧 A', subagentId: 'cv_a' }) },
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
        nodes: { a: { phase: 'working', label: 'A', subagentId: 'cv_a' as never } },
      },
    ]
    const folded = foldWorkflow(records, 'wf')
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.projection.states.a?.phase).toBe('working')
    expect(folded.projection.phase).toBe('running')
  })
})

describe('转移只记录本次调用执行的操作', () => {
  test('只提供 workflowId 无效：审查动作必须指定检查点', () => {
    const got = parseWorkflowCall({ workflowId: 'wf' })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.error).toBe('审查动作必须填写 workflowId 和 checkpointId')
  })

  test('已派发的节点原样读取', () => {
    const transition = workflowTransitionOf(outcome({ workflowId: 'wf', dispatched: ['a', 'c'] }))
    expect(transition).toEqual({ workflowId: 'wf', dispatched: ['a', 'c'] })
  })

  test('没有 dispatched 的结果不是转移', () => {
    expect(
      workflowTransitionOf({
        status: 'success',
        executed: true,
        message: 'ok',
        data: { workflowId: 'wf' },
      }),
    ).toBeNull()
  })
})
