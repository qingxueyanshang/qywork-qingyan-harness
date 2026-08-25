/**
 * 一次交一整张图：拆成哪几件事、每件派给谁、哪些并行、哪些等上一步。
 *
 * **与 `subagent` 的分工。** 派一件事用 `subagent`；**几件事之间有先后依赖**才用这个。判据是「要不
 * 要把上一步的产出传给下一步」——要，就是一张图。
 *
 * 节点的目标与 `subagent` 同一套取值：不写 = 临时子 agent，写角色 id = 配置好的角色，
 * 写 `cli:<id>` = 本机的外部 CLI。一张图里三种可以混。
 *
 * **调度不在这里。** 图交出去之后由服务端的编排器按图跑：依赖就绪才启动、并发上限都在那边。
 * **模型不参与调度**——每完成一步再回来问「下一步派谁」的话，每次跑出来的形状都不同，
 * 出问题既不能复现也不能归因，界面上也画不出一张固定的图。
 *
 * **图卡靠 stepId 认领。** 进度事件带的是这次调用的 step id（`ctx.stepId`），前端据此把节点状态落到
 * 这张卡上。但**进度事件不落库**：刷新之后能重画这张图的只有这次调用的返回值，所以逐节点的终态
 * （含子会话 id）必须原样回在 `data.nodes` 里。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'

interface NodeArg {
  id: string
  agent: string
  task: string
  needs?: string[]
  passInput?: boolean
  model?: string
}

export const workflowTool: ToolSpec = {
  name: 'workflow',
  description:
    '把一件复杂的事拆成一张图交出去执行：节点之间用 needs 表达先后——' +
    '不写依赖的并行跑，写了的等上游做完并拿到它的产出。整张图跑完一次性回来，' +
    '逐节点带状态与产出。' +
    '节点不指定 agent 就临时起一个子 agent（当前模型、全套工具），' +
    '指定则派给配置好的角色或 cli:<id> 的外部 CLI。' +
    '只派一件事用 subagent。',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: '这张图整体要达成什么。节点任务里写 {goal} 会被替换成它。',
      },
      nodes: {
        type: 'array',
        description: '图的全部节点。至少一个。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '节点 id，图内唯一，被 needs 引用' },
            agent: {
              type: 'string',
              description:
                '派给谁。留空 = 临时起一个子 agent；角色 id = 配置好的角色；' +
                'cli:<id> = 本机的外部 CLI。',
            },
            task: {
              type: 'string',
              description:
                '要它做什么。子 agent 看不到这条会话，背景要写全。' +
                '写 {input} 决定上游产出插在哪里，不写则追加在末尾。',
            },
            needs: {
              type: 'array',
              items: { type: 'string' },
              description: '依赖的节点 id，全部做完本节点才开始',
            },
            passInput: {
              type: 'boolean',
              description: 'false = 依赖只管顺序，不把上游产出带给它。默认带。',
            },
            model: {
              type: 'string',
              description:
                '**只在用户点名了模型时才填**：写模型 id，同一个 id 挂在多个接口下时写 接口/模型。' +
                '不填 = 跟当前会话同一个模型。外部 CLI 节点填了会被拒。',
            },
          },
          required: ['id', 'task'],
          additionalProperties: false,
        },
      },
    },
    required: ['goal', 'nodes'],
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '编排',
  category: 'session',
  facet: '协作',
  summary: '把一张图交出去跑',
  targetExtractor: (a) => (typeof a.goal === 'string' ? a.goal : null),
  // 图里的每个节点最终都是一个子会话或一个本机进程，与 `subagent` 同一档。
  permissionEffect: 'execute',
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const delegate = ctx.delegate
    if (!delegate) {
      // 正常不会走到：没有这条通道时这个工具不注册。
      return { status: 'failure' as const, message: '本次执行没有派活通道' }
    }

    if (!ctx.stepId) {
      // 挂不上卡的进度事件到了前端是静默丢弃，那样图会一直停在「等着跑」。
      return { status: 'failure' as const, message: '这次调用拿不到卡片 id，图没法画' }
    }

    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    if (!goal) return { status: 'failure' as const, message: '这张图整体要达成什么，得写清楚' }

    const raw = Array.isArray(args.nodes) ? (args.nodes as Record<string, unknown>[]) : []
    if (raw.length === 0) return { status: 'failure' as const, message: '图里一个节点都没有' }

    const nodes: NodeArg[] = []
    for (const n of raw) {
      const id = typeof n.id === 'string' ? n.id.trim() : ''
      const task = typeof n.task === 'string' ? n.task.trim() : ''
      if (!id || !task) {
        return { status: 'failure' as const, message: '每个节点都要有 id 和 task' }
      }
      // 没写派给谁 = 临时子 agent。这个 id 在执行侧兜底成一条内置角色，
      // 用户自己定义了同 id 的角色时以他那条为准。
      const agent = typeof n.agent === 'string' && n.agent.trim() ? n.agent.trim() : 'ad-hoc'
      if (nodes.some((x) => x.id === id)) {
        return { status: 'failure' as const, message: `节点 id 重复：${id}` }
      }
      nodes.push({
        id,
        agent,
        task,
        ...(Array.isArray(n.needs) ? { needs: n.needs.map(String) } : {}),
        ...(n.passInput === false ? { passInput: false } : {}),
        ...(typeof n.model === 'string' && n.model.trim() ? { model: n.model.trim() } : {}),
      })
    }

    // 成环、悬空依赖、门禁引用不到角色由编排器那边校验：那三件事要拿到角色表才判得了，
    // 而角色表在服务端。这里只挡「一眼就知道写错了」的那几种。
    const res = await delegate.runGraph({
      goal,
      nodes,
      runId: ctx.runId,
      stepId: ctx.stepId,
      signal: ctx.signal,
    })

    if (res.error) {
      return { status: 'failure' as const, message: `这张图跑不起来：${res.error}` }
    }

    const done = res.nodes.filter((n) => n.status === 'done').length
    const failed = res.nodes.filter((n) => n.status === 'failed')
    const skipped = res.nodes.filter((n) => n.status === 'skipped').length
    const parts = [`${done} 个完成`]
    if (failed.length) parts.push(`${failed.length} 个失败`)
    if (skipped) parts.push(`${skipped} 个跳过`)

    return {
      // 有一个没做成就算这次工具调用失败：回 success 等于告诉模型整张图都跑通了，
      // 而它下一步很可能就建立在那个没做成的节点的产出上。
      status: res.ok ? ('success' as const) : ('failure' as const),
      message: `${res.nodes.length} 个节点：${parts.join(' · ')}`,
      data: { nodes: res.nodes },
    }
  },
}
