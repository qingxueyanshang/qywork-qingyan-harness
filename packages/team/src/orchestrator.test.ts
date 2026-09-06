/**
 * 推进器：给定格状态算出这一趟派谁、跳过谁、到没到检查点。
 *
 * 覆盖范围：`orchestrator.ts` 的 `advance` 与 `validatePlan`。
 * 这里不派活也不等——派出去、写状态、发回执都在 server 的派活通道，
 * 它那一侧由 `server/delegate.test.ts` 覆盖。
 */
import { describe, expect, test } from 'bun:test'
import { DEFAULT_MAX_CONCURRENT, type NodeState, type SubagentTarget } from '@qywork/core'
import { type AdvanceInput, advance, validatePlan } from './orchestrator.ts'
import type { PlanNode } from './types.ts'

/** 派给角色 r 的节点；图里绝大多数格子都是它。 */
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

/** 一格的终态。回执就是它，推进器不认第二个来源。 */
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
   * 成环在运行时的表现是「一直没有可启动节点」——从这个现象倒推原因很费劲，
   * 所以必须在加载期报出确切的环路径。
   */
  test('循环依赖在加载期就报出环路径', () => {
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
   * 每个节点的成败都要有检查点裁决。没有的话终态只能按「任一回执非 done 即失败」粗判，
   * 而失败之后没有回流入口——这正是四个节点全部失败后只能新开子会话的形状。
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

describe('这一趟派谁', () => {
  test('首派只派依赖已就绪的格', () => {
    const plan = [node('a', '先做'), node('b', '后做', { needs: ['a'] }), checkpoint('cp', ['b'])]
    const result = step(plan)
    expect(dispatched(result)).toEqual(['a'])
    expect(result.checkpoint).toBeNull()
    expect(result.completed).toBe(false)
  })

  test('一格跑完之后派它的下游，上游产出注入任务', () => {
    const plan = [
      node('a', '先做'),
      node('b', '基于 {input} 继续', { needs: ['a'] }),
      checkpoint('cp', ['b']),
    ]
    const result = step(plan, { states: { a: cell('a', { output: 'A 的产出' }) } })
    expect(dispatched(result)).toEqual(['b'])
    expect(promptOf(result, 'b')).toBe('基于 A 的产出 继续')
  })

  test('没写 {input} 时上游产出追加到末尾，而不是丢掉', () => {
    const plan = [node('a', '先做'), node('b', '复核', { needs: ['a'] }), checkpoint('cp', ['b'])]
    const result = step(plan, { states: { a: cell('a', { output: 'A 的产出' }) } })
    expect(promptOf(result, 'b')).toBe('复核\n\n## 上游产出\n\nA 的产出')
  })

  test('passInput: false 时依赖只管顺序，不传产出', () => {
    const plan = [
      node('a', '先做'),
      node('b', '复核', { needs: ['a'], passInput: false }),
      checkpoint('cp', ['b']),
    ]
    const result = step(plan, { states: { a: cell('a', { output: 'A 的产出' }) } })
    expect(promptOf(result, 'b')).toBe('复核')
  })

  test('没有上游时不留空的「上游产出」小节，{goal} 就地替换', () => {
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

  test('已经在跑的格不重复派', () => {
    const plan = [node('a', '做'), node('b', '也做'), checkpoint('cp', ['a', 'b'])]
    const result = step(plan, { states: { a: { phase: 'working', label: 'a' } } })
    expect(dispatched(result)).toEqual(['b'])
  })

  test('并发闸按在跑的格数算，超出的标排队', () => {
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

  test('已经标过排队的格不重复标', () => {
    const plan = [node('a', '做'), node('b', '做'), checkpoint('cp', ['a', 'b'])]
    const result = step(plan, {
      maxConcurrent: 1,
      states: { a: { phase: 'working', label: 'a' }, b: { phase: 'queued', label: 'b' } },
    })
    expect(result.queued).toEqual([])
    expect(dispatched(result)).toEqual([])
  })
})

describe('一格失败，其余照跑', () => {
  test('失败的格不挡住同批还在跑的格，检查点也还没到', () => {
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

  test('上游失败时下游跳过，不拿着坏输入继续，跳过还会传播', () => {
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
    // 跳过是终态：检查点因此到得了，图不会停在没有出口的地方。
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

  test('approve 之后派下一批，批准的正文带着上游产出', () => {
    const result = step(plan, {
      states: { a: cell('a', { output: 'A 的产出' }) },
      review: { checkpointId: 'cp', decision: 'approve', note: '通过', revisions: [] },
    })
    expect(result.review).toEqual({ checkpointId: 'cp', decision: 'approve', note: '通过' })
    expect(dispatched(result)).toEqual(['b'])
    expect(promptOf(result, 'b')).toContain('A 的产出')
  })

  test('approve 接受了未完成的格时逐条列出来', () => {
    const result = step(plan, {
      states: { a: cell('a', { phase: 'failed', error: '连不上' }) },
      review: { checkpointId: 'cp', decision: 'approve', note: '先往下走', revisions: [] },
    })
    expect(result.review?.acceptedFailures).toEqual([{ nodeId: 'a', reason: '连不上' }])
  })

  test('上游还没终态就 approve 直接拒绝', () => {
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

  test('全部格终态、全部检查点已批准 = 完成', () => {
    const result = step(plan, {
      states: { a: cell('a', { output: 'A' }), b: cell('b', { output: 'B' }) },
      approvals: { cp: '批了' },
      review: { checkpointId: 'cp2', decision: 'approve', note: '收工', revisions: [] },
    })
    expect(result.completed).toBe(true)
    expect(dispatched(result)).toEqual([])
  })
})

describe('revise 只动闭包', () => {
  const plan = [
    node('a', '研究'),
    node('b', '复核', { needs: ['a'] }),
    node('c', '另一件', { needs: ['a'] }),
    checkpoint('cp', ['b', 'c']),
  ]

  test('被点名的格向原子 agent 续发，只发指令与最新上游产出', () => {
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
    // 闭包内的下游这一趟还派不了（上游没有回执），但它的旧回执已经作废。
    expect(result.checkpoint).toBeNull()
  })

  test('闭包内没被点名的格随后续发默认指令，仍接原子 agent', () => {
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

  test('点名一个还没终态的格直接拒绝', () => {
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
    ).toThrow(/还没有终态/)
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

  test('找不到检查点直接拒绝', () => {
    expect(() =>
      step(plan, {
        review: { checkpointId: 'nope', decision: 'approve', note: '', revisions: [] },
      }),
    ).toThrow(/找不到检查点 nope/)
  })
})
