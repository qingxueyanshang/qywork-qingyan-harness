import { describe, expect, test } from 'bun:test'
import { DEFAULT_MAX_CONCURRENT } from '@qywork/core'
import { TeamOrchestrator, validatePlan } from './orchestrator.ts'
import type { NodeResult, Role, TeamConfig } from './types.ts'

function role(id: string): Role {
  return {
    id,
    name: id,
    description: id,
    systemPrompt: `你是 ${id}`,
  }
}

function deps(
  run: (agent: string, prompt: string) => Promise<{ ok: boolean; output: string }>,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
) {
  const order: string[] = []
  const prompts: string[] = []
  const events: Record<string, unknown>[] = []
  return {
    order,
    prompts,
    events,
    deps: {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      runId: 'rn_t' as never,
      maxConcurrent,
      emit: (event: Record<string, unknown>) => events.push(event),
      resolveCli: () => undefined,
      runBuiltin: async ({ role: r, prompt }: { role: Role; prompt: string }) => {
        order.push(r.id)
        prompts.push(prompt)
        return run(r.id, prompt)
      },
    },
  }
}

const ok = async (id: string) => ({ ok: true, output: `${id} 的产出` })

describe('计划校验', () => {
  test('引用不存在的角色直接拒绝', () => {
    expect(() => validatePlan([{ id: 'a', agent: 'nope', task: '' }], [role('dev')])).toThrow(
      /不存在的角色/,
    )
  })

  test('依赖不存在的节点直接拒绝', () => {
    expect(() =>
      validatePlan([{ id: 'a', agent: 'dev', task: '', needs: ['ghost'] }], [role('dev')]),
    ).toThrow(/不存在的节点/)
  })

  /**
   * 成环在运行时的表现是「一直没有可启动节点」——从这个现象倒推原因很费劲，
   * 所以必须在加载期报出确切的环路径。
   */
  test('循环依赖在加载期就报出环路径', () => {
    expect(() =>
      validatePlan(
        [
          { id: 'a', agent: 'dev', task: '', needs: ['c'] },
          { id: 'b', agent: 'dev', task: '', needs: ['a'] },
          { id: 'c', agent: 'dev', task: '', needs: ['b'] },
        ],
        [role('dev')],
      ),
    ).toThrow(/循环依赖/)
  })

  test('节点 id 重复直接拒绝', () => {
    expect(() =>
      validatePlan(
        [
          { id: 'a', agent: 'dev', task: '' },
          { id: 'a', agent: 'dev', task: '' },
        ],
        [role('dev')],
      ),
    ).toThrow(/重复/)
  })

  test('不允许有分支绕过主会话检查点', () => {
    expect(() =>
      validatePlan(
        [
          { id: 'a', agent: 'dev', task: '第一批' },
          { id: 'cp', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
          { id: 'b', agent: 'dev', task: '没有经过检查点' },
        ],
        [role('dev')],
      ),
    ).toThrow(/绕过检查点/)
  })
})

describe('编排执行', () => {
  test('节点的 provider 与 model 两列原样交给内置执行器', async () => {
    const seen: Array<{ provider?: string; model?: string }> = []
    const config: TeamConfig = {
      name: 'model-pair',
      roles: [role('实现')],
      plan: [
        {
          id: 'impl',
          agent: '实现',
          task: '实现',
          provider: '官方/中转',
          model: 'anthropic/claude-opus-5',
        },
      ],
    }
    const d = {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      runId: 'rn_model_pair' as never,
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      emit: () => {},
      resolveCli: () => undefined,
      runBuiltin: async (input: { provider?: string; model?: string }) => {
        seen.push({
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
        })
        return { ok: true, output: '完成' }
      },
    }

    await new TeamOrchestrator(config, d as never).run('目标')

    expect(seen).toEqual([{ provider: '官方/中转', model: 'anthropic/claude-opus-5' }])
  })

  test('按依赖顺序执行，上游产出注入下游', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('设计'), role('实现')],
      plan: [
        { id: 'design', agent: '设计', task: '设计：{goal}' },
        { id: 'impl', agent: '实现', task: '实现，参考：{input}', needs: ['design'] },
      ],
    }
    const d = deps(ok)
    const { receipts: results } = await new TeamOrchestrator(config, d.deps as never).run(
      '做个登录页',
    )

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
    const config: TeamConfig = {
      name: 't',
      roles: [role('设计'), role('评审')],
      plan: [
        { id: 'design', agent: '设计', task: '设计：{goal}' },
        { id: 'review', agent: '评审', task: '复核一下', needs: ['design'] },
      ],
    }
    const d = deps(ok)
    await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(d.prompts[1]).toContain('复核一下')
    expect(d.prompts[1]).toContain('设计 的产出')
  })

  test('passInput: false 时依赖只管顺序，不传产出', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('构建'), role('测试')],
      plan: [
        { id: 'build', agent: '构建', task: '构建' },
        { id: 'test', agent: '测试', task: '跑测试', needs: ['build'], passInput: false },
      ],
    }
    const d = deps(ok)
    await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(d.order).toEqual(['构建', '测试'])
    expect(d.prompts[1]).not.toContain('构建 的产出')
  })

  /**
   * 复现的失败形状：图里写了一个 `cli:` 节点，而那台机器上没装它。
   * 整张图不该起不来，也不该退回内置模型冒充它——只有那一个节点失败。
   */
  test('指向没识别到的外部 CLI 时只失败那一个节点', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('dev')],
      plan: [
        { id: 'a', agent: 'dev', task: '执行任务' },
        { id: 'b', agent: 'cli:nope', task: '交给外面那位' },
      ],
    }
    const d = deps(ok)
    const { receipts: results } = await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(results.find((r) => r.nodeId === 'a')?.status).toBe('done')
    const failed = results.find((r) => r.nodeId === 'b')!
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('nope')
    // 没有落到内置执行上：内置只跑了角色那一个节点。
    expect(d.order).toEqual(['dev'])
  })

  test('没有上游时不留空的「上游产出」小节', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('dev')],
      plan: [{ id: 'a', agent: 'dev', task: '执行任务' }],
    }
    const d = deps(ok)
    await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(d.prompts[0]).not.toContain('上游产出')
  })

  test('公共规则追加到每个角色的提示词', async () => {
    const config: TeamConfig = {
      name: 't',
      rules: { shared: '禁止修改 CI 配置' },
      roles: [role('dev')],
      plan: [{ id: 'a', agent: 'dev', task: '执行任务' }],
    }
    const d = deps(ok)
    await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(d.prompts[0]).toContain('禁止修改 CI 配置')
  })

  /**
   * 上游失败时下游必须跳过而不是照跑：拿着失败的上游输出继续，
   * 产出的是看起来合理实则无根的结果，比直接失败更难发现。
   */
  test('上游失败时下游跳过，不拿着坏输入继续', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('a'), role('b')],
      plan: [
        { id: 'n1', agent: 'a', task: 'x' },
        { id: 'n2', agent: 'b', task: 'y', needs: ['n1'] },
      ],
    }
    const d = deps(async (id) =>
      id === 'a' ? { ok: false, output: '' } : { ok: true, output: 'ok' },
    )
    const { receipts: results } = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(byId(results, 'n1').status).toBe('failed')
    expect(byId(results, 'n2').status).toBe('skipped')
    // 角色 b 不该被调用。
    expect(d.order).toEqual(['a'])
  })

  test('无依赖的节点可并行，受调用参数 maxConcurrent 限制', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('r')],
      plan: [
        { id: 'a', agent: 'r', task: '1' },
        { id: 'b', agent: 'r', task: '2' },
        { id: 'c', agent: 'r', task: '3' },
        { id: 'd', agent: 'r', task: '4' },
      ],
    }
    let inFlight = 0
    let peak = 0
    const d = deps(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(20)
      inFlight--
      return { ok: true, output: 'x' }
    }, 2)
    const { receipts: results } = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(results.filter((r) => r.status === 'done')).toHaveLength(4)
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('调用参数把并发放宽到 5 时五个节点同时启动', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('r')],
      plan: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, agent: 'r', task: id })),
    }
    let inFlight = 0
    let peak = 0
    const d = deps(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(20)
      inFlight--
      return { ok: true, output: 'x' }
    }, 5)

    const { receipts } = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(receipts).toHaveLength(5)
    expect(peak).toBe(5)
    expect(d.events.some((event) => event.phase === 'queued')).toBe(false)
  })

  test('未配置并发闸时四个节点同时启动，超出的节点明确报等待槽位', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('r')],
      plan: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, agent: 'r', task: id })),
    }
    let inFlight = 0
    let peak = 0
    const d = deps(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(20)
      inFlight--
      return { ok: true, output: 'x' }
    })

    const { receipts } = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(receipts).toHaveLength(5)
    expect(peak).toBe(4)
    expect(d.events).toContainEqual(
      expect.objectContaining({ type: 'team.member', memberId: 'e', phase: 'queued' }),
    )
    expect(d.events).toContainEqual(
      expect.objectContaining({ type: 'team.member', memberId: 'e', phase: 'working' }),
    )
  })
})

