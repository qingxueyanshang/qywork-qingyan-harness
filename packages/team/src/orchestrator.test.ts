/**
 * 推进器：根据节点状态计算本次派发哪些节点、跳过哪些节点、是否到达检查点。
 *
 * 覆盖范围：`orchestrator.ts` 的 `advance` 与 `validatePlan`。
 * 此处不派发任务也不等待：派发、写入状态、发送回执都在 server 的派发通道中完成，
 * 该侧由 `server/delegate.test.ts` 覆盖。
 */
import { describe, expect, test } from 'bun:test'
import { DEFAULT_MAX_CONCURRENT, type NodeState, type SubagentTarget } from '@qywork/core'
import { type AdvanceInput, advance, validatePlan } from './orchestrator.ts'
import type { PlanNode } from './types.ts'

/** 派发给角色 r 的节点；图中绝大多数节点都是这种。 */
function node(id: string, task: string, extra: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    kind: 'subagent',
    target: { kind: 'role', role: 'r' },
    task,
    ...extra,
  } as PlanNode
}

const checkpoint = (id: string, needs: string[]): PlanNode => ({
  id,
  kind: 'checkpoint',
  label: '主会话审查',
  needs,
})

const KNOWN = {
  roles: new Set(['r', 'dev', '设计', '实现', '评审', '构建', '测试', 'a', 'b']),
  clis: new Set(['codex']),
  subagents: new Set(['cv_known']),
}

/** 节点的终态。回执即终态，推进器不接受第二个来源。 */
function cell(
  label: string,
  input: {
    phase?: NodeState['phase']
    output?: string
    error?: string
    subagentId?: string
  } = {},
): NodeState {
  return {
    phase: input.phase ?? 'done',
    label,
    durationMs: 1,
    ...(input.output ? { output: input.output } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.subagentId ? { subagentId: input.subagentId as never } : {}),
  }
}

function step(plan: PlanNode[], extra: Partial<AdvanceInput> = {}) {
  return advance({
    plan,
    goal: '把这件事做完',
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    states: {},
    approvals: {},
    ...extra,
  })
}

const dispatched = (result: ReturnType<typeof advance>) => result.dispatch.map((d) => d.nodeId)
const promptOf = (result: ReturnType<typeof advance>, nodeId: string) =>
  result.dispatch.find((d) => d.nodeId === nodeId)?.prompt ?? ''
const targetOf = (result: ReturnType<typeof advance>, nodeId: string): SubagentTarget | undefined =>
  result.dispatch.find((d) => d.nodeId === nodeId)?.target

describe('计划校验', () => {
  test('引用不存在的角色直接拒绝', () => {
    expect(() =>
      validatePlan([node('a', '', { target: { kind: 'role', role: 'nope' } })], KNOWN),
    ).toThrow(/不存在的角色/)
  })

  test('引用本机没有的外部 CLI 直接拒绝', () => {
    expect(() =>
      validatePlan([node('a', '', { target: { kind: 'cli', cli: 'nope' } })], KNOWN),
    ).toThrow(/本机没有的外部 CLI nope/)
  })

  test('指向不属于本会话的子 agent 直接拒绝', () => {
    expect(() =>
      validatePlan([node('a', '', { target: { subagent: 'cv_other' } })], KNOWN),
    ).toThrow(/不在本会话里/)
  })

  test('依赖不存在的节点直接拒绝', () => {
    expect(() => validatePlan([node('a', '', { needs: ['ghost'] })], KNOWN)).toThrow(/不存在的节点/)
  })

  /**
   * 成环在运行时表现为始终没有可启动的节点，从该现象反推原因很困难，
   * 因此必须在加载期报告确切的环路径。
   */
  test('循环依赖在加载期报告环路径', () => {
    expect(() =>
      validatePlan(
        [
          node('a', '', { needs: ['c'] }),
          node('b', '', { needs: ['a'] }),
          node('c', '', { needs: ['b'] }),
        ],
        KNOWN,
      ),
    ).toThrow(/循环依赖/)
  })

  test('节点 id 重复直接拒绝', () => {
    expect(() => validatePlan([node('a', ''), node('a', '')], KNOWN)).toThrow(/重复/)
  })

  /**
   * 每个节点的成败都必须由检查点裁决。否则终态只能按「任一回执非 done 即失败」粗略判定，
   * 且失败之后没有回流入口，四个节点全部失败后只能新建子会话。
   */
  test('节点后面没有检查点直接拒绝', () => {
    expect(() => validatePlan([node('a', '干完')], KNOWN)).toThrow(/节点 a 后面没有检查点/)
    expect(() =>
      validatePlan(
        [
          node('a', '第一批'),
          checkpoint('cp', ['a']),
          node('b', '检查点之后还有一节', { needs: ['cp'] }),
        ],
        KNOWN,
      ),
    ).toThrow(/节点 b 后面没有检查点/)
  })

  test('不允许有分支绕过主会话检查点', () => {
    expect(() =>
      validatePlan(
        [node('a', '第一批'), checkpoint('cp', ['a']), node('b', '没有经过检查点')],
        KNOWN,
      ),
    ).toThrow(/绕过检查点/)
  })
})

