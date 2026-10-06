/**
 * 定时任务的共享类型、校验与时间判定。
 *
 * 能力边界：qywork 没有常驻服务，sidecar 的生命周期依附于桌面端窗口（`--parent-pid`）。
 * 「每天 9:00 执行一次」在应用未运行时不触发；重新打开后已到期的任务立即执行一次，关闭期间错过的
 * 次数不逐次补充执行。界面上必须写明这一边界：显示已排期而实际不会触发的任务，比没有该功能危害更大。
 *
 * 以下函数均为纯函数，`now` 由调用方传入：仓储、HTTP 接口与模型工具共用同一份判定，
 * 各自实现会对同一任务给出两个不同的下次时刻。
 */

export type ScheduleKind = 'interval' | 'daily'

/**
 * 一条定时任务。只包含配置与触发游标，不包含执行结果。
 *
 * 上一次的执行结果由 `conversationId` 关联的 Run 提供（见 `ScheduleView.lastRun`）。
 * 在此另存一份 status/error 将构成独立的第二份状态：Run 落终态与任务表回写之间隔着进程退出的
 * 窗口，两份状态必然不一致。
 */
export interface Schedule {
  id: string
  /** 归属工作区的绝对路径。 */
  workspaceRoot: string
  title: string
  /** 触发时作为用户消息发送的内容。 */
  prompt: string
  kind: ScheduleKind
  /** kind='interval' 专有，单位为分钟。 */
  everyMinutes?: number
  /** kind='daily' 专有，本机时区的 0–23 / 0–59。 */
  atHour?: number
  atMinute?: number
  enabled: boolean
  createdAt: number
  /** 自动触发游标：最近一次自动触发的时刻。手动试运行不更新该值。 */
  lastRunAt?: number
  /**
   * 最近一次触发所进入的会话。会话被删除后置空，游标保留。
   *
   * `newConversation` 为假时它同时是绑定会话：触发时把 `prompt` 作为一条用户消息发送到该会话，
   * 上下文在各次之间延续；该字段为空时，下一次触发新建一条会话并写回。
   */
  conversationId?: string
  /**
   * 每次触发另建一条会话，各次互不可见。
   *
   * 只在用户明确要求时置为真，不按任务内容推断。创建任务时确定，之后不再修改：修改会使
   * 同一任务的历史一部分在绑定会话中、一部分分散在其他会话中。
   */
  newConversation: boolean
}

/**
 * 创建任务时需提供的字段。
 *
 * 不含 `workspaceRoot`：归属由调用方所在的会话决定，由请求方填写等于允许它把任务
 * 排入另一个项目。id、createdAt、enabled 由仓储生成。
 */
export interface ScheduleDraft {
  title: string
  prompt: string
  kind: ScheduleKind
  everyMinutes?: number
  atHour?: number
  atMinute?: number
  /** 见 `Schedule.newConversation`。缺省时发送到创建任务的会话。 */
  newConversation?: boolean
}

/**
 * 绑定会话中最近一条 Run 的终态投影。
 *
 * 边界：读取到的不一定是定时触发的那一轮。绑定会话同时接收用户手动发送的消息，最近一条 Run
 * 可能来自手动发送。为此新增一列「上次触发产生的 run」会形成第二份状态：Run 落终态与任务表回写
 * 之间存在进程退出的窗口。
 *
 * `runId` 为 null 表示有会话而没有 Run：认领提交之后、开始执行之前进程退出，或旧数据导入时
 * 没有可核验的历史执行。调用方须如实呈现，不得显示虚假的成功。
 */
export interface ScheduleLastRun {
  conversationId: string
  runId: string | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | null
  errorMessage: string | null
}

/** 任务及其派生读数。派生值不落盘，每次实时计算。 */
export interface ScheduleView extends Schedule {
  nextRunAt: number | null
  due: boolean
  /** null 表示没有绑定会话（会话已被删除，或旧数据从未绑定）。 */
  lastRun: ScheduleLastRun | null
}

/**
 * 校验一条定时任务。返回问题列表，空数组表示合法。
 *
 * 与 `diagnoseConfig` 规则相同：有问题时不落盘。写入一条 `everyMinutes: 0`
 * 的任务后，调度器每个 tick 都会触发一次，不断创建会话。
 */
export function diagnoseSchedule(s: Partial<Schedule>): string[] {
  const problems: string[] = []
  if (!s.title?.trim()) problems.push('标题不能为空')
  if (!s.prompt?.trim()) problems.push('任务内容不能为空')
  if (s.kind === 'interval') {
    const m = s.everyMinutes
    // 下限 1 分钟：调度器以分钟为粒度，更短的间隔无效。
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 1) {
      problems.push('间隔必须是不小于 1 的分钟数')
    }
  } else if (s.kind === 'daily') {
    const h = s.atHour
    const mi = s.atMinute
    if (typeof h !== 'number' || h < 0 || h > 23) problems.push('小时必须在 0–23 之间')
    if (typeof mi !== 'number' || mi < 0 || mi > 59) problems.push('分钟必须在 0–59 之间')
  } else {
    problems.push('未知的触发方式')
  }
  return problems
}

/**
 * 判定当前时刻是否应触发。
 *
 * 关闭期间错过的执行不逐次补充：应用停止两天后再打开，当前时刻触发一次，不为错过的两次各执行一轮。
 * 因此 daily 的判据是「今天尚未执行过，且已过设定时刻」，而不是「距上次超过 24 小时」。
 */
export function isDue(s: Schedule, now: number): boolean {
  if (!s.enabled) return false

  if (s.kind === 'interval') {
    const every = (s.everyMinutes ?? 0) * 60_000
    if (every <= 0) return false
    // 从未执行过的任务以创建时刻为基准：新建的每 30 分钟任务不应在保存时立即执行一轮。
    const base = s.lastRunAt ?? s.createdAt
    return now - base >= every
  }

  const at = new Date(now)
  at.setHours(s.atHour ?? 0, s.atMinute ?? 0, 0, 0)
  const dueAt = at.getTime()
  if (now < dueAt) return false
  if (!s.lastRunAt) return true
  // 同一天已执行过则不再触发。按本地日历日比较，不使用 24 小时差：
  // 跨越夏令时切换时，后者会少触发或多触发一次。
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

/** 下次预计触发的时刻；无法计算时（已禁用 / 配置不合法）返回 null。 */
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
