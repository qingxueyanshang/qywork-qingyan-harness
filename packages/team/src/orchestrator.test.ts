import { describe, expect, test } from 'bun:test'
import { DEFAULT_MAX_CONCURRENT, type SubagentTarget } from '@qywork/core'
import { type OrchestratorDeps, TeamOrchestrator, validatePlan } from './orchestrator.ts'
import type { NodeResult, PlanNode } from './types.ts'

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

const KNOWN = {
  roles: new Set(['r', 'dev', '设计', '实现', '评审', '构建', '测试', 'a', 'b']),
  clis: new Set(['codex']),
  subagents: new Set(['cv_known']),
}

type Dispatch = OrchestratorDeps['dispatch']

/**
 * 假的派发端：按目标名字记下调用顺序与提示词。
 * `describe` 按已知集合给名字，名字就是角色 id / 临时名 / CLI id / 子 agent id。
 */
function deps(
  run: (
    label: string,
    input: Parameters<Dispatch>[0],
  ) => Promise<{ ok: boolean; output: string; error?: string; subagentId?: string }>,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
) {
  const order: string[] = []
  const prompts: string[] = []
  const events: Record<string, unknown>[] = []
  const describe = (target: SubagentTarget) => {
    if ('subagent' in target) {
      return KNOWN.subagents.has(target.subagent) ? { label: target.subagent } : null
    }
    if (target.kind === 'temp') return { label: target.name }
    if (target.kind === 'role') {
      return KNOWN.roles.has(target.role) ? { label: target.role } : null
    }
    return KNOWN.clis.has(target.cli) ? { label: target.cli } : null
  }
  const d: OrchestratorDeps = {
    signal: new AbortController().signal,
    maxConcurrent,
    node: (nodeId, state) => events.push({ nodeId, ...state }),
    describe,
    dispatch: async (input) => {
      const label = describe(input.target)?.label ?? '?'
      order.push(label)
      prompts.push(input.prompt)
      return run(label, input)
    },
    join: async () => ({ ok: false, output: '' }),
  }
  return { order, prompts, events, deps: d }
}

const ok = async (label: string) => ({ ok: true, output: `${label} 的产出` })

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
          { id: 'cp', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
          node('b', '检查点之后还有一节', { needs: ['cp'] }),
        ],
        KNOWN,
      ),
    ).toThrow(/节点 b 后面没有检查点/)
  })

  test('不允许有分支绕过主会话检查点', () => {
    expect(() =>
      validatePlan(
        [
          node('a', '第一批'),
          { id: 'cp', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
          node('b', '没有经过检查点'),
        ],
        KNOWN,
      ),
    ).toThrow(/绕过检查点/)
  })
})