describe('本次派发哪些节点', () => {
  test('首次派发只派发依赖已就绪的节点', () => {
    const plan = [node('a', '先做'), node('b', '后做', { needs: ['a'] }), checkpoint('cp', ['b'])]
    const result = step(plan)
    expect(dispatched(result)).toEqual(['a'])
    expect(result.checkpoint).toBeNull()
    expect(result.completed).toBe(false)
  })

  test('节点执行完毕后派发其下游，上游产出写入任务', () => {
    const plan = [
      node('a', '先做'),
      node('b', '基于 {input} 继续', { needs: ['a'] }),
      checkpoint('cp', ['b']),
    ]
    const result = step(plan, { states: { a: cell('a', { output: 'A 的产出' }) } })
    expect(dispatched(result)).toEqual(['b'])
    expect(promptOf(result, 'b')).toBe('基于 A 的产出 继续')
  })

  test('未写 {input} 时上游产出追加到末尾，而不是丢弃', () => {
    const plan = [node('a', '先做'), node('b', '复核', { needs: ['a'] }), checkpoint('cp', ['b'])]
    const result = step(plan, { states: { a: cell('a', { output: 'A 的产出' }) } })
    expect(promptOf(result, 'b')).toBe('复核\n\n## 上游产出\n\nA 的产出')
  })

  test('passInput: false 时依赖只决定顺序，不传递产出', () => {
    const plan = [
      node('a', '先做'),
      node('b', '复核', { needs: ['a'], passInput: false }),
      checkpoint('cp', ['b']),
    ]
    const result = step(plan, { states: { a: cell('a', { output: 'A 的产出' }) } })
    expect(promptOf(result, 'b')).toBe('复核')
  })

  test('没有上游时不保留空的「上游产出」小节，{goal} 原位替换', () => {
    const plan = [node('a', '围绕 {goal} 做'), checkpoint('cp', ['a'])]
    expect(promptOf(step(plan), 'a')).toBe('围绕 把这件事做完 做')
  })

  test('节点的 provider 与 model 两列原样交给派发端', () => {
    const plan = [
      node('a', '做', { provider: '另/接口', model: 'qwen/model-3.8' }),
      checkpoint('cp', ['a']),
    ]
    expect(step(plan).dispatch[0]).toMatchObject({
      provider: '另/接口',
      model: 'qwen/model-3.8',
    })
  })

  test('指向本会话已有子 agent 的节点按 id 派发，不新建', () => {
    const plan = [
      node('a', '接着做', { target: { subagent: 'cv_known' } }),
      checkpoint('cp', ['a']),
    ]
    expect(targetOf(step(plan), 'a')).toEqual({ subagent: 'cv_known' })
  })

  test('运行中的节点不重复派发', () => {
    const plan = [node('a', '做'), node('b', '也做'), checkpoint('cp', ['a', 'b'])]
    const result = step(plan, { states: { a: { phase: 'working', label: 'a' } } })
    expect(dispatched(result)).toEqual(['b'])
  })

  test('并发上限按运行中的节点数计算，超出的节点标记为排队', () => {
    const plan = [
      node('a', '做'),
      node('b', '做'),
      node('c', '做'),
      checkpoint('cp', ['a', 'b', 'c']),
    ]
    const result = step(plan, {
      maxConcurrent: 2,
      states: { a: { phase: 'working', label: 'a' } },
    })
    expect(dispatched(result)).toEqual(['b'])
    expect(result.queued.map((q) => q.nodeId)).toEqual(['c'])
    expect(result.queued[0]?.state.phase).toBe('queued')
  })

  test('已标记为排队的节点不重复标记', () => {
    const plan = [node('a', '做'), node('b', '做'), checkpoint('cp', ['a', 'b'])]
    const result = step(plan, {
      maxConcurrent: 1,
      states: { a: { phase: 'working', label: 'a' }, b: { phase: 'queued', label: 'b' } },
    })
    expect(result.queued).toEqual([])
    expect(dispatched(result)).toEqual([])
  })
})

