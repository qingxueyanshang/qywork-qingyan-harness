/**
 * 模型侧的三个定时任务工具。
 *
 * 能力边界：qywork 没有常驻服务，sidecar 的生命周期挂在桌面端窗口上（`--parent-pid`）。
 * 「每天 9:00 跑一次」在应用未运行时不触发；重新打开后已到期的任务跑一次，关闭期间欠下的次数
 * 不逐次补跑——`BOUNDARY` 那两句必须留在工具描述里，否则模型会安排一件不会发生的事，
 * 然后向用户报告已经安排好了。
 *
 * 三条共同约束：
 *
 * 1. **只看当前工作区。** 任务表是全机一份，`SchedulePort` 已经按会话的工作区收窄；
 *    不收窄的话模型会列出、甚至删掉另一个项目排的任务，而那些任务它从没见过。
 * 2. **写入一律走端口。** 仓储在 `@qywork/store`，工具不自己持有账本句柄——归属哪个工作区、
 *    写进哪一份账本由装配方决定（同 `GoalPort`）。端口由 runtime 注入。
 * 3. **记录形状由仓储定。** id 前缀、`createdAt`、`enabled` 默认值都在 `createSchedule`
 *    里生成，这里不另拼一份，否则设置页和调度器会各认得一半。
 */

import type { ToolSpec } from '@qywork/agent'
import type { ScheduleDraft, ScheduleKind, ScheduleView } from '@qywork/core'
import { diagnoseSchedule } from '@qywork/core'

/** 参数可能是数字也可能是数字串，模型两种都发得出来。取不到有效数字就当没给。 */
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
 * 不用 `toLocaleString()`：它的输出随机器区域设置变，同一条任务在两台机器上
 * 给模型看到的字符串不一样，而这串是要被模型读进去当事实的。
 */
function stamp(t: number): string {
  const d = new Date(t)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 触发方式的一句话说法。建完的回执与列表共用一份，两处各写一遍必然漂。 */
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

/** 触发发到哪里的一句话说法。建完的回执与列表共用一份。 */
function describeTarget(s: { newConversation: boolean }): string {
  return s.newConversation ? '每次新建会话' : '发回本会话'
}

/**
 * 上一次触发的说法。
 *
 * 终态取自关联的 Run，任务表里没有第二份。有触发时刻却没有 Run 的，如实说没有执行记录——
 * 认领提交之后、起轮之前进程退出会留下这个状态，把它显示成成功是给账本注水。
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

/** 装配方没接端口时的统一回答。假装记下了比直接说没有任务表坏得多。 */
const NO_PORT = {
  status: 'failure',
  message: '本次执行没有定时任务表，无法排定或查询定时任务。',
  errorKind: 'unsupported',
} as const

/**
 * 这两句必须出现在 `create_schedule` 与 `list_schedules` 的描述里。
 *
 * 它们不是补充说明，是**能力边界**（CLAUDE.md B7）：不写的话模型会安排一件
 * 不会发生的事，然后向用户报告已经安排好了。
 */
const BOUNDARY =
  '最小粒度是 1 分钟，更密的间隔会被拒绝。' +
  '仅在应用运行时触发；关闭期间错过的不逐次补跑，重新打开后每条任务最多跑一次。'

export const createScheduleTool: ToolSpec = {
  name: 'create_schedule',
  description:
    '排一条定时任务：到点把 prompt 作为一条用户消息发进当前会话，上下文接着往下走，' +
    '不需要了就用 delete_schedule 停掉。' +
    '用户明确要求这条任务每次触发新建会话时才给 new_conversation=true，不要按任务内容自行判断。' +
    // 条件必填逐条写清。`diagnoseSchedule` 是运行期才拦的，
    // 只靠它等于让模型先废一整轮往返才知道该给哪个参数。
    'kind="interval" 时必须给 every_minutes（分钟）；' +
    'kind="daily" 时必须给 at_hour(0–23) 与 at_minute(0–59)，用本机时区。' +
    '两组参数不能混用，也没有默认值——缺失时报错，不使用默认时间。' +
    BOUNDARY,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题' },
      prompt: { type: 'string', description: '触发时发出去的消息内容' },
      kind: {
        type: 'string',
        enum: ['interval', 'daily'],
        description: 'interval=每隔多少分钟一次；daily=每天固定时刻一次',
      },
      every_minutes: { type: 'integer', description: 'kind=interval 必填，不小于 1' },
      at_hour: { type: 'integer', description: 'kind=daily 必填，0–23，本机时区' },
      at_minute: { type: 'integer', description: 'kind=daily 必填，0–59' },
      new_conversation: {
        type: 'boolean',
        description:
          '仅当用户明确要求这条任务每次触发新建会话时为 true；未要求时不要传，' +
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
  summary: '排一条到点发消息的任务',
  targetExtractor: (a) => (typeof a.title === 'string' ? a.title : null),
  // 写的是本机的任务表，触发时走的是与手动发消息**完全相同**的 `submitMessage` 与
  // 同一份 config——排一条任务不会拿到任何当前拿不到的权限。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.schedules
    if (!port) return NO_PORT

    // 认不出的 kind **当场拒**，不兜底成 interval：`kind="weekly"` 配一个
    // `every_minutes` 兜底之后会变成一条能跑的间隔任务，而模型要的是每周一次。
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
      // 时刻**不补默认值**。HTTP 面能默认是因为表单一定填好了才提交；
      // 这里少一个字段意味着模型没想清楚跑在什么时候，静默补一个 9:00 的话
      // 用户会在一个谁都没选过的时刻收到触发。缺了就让下面那道校验说出来。
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
    '列出当前工作区已排的定时任务：触发方式、发回本会话还是每次新建会话、下次预计时刻、' +
    '上次跑的时间与结果。' +
    // 它不像 list_skills 那样冗余：定时任务不进上下文（它随时在变），
    // 这是模型查当前状态的唯一入口。
    '定时任务不在上下文里，查询当前已排任务只能通过本工具。' +
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
    '删除一条定时任务，id 取自 list_schedules。只能删除当前工作区的：' +
    '任务表是全机共享的，其他工作区的任务在此不可见、不可删除。',
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
  summary: '删掉一条定时任务',
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