describe('编排执行', () => {
  test('节点的 provider 与 model 两列原样交给派发端', async () => {
    const seen: Array<{ provider?: string; model?: string }> = []
    const plan: PlanNode[] = [
      node('impl', '实现', {
        target: { kind: 'temp', name: '实现' },
        provider: '官方/中转',
        model: 'anthropic/claude-opus-5',
      }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['impl'] },
    ]
    const d = deps(async (_label, input) => {
      seen.push({
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
      })
      return { ok: true, output: '完成' }
    })

    await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')

    expect(seen).toEqual([{ provider: '官方/中转', model: 'anthropic/claude-opus-5' }])
  })

  test('按依赖顺序执行，上游产出注入下游', async () => {
    const plan: PlanNode[] = [
      node('design', '设计：{goal}', { target: { kind: 'role', role: '设计' } }),
      node('impl', '实现，参考：{input}', {
        target: { kind: 'role', role: '实现' },
        needs: ['design'],
      }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['impl'] },
    ]
    const d = deps(ok)
    const { receipts: results } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('做个登录页')

    expect(d.order).toEqual(['设计', '实现'])
    expect(results.every((r) => r.status === 'done')).toBe(true)
    // {goal} 与 {input} 都要被替换掉，不能把占位符原样发给模型。
    expect(d.prompts[0]).toContain('做个登录页')
    expect(d.prompts[1]).toContain('设计 的产出')
    expect(d.prompts.join()).not.toContain('{goal}')
    expect(d.prompts.join()).not.toContain('{input}')
  })

  /**
   * 这条是实测撞出来的：`needs` 写了、`{input}` 没写，上游产出被静默丢掉，
   * 下游角色回「没有上一步的上下文，无法复核」。配置看上去完全正确，
   * 错在一个不会报错的地方。
   */
  test('没写 {input} 时上游产出追加到末尾，而不是丢掉', async () => {
    const plan: PlanNode[] = [
      node('design', '设计：{goal}', { target: { kind: 'role', role: '设计' } }),
      node('review', '复核一下', { target: { kind: 'role', role: '评审' }, needs: ['design'] }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['review'] },
    ]
    const d = deps(ok)
    await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')
    expect(d.prompts[1]).toContain('复核一下')
    expect(d.prompts[1]).toContain('设计 的产出')
  })

  test('passInput: false 时依赖只管顺序，不传产出', async () => {
    const plan: PlanNode[] = [
      node('build', '构建', { target: { kind: 'role', role: '构建' } }),
      node('test', '跑测试', {
        target: { kind: 'role', role: '测试' },
        needs: ['build'],
        passInput: false,
      }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['test'] },
    ]
    const d = deps(ok)
    await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')
    expect(d.order).toEqual(['构建', '测试'])
    expect(d.prompts[1]).not.toContain('构建 的产出')
  })

  test('没有上游时不留空的「上游产出」小节', async () => {
    const plan: PlanNode[] = [
      node('a', '执行任务'),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
    ]
    const d = deps(ok)
    await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')
    expect(d.prompts[0]).not.toContain('上游产出')
  })

  /**
   * 上游失败时下游必须跳过而不是照跑：拿着失败的上游输出继续，
   * 产出的是看起来合理实则无根的结果，比直接失败更难发现。
   */
  test('上游失败时下游跳过，不拿着坏输入继续', async () => {
    const plan: PlanNode[] = [
      node('n1', 'x', { target: { kind: 'role', role: 'a' } }),
      node('n2', 'y', { target: { kind: 'role', role: 'b' }, needs: ['n1'] }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['n2'] },
    ]
    const d = deps(async (label) =>
      label === 'a' ? { ok: false, output: '' } : { ok: true, output: 'ok' },
    )
    const { receipts: results } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')

    expect(byId(results, 'n1').status).toBe('failed')
    expect(byId(results, 'n2').status).toBe('skipped')
    // 角色 b 不该被调用。
    expect(d.order).toEqual(['a'])
  })

  test('无依赖的节点可并行，受调用参数 maxConcurrent 限制', async () => {
    const plan: PlanNode[] = [
      node('a', '1'),
      node('b', '2'),
      node('c', '3'),
      node('d', '4'),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b', 'c', 'd'] },
    ]
    let inFlight = 0
    let peak = 0
    const d = deps(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(20)
      inFlight--
      return { ok: true, output: 'x' }
    }, 2)
    const { receipts: results } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')

    expect(results.filter((r) => r.status === 'done')).toHaveLength(4)
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('调用参数把并发放宽到 5 时五个节点同时启动', async () => {
    const plan: PlanNode[] = [
      ...['a', 'b', 'c', 'd', 'e'].map((id) => node(id, id)),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b', 'c', 'd', 'e'] },
    ]
    let inFlight = 0
    let peak = 0
    const d = deps(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(20)
      inFlight--
      return { ok: true, output: 'x' }
    }, 5)

    const { receipts } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')

    expect(receipts).toHaveLength(5)
    expect(peak).toBe(5)
    expect(d.events.some((event) => event.phase === 'queued')).toBe(false)
  })

  test('未配置并发闸时四个节点同时启动，超出的节点明确报等待槽位', async () => {
    const plan: PlanNode[] = [
      ...['a', 'b', 'c', 'd', 'e'].map((id) => node(id, id)),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b', 'c', 'd', 'e'] },
    ]
    let inFlight = 0
    let peak = 0
    const d = deps(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(20)
      inFlight--
      return { ok: true, output: 'x' }
    })

    const { receipts } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')

    expect(receipts).toHaveLength(5)
    expect(peak).toBe(4)
    expect(d.events).toContainEqual(expect.objectContaining({ nodeId: 'e', phase: 'queued' }))
    expect(d.order).toHaveLength(5)
  })

  test('指向本会话已有子 agent 的节点按 id 派发，不新建', async () => {
    const plan: PlanNode[] = [
      node('again', '再来一次', { target: { subagent: 'cv_known' } }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['again'] },
    ]
    const targets: SubagentTarget[] = []
    const d = deps(async (_label, input) => {
      targets.push(input.target)
      return { ok: true, output: 'x', subagentId: 'cv_known' }
    })
    const { receipts } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')
    expect(targets).toEqual([{ subagent: 'cv_known' }])
    expect(receipts[0]?.subagentId).toBe('cv_known')
  })
})

