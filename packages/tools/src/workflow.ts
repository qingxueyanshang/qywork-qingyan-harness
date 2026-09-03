/**
 * 一张可暂停、可审查、可续发的 DAG。
 *
 * workflow 每次调用只推进到下一个 checkpoint 或结束。检查点回执回到当前
 * 会话后，由当前会话决定 approve 或 revise；续发仍使用同一个 workflowId。
 */
import type { ToolContext, ToolSpec } from '@qywork/agent'
import { DEFAULT_MAX_CONCURRENT, parseWorkflowCall, type WorkflowTransition } from '@qywork/core'

export const workflowTool: ToolSpec = {
  name: 'workflow',
  description:
    '把复杂任务按 DAG 分批交给子 agent。agent 节点按 needs 并行或串行执行；checkpoint 节点' +
    '把上一批回执交回当前会话审查。到 checkpoint 只代表本次调度返回，不代表整个 workflow 完成：' +
    '核验后必须再次调用本工具，用同一 workflowId 对该 checkpoint approve 或 revise。' +
    'revise 会向原子会话续发，approve 才启动下一批。' +
    '节点不指定 agent 就临时起一个子 agent（当前模型、全套工具），' +
    '指定则派给配置好的角色或 cli:<id> 的外部 CLI。' +
    '只派一件事用 subagent。用户明确要求先设计流程时，先用普通回复展示完整图并等待确认，' +
    '确认前不要调用本工具。',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '整个 workflow 的目标（首次调用）' },
      nodes: {
        type: 'array',
        description:
          '首次调用的 DAG 节点；直接传数组，不要传 JSON 字符串。agent 执行任务，checkpoint 将回执交回当前会话审查',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '节点唯一 ID' },
            kind: {
              type: ['string', 'null'],
              enum: ['agent', 'checkpoint', null],
              description: '默认 agent；checkpoint 是主会话审查关口',
            },
            agent: { type: 'string', description: '角色名或 cli:<id>；agent 节点可省略' },
            task: { type: 'string', description: 'agent 节点任务' },
            label: { type: 'string', description: 'checkpoint 显示名称' },
            needs: { type: 'array', items: { type: 'string' }, description: '依赖节点 ID' },
            passInput: { type: 'boolean', description: '是否把上游输出传入任务，默认 true' },
            provider: {
              type: 'string',
              description:
                '覆盖模型所属接口；填写 model 时逐字使用运行上下文「已配置模型」清单中同一行的 provider 参数',
            },
            model: {
              type: 'string',
              description:
                '该 agent 节点的模型覆盖；逐字使用运行上下文「已配置模型」清单中的 model 参数，并同时填写对应 provider',
            },
          },
          required: ['id'],
        },
      },
      maxConcurrent: {
        type: ['integer', 'null'],
        description:
          `同时最多跑几个 agent 节点，默认 ${DEFAULT_MAX_CONCURRENT}，超出的排队；` +
          '图里互不依赖的节点数多于它时按需调高。只在首次调用填写。',
      },
      workflowId: { type: 'string', description: '续接既有 workflow 时使用首次返回的 ID' },
      checkpointId: { type: 'string', description: '当前待审查 checkpoint ID' },
      decision: {
        type: ['string', 'null'],
        enum: ['approve', 'revise', null],
        description: 'approve 进入下一批；revise 向指定原子会话续发',
      },
      note: { type: 'string', description: '本次审批或修订说明' },
      revisions: {
        type: 'array',
        description: 'revise 时要向原节点续发的指令；直接传数组，不要传 JSON 字符串',
        items: {
          type: 'object',
          properties: {
            nodeId: { type: 'string' },
            instruction: { type: 'string' },
          },
          required: ['nodeId', 'instruction'],
        },
      },
    },
    required: [],
  },
  actionKind: 'run',
  objectLabel: '编排',
  category: 'session',
  facet: '协作',
  summary: '分批执行并由当前会话审查一张图',
  permissionEffect: 'execute',
  parallelSafe: false,
  targetExtractor: (args) => {
    const goal = typeof args.goal === 'string' ? args.goal : ''
    const workflowId = typeof args.workflowId === 'string' ? args.workflowId : ''
    return (goal || workflowId).slice(0, 200)
  },
  fn: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    if (!ctx?.delegate) return { status: 'failure', message: '本次执行没有派活通道' }
    if (!ctx.stepId) return { status: 'failure', message: '这次调用拿不到卡片 id，图没法画' }
    const parsed = parseWorkflowCall(args)
    if (!parsed.ok) return { status: 'failure', message: parsed.error }

    const res = await ctx.delegate.runGraph({
      call: parsed.call,
      runId: ctx.runId,
      stepId: ctx.stepId,
      signal: ctx.signal,
    })
    if (res.error) return { status: 'failure', message: `这张图跑不起来：${res.error}` }
    if (!res.transition) return { status: 'failure', message: 'Workflow 没有返回状态转移' }

    const transition = res.transition
    return {
      status: res.ok ? 'success' : 'failure',
      message: transitionMessage(transition),
      data: transition as unknown as Record<string, unknown>,
    }
  },
}

function transitionMessage(transition: WorkflowTransition): string {
  const count = transition.receipts.length
  if (transition.phase === 'waiting_review') {
    return (
      `本次调度已返回 ${count} 个回执；整个 workflow 尚未完成。` +
      ` workflowId=${transition.workflowId}，checkpointId=${transition.checkpointId}。` +
      '请核验回执后，再以 approve 或 revise 续接。'
    )
  }
  if (transition.phase === 'completed') return `Workflow 已完成，本次返回 ${count} 个回执`
  return `Workflow 执行失败，本次返回 ${count} 个回执`
}
