import { describe, expect, test } from 'bun:test'
import { TeamOrchestrator, validatePlan } from './orchestrator.ts'
import type { NodeResult, Role, TeamConfig } from './types.ts'

function role(id: string): Role {
  return {
    id,
    name: id,
    description: id,
    systemPrompt: `你是 ${id}`,
    backend: { kind: 'builtin' },
  }
}

function deps(
  run: (roleId: string, prompt: string) => Promise<{ ok: boolean; output: string }>,
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
    expect(() => validatePlan([{ id: 'a', roleId: 'nope', task: '' }], [role('dev')])).toThrow(
      /不存在的角色/,
    )
  })

  test('依赖不存在的节点直接拒绝', () => {
    expect(() =>
      validatePlan([{ id: 'a', roleId: 'dev', task: '', needs: ['ghost'] }], [role('dev')]),
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
          { id: 'a', roleId: 'dev', task: '', needs: ['c'] },
          { id: 'b', roleId: 'dev', task: '', needs: ['a'] },
          { id: 'c', roleId: 'dev', task: '', needs: ['b'] },
        ],
        [role('dev')],
      ),
    ).toThrow(/循环依赖/)
  })

  test('节点 id 重复直接拒绝', () => {
    expect(() =>
      validatePlan(
        [
          { id: 'a', roleId: 'dev', task: '' },
          { id: 'a', roleId: 'dev', task: '' },
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
        { id: 'design', roleId: '设计', task: '设计：{goal}' },
        { id: 'impl', roleId: '实现', task: '实现，参考：{input}', needs: ['design'] },
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
        { id: 'design', roleId: '设计', task: '设计：{goal}' },
        { id: 'review', roleId: '评审', task: '复核一下', needs: ['design'] },
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
        { id: 'build', roleId: '构建', task: '构建' },
        { id: 'test', roleId: '测试', task: '跑测试', needs: ['build'], passInput: false },
      ],
    }
    const d = deps(ok)
    await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(d.order).toEqual(['构建', '测试'])
    expect(d.prompts[1]).not.toContain('构建 的产出')
  })

  test('没有上游时不留空的「上游产出」小节', async () => {
    const config: TeamConfig = {
      name: 't',
      roles: [role('dev')],
      plan: [{ id: 'a', roleId: 'dev', task: '干活' }],
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
      plan: [{ id: 'a', roleId: 'dev', task: '干活' }],
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
        { id: 'n1', roleId: 'a', task: 'x' },
        { id: 'n2', roleId: 'b', task: 'y', needs: ['n1'] },
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
      rules: { humanGates: ['risky'] },
      roles: [role('dev')],
      plan: [{ id: 'risky', roleId: 'dev', task: '删库' }],
    }
    const d = deps(ok, { gate: false })
    const results = await new TeamOrchestrator(config, d.deps as never).run('目标')

    expect(byId(results, 'risky').status).toBe('skipped')
    // 门禁在执行前问：拒绝之后不能已经跑过了。
    expect(d.order).toEqual([])
  })

  test('无依赖的节点可并行，受 maxConcurrent 限制', async () => {
    const config: TeamConfig = {
      name: 't',
      rules: { maxConcurrent: 2 },
      roles: [role('r')],
      plan: [
        { id: 'a', roleId: 'r', task: '1' },
        { id: 'b', roleId: 'r', task: '2' },
        { id: 'c', roleId: 'r', task: '3' },
        { id: 'd', roleId: 'r', task: '4' },
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

  test('没有 plan 时退化成单角色直跑', async () => {
    const config: TeamConfig = { name: 't', roles: [role('solo')] }
    const d = deps(ok)
    const results = await new TeamOrchestrator(config, d.deps as never).run('目标')
    expect(d.order).toEqual(['solo'])
    expect(results).toHaveLength(1)
  })
})

function byId(results: NodeResult[], id: string): NodeResult {
  const r = results.find((x) => x.nodeId === id)
  if (!r) throw new Error(`没有节点 ${id}`)
  return r
}
