/**
 * 定时任务。
 *
 * ## 这个功能的前提必须先说清楚
 *
 * qywork 没有常驻服务：sidecar 的生命周期挂在桌面端窗口上（`--parent-pid`）。
 * 所以「每天 9:00 跑一次」在**应用关着的时候不会触发**，错过的也不补。
 *
 * 这不是实现偷懒，是一个被正面选择过的取舍（ROADMAP §34.2）：另一条路是装
 * 系统级计划任务（Windows 计划任务 / launchd / systemd timer），那能力是真的，
 * 但要写系统状态、卸载有残留，属于「难以回滚的系统改动」——按处理 Windows 沙箱时
 * 定下的同一条原则（§32.5），不替用户做。
 *
 * **界面上必须写明这一条。** 一个用户以为会在后台跑、实际不跑的定时任务，
 * 比没有这个功能坏得多。
 *
 * ## 为什么存成文件而不是进 SQLite
 *
 * 定时任务是**配置**不是**记录**：它跟着这台机器走，用户会想直接打开看、
 * 手改、备份。账本里那些表存的是发生过的事实（run / step / usage），
 * 两者的生命周期和编辑方式都不一样。
 *
 * 唯一存进来的运行信息是 `lastRunAt` / `lastError`，它们是**调度状态**
 * （用来判断下次该不该触发），不是历史——真正的历史在会话里，
 * 每次触发都留下一个可以点开的会话。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configDir } from './config.ts'

export type ScheduleKind = 'interval' | 'daily'

export interface Schedule {
  id: string
  /** 归属工作区的绝对路径。调度器只触发当前工作区的任务。 */
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
  lastRunAt?: number
  lastRunConversationId?: string
  lastError?: string
}

export function schedulesPath(): string {
  return join(configDir(), 'schedules.json')
}

export async function loadSchedules(): Promise<Schedule[]> {
  const raw = await readFile(schedulesPath(), 'utf8').catch(() => null)
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Schedule[]) : []
  } catch {
    // 文件坏了不能让服务起不来，但也**不能静默当成空**——
    // 静默的话用户会以为自己的定时任务被删了，然后再建一遍，
    // 而下一次写入会把坏文件覆盖掉，里面的内容彻底消失。
    process.stderr.write(`[qy] 定时任务文件解析失败，本次按空处理：${schedulesPath()}\n`)
    return []
  }
}

export async function saveSchedules(list: Schedule[]): Promise<void> {
  await mkdir(dirname(schedulesPath()), { recursive: true })
  await writeFile(schedulesPath(), `${JSON.stringify(list, null, 2)}\n`, 'utf8')
}

/** 串行化 `updateSchedules`。同一进程内所有读-改-写排成一条队。 */
let writeQueue: Promise<unknown> = Promise.resolve()

/**
 * 读-改-写一次定时任务表，**全程串行**。
 *
 * 为什么必须有这个：调度 tick 要回写 `lastRunAt`，设置页的增删改要写整表，
 * 两条路径都是「读全表 → 改 → 写全表」，而中间隔着 await。交错时后写的那方
 * 拿的是过期快照，会把先写方的改动整段抹掉——用户刚建的任务凭空消失，
 * 或者刚记下的 lastRunAt 丢了导致任务被重复触发，而且两者都毫无提示。
 *
 * 只解决**同一进程内**的交错。跨进程要文件锁，那是另一件事，
 * 而现在两个写入方本来就在同一个进程里。
 */
export function updateSchedules(
  mutate: (current: Schedule[]) => Schedule[] | Promise<Schedule[]>,
): Promise<Schedule[]> {
  const next = writeQueue.then(async () => {
    const current = await loadSchedules()
    const updated = await mutate(current)
    await saveSchedules(updated)
    return updated
  })
  // 队列本身不能因为某次失败就断掉，否则后续写入全部无声挂起。
  writeQueue = next.catch(() => {})
  return next
}

/**
 * 校验一条定时任务。返回问题列表，空数组 = 合格。
 *
 * 与 `diagnoseConfig` 同一口径：**有问题就不落盘**。写进去一条 `everyMinutes: 0`
 * 的任务，调度器会每个 tick 都触发一次，表现是无限刷会话。
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
 * **错过的不补**：应用关了两天再打开，不该在启动那一瞬间连着触发两次。
 * 所以 daily 的判据是「今天还没跑过，且已经过了点」，而不是「距上次超过 24 小时」。
 *
 * `now` 由调用方传入而不是内部取——这样它可测，不必依赖真实时钟。
 */
export function isDue(s: Schedule, now: number): boolean {
  if (!s.enabled) return false

  if (s.kind === 'interval') {
    const every = (s.everyMinutes ?? 0) * 60_000
    if (every <= 0) return false
    // 从没跑过的：以创建时刻为基准，而不是立刻触发——
    // 「新建一条每 30 分钟的任务」不该在保存的那一秒就先跑一轮。
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