describe('主会话检查点', () => {
  const plan: PlanNode[] = [
    node('a', '查 A'),
    node('b', '查 B'),
    { id: 'review', kind: 'checkpoint', label: '主会话审查', needs: ['a', 'b'] },
    node('c', '汇总 {input}', { needs: ['review'] }),
    { id: 'final', kind: 'checkpoint', label: '收尾审查', needs: ['c'] },
  ]

  test('首批并行回执齐后暂停，approve 才启动下一批', async () => {
    const calls: string[] = []
    const d = deps(async (_label, input) => {
      calls.push(input.prompt)
      return { ok: true, output: `结果 ${calls.length}`, subagentId: `cv_${calls.length}` }
    })
    const first = await new TeamOrchestrator(plan, d.deps, KNOWN).run('完成目标')
    expect(first.phase).toBe('waiting_review')
    expect(first.checkpointId).toBe('review')
    expect(first.receipts.map((receipt) => receipt.nodeId).sort()).toEqual(['a', 'b'])
    expect(calls).toHaveLength(2)

    const results = Object.fromEntries(first.receipts.map((receipt) => [receipt.nodeId, receipt]))
    const second = await new TeamOrchestrator(plan, d.deps, KNOWN).run('完成目标', {
      results,
      approvals: {},
      checkpointId: 'review',
      review: {
        checkpointId: 'review',
        decision: 'approve',
        note: '回执合格',
        revisions: [],
      },
    })
    // 图以检查点收尾，所以批准 review 之后停在 final 等第二次审查，不直接完成。
    expect(second.phase).toBe('waiting_review')
    expect(second.checkpointId).toBe('final')
    expect(second.review?.decision).toBe('approve')
    expect(second.receipts.map((receipt) => receipt.nodeId)).toEqual(['c'])
    expect(calls[2]).toContain('回执合格')
    expect(calls[2]).toContain('结果 1')
    expect(calls[2]).toContain('结果 2')
  })

  /** 续接时派发目标是子 agent 的 id；假派发端按它回同一个 id。 */
  function resuming() {
    const seen: Array<{ prompt: string; target: SubagentTarget }> = []
    let fresh = 0
    const d = deps(async (_label, input) => {
      seen.push({ prompt: input.prompt, target: input.target })
      if (!('subagent' in input.target)) {
        fresh += 1
        return { ok: true, output: `初稿 ${fresh}`, subagentId: `cv_${fresh}` }
      }
      return {
        ok: true,
        output: input.target.subagent === 'cv_1' ? '修订稿' : '复核新版',
        subagentId: input.target.subagent,
      }
    })
    return { seen, d }
  }

  test('revise 向原子 agent 续发，并让本批下游在原子 agent 重跑', async () => {
    const chain: PlanNode[] = [
      node('a', '先研究'),
      node('b', '再复核 {input}', { needs: ['a'] }),
      { id: 'review', kind: 'checkpoint', label: '主会话审查', needs: ['b'] },
    ]
    const { seen, d } = resuming()
    const first = await new TeamOrchestrator(chain, d.deps, KNOWN).run('目标')
    const results = Object.fromEntries(first.receipts.map((receipt) => [receipt.nodeId, receipt]))
    const second = await new TeamOrchestrator(chain, d.deps, KNOWN).run('目标', {
      results,
      approvals: {},
      checkpointId: 'review',
      review: {
        checkpointId: 'review',
        decision: 'revise',
        note: 'A 缺少证据',
        revisions: [{ nodeId: 'a', instruction: '补充两条可核验证据' }],
      },
    })

    expect(second.phase).toBe('waiting_review')
    expect(second.review?.decision).toBe('revise')
    expect(second.receipts.map((receipt) => receipt.nodeId)).toEqual(['a', 'b'])
    expect(seen.slice(-2).map((call) => call.target)).toEqual([
      { subagent: 'cv_1' },
      { subagent: 'cv_2' },
    ])
    expect(seen.at(-2)?.prompt).toContain('补充两条可核验证据')
    expect(seen.at(-1)?.prompt).toContain('修订稿')
    expect(second.receipts.map((receipt) => receipt.subagentId)).toEqual(['cv_1', 'cv_2'])
  })

  /**
   * 原始失败形状：四个节点全部失败，主会话仍在检查点批准，此后要让某一个节点
   * 在它自己那个子 agent 里继续做。批准即解散的话，模型只剩另起一个子 agent。
   */
  test('批准之后仍能 revise：撤销该检查点的批准，并向原子 agent 续发', async () => {
    const graph: PlanNode[] = [
      node('build-glm', '做 glm 版'),
      node('build-qwen', '做 qwen 版'),
      {
        id: 'audit-builds',
        kind: 'checkpoint',
        label: '主会话验收',
        needs: ['build-glm', 'build-qwen'],
      },
    ]
    const seen: Array<{ prompt: string; target: SubagentTarget }> = []
    let fresh = 0
    const d = deps(async (_label, input) => {
      seen.push({ prompt: input.prompt, target: input.target })
      if (!('subagent' in input.target)) {
        fresh += 1
        return {
          ok: false,
          output: '半成品',
          error: '步数用尽，任务没做完',
          subagentId: `cv_${fresh}`,
        }
      }
      return { ok: true, output: '修好了', subagentId: input.target.subagent }
    })

    const first = await new TeamOrchestrator(graph, d.deps, KNOWN).run('四个模型各做一版')
    expect(first.phase).toBe('waiting_review')
    const results = Object.fromEntries(first.receipts.map((receipt) => [receipt.nodeId, receipt]))
    expect(results['build-qwen']?.status).toBe('failed')

    // 对含失败回执的检查点批准：终态不再由回执粗判，approve 把接受了什么列出来。
    const approved = await new TeamOrchestrator(graph, d.deps, KNOWN).run('四个模型各做一版', {
      results,
      approvals: {},
      checkpointId: 'audit-builds',
      review: {
        checkpointId: 'audit-builds',
        decision: 'approve',
        note: '均已产生代码，现批准',
        revisions: [],
      },
    })
    expect(approved.phase).toBe('completed')
    expect(approved.review?.acceptedFailures?.map((item) => item.nodeId).sort()).toEqual([
      'build-glm',
      'build-qwen',
    ])
    expect(approved.review?.acceptedFailures?.[0]?.reason).toContain('步数用尽')

    const approvals = { 'audit-builds': '已接受的上游回执' }
    const revised = await new TeamOrchestrator(graph, d.deps, KNOWN).run('四个模型各做一版', {
      results,
      approvals,
      review: {
        checkpointId: 'audit-builds',
        decision: 'revise',
        note: '继续优化 qwen 版',
        revisions: [{ nodeId: 'build-qwen', instruction: '按 bug 列表继续改' }],
      },
    })
    expect(revised.phase).toBe('waiting_review')
    expect(revised.checkpointId).toBe('audit-builds')
    expect(revised.receipts.map((receipt) => receipt.nodeId)).toEqual(['build-qwen'])
    // 续发到首派那个子 agent，不是新开一个。
    expect(seen.at(-1)?.target).toEqual({ subagent: results['build-qwen']?.subagentId ?? '' })
    expect(seen.at(-1)?.prompt).toContain('按 bug 列表继续改')
  })

  test('中断时终态是 failed，没被中断就是 completed', async () => {
    const graph: PlanNode[] = [
      node('a', '做'),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a'] },
    ]
    const controller = new AbortController()
    controller.abort()
    const d = deps(async () => ({ ok: true, output: '不该执行' }))
    expect(
      (
        await new TeamOrchestrator(graph, { ...d.deps, signal: controller.signal }, KNOWN).run(
          '目标',
        )
      ).phase,
    ).toBe('failed')

    const done = await new TeamOrchestrator(graph, d.deps, KNOWN).run('目标', {
      results: {
        a: {
          nodeId: 'a',
          label: 'r',
          status: 'failed',
          output: '',
          error: '没做完',
          durationMs: 1,
        },
      },
      approvals: {},
      checkpointId: 'cp',
      review: { checkpointId: 'cp', decision: 'approve', note: '接受', revisions: [] },
    })
    expect(done.phase).toBe('completed')
  })

  /**
   * 上一轮被中断时，只有部分节点留下了带子 agent id 的回执。revise 要能对留下回执的那个
   * 续发，同时让没跑过的节点正常起跑；要求检查点回执齐全的话，中断之后整张图只能重派。
   */
  test('检查点回执不齐时仍能 revise：有回执的续发，没跑过的新起', async () => {
    const graph: PlanNode[] = [
      node('a', '做 A'),
      node('b', '做 B'),
      node('c', '做 C'),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b', 'c'] },
    ]
    const seen: Array<{ nodeId: string; target: SubagentTarget }> = []
    const d = deps(async (_label, input) => {
      seen.push({ nodeId: input.nodeId, target: input.target })
      return {
        ok: true,
        output: '产出',
        subagentId: 'subagent' in input.target ? input.target.subagent : 'cv_new',
      }
    })
    const receipt = (nodeId: string): NodeResult => ({
      nodeId,
      label: 'r',
      status: 'failed',
      output: '',
      error: '调用中断',
      durationMs: 0,
      subagentId: `cv_${nodeId}`,
    })

    const result = await new TeamOrchestrator(graph, d.deps, KNOWN).run('目标', {
      results: { a: receipt('a'), b: receipt('b') },
      approvals: {},
      review: {
        checkpointId: 'cp',
        decision: 'revise',
        note: '接着做',
        revisions: [{ nodeId: 'a', instruction: '已完成则复述最终产出，否则继续' }],
      },
    })

    expect(result.phase).toBe('waiting_review')
    expect(seen.find((call) => call.nodeId === 'a')?.target).toEqual({ subagent: 'cv_a' })
    expect(seen.find((call) => call.nodeId === 'c')?.target).toEqual({ kind: 'role', role: 'r' })
    // b 的回执没被点名也没被作废，检查点直接用它。
    expect(result.receipts.map((r) => r.nodeId).sort()).toEqual(['a', 'c'])
  })

  test('上一轮缺少子 agent id 时明确失败，不偷偷新建', async () => {
    let calls = 0
    const d = deps(async () => {
      calls += 1
      return { ok: true, output: '不该执行' }
    })
    const result = await new TeamOrchestrator(
      [node('a', '研究'), { id: 'review', kind: 'checkpoint', label: '审查', needs: ['a'] }],
      d.deps,
      KNOWN,
    ).run('目标', {
      results: {
        a: { nodeId: 'a', label: 'r', status: 'done', output: '旧稿', durationMs: 1 },
      },
      approvals: {},
      checkpointId: 'review',
      review: {
        checkpointId: 'review',
        decision: 'revise',
        note: '',
        revisions: [{ nodeId: 'a', instruction: '重做' }],
      },
    })
    expect(result.receipts[0]?.status).toBe('failed')
    expect(result.receipts[0]?.error).toContain('没有可续接的子 agent')
    expect(calls).toBe(0)
  })
})