describe('单个节点失败，其余照常运行', () => {
  test('失败的节点不阻止同批运行中的节点，检查点尚未到达', () => {
    const plan = [node('a', '做'), node('b', '也做'), checkpoint('cp', ['a', 'b'])]
    const result = step(plan, {
      states: {
        a: cell('a', { phase: 'failed', error: '连不上' }),
        b: { phase: 'working', label: 'b' },
      },
    })
    expect(result.checkpoint).toBeNull()
    expect(dispatched(result)).toEqual([])
  })

  test('上游失败时下游跳过，不以错误输入继续执行，跳过状态向下传播', () => {
    const plan = [
      node('a', '做'),
      node('b', '接着做', { needs: ['a'] }),
      node('c', '再接着', { needs: ['b'] }),
      checkpoint('cp', ['c']),
    ]
    const result = step(plan, { states: { a: cell('a', { phase: 'failed', error: '连不上' }) } })
    expect(result.skipped.map((s) => s.nodeId)).toEqual(['b', 'c'])
    expect(result.skipped[0]?.state).toMatchObject({ phase: 'skipped', error: '上游节点未成功' })
    expect(dispatched(result)).toEqual([])
    // 跳过是终态：检查点因此可以到达，图不会停滞在没有出口的位置。
    expect(result.checkpoint).toBe('cp')
  })

  test('上游全部终态时到达检查点', () => {
    const plan = [node('a', '做'), node('b', '也做'), checkpoint('cp', ['a', 'b'])]
    const result = step(plan, {
      states: {
        a: cell('a', { output: '甲' }),
        b: cell('b', { phase: 'failed', error: '连不上' }),
      },
    })
    expect(result.checkpoint).toBe('cp')
    expect(result.completed).toBe(false)
  })
})

describe('检查点审查', () => {
  const plan = [
    node('a', '第一批'),
    checkpoint('cp', ['a']),
    node('b', '第二批', { needs: ['cp'] }),
    checkpoint('cp2', ['b']),
  ]

  test('approve 之后派发下一批，批准的正文包含上游产出', () => {
    const result = step(plan, {
      states: { a: cell('a', { output: 'A 的产出' }) },
      review: { checkpointId: 'cp', decision: 'approve', note: '通过', revisions: [] },
    })
    expect(result.review).toEqual({ checkpointId: 'cp', decision: 'approve', note: '通过' })
    expect(dispatched(result)).toEqual(['b'])
    expect(promptOf(result, 'b')).toContain('A 的产出')
  })

  test('approve 接受了未完成的节点时逐条列出', () => {
    const result = step(plan, {
      states: { a: cell('a', { phase: 'failed', error: '连不上' }) },
      review: { checkpointId: 'cp', decision: 'approve', note: '先往下走', revisions: [] },
    })
    expect(result.review?.acceptedFailures).toEqual([{ nodeId: 'a', reason: '连不上' }])
  })

  test('上游尚未到达终态时 approve 直接拒绝', () => {
    expect(() =>
      step(plan, {
        states: { a: { phase: 'working', label: 'a' } },
        review: { checkpointId: 'cp', decision: 'approve', note: '', revisions: [] },
      }),
    ).toThrow(/上游回执尚未齐全/)
  })

  test('重复批准同一个检查点直接拒绝', () => {
    expect(() =>
      step(plan, {
        states: { a: cell('a', { output: 'A' }) },
        approvals: { cp: '已批准' },
        review: { checkpointId: 'cp', decision: 'approve', note: '', revisions: [] },
      }),
    ).toThrow(/已经批准/)
  })

  test('全部节点到达终态、全部检查点已批准 = 完成', () => {
    const result = step(plan, {
      states: { a: cell('a', { output: 'A' }), b: cell('b', { output: 'B' }) },
      approvals: { cp: '批了' },
      review: { checkpointId: 'cp2', decision: 'approve', note: '收工', revisions: [] },
    })
    expect(result.completed).toBe(true)
    expect(dispatched(result)).toEqual([])
  })
})

