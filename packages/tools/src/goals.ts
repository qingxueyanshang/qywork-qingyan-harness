/**
 * 目标：一个跨轮次的目标，让 agent 一轮接一轮做下去。
 *
 * **立目标是用户的动作：模型手里没有 `create_goal`。** 目标只能由用户用 `/goal` 立
 * （`server/commands.ts` 的 `goal.set` → `run-control.ts` 的 `setGoal`）。
 * 理由是决策时机：模型要在第二步就判「这活要不要跨轮」，而那个信息它在那一步拿不到。
 * 账本里留下过一次实证——模型开局立了个 8 轮的目标，同一个 run 里就自己
 * complete 掉了，自动续起一轮没起，用户全程只看到界面上挂着「第 0 / 8 轮」。
 *
 * 所以模型侧只剩**循环的出口**：做到了 → `complete`，做不下去 → `blocked`。
 * 立、改、暂停、继续都在用户那侧。少了出口的话，每个目标都得耗满轮数才停。
 *
 * **它和待办是两件事。** `write_todos` 管**这一轮**的清单。目标管的是**轮与轮之间**：目标是
 * `active` 的时候，每一轮 run 收尾都会自动再起一轮（`run-control.ts` 的 `startRun` finally）。
 *
 * **边界**：
 * - **没有轮数上限，也没有资源预算**：出口只有模型自检（`complete` / `blocked`）
 *   和用户点停止。所以那两个动作是这个循环唯一的正常刹车，描述里必须说清。
 * - **不自动重试异常**：provider 报错、落盘失败之后目标转 `blocked` 停下等人，
 *   隐式重试会把一次故障放大成一串。
 */

import type { ToolOutcome, ToolSpec } from '@qywork/agent'
import type { Goal, GoalAction } from '@qywork/core'

/**
 * 两个工具都要说的那句：**循环不会自己停**。
 *
 * 它不是补充说明，是**能力边界**（CLAUDE.md B7）。不写的话模型会按「有轮数或
 * 预算在兜底」行事，没做完就交回——而实际上除了它自己宣布收尾，
 * 只剩用户手动点停止。
 */
const BOUNDARY =
  '这个循环没有轮数上限，也不计 token、费用、时间：' +
  '除非声明完成或受阻，循环将持续自动续起，直到用户手动停止。'

/** 端口没接上时的统一回话。降级要说得出**为什么**，不能只说失败。 */
function noPort(): ToolOutcome {
  return {
    status: 'failure',
    message: '本次执行没有目标账本（一次性执行不带会话状态），目标功能不可用',
    errorKind: 'no_goal_store',
  }
}

/** 给模型看的目标全文。两个工具的回执共用一份，各写一遍必然漂。 */
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
   * 不要因为续起提示词已带目标全文就删掉它：**用户插话的那一轮没有那段提示词**
   * （人类消息会解除续起标记，`run-control.ts` 的 `disarm`），而目标仍然有效。
   * 用户说「行了，把目标结掉」时，模型只有这里够得到 goal_id 与 revision。
   * revision 撞车之后的恢复也只有这一条路。
   */
  description:
    '读回当前会话的目标：目标正文、状态、以及 goal_id 与 revision。' +
    '声明完成或受阻前先读取一次——revision 对不上会被拒。' +
    BOUNDARY,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  actionKind: 'read',
  objectLabel: '目标',
  category: 'goal',
  facet: '目标账本',
  summary: '读回当前目标与轮次',
  targetExtractor: () => null,
  permissionEffect: 'internal_control',
  parallelSafe: true,

  async fn(_args, ctx) {
    const port = ctx.goals
    if (!port) return noPort()
    const goal = port.read()
    return goal
      ? { status: 'success', message: describe(goal), data: { goal } }
      : { status: 'success', message: '这条会话还没有目标', data: { goal: null } }
  },
}

/**
 * 模型能对目标做的**两个**动作，就是循环的两个出口。
 *
 * `edit` / `pause` / `resume` 不在这里：目标是用户下的令，改它、停它、接着跑
 * 都是用户的动作（`/goal` 与目标条上那两个按钮）。模型 resume 一个用户刚停掉的
 * 循环，是把用户的决定推翻；模型 edit 目标正文，是把用户下的令改成别的。
 * 账本层仍留着这三个动作——它们的生产者在服务端与用户那一侧，不是死代码。
 */
const ACTIONS: GoalAction[] = ['complete', 'blocked']

export const updateGoalTool: ToolSpec = {
  name: 'update_goal',
  description:
    '结束当前目标循环。两个动作：' +
    'complete=目标已达成，循环结束；' +
    'blocked=无法继续（**必须同时给 blocked_reason**，写明受阻位置与解除条件）。' +
    'goal_id 与 revision 必填，先用 read_goal 读到最新的那一对——' +
    'revision 对不上会被拒，那说明目标在你读到之后被改过了。' +
    '目标未达成不要调用 complete：声明完成前先给出证据（执行一次命令、读取一次文件）。' +
    'provider 报错、工具连续失败这类异常一律走 blocked，不要自行重试。' +
    '目标正文与暂停由用户控制，本工具只能声明达成或受阻。' +
    BOUNDARY,
  parameters: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'read_goal 给出的目标 id' },
      revision: { type: 'integer', description: 'read_goal 给出的 revision，对不上会被拒' },
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'complete / blocked',
      },
      blocked_reason: {
        type: 'string',
        description: 'action=blocked 必填：卡在哪、需要用户做什么才能继续',
      },
    },
    required: ['goal_id', 'revision', 'action'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '目标',
  category: 'goal',
  facet: '目标账本',
  summary: '宣布目标完成或受阻，给自动续起收尾',
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
    // 终态要把「循环到此为止」说出来。只回一句「已更新」的话，模型会按还有下一轮
    // 行事，把该说给用户的话留到一个不会发生的轮次里。
    const tail =
      goal.status === 'completed' ? '目标已完成，不会再自动续起。' : '自动续起已停止，等用户决定。'
    return {
      status: 'success',
      message: `${tail}\n${describe(goal)}`,
      data: { goal },
    }
  },
}