/**
 * 续发不重抄原任务。子 agent 接的是自己的会话，原任务在它的历史里；每一轮都把两千字的任务
 * 再发一遍，卡上就是一遍遍同样的话。修订节点只收指令，下游节点只收「上游改了」加最新上游产出。
 */
describe('续发的内容', () => {
  test('被修订的节点只收指令，下游节点收最新上游产出，都不再带原任务正文', async () => {
    const d = deps(ok)
    const plan: PlanNode[] = [
      node('a', '研究这个题目'),
      node('b', '按研究写稿', { needs: ['a'] }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b'] },
    ]
    await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标', {
      results: {
        a: {
          nodeId: 'a',
          subagentId: 'cv_known',
          label: 'r',
          status: 'done',
          output: '旧研究',
          durationMs: 1,
        },
        b: {
          nodeId: 'b',
          subagentId: 'cv_b',
          label: 'r',
          status: 'done',
          output: '旧稿',
          durationMs: 1,
        },
      },
      approvals: {},
      checkpointId: 'cp',
      review: {
        checkpointId: 'cp',
        decision: 'revise',
        note: '',
        revisions: [{ nodeId: 'a', instruction: '补两个来源' }],
      },
    })
    expect(d.prompts[0]).toBe('补两个来源')
    expect(d.prompts[1]).toContain('上游结果已被主会话要求修订')
    expect(d.prompts[1]).toContain('## 上游产出（最新）\n\ncv_known 的产出')
    expect(d.prompts[1]).not.toContain('按研究写稿')
  })
})