describe('主会话检查点', () => {
  const plan: TeamConfig = {
    name: 'checkpoint',
    roles: [role('r')],
    plan: [
      { id: 'a', agent: 'r', task: '查 A' },
      { id: 'b', agent: 'r', task: '查 B' },
      { id: 'review', kind: 'checkpoint', label: '主会话审查', needs: ['a', 'b'] },
      { id: 'c', agent: 'r', task: '汇总 {input}', needs: ['review'] },
    ],
  }

  test('首批并行回执齐后暂停，approve 才启动下一批', async () => {
    const calls: string[] = []
    const deps = {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      runId: 'rn_checkpoint' as never,
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      emit: () => {},
      resolveCli: () => undefined,
      runBuiltin: async ({ prompt }: { prompt: string }) => {
        calls.push(prompt)
        return { ok: true, output: `结果 ${calls.length}`, conversationId: `cv_${calls.length}` }
      },
    }
    const first = await new TeamOrchestrator(plan, deps as never).run('完成目标')
    expect(first.phase).toBe('waiting_review')
    expect(first.checkpointId).toBe('review')
    expect(first.receipts.map((receipt) => receipt.nodeId).sort()).toEqual(['a', 'b'])
    expect(calls).toHaveLength(2)

    const results = Object.fromEntries(first.receipts.map((receipt) => [receipt.nodeId, receipt]))
    const second = await new TeamOrchestrator(plan, deps as never).run('完成目标', {
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
    expect(second.phase).toBe('completed')
    expect(second.review?.decision).toBe('approve')
    expect(second.receipts.map((receipt) => receipt.nodeId)).toEqual(['c'])
    expect(calls[2]).toContain('回执合格')
    expect(calls[2]).toContain('结果 1')
    expect(calls[2]).toContain('结果 2')
  })

  test('revise 向原子会话续发，并让本批下游在原会话重跑', async () => {
    const chain: TeamConfig = {
      name: 'revise',
      roles: [role('r')],
      plan: [
        { id: 'a', agent: 'r', task: '先研究' },
        { id: 'b', agent: 'r', task: '再复核 {input}', needs: ['a'] },
        { id: 'review', kind: 'checkpoint', label: '主会话审查', needs: ['b'] },
      ],
    }
    const resumed: Array<{ prompt: string; existing?: string }> = []
    let fresh = 0
    const deps = {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      runId: 'rn_revise' as never,
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      emit: () => {},
      resolveCli: () => undefined,
      runBuiltin: async (input: { prompt: string; existingConversationId?: string }) => {
        resumed.push({
          prompt: input.prompt,
          ...(input.existingConversationId ? { existing: input.existingConversationId } : {}),
        })
        if (!input.existingConversationId) {
          fresh += 1
          return { ok: true, output: `初稿 ${fresh}`, conversationId: `cv_${fresh}` }
        }
        return {
          ok: true,
          output: input.existingConversationId === 'cv_1' ? '修订稿' : '复核新版',
          conversationId: input.existingConversationId,
        }
      },
    }
    const first = await new TeamOrchestrator(chain, deps as never).run('目标')
    const results = Object.fromEntries(first.receipts.map((receipt) => [receipt.nodeId, receipt]))
    const second = await new TeamOrchestrator(chain, deps as never).run('目标', {
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
    expect(resumed.slice(-2).map((call) => call.existing)).toEqual(['cv_1', 'cv_2'])
    expect(resumed.at(-2)?.prompt).toContain('补充两条可核验证据')
    expect(resumed.at(-1)?.prompt).toContain('修订稿')
    expect(second.receipts.map((receipt) => receipt.conversationId)).toEqual(['cv_1', 'cv_2'])
  })

  test('上一轮缺少 conversationId 时明确失败，不偷偷新建会话', async () => {
    let calls = 0
    const deps = {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      runId: 'rn_missing_handle' as never,
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      emit: () => {},
      resolveCli: () => undefined,
      runBuiltin: async () => {
        calls += 1
        return { ok: true, output: '不该执行' }
      },
    }
    const result = await new TeamOrchestrator(
      {
        name: 'missing',
        roles: [role('r')],
        plan: [
          { id: 'a', agent: 'r', task: '研究' },
          { id: 'review', kind: 'checkpoint', label: '审查', needs: ['a'] },
        ],
      },
      deps as never,
    ).run('目标', {
      results: {
        a: {
          nodeId: 'a',
          agent: 'r',
          label: 'r',
          status: 'done',
          output: '旧稿',
          durationMs: 1,
        },
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
    expect(result.receipts[0]?.error).toContain('没有可续接子会话')
    expect(calls).toBe(0)
  })

  test('外部 CLI 没有 resumeArgs 时明确失败，不另起新进程', async () => {
    const deps = {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      runId: 'rn_cli_no_resume' as never,
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      emit: () => {},
      resolveCli: () => ({
        id: 'plain',
        vendor: 'Plain',
        command: 'plain',
        args: ['{prompt}'],
        output: 'text' as const,
      }),
      runBuiltin: async () => ({ ok: true, output: '不该执行' }),
    }
    const result = await new TeamOrchestrator(
      {
        name: 'cli-no-resume',
        roles: [],
        plan: [
          { id: 'a', agent: 'cli:plain', task: '研究' },
          { id: 'review', kind: 'checkpoint', label: '审查', needs: ['a'] },
        ],
      },
      deps,
    ).run('目标', {
      results: {
        a: {
          nodeId: 'a',
          agent: 'cli:plain',
          label: 'Plain plain',
          status: 'done',
          output: '旧稿',
          durationMs: 1,
          session: 'sess_old',
        },
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
    expect(result.receipts[0]?.error).toContain('没有可续接会话')
    expect(result.receipts[0]?.session).toBe('sess_old')
  })
})

function byId(results: NodeResult[], id: string): NodeResult {
  const r = results.find((x) => x.nodeId === id)
  if (!r) throw new Error(`没有节点 ${id}`)
  return r
}

/**
 * 成员子会话的 id 要带出去。
 *
 * 子会话打了 `source: 'workflow'`，不进会话列表——**`team.member` 事件里的这个 id
 * 是它唯一的入口**。断在这一环的表现最难查：面板照常显示「完成」，
 * 只是那个成员读了什么、跑了哪些命令永远看不到，而且没有任何报错。
 */
describe('成员子会话', () => {
  function collect(run: (agent: string) => Promise<Record<string, unknown>>) {
    const events: Record<string, unknown>[] = []
    return {
      events,
      deps: {
        workspaceRoot: '/tmp',
        signal: new AbortController().signal,
        runId: 'rn_t' as never,
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
        emit: (e: Record<string, unknown>) => events.push(e),
        runBuiltin: async ({ role: r }: { role: Role }) => run(r.id),
      },
    }
  }

  const cfg: TeamConfig = {
    name: 't',
    roles: [role('dev')],
    plan: [{ id: 'n1', agent: 'dev', task: '执行任务' }],
  }

  test('内置后端返回了会话 id，就出现在 done 事件上', async () => {
    const { events, deps: d } = collect(async (id) => ({
      ok: true,
      output: `${id} 的产出`,
      conversationId: 'cv_child',
    }))
    await new TeamOrchestrator(cfg, d as never).run('目标')
    const done = events.find((e) => e.phase === 'done')
    expect(done?.childConversationId).toBe('cv_child')
  })

  /** 没有子会话时这个键必须**缺席**，不是 undefined：界面据它判断这行能不能点。 */
  test('没有子会话时不带这个键', async () => {
    const { events, deps: d } = collect(async (id) => ({ ok: true, output: `${id} 的产出` }))
    await new TeamOrchestrator(cfg, d as never).run('目标')
    const done = events.find((e) => e.phase === 'done')
    expect('childConversationId' in (done ?? {})).toBe(false)
  })
})
