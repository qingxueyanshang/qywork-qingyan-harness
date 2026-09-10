/**
 * 定时任务的共享类型、校验与时间判定。
 *
 * 能力边界：qywork 没有常驻服务，sidecar 的生命周期挂在桌面端窗口上（`--parent-pid`）。
 * 「每天 9:00 跑一次」在应用未运行时不触发；重新打开后已到期的任务立刻跑一次，关闭期间欠下的
 * 次数不逐次补跑。界面上必须写明这一条——一条显示已排期、实际不会触发的任务比没有这个功能坏得多。
 *
 * 这几个函数是纯的，`now` 由调用方传入：仓储、HTTP 面与模型工具共用同一份判定，
 * 各写一份会对同一条任务给出两种下次时刻。
 */

export type ScheduleKind = 'interval' | 'daily'

/**
 * 一条定时任务。**这里只有配置与触发游标，没有执行结果。**
 *
 * 上一次跑成什么样由 `lastRunConversationId` 关联的 Run 回答（见 `ScheduleView.lastRun`）。
 * 在这里再存一份 status/error 就是第二本账：Run 落终态与任务表回写之间隔着进程退出的
 * 窗口，两份必然分叉。
 */
export interface Schedule {
  id: string
  /** 归属工作区的绝对路径。 */
  workspaceRoot: string
  title: string
  /** 触发时作为用户消息发出去的内容。 */
  prompt: string
  kind: ScheduleKind
  /** kind='interval' 专有，分钟。 */
  everyMinutes?: number
  /** kind='daily' 专有，本机时区的 0–23 / 0–59。 */
  atHour?: number
  atMinute?: number
  enabled: boolean
  createdAt: number
  /** 自动触发游标：最近一次自动触发的时刻。手动试跑不推进它。 */
  lastRunAt?: number
  /** 最近一次触发建的会话。会话被删除后置空，游标保留。 */
  lastRunConversationId?: string
}

/**
 * 建一条任务要给的字段。
 *
 * **不含 `workspaceRoot`**：归属由调用方所在的会话决定，让请求方自己填等于允许它把任务
 * 排进另一个项目。id、createdAt、enabled 由仓储生成。
 */
export interface ScheduleDraft {
  title: string
  prompt: string
  kind: ScheduleKind
  everyMinutes?: number
  atHour?: number
  atMinute?: number
}

/**
 * 上一次触发的执行终态投影。
 *
 * `runId` 为 null = 有会话没有 Run：认领提交之后、`startRun` 落 Run 之前进程退出，
 * 或者旧数据导入时本来就没有可核验的历史执行。调用方须如实呈现，不得补一个假的成功。
 */
export interface ScheduleLastRun {
  conversationId: string
  runId: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | null
  errorMessage: string | null
}

/** 任务加上派生读数。派生值不落盘，每次现算。 */
export interface ScheduleView extends Schedule {
  nextRunAt: number | null
  due: boolean
  /** null = 没有关联会话（从没触发过，或会话已被删除）。 */
  lastRun: ScheduleLastRun | null
}

/**
 * 校验一条定时任务。返回问题列表，空数组 = 合格。
 *
 * 与 `diagnoseConfig` 同一口径：有问题就不落盘。写进去一条 `everyMinutes: 0`
 * 的任务，调度器每个 tick 都会触发一次，表现是无限刷会话。
 */
export function diagnoseSchedule(s: Partial<Schedule>): string[] {
  const problems: string[] = []
  if (!s.title?.trim()) problems.push('标题不能为空')
  if (!s.prompt?.trim()) problems.push('任务内容不能为空')
  if (s.kind === 'interval') {
    const m = s.everyMinutes
    // 下限 1 分钟：调度器本身就是分钟级的，比这更密只会空转。
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 1) {
      problems.push('间隔必须是不小于 1 的分钟数')
    }
  } else if (s.kind === 'daily') {
    const h = s.atHour
    const mi = s.atMinute
    if (typeof h !== 'number' || h < 0 || h > 23) problems.push('小时必须在 0–23')
    if (typeof mi !== 'number' || mi < 0 || mi > 59) problems.push('分钟必须在 0–59')
  } else {
    problems.push('未知的触发方式')
  }
  return problems
}

/**
 * 这一刻该不该触发。
 *
 * 关闭期间错过的不逐次补跑：应用停了两天再打开，这一刻触发一次，不为欠下的两次各跑一轮。
 * 所以 daily 的判据是「今天还没跑过，且已经过了点」，而不是「距上次超过 24 小时」。
 */
export function isDue(s: Schedule, now: number): boolean {
  if (!s.enabled) return false

  if (s.kind === 'interval') {
    const every = (s.everyMinutes ?? 0) * 60_000
    if (every <= 0) return false
    // 从没跑过的以创建时刻为基准：新建一条每 30 分钟的任务不该在保存那一秒先跑一轮。
    const base = s.lastRunAt ?? s.createdAt
    return now - base >= every
  }

  const at = new Date(now)
  at.setHours(s.atHour ?? 0, s.atMinute ?? 0, 0, 0)
  const dueAt = at.getTime()
  if (now < dueAt) return false
  if (!s.lastRunAt) return true
  // 同一天已经跑过就不再触发。用本地日历日比较，不用 24 小时差：
  // 跨夏令时时后者会漏掉或多出一次。
  return !sameLocalDay(s.lastRunAt, now)
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

/** 下次预计触发的时刻；算不出来（已禁用 / 配置不合法）返回 null。 */
export function nextRunAt(s: Schedule, now: number): number | null {
  if (!s.enabled) return null
  if (s.kind === 'interval') {
    const every = (s.everyMinutes ?? 0) * 60_000
    if (every <= 0) return null
    return (s.lastRunAt ?? s.createdAt) + every
  }
  const at = new Date(now)
  at.setHours(s.atHour ?? 0, s.atMinute ?? 0, 0, 0)
  let t = at.getTime()
  if (t <= now || (s.lastRunAt && sameLocalDay(s.lastRunAt, now))) t += 86_400_000
  return t
}
