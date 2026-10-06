/**
 * 一张可暂停、可审查、可续发的 DAG。
 *
 * 每次调用只派发此刻就绪的节点，随即返回。节点执行完毕的回执、到达检查点的回执都由派发通道
 * 作为消息送入当前会话；当前会话据此决定 approve 或 revise，续发仍使用同一个 workflowId。
 */
import type { ToolContext, ToolSpec } from '@qywork/agent'
import { DEFAULT_MAX_CONCURRENT, parseWorkflowCall, type WorkflowTransition } from '@qywork/core'

export const workflowTool: ToolSpec = {
  name: 'workflow',
  description:
    '把两个及以上子 agent 的任务按 DAG 一次提交。子 agent 节点按 needs 并行或串行执行，' +
    'checkpoint 节点把上一批回执交回当前会话。' +
    '调用只派发此刻就绪的节点，派发后立即返回：每个节点执行完毕的回执、节点失败的回执、到达 checkpoint 的回执都会作为消息送到本会话，不要为了等回执反复调用。' +
    '收到 checkpoint 回执后用同一 workflowId 对该 checkpoint approve（进入下一批）或 revise' +
    '（让指定的节点在其原有子会话中继续，只发送修订指令与最新上游产出），批准之后仍可 revise。' +
    '两种调用各自的参数：首次派发只带 goal、nodes、maxConcurrent；审查只带 workflowId、checkpointId、decision、note、revisions。' +
    'checkpoint 的连接方式：并行的子 agent 节点共用一个 checkpoint（needs 列出全部这些节点），而不是每个节点各连接一个；' +
    'checkpoint 之间串成一条链；每个子 agent 节点都要位于某个 checkpoint 的上游。不符合该规则的图在加载期被拒绝。' +
    '节点按 kind 新建：role 按角色 id 新建、temp 为临时子 agent（name 必填）、cli 为外部 CLI；指向本会话已有子 agent 的节点填 subagent。',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: '整个 workflow 的目标（首次调用）' },
      nodes: {
        type: 'array',
        description:
          '首次调用的 DAG 节点，直接传数组（不是 JSON 字符串）。子 agent 节点执行任务，checkpoint 节点把回执交回当前会话审查',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '节点唯一 ID' },
            kind: {
              type: ['string', 'null'],
              enum: ['role', 'temp', 'cli', 'checkpoint', null],
              description:
                '节点种类。role：按角色库里的角色新建子 agent，同时填 role；temp：新建临时子 agent，同时填 name；' +
                'cli：外部 CLI，同时填 cli；checkpoint：当前会话审查关口。指向本会话已有子 agent 时不填 kind，改填 subagent。',
            },
            role: {
              type: 'string',
              description: '角色 id，运行上下文「角色」清单里的一项。kind 为 role 时填',
            },
            name: {
              type: 'string',
              description:
                '子 agent 的名称。kind 为 temp 时必填；role / cli 可选，不填时使用角色名或 CLI 名',
            },
            cli: {
              type: 'string',
              description: '外部 CLI 的 id，运行上下文清单里的一项。kind 为 cli 时填',
            },
            subagent: {
              type: 'string',
              description:
                '本会话已有子 agent 的 id。填写后该节点在该子 agent 的上下文中继续，不再填 kind、role、name、cli',
            },
            task: { type: 'string', description: '子 agent 节点任务' },
            label: { type: 'string', description: 'checkpoint 显示名称' },
            needs: { type: 'array', items: { type: 'string' }, description: '依赖节点 ID' },
            passInput: { type: 'boolean', description: '是否把上游输出传入任务，默认 true' },
            provider: {
              type: 'string',
              description:
                '与 model 同一行的 provider 参数，逐字取自运行上下文「已配置模型」清单；填写 model 时必须同时填写',
            },
            model: {
              type: 'string',
              description:
                '仅在用户指定模型时填写：逐字使用运行上下文「已配置模型」清单中的 model 参数，并同时填写 provider。' +
                '写在 task 正文里不生效，子 agent 不会自行切换模型。' +
                '不填 = 使用当前会话的模型（角色指定了模型时使用角色的模型）；指向已有子 agent 或外部 CLI 的节点不接受',
            },
          },
          required: ['id'],
        },
      },
      maxConcurrent: {
        type: ['integer', 'null'],
        description:
          `同时运行的 agent 节点数上限，默认 ${DEFAULT_MAX_CONCURRENT}，超出的排队；` +
          '图中互不依赖的节点数多于该值时按需调高。只在首次调用填写。',
      },
      workflowId: { type: 'string', description: '续接既有 workflow 时使用首次返回的 ID' },
      checkpointId: { type: 'string', description: '当前待审查 checkpoint ID' },
      decision: {
        type: ['string', 'null'],
        enum: ['approve', 'revise', null],
        description: 'approve 进入下一批；revise 向指定节点的原有子会话续发',
      },
      note: { type: 'string', description: '本次审批或修订说明' },
      revisions: {
        type: 'array',
        description: 'revise 时向点名节点续发的指令，直接传数组（不是 JSON 字符串）',
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
  objectLabel: '工作流',
  category: 'session',
  facet: '协作',
  summary: '分批执行任务图，并由当前会话审查结果',
  permissionEffect: 'execute',
  parallelSafe: false,
  targetExtractor: (args) => {
    const goal = typeof args.goal === 'string' ? args.goal : ''
    const workflowId = typeof args.workflowId === 'string' ? args.workflowId : ''
    return (goal || workflowId).slice(0, 200)
  },
  fn: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    if (!ctx?.delegate) return { status: 'failure', message: '本次执行没有派发通道' }
    if (!ctx.stepId)
      return { status: 'failure', message: '本次调用无法获取卡片 id，无法渲染任务图' }
    const parsed = parseWorkflowCall(args)
    if (!parsed.ok) return { status: 'failure', message: parsed.error }

    const res = await ctx.delegate.runGraph({
      call: parsed.call,
      runId: ctx.runId,
      stepId: ctx.stepId,
    })
    if (res.error) return { status: 'failure', message: `该图无法执行：${res.error}` }
    if (!res.transition) return { status: 'failure', message: 'Workflow 没有返回状态转移' }

    return {
      status: 'success',
      message: transitionMessage(res.transition, res.completed === true),
      data: { ...res.transition } as unknown as Record<string, unknown>,
    }
  },
}

function transitionMessage(transition: WorkflowTransition, completed: boolean): string {
  // 必须说明批准接受了哪些未完成节点：approve 之后这些节点不再返回修订，
  // 只凭「已批准」判断时，一次接受四个失败节点的批准与四个节点全部成功无法区分。
  const accepted = transition.review?.acceptedFailures ?? []
  const acceptedNote = accepted.length
    ? ` 本次批准接受了未完成的节点：${accepted.map((item) => `${item.nodeId}（${item.reason}）`).join('、')}。`
    : ''
  if (completed) return `Workflow 已完成。${acceptedNote}`
  const dispatched = transition.dispatched
  const head = dispatched.length
    ? `已开始执行，运行中 ${dispatched.length} 个节点：${dispatched.join('、')}。`
    : '本次没有可派发的节点，运行中的节点执行完毕后会送达回执。'
  return (
    `${head} workflowId=${transition.workflowId}。` +
    '每个节点执行完毕的回执会作为消息送到本会话，到达 checkpoint 时收到检查点回执后再 approve 或 revise。' +
    acceptedNote
  )
}