function byId(results: NodeResult[], id: string): NodeResult {
  const r = results.find((x) => x.nodeId === id)
  if (!r) throw new Error(`没有节点 ${id}`)
  return r
}

/**
 * 子 agent 的 id 与耗时随回执带出去：子 agent 的会话不进会话列表，这个 id 是续接它的
 * 唯一入口；耗时以派发方量的为准，卡上那一格与回执是同一个数。
 */
describe('子 agent 入口', () => {
  const plan: PlanNode[] = [
    node('n1', '执行任务', { target: { kind: 'role', role: 'dev' } }),
    { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['n1'] },
  ]

  test('派发端返回的子 agent id 与耗时原样进回执', async () => {
    const d = deps(async (label) => ({
      ok: true,
      output: `${label} 的产出`,
      subagentId: 'cv_child',
      durationMs: 1234,
    }))
    const { receipts } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')
    expect(receipts[0]?.subagentId).toBe('cv_child')
    expect(receipts[0]?.durationMs).toBe(1234)
  })

  /** 没有子 agent id 时这个键必须**缺席**，不是 undefined：续接按它判断有没有可续的。 */
  test('没有子 agent id 时不带这个键', async () => {
    const d = deps(async (label) => ({ ok: true, output: `${label} 的产出` }))
    const { receipts } = await new TeamOrchestrator(plan, d.deps, KNOWN).run('目标')
    expect('subagentId' in (receipts[0] ?? {})).toBe(false)
  })

  /** 卡上每一格的状态由编排器报：开跑先等待，排队、跳过与派发之外的失败各报一次。 */
  test('开跑先把每一格标成等待，派发方找不到目标时那一格失败', async () => {
    const d = deps(ok)
    const bad: PlanNode[] = [
      node('a', '做'),
      node('b', '也做', { target: { kind: 'role', role: 'nobody' } }),
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b'] },
    ]
    await new TeamOrchestrator(bad, d.deps, {
      ...KNOWN,
      roles: new Set([...KNOWN.roles, 'nobody']),
    }).run('目标')
    expect(d.events.slice(0, 2)).toEqual([
      { nodeId: 'a', phase: 'waiting', label: 'r' },
      { nodeId: 'b', phase: 'waiting', label: 'nobody' },
    ])
    expect(d.events.at(-1)).toMatchObject({ nodeId: 'b', phase: 'failed', error: '找不到派发目标' })
  })
})