describe('revise 只影响闭包', () => {
  const plan = [
    node('a', '研究'),
    node('b', '复核', { needs: ['a'] }),
    node('c', '另一件', { needs: ['a'] }),
    checkpoint('cp', ['b', 'c']),
  ]

  test('被指定的节点向原有子 agent 续发，只发送指令与最新上游产出', () => {
    const result = step(plan, {
      states: {
        a: cell('a', { output: '旧 A', subagentId: 'cv_a' }),
        b: cell('b', { output: '旧 B', subagentId: 'cv_b' }),
        c: cell('c', { output: '旧 C', subagentId: 'cv_c' }),
      },
      review: {
        checkpointId: 'cp',
        decision: 'revise',
        note: '返工',
        revisions: [{ nodeId: 'a', instruction: '补证据' }],
      },
    })
    expect(result.review).toEqual({ checkpointId: 'cp', decision: 'revise', note: '返工' })
    expect(dispatched(result)).toEqual(['a'])
    expect(targetOf(result, 'a')).toEqual({ subagent: 'cv_a' })
    expect(promptOf(result, 'a')).toBe('补证据')
    // 闭包内的下游本次仍无法派发（上游没有回执），但其旧回执已作废。
    expect(result.checkpoint).toBeNull()
  })

  test('闭包内未被指定的节点随后续发默认指令，仍续接原有子 agent', () => {
    const result = step(plan, {
      states: {
        a: cell('a', { output: '新 A', subagentId: 'cv_a' }),
        b: { phase: 'waiting', label: 'b', subagentId: 'cv_b' as never },
        c: { phase: 'waiting', label: 'c', subagentId: 'cv_c' as never },
      },
    })
    expect(dispatched(result).sort()).toEqual(['b', 'c'])
    expect(targetOf(result, 'b')).toEqual({ subagent: 'cv_b' })
    expect(promptOf(result, 'b')).toContain('上游结果已被主会话要求修订')
    expect(promptOf(result, 'b')).toContain('新 A')
  })

  test('指定尚未到达终态的节点时直接拒绝', () => {
    expect(() =>
      step(plan, {
        states: { a: { phase: 'working', label: 'a' } },
        review: {
          checkpointId: 'cp',
          decision: 'revise',
          note: '',
          revisions: [{ nodeId: 'a', instruction: '改' }],
        },
      }),
    ).toThrow(/尚无终态/)
  })

  test('revise 撤销该检查点的批准', () => {
    const result = step(plan, {
      states: {
        a: cell('a', { output: '旧 A', subagentId: 'cv_a' }),
        b: cell('b', { output: '旧 B', subagentId: 'cv_b' }),
        c: cell('c', { output: '旧 C', subagentId: 'cv_c' }),
      },
      approvals: { cp: '批过了' },
      review: {
        checkpointId: 'cp',
        decision: 'revise',
        note: '再改',
        revisions: [{ nodeId: 'b', instruction: '改 B' }],
      },
    })
    expect(dispatched(result)).toEqual(['b'])
    expect(result.completed).toBe(false)
  })

  test('未找到检查点时直接拒绝', () => {
    expect(() =>
      step(plan, {
        review: { checkpointId: 'nope', decision: 'approve', note: '', revisions: [] },
      }),
    ).toThrow(/未找到检查点 nope/)
  })
})
