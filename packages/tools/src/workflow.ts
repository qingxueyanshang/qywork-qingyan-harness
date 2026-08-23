/**
 * 一次交一整张图：拆成哪几件事、每件派给谁、哪些并行、哪些等上一步。
 *
 * ## 与 `subagent` 的分工
 *
 * 派一件事用 `subagent`；**几件事之间有先后依赖**才用这个。判据是「要不要把上一步的
 * 产出喂给下一步」——要，就是一张图。
 *
 * ## 调度不在这里
 *
 * 图交出去之后由服务端的编排器按图跑：依赖就绪才启动、并发上限、人工门禁都在那边。
 * **模型不参与调度**——每完成一步再回来问「下一步派谁」的话，每次跑出来的形状都不同，
 * 出问题既不能复现也不能归因，界面上也画不出一张固定的图。
 *
 * ## 图卡靠 stepId 认领
 *
 * 进度事件带的是这次调用的 step id（`ctx.stepId`），前端据此把节点状态落到这张卡上。
 * 但**进度事件不落库**：刷新之后能重画这张图的只有这次调用的返回值，
 * 所以逐节点的终态（含子会话 id）必须原样回在 `data.nodes` 里。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'

interface NodeArg {
  id: string
  agent: string
  task: string
  needs?: string[]
  passInput?: boolean
}

export const workflowTool: ToolSpec = {
  name: 'workflow',
  description:
    '把一件复杂的事拆成一张图交出去执行：每个节点派给一个子 agent 或本机的外部 CLI，' +
    '节点之间用 needs 表达先后——不写依赖的并行跑，写了的等上游做完并拿到它的产出。' +
    '整张图跑完一次性回来，逐节点带状态与产出。' +
    '只派一件事用 subagent；能派给谁用不带参数的 subagent 查。',
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
              description: '派给谁：角色 id，或 cli:<id> 指一个本机识别到的外部 CLI',
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
          },
          required: ['id', 'agent', 'task'],
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
      // 正常不会走到：没有这条通道时这个工具压根不注册。
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
      const agent = typeof n.agent === 'string' ? n.agent.trim() : ''
      const task = typeof n.task === 'string' ? n.task.trim() : ''
      if (!id || !agent || !task) {
        return { status: 'failure' as const, message: '每个节点都要有 id、agent 和 task' }
      }
      if (nodes.some((x) => x.id === id)) {
        return { status: 'failure' as const, message: `节点 id 重复：${id}` }
      }
      nodes.push({
        id,
        agent,
        task,
        ...(Array.isArray(n.needs) ? { needs: n.needs.map(String) } : {}),
        ...(n.passInput === false ? { passInput: false } : {}),
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
      // 有一个没做成就算这次工具调用失败：回 success 会让模型以为整张图都跑通了，
      // 而它下一步很可能就建立在那个没做成的节点的产出上。
      status: res.ok ? ('success' as const) : ('failure' as const),
      message: `${res.nodes.length} 个节点：${parts.join(' · ')}`,
      data: { nodes: res.nodes },
    }
  },
}
