/**
 * 目标：立一个跨轮次的目标，让 agent 一轮接一轮做下去。
 *
 * ## 它和待办是两件事
 *
 * `write_todos` 管**这一轮**的清单，一轮结束就没人再看它。目标管的是**轮与轮之间**：
 * 目标是 `active` 的时候，每一轮 run 收尾都会自动再起一轮
 * （`server/run-control.ts` 的 `startRun` finally），直到做完、被暂停，或撞上轮数上限。
 *
 * ## 边界（三条都写进了 description，不是只在这里说说）
 *
 * - **同时只有一个目标**，不做并行目标。
 * - **只有轮数上限，不是资源预算**：不计 token、不计钱、不计时间。
 * - **不自动重试异常**：provider 报错、落盘失败之后目标转 `blocked` 停下等人，
 *   隐式重试会把一次故障放大成一串。
 *
 * ## 三个工具，不是五个
 *
 * 暂停 / 继续 / 完成 / 受阻 / 改写共享同一组必填参数（`goal_id` + `revision`），
 * 差异只在两条条件必填，所以它们是**一个 `update_goal` 门面**（见方案 §4.1 第二档）。
 * 而 `read_goal`（无参、只读）与 `create_goal`（不需要 revision）跟它们不同形，
 * 各自独立。
 */

import type { ToolOutcome, ToolSpec } from '@qywork/agent'
import type { Goal, GoalAction } from '@qywork/core'

/**
 * 三个工具都要说的那两句：一个目标、轮数是唯一护栏。
 *
 * 它们不是补充说明，是**能力边界**（CLAUDE.md B7）——不写的话模型会立第二个目标、
 * 或者以为跑不完是因为没钱了。
 */
const BOUNDARY =
  '同一条会话同时只能有一个目标。' +
  '唯一的护栏是轮数上限（max_rounds）：不计 token、不计费用、不计时间。'

/** 端口没接上时的统一回话。降级要说得出**为什么**，不能只说失败。 */
function noPort(): ToolOutcome {
  return {
    status: 'failure',
    message: '本次执行没有目标账本（一次性执行不带会话状态），目标功能不可用',
    errorKind: 'no_goal_store',
  }
}

/** 给模型看的目标全文。三个工具的回执共用一份，各写一遍必然漂。 */
function describe(goal: Goal): string {
  const head = `目标 ${goal.id}（revision ${goal.revision}，状态 ${goal.status}，第 ${goal.round}/${goal.maxRounds} 轮）`
  const blocked = goal.blockedReason
    ? `\n受阻原因（${goal.blockedCode}）：${goal.blockedReason}`
    : ''
  return `${head}\n${goal.objective}${blocked}`
}

export const readGoalTool: ToolSpec = {
  name: 'read_goal',
  description:
    '读回当前会话的目标：目标正文、状态、已经自动跑了第几轮、以及改它要用的 revision。' +
    '改目标之前先读一次——revision 对不上会被拒。' +
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

export const createGoalTool: ToolSpec = {
  name: 'create_goal',
  description:
    '立一个跨轮次的目标：目标是 active 状态时，这一轮做完之后系统会自动再起一轮，' +
    '直到你调 update_goal 宣布完成 / 受阻，或者跑满 max_rounds。' +
    '只有多轮才做得完的任务才立目标；一轮就能做完的直接做，别立。' +
    BOUNDARY,
  parameters: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: '要做到什么。写成可验证的样子——「测试全绿」而不是「改进测试」',
      },
      max_rounds: {
        type: 'integer',
        description: '最多自动跑几轮，1–50，不给按默认值。人类自己发的消息不算轮次',
      },
    },
    required: ['objective'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '目标',
  category: 'goal',
  facet: '目标账本',
  summary: '立一个跨轮次自动续起的目标',
  targetExtractor: () => null,
  // 纯内部记账：续起走的是与手动发消息完全相同的 `startRun` 与同一份 config，
  // 立一个目标不会拿到任何当前拿不到的权限。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.goals
    if (!port) return noPort()

    const maxRounds = args.max_rounds === undefined ? undefined : Number(args.max_rounds)
    const result = port.create({
      objective: String(args.objective ?? ''),
      ...(maxRounds === undefined ? {} : { maxRounds }),
    })
    if (!result.ok) {
      return { status: 'failure', message: result.message, errorKind: result.code }
    }
    return {
      status: 'success',
      message: `已立目标，做完这一轮会自动继续。\n${describe(result.goal)}`,
      data: { goal: result.goal },
    }
  },
}

const ACTIONS: GoalAction[] = ['edit', 'pause', 'resume', 'complete', 'blocked']

export const updateGoalTool: ToolSpec = {
  name: 'update_goal',
  description:
    '改当前目标的状态或正文。五个动作：' +
    'edit=改目标正文（**必须同时给 objective**）；' +
    'pause=先停下，之后能继续；' +
    'resume=接着做，下一轮会自动起来；' +
    'complete=已经做到了，循环结束；' +
    'blocked=做不下去了（**必须同时给 blocked_reason**，写清卡在哪、需要什么才能继续）。' +
    'goal_id 与 revision 必填，先用 read_goal 读到最新的那一对——' +
    'revision 对不上会被拒，那说明目标在你读到之后被改过了。' +
    '目标没达成就别调 complete：宣布完成之前先给出证据（跑一次命令、读一次文件）。' +
    'provider 报错、工具连续失败这类异常一律走 blocked，不要自己一轮轮重试。',
  parameters: {
    type: 'object',
    properties: {
      goal_id: { type: 'string', description: 'read_goal 给出的目标 id' },
      revision: { type: 'integer', description: 'read_goal 给出的 revision，对不上会被拒' },
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'edit / pause / resume / complete / blocked',
      },
      objective: { type: 'string', description: 'action=edit 必填：改写后的目标正文' },
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
  summary: '暂停 / 继续 / 完成 / 标记受阻 / 改写目标',
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
      ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
      ...(typeof args.blocked_reason === 'string' ? { blockedReason: args.blocked_reason } : {}),
    })
    if (!result.ok) {
      return { status: 'failure', message: result.message, errorKind: result.code }
    }

    const goal = result.goal
    // 终态要把「循环到此为止」说出来。只回一句「已更新」的话，模型会以为
    // 下一轮照样会来，然后把该说给用户的话留到一个不会发生的轮次里。
    const tail =
      goal.status === 'active'
        ? '这一轮做完会自动继续。'
        : goal.status === 'completed'
          ? '目标已完成，不会再自动续起。'
          : '自动续起已停止，等用户决定。'
    return {
      status: 'success',
      message: `${tail}\n${describe(goal)}`,
      data: { goal },
    }
  },
}
