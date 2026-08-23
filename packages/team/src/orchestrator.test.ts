import { describe, expect, test } from 'bun:test'
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
  opts: { gate?: boolean } = {},
) {
  const order: string[] = []
  const prompts: string[] = []
  return {
    order,
    prompts,
    deps: {
      workspaceRoot: '/tmp',
      signal: new AbortController().signal,
      runId: 'rn_t' as never,
      emit: () => {},
      awaitHumanGate: async () => opts.gate ?? true,
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
})

describe('编排执行', () => {
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
    const results = await new TeamOrchestrator(config, d.deps as never).run('做个登录页')

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
        { id: 'a', agent: 'dev', task: '干活' },
        { id: 'b', agent: 'cli:nope', task: '交给外面那位' },
      ],
    }
    const d = deps(ok)
    const results = await new TeamOrchestrator(config, d.deps as never).run('目标')
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
      plan: [{ id: 'a', agent: 'dev', task: '干活' }],
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
      plan: [{ id: 'a', agent: 'dev', task: '干活' }],
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
    const results = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(byId(results, 'n1').status).toBe('failed')
    expect(byId(results, 'n2').status).toBe('skipped')
    // 角色 b 根本不该被调用。
    expect(d.order).toEqual(['a'])
  })

  test('人工门禁未通过则该节点跳过且不执行', async () => {
    const config: TeamConfig = {
      name: 't',
      // 门禁按**目标**认，不按节点 id：图由模型现画，节点 id 是它当场拟的。
      rules: { humanGates: ['dev'] },
      roles: [role('dev')],
      plan: [{ id: 'risky', agent: 'dev', task: '删库' }],
    }
    const d = deps(ok, { gate: false })
    const results = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(byId(results, 'risky').status).toBe('skipped')
    // 门禁在执行前问：拒绝之后不能已经跑过了。
    expect(d.order).toEqual([])
  })

  /**
   * 复现的失败形状：门禁原来按节点 id 认，而模型现画的图里节点 id 每次都不同——
   * 于是配了门禁的人要么每次撞「引用了不存在的节点」，要么那条门禁静默失效。
   * 按目标认之后，同一个角色的每个节点都被拦住，图怎么画都命中。
   */
  test('门禁按目标认：同一个角色的每个节点都要过', async () => {
    const config: TeamConfig = {
      name: 't',
      rules: { humanGates: ['deployer'] },
      roles: [role('dev'), role('deployer')],
      plan: [
        { id: 'a', agent: 'dev', task: '写' },
        { id: 'b', agent: 'deployer', task: '发一次', needs: ['a'] },
        { id: 'c', agent: 'deployer', task: '再发一次', needs: ['a'] },
      ],
    }
    const d = deps(ok, { gate: false })
    const results = await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(byId(results, 'a').status).toBe('done')
    expect(byId(results, 'b').status).toBe('skipped')
    expect(byId(results, 'c').status).toBe('skipped')
    expect(d.order).toEqual(['dev'])
  })

  test('门禁引用不存在的角色当场拒绝', () => {
    expect(() =>
      validatePlan([{ id: 'a', agent: 'dev', task: '' }], [role('dev')], {
        humanGates: ['查无此人'],
      }),
    ).toThrow(/不存在的角色/)
  })

  test('无依赖的节点可并行，受 maxConcurrent 限制', async () => {
    const config: TeamConfig = {
      name: 't',
      rules: { maxConcurrent: 2 },
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
    })
    const results = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(results.filter((r) => r.status === 'done')).toHaveLength(4)
    expect(peak).toBeLessThanOrEqual(2)
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
 * 只是那个成员到底读了什么、跑了哪些命令永远看不到，而且没有任何报错。
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
        emit: (e: Record<string, unknown>) => events.push(e),
        awaitHumanGate: async () => true,
        runBuiltin: async ({ role: r }: { role: Role }) => run(r.id),
      },
    }
  }

  const cfg: TeamConfig = {
    name: 't',
    roles: [role('dev')],
    plan: [{ id: 'n1', agent: 'dev', task: '干活' }],
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