describe('一格失败先交回', () => {
  const temp = (id: string, task: string, extra: Partial<PlanNode> = {}): PlanNode =>
    node(id, task, { target: { kind: 'temp', name: id.toUpperCase() }, ...extra })
  const graph = (): PlanNode[] => [
    temp('a', '做 A'),
    temp('b', '做 B'),
    temp('c', '做 C'),
    temp('d', '做 D', { needs: ['b'] }),
    { id: 'cp', kind: 'checkpoint', label: '审查', needs: ['a', 'b', 'c', 'd'] },
  ]
  const never = () => new Promise<never>(() => {})
  const failedB: NodeResult = {
    nodeId: 'b',
    subagentId: 'cv_b',
    label: 'B',
    status: 'failed',
    output: '',
    error: '接口连不上',
    durationMs: 1,
  }
  const skippedD: NodeResult = {
    nodeId: 'd',
    label: 'D',
    status: 'skipped',
    output: '',
    error: '上游节点未成功',
    durationMs: 0,
  }
  const doneOf = (id: string): NodeResult => ({
    nodeId: id,
    subagentId: `cv_${id}`,
    label: id.toUpperCase(),
    status: 'done',
    output: `${id} 的产出`,
    durationMs: 1,
  })

  /** 父会话拿到失败的唯一出口是调用返回：失败的与被它拖累的先交回，其余格照跑。 */
  test('并行批里一格失败、其余还在跑时立即返回，回执只含已落的', async () => {
    const d = deps(async (label) =>
      label === 'B' ? { ok: false, output: '', error: '接口连不上', subagentId: 'cv_b' } : never(),
    )
    const res = await new TeamOrchestrator(graph(), d.deps, KNOWN).run('目标')
    expect(res.phase).toBe('waiting_review')
    expect(res.checkpointId).toBe('cp')
    expect(res.receipts.map((r) => [r.nodeId, r.status])).toEqual([
      ['b', 'failed'],
      ['d', 'skipped'],
    ])
    expect(res.running?.sort()).toEqual(['a', 'c'])
    expect(d.order.sort()).toEqual(['A', 'B', 'C'])
  })

  /** 下一次调用汇合还在跑的格：不重派、不重写它的状态，等它的回执。 */
  test('下一次调用汇合还在跑的格，回执齐了才到检查点', async () => {
    const d = deps(async () => ({ ok: true, output: '不该重派' }))
    const joined: string[] = []
    d.deps.join = async ({ nodeId, subagentId }) => {
      joined.push(`${nodeId}:${subagentId}`)
      return { ok: true, output: `${nodeId} 的产出`, subagentId }
    }
    const res = await new TeamOrchestrator(graph(), d.deps, KNOWN).run('目标', {
      results: { b: failedB, d: skippedD },
      states: {
        a: { phase: 'working', label: 'A', subagentId: 'cv_a' as never },
        b: { phase: 'failed', label: 'B', subagentId: 'cv_b' as never, error: '接口连不上' },
        c: { phase: 'done', label: 'C', subagentId: 'cv_c' as never },
        d: { phase: 'skipped', label: 'D' },
      },
      approvals: {},
      checkpointId: 'cp',
    })
    expect(d.order).toEqual([])
    expect(joined.sort()).toEqual(['a:cv_a', 'c:cv_c'])
    expect(d.events.filter((e) => e.phase === 'waiting')).toEqual([])
    expect(res.phase).toBe('waiting_review')
    expect(res.checkpointId).toBe('cp')
    expect(res.running).toBeUndefined()
    expect(res.receipts.map((r) => [r.nodeId, r.status, r.subagentId]).sort()).toEqual([
      ['a', 'done', 'cv_a'],
      ['c', 'done', 'cv_c'],
    ])
  })

  /** 进程内没有它时不编回执：格已失败的用格上的原因，其余说明回执没送到，都带子 agent id 供续接。 */
  test('汇合不到的格按格上的事实出回执', async () => {
    const d = deps(async () => ({ ok: true, output: '不该重派' }))
    const res = await new TeamOrchestrator(graph(), d.deps, KNOWN).run('目标', {
      results: { b: doneOf('b'), d: doneOf('d') },
      states: {
        a: { phase: 'failed', label: 'A', subagentId: 'cv_a' as never, error: '模型服务出错' },
        c: { phase: 'done', label: 'C', subagentId: 'cv_c' as never },
      },
      approvals: {},
      checkpointId: 'cp',
    })
    expect(d.order).toEqual([])
    const byId = Object.fromEntries(res.receipts.map((r) => [r.nodeId, r]))
    expect(byId.a).toMatchObject({ status: 'failed', error: '模型服务出错', subagentId: 'cv_a' })
    expect(byId.c).toMatchObject({ status: 'failed', subagentId: 'cv_c' })
    expect(byId.c?.error).toContain('回执没有送达')
    expect(res.phase).toBe('waiting_review')
  })

  test('上游还在跑时 approve 被拒，理由列出还在跑的节点', async () => {
    const d = deps(ok)
    await expect(
      new TeamOrchestrator(graph(), d.deps, KNOWN).run('目标', {
        results: { b: failedB, d: skippedD },
        states: { a: { phase: 'working', label: 'A', subagentId: 'cv_a' as never } },
        approvals: {},
        checkpointId: 'cp',
        review: { checkpointId: 'cp', decision: 'approve', note: '接受', revisions: [] },
      }),
    ).rejects.toThrow('检查点 cp 的上游回执尚未齐全：a、c（a 还在跑）')
  })

  test('还在跑的节点不能修订，它的上游也不能', async () => {
    const d = deps(ok)
    await expect(
      new TeamOrchestrator(graph(), d.deps, KNOWN).run('目标', {
        results: { b: failedB, d: skippedD },
        states: { a: { phase: 'working', label: 'A', subagentId: 'cv_a' as never } },
        approvals: {},
        checkpointId: 'cp',
        review: {
          checkpointId: 'cp',
          decision: 'revise',
          note: '改',
          revisions: [{ nodeId: 'a', instruction: '换个做法' }],
        },
      }),
    ).rejects.toThrow('节点 a 还在跑，等它的回执再修订')
    await expect(
      new TeamOrchestrator(graph(), d.deps, KNOWN).run('目标', {
        results: { b: failedB },
        states: { d: { phase: 'working', label: 'D', subagentId: 'cv_d' as never } },
        approvals: {},
        checkpointId: 'cp',
        review: {
          checkpointId: 'cp',
          decision: 'revise',
          note: '改',
          revisions: [{ nodeId: 'b', instruction: '重做' }],
        },
      }),
    ).rejects.toThrow('节点 d 还在跑，等它的回执再修订它的上游')
  })

  test('被中断时还没派出的格标成中断', async () => {
    const controller = new AbortController()
    controller.abort()
    const d = deps(async () => ({ ok: true, output: '不该执行' }))
    const res = await new TeamOrchestrator(
      graph(),
      { ...d.deps, signal: controller.signal },
      KNOWN,
    ).run('目标')
    expect(res.phase).toBe('failed')
    expect(d.order).toEqual([])
    expect(d.events.filter((e) => e.phase === 'interrupted').map((e) => e.nodeId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
  })
})
