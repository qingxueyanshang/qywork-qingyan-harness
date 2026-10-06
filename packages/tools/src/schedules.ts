/**
 * 模型侧的三个定时任务工具。
 *
 * 能力边界：qywork 没有常驻服务，sidecar 的生命周期依附于桌面端窗口（`--parent-pid`）。
 * 「每天 9:00 执行一次」在应用未运行时不触发；重新打开后已到期的任务执行一次，关闭期间错过的次数
 * 不逐次补执行。`BOUNDARY` 的两句必须保留在工具描述中，否则模型会排定一项不会执行的任务，
 * 并向用户报告已排定。
 *
 * 三条共同约束：
 *
 * 1. 只访问当前工作区。任务表全机只有一份，`SchedulePort` 已按会话的工作区过滤；
 *    不过滤时模型会列出甚至删除其他项目排定的任务，而它从未见过这些任务。
 * 2. 写入一律经由端口。仓储位于 `@qywork/store`，工具不自行持有账本句柄：归属哪个工作区、
 *    写入哪一份账本由装配方决定（同 `GoalPort`）。端口由 runtime 注入。
 * 3. 记录结构由仓储决定。id 前缀、`createdAt`、`enabled` 默认值都在 `createSchedule`
 *    中生成，此处不另行构造，否则设置页与调度器各自只能识别其中一部分。
 */

import type { ToolSpec } from '@qywork/agent'
import type { ScheduleDraft, ScheduleKind, ScheduleView } from '@qywork/core'
import { diagnoseSchedule } from '@qywork/core'

/** 模型可能以数字或数字字符串传参，两种都接受。无法取得有效数字时视为未提供。 */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 本机时区的 `MM-DD HH:MM`。
 *
 * 不使用 `toLocaleString()`：其输出随机器区域设置变化，同一条任务在两台机器上
 * 呈现给模型的字符串不同，而模型会把该字符串当作事实读取。
 */
function stamp(t: number): string {
  const d = new Date(t)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 触发方式的描述。创建后的回执与列表共用此函数，分别编写必然不一致。 */
function describeTiming(s: {
  kind: ScheduleKind
  everyMinutes?: number
  atHour?: number
  atMinute?: number
}): string {
  return s.kind === 'interval'
    ? `每 ${s.everyMinutes} 分钟`
    : `每天 ${pad(s.atHour ?? 0)}:${pad(s.atMinute ?? 0)}`
}

/** 触发消息发送目标的描述。创建后的回执与列表共用此函数。 */
function describeTarget(s: { newConversation: boolean }): string {
  return s.newConversation ? '每次新建会话' : '发回原会话'
}

/**
 * 上一次触发的描述。
 *
 * 终态取自关联的 Run，任务表中不另存一份。有触发时刻而没有 Run 时，如实报告没有执行记录：
 * 认领提交之后、轮次启动之前进程退出会留下该状态，将其显示为成功会使账本失实。
 */
function lastRunNote(v: ScheduleView): string {
  if (v.lastRunAt === undefined) return '  未执行过'
  const when = `  上次 ${stamp(v.lastRunAt)}`
  const run = v.lastRun
  if (run === null || run.runId === null) return `${when}  没有执行记录`
  if (run.status === 'failed') return `${when}  失败：${run.errorMessage ?? '没有报错正文'}`
  if (run.status === 'interrupted') return `${when}  已中断`
  if (run.status === 'queued' || run.status === 'running') return `${when}  执行中`
  return when
}

/** 装配方未注入端口时的统一返回。声称已记录而实际未记录，远比如实说明没有任务表有害。 */
const NO_PORT = {
  status: 'failure',
  message: '本次执行没有定时任务表，无法排定或查询定时任务。',
  errorKind: 'unsupported',
} as const

/**
 * 这两句必须出现在 `create_schedule` 与 `list_schedules` 的描述中。
 *
 * 它们不是补充说明，而是能力边界（CLAUDE.md B7）：缺少时模型会排定一项
 * 不会执行的任务，并向用户报告已排定。
 */
const BOUNDARY =
  '最小粒度是 1 分钟，更短的间隔会被拒绝。' +
  '仅在应用运行时触发；关闭期间错过的不逐次补执行，重新打开后每条任务最多执行一次。'

export const createScheduleTool: ToolSpec = {
  name: 'create_schedule',
  description:
    '排定一条定时任务：到达设定时间时把 prompt 作为一条用户消息发送到当前会话，上下文延续，' +
    '不再需要时用 delete_schedule 停止。' +
    '仅当用户明确要求该任务每次触发时新建会话，才传 new_conversation=true，不要按任务内容自行判断。' +
    // 逐条写明条件必填参数。`diagnoseSchedule` 在运行时才拦截，
    // 只依靠它时，模型需要浪费一轮往返才知道应提供哪个参数。
    'kind="interval" 时必须提供 every_minutes（分钟）；' +
    'kind="daily" 时必须提供 at_hour(0–23) 与 at_minute(0–59)，使用本机时区。' +
    '两组参数不能混用，也没有默认值：缺失时报错，不使用默认时间。' +
    BOUNDARY,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题' },
      prompt: { type: 'string', description: '触发时发送的消息内容' },
      kind: {
        type: 'string',
        enum: ['interval', 'daily'],
        description: 'interval=每隔指定分钟数一次；daily=每天固定时刻一次',
      },
      every_minutes: { type: 'integer', description: 'kind=interval 必填，不小于 1' },
      at_hour: { type: 'integer', description: 'kind=daily 必填，0–23，本机时区' },
      at_minute: { type: 'integer', description: 'kind=daily 必填，0–59' },
      new_conversation: {
        type: 'boolean',
        description:
          '仅当用户明确要求该任务每次触发时新建会话才为 true；未要求时不要传，' +
          '默认把消息发回当前会话',
      },
    },
    required: ['title', 'prompt', 'kind'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '定时任务',
  category: 'schedule',
  facet: '定时任务',
  summary: '创建一条定时发送消息的任务',
  targetExtractor: (a) => (typeof a.title === 'string' ? a.title : null),
  // 写入本机的任务表；触发时经由与手动发送消息完全相同的 `submitMessage` 与
  // 同一份 config，排定任务不会获得任何当前不具备的权限。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.schedules
    if (!port) return NO_PORT

    // 无法识别的 kind 立即拒绝，不回退为 interval：`kind="weekly"` 加上
    // `every_minutes` 回退后会成为一条可执行的间隔任务，而模型要求的是每周一次。
    const kind = args.kind
    if (kind !== 'interval' && kind !== 'daily') {
      return {
        status: 'failure',
        message: `kind 只能是 interval 或 daily，收到 ${JSON.stringify(args.kind)}`,
        errorKind: 'invalid_schedule',
      }
    }
    const everyMinutes = num(args.every_minutes)
    const atHour = num(args.at_hour)
    const atMinute = num(args.at_minute)

    const draft: ScheduleDraft = {
      title: String(args.title ?? '').trim(),
      prompt: String(args.prompt ?? '').trim(),
      kind,
      newConversation: args.new_conversation === true,
      // 时刻不补默认值。HTTP 接口可以使用默认值，因为表单必然填写完整后才提交；
      // 此处缺少字段表示模型未确定执行时间，静默补为 9:00 时，
      // 用户会在一个无人选择的时刻收到触发。缺少时由下方的校验报告。
      ...(kind === 'daily'
        ? {
            ...(atHour !== undefined ? { atHour } : {}),
            ...(atMinute !== undefined ? { atMinute } : {}),
          }
        : { ...(everyMinutes !== undefined ? { everyMinutes } : {}) }),
    }

    const problems = diagnoseSchedule(draft)
    if (problems.length) {
      return {
        status: 'failure',
        message: `定时任务不合法：${problems.join('；')}`,
        errorKind: 'invalid_schedule',
      }
    }

    const saved = port.create(draft)
    return {
      status: 'success',
      message:
        `已排定「${saved.title}」${describeTiming(saved)}，${describeTarget(saved)}，` +
        `id ${saved.id}。${BOUNDARY}`,
      data: {
        id: saved.id,
        title: saved.title,
        timing: describeTiming(saved),
        newConversation: saved.newConversation,
      },
    }
  },
}

