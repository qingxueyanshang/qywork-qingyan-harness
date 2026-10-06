/**
 * 目标：跨轮次的目标，使 agent 逐轮持续执行。
 *
 * **设定目标是用户的操作，模型没有 `create_goal`。** 目标只能由用户通过 `/goal` 设定
 * （`server/commands.ts` 的 `goal.set` → `run-control.ts` 的 `setGoal`）。
 * 原因是决策时机：模型须在第二步就判断该任务是否需要跨轮，而该信息在那一步无法取得。
 * 账本中有一次实例：模型在开始时设定了 8 轮目标，在同一个 run 中自行
 * complete，自动继续未发生，界面始终显示「第 0 / 8 轮」。
 *
 * 因此模型只掌握循环的出口：已达成 → `complete`，无法继续 → `blocked`。
 * 设定、修改、暂停与继续由用户执行。缺少出口时，目标只能由用户手动停止。
 *
 * **目标与待办是两个概念。** `write_todos` 管理当前一轮的清单，目标作用于轮与轮之间：目标为
 * `active` 时，每轮 run 收尾后自动开始下一轮（`run-control.ts` 的 `startRun` finally）。
 *
 * 边界：
 * - 没有轮数上限，也没有资源预算：出口只有模型自检（`complete` / `blocked`）
 *   与用户点击停止。因此这两个动作是循环唯一的正常终止方式，描述中必须写明。
 * - 不自动重试异常：provider 报错、落盘失败之后目标转为 `blocked` 并等待用户处理，
 *   隐式重试会把一次故障放大为连续故障。
 */

import type { ToolOutcome, ToolSpec } from '@qywork/agent'
import type { Goal, GoalAction } from '@qywork/core'

/**
 * 两个工具描述共用的一句：循环不会自动停止。
 *
 * 它是能力边界（CLAUDE.md B7），不是补充说明。不写时模型会假定存在轮数或
 * 预算上限，未完成即交回；而实际上除模型声明结束外，
 * 只有用户手动停止能终止循环。
 */
const BOUNDARY =
  '该循环没有轮数上限，也不计 token、费用、时间：' +
  '除非声明完成或受阻，循环将一直自动继续，直到用户手动停止。'

/** 端口未接入时的统一回执。降级时必须说明原因，不能只返回失败。 */
function noPort(): ToolOutcome {
  return {
    status: 'failure',
    message: '本次执行没有目标账本（一次性执行不带会话状态），目标功能不可用',
    errorKind: 'no_goal_store',
  }
}

/** 提供给模型的目标全文。两个工具的回执共用同一份，分别编写会导致不一致。 */
function describe(goal: Goal): string {
  const head = `目标 ${goal.id}（revision ${goal.revision}，状态 ${goal.status}）`
  const blocked = goal.blockedReason
    ? `\n受阻原因（${goal.blockedCode}）：${goal.blockedReason}`
    : ''
  return `${head}\n${goal.objective}${blocked}`
}

export const readGoalTool: ToolSpec = {
  name: 'read_goal',
  /*
   * 不要因为自动继续的提示词已包含目标全文而删除本工具：用户插入消息的那一轮没有该提示词
   * （用户消息会解除自动继续标记，`run-control.ts` 的 `disarm`），而目标仍然有效。
   * 用户说「行了，把目标结掉」时，模型只能经由本工具取得 goal_id 与 revision。
   * revision 冲突之后的恢复同样只有这一条路径。
   */
  description:
    '读取当前会话的目标：目标正文、状态以及 goal_id 与 revision。' +
    '声明完成或受阻前先读取一次：revision 不匹配会被拒绝。' +
    BOUNDARY,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  actionKind: 'read',
  objectLabel: '目标',
  category: 'goal',
  facet: '目标账本',
  summary: '读取当前目标与轮次',
  targetExtractor: () => null,
  permissionEffect: 'internal_control',
  parallelSafe: true,

  async fn(_args, ctx) {
    const port = ctx.goals
    if (!port) return noPort()
    const goal = port.read()
    return goal
      ? { status: 'success', message: describe(goal), data: { goal } }
      : { status: 'success', message: '本会话尚无目标', data: { goal: null } }
  },
}

/**
 * 模型对目标只能执行两个动作，即循环的两个出口。
 *
 * `edit` / `pause` / `resume` 不在此处：目标是用户下达的指令，修改、暂停与继续运行
 * 均是用户的操作（`/goal` 与目标条上的两个按钮）。模型 resume 用户刚暂停的
 * 循环会推翻用户的决定；模型 edit 目标正文会改变用户的指令。
 * 账本层仍保留这三个动作：它们的生产者位于服务端与用户一侧，不是死代码。
 */
const ACTIONS: GoalAction[] = ['complete', 'blocked']

export const updateGoalTool: ToolSpec = {
  name: 'update_goal',
  description:
    '结束当前目标循环。两个动作：' +
    'complete=目标已达成，循环结束；' +
    'blocked=无法继续（**必须同时提供 blocked_reason**，写明受阻位置与解除条件）。' +
    'goal_id 与 revision 必填，先用 read_goal 读取最新的 goal_id 与 revision：' +
    'revision 不匹配会被拒绝，说明目标在读取之后已被修改。' +
    '目标未达成不要调用 complete：声明完成前先给出证据（执行一次命令、读取一次文件）。' +
    'provider 报错、工具连续失败等异常一律使用 blocked，不要自行重试。' +
    '目标正文与暂停由用户控制，本工具只能声明达成或受阻。' +
    BOUNDARY,
  parameters: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'read_goal 给出的目标 id' },
      revision: { type: 'integer', description: 'read_goal 给出的 revision，不匹配会被拒绝' },
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'complete / blocked',
      },
      blocked_reason: {
        type: 'string',
        description: 'action=blocked 必填：受阻位置，以及需要用户做什么才能继续',
      },
    },
    required: ['goal_id', 'revision', 'action'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '目标',
  category: 'goal',
  facet: '目标账本',
  summary: '将目标标记为已完成或受阻，并停止自动继续',
  targetExtractor: () => null,
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.goals
    if (!port) return noPort()

    const action = args.action as GoalAction
    if (!ACTIONS.includes(action)) {
      return {
        status: 'failure',
        message: `action 只能是 ${ACTIONS.join(' / ')}，收到 ${JSON.stringify(args.action)}`,
        errorKind: 'invalid_action',
      }
    }
    const revision = Number(args.revision)
    if (!Number.isInteger(revision)) {
      return {
        status: 'failure',
        message: `revision 必须是整数，收到 ${JSON.stringify(args.revision)}`,
        errorKind: 'invalid_revision',
      }
    }

    const result = port.update({
      goalId: String(args.goal_id ?? ''),
      revision,
      action,
      ...(typeof args.blocked_reason === 'string' ? { blockedReason: args.blocked_reason } : {}),
    })
    if (!result.ok) {
      return { status: 'failure', message: result.message, errorKind: result.code }
    }

    const goal = result.goal
    // 终态回执必须说明循环已结束。只返回「已更新」时，模型会假定还有下一轮，
    // 把应告知用户的内容留到一个不会发生的轮次中。
    const tail =
      goal.status === 'completed' ? '目标已完成，不再自动继续。' : '自动继续已停止，等待用户决定。'
    return {
      status: 'success',
      message: `${tail}\n${describe(goal)}`,
      data: { goal },
    }
  },
}