export const listSchedulesTool: ToolSpec = {
  name: 'list_schedules',
  description:
    '列出当前工作区已排定的定时任务：触发方式、发回原会话还是每次新建会话、下次预计时刻、' +
    '上次执行的时间与结果。' +
    // 本工具与 list_skills 不同，并不冗余：定时任务不进入上下文（其状态随时变化），
    // 这是模型查询当前状态的唯一入口。
    '定时任务不在上下文中，查询当前已排定的任务只能通过本工具。' +
    BOUNDARY,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  actionKind: 'query',
  objectLabel: '定时任务',
  category: 'schedule',
  facet: '定时任务',
  summary: '列出当前工作区的定时任务',
  permissionEffect: 'internal_control',
  parallelSafe: true,

  async fn(_args, ctx) {
    const port = ctx.schedules
    if (!port) return NO_PORT

    const mine = port.list()
    if (mine.length === 0) {
      return { status: 'success', message: '当前工作区没有定时任务。', data: { schedules: [] } }
    }

    const rows = mine.map((s) => ({
      id: s.id,
      title: s.title,
      timing: describeTiming(s),
      newConversation: s.newConversation,
      enabled: s.enabled,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt ?? null,
      lastRun: s.lastRun,
    }))

    return {
      status: 'success',
      message: mine
        .map((s) =>
          [
            `${s.id}  ${s.title}  ${describeTiming(s)}  ${describeTarget(s)}`,
            s.enabled ? '' : '  [已停用]',
            s.nextRunAt === null ? '' : `  下次 ${stamp(s.nextRunAt)}`,
            lastRunNote(s),
          ].join(''),
        )
        .join('\n'),
      data: { schedules: rows },
    }
  },
}

export const deleteScheduleTool: ToolSpec = {
  name: 'delete_schedule',
  description:
    '删除一条定时任务，id 取自 list_schedules。只能删除当前工作区的任务：' +
    '任务表由全机共享，其他工作区的任务在此不可见、不可删除。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: '任务 id，形如 sch_xxx' } },
    required: ['id'],
    additionalProperties: false,
  },
  actionKind: 'delete',
  objectLabel: '定时任务',
  category: 'schedule',
  facet: '定时任务',
  summary: '删除一条定时任务',
  targetExtractor: (a) => (typeof a.id === 'string' ? a.id : null),
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.schedules
    if (!port) return NO_PORT

    const id = String(args.id ?? '').trim()
    if (!id) return { status: 'failure', message: '缺少 id' }

    const gone = port.remove(id)
    return gone
      ? { status: 'success', message: `已删除定时任务「${gone.title}」`, data: { id } }
      : {
          status: 'failure',
          message: `当前工作区没有 id 为 ${id} 的定时任务`,
          errorKind: 'not_found',
        }
  },
}
