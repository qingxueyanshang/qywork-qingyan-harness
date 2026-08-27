/**
 * 定时任务。
 *
 * **这个功能的前提必须先说清楚。** qywork 没有常驻服务：sidecar 的生命周期挂在桌面端窗口上
 * （`--parent-pid`）。所以「每天 9:00 跑一次」在**应用关着的时候不会触发**，错过的也不补。
 *
 * 这是一个被正面选择过的取舍：另一条路是装
 * 系统级计划任务（Windows 计划任务 / launchd / systemd timer），那能力是真的，
 * 但要写系统状态、卸载有残留，属于「难以回滚的系统改动」——按处理 Windows 沙箱时
 * 定下的同一条原则，不替用户做。
 *
 * **界面上必须写明这一条。** 一条界面上显示已排期、实际不会触发的定时任务，
 * 比没有这个功能坏得多。
 *
 * **为什么存成文件而不是进 SQLite。** 定时任务是**配置**不是**记录**：它跟着这台机器走，用户会想直
 * 接打开看、手改、备份。账本里那些表存的是发生过的事实（run / step / usage），两者的生命周期和编
 * 辑方式都不一样。
 *
 * 唯一存进来的运行信息是 `lastRunAt` / `lastError`，它们是**调度状态**
 * （用来判断下次该不该触发），不是历史——真正的历史在会话里，
 * 每次触发都留下一个可以点开的会话。
 *
 * **为什么这一份在 `tools` 而不在 `runtime`。** 因为模型侧的三个工具（本文件下半段）必须在这里：工
 * 具都在 `tools` 包，而 `tools`(L3) 不许依赖 `runtime`(L5)——依赖只能朝更底层走
 * （`scripts/dependency-graph.test.ts`）。
 *
 * 下沉不需要付任何代价：这份代码对 `runtime` 的唯一依赖是 `configDir()`，
 * 而它本身就是 `globalScopeRoot()` 的一层转手（`runtime/config.ts` 的 `configDir()`），
 * 定义就在隔壁的 `scopes.ts`。改成直接调它，路径的真源仍然只有一处。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolSpec } from '@qywork/agent'
import { globalScopeRoot } from './scopes.ts'

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
  return join(globalScopeRoot(), 'schedules.json')
}

export async function loadSchedules(): Promise<Schedule[]> {
  const raw = await readFile(schedulesPath(), 'utf8').catch(() => null)
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Schedule[]) : []
  } catch {
    // 文件坏了不能让服务起不来，但也**不能静默当成空**——
    // 静默的话界面上等同于定时任务被删了，用户会再建一遍，
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

// ─────────────────────────────── 模型侧的三个工具 ───────────────────────────────

/*
 * 调度器、设置页、HTTP 面都早就在了，缺的一直是**模型这一侧的生产者**：
 * 没有这两个工具时只有用户能排定时任务，模型知道这个能力存在却用不上。
 *
 * 三条共同约束：
 *
 * 1. **只看当前工作区。** `schedules.json` 是全机一份（`globalScopeRoot()`），
 *    `workspaceRoot` 是归属字段，调度器按它过滤（`server.ts` 的 `tickSchedules`）。
 *    不过滤的话模型会列出、甚至删掉另一个项目排的任务——而那些任务它从没见过。
 * 2. **写入一律走 `updateSchedules`。** 自己读一份再整表写回就是第二条落盘路径，
 *    而两条路径各拿各的快照回写正是丢更新的标准形状（那个函数上面写了原因）。
 * 3. **记录形状与 HTTP 面同形**（`server/api/schedules.ts`）：同一个文件两个入口，
 *    id 前缀、`createdAt`、`enabled` 默认值不一致的话，设置页和调度器会各看到一半。
 */

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
function describeTiming(s: Schedule): string {
  return s.kind === 'interval'
    ? `每 ${s.everyMinutes} 分钟`
    : `每天 ${pad(s.atHour ?? 0)}:${pad(s.atMinute ?? 0)}`
}

/**
 * 这两句必须出现在 `create_schedule` 与 `list_schedules` 的描述里。
 *
 * 它们不是补充说明，是**能力边界**（CLAUDE.md B7）：不写的话模型会安排一件
 * 不会发生的事，然后向用户报告已经安排好了。
 */
const BOUNDARY =
  '最小粒度是 1 分钟，更密的间隔会被拒绝。' +
  '只在应用运行时触发：应用关着不跑，关闭期间错过的也不补。'

export const createScheduleTool: ToolSpec = {
  name: 'create_schedule',
  description:
    '排一条定时任务：到点自动新建一个会话，把 prompt 当作用户消息发进去。' +
    // 条件必填逐条写清。`diagnoseSchedule` 是运行期才拦的，
    // 只靠它等于让模型先废一整轮往返才知道该给哪个参数。
    'kind="interval" 时必须给 every_minutes（分钟）；' +
    'kind="daily" 时必须给 at_hour(0–23) 与 at_minute(0–59)，用本机时区。' +
    '两组参数不能混用，也没有默认值——缺失时报错，不使用默认时间。' +
    BOUNDARY,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题，触发时用作会话标题' },
      prompt: { type: 'string', description: '触发时发出去的消息内容' },
      kind: {
        type: 'string',
        enum: ['interval', 'daily'],
        description: 'interval=每隔多少分钟一次；daily=每天固定时刻一次',
      },
      every_minutes: { type: 'integer', description: 'kind=interval 必填，不小于 1' },
      at_hour: { type: 'integer', description: 'kind=daily 必填，0–23，本机时区' },
      at_minute: { type: 'integer', description: 'kind=daily 必填，0–59' },
    },
    required: ['title', 'prompt', 'kind'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '定时任务',
  category: 'schedule',
  facet: '定时任务',
  summary: '排一条到点自动开新会话的任务',
  targetExtractor: (a) => (typeof a.title === 'string' ? a.title : null),
  // 写的是本机的任务表，触发时走的是与手动发消息**完全相同**的 `startRun` 与
  // 同一份 config——排一条任务不会拿到任何当前拿不到的权限。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args, ctx) {
    // 认不出的 kind **当场拒**，不像 HTTP 面那样兜底成 interval。
    // 那边的参数来自填好的表单，这边来自模型：`kind="weekly"` 配一个
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

    const draft: Schedule = {
      id: `sch_${crypto.randomUUID().slice(0, 12)}`,
      workspaceRoot: ctx.workspaceRoot,
      title: String(args.title ?? '').trim(),
      prompt: String(args.prompt ?? '').trim(),
      kind,
      enabled: true,
      createdAt: Date.now(),
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

    await updateSchedules((cur) => [...cur, draft])
    return {
      status: 'success',
      message: `已排定「${draft.title}」${describeTiming(draft)}，id ${draft.id}。${BOUNDARY}`,
      data: { id: draft.id, title: draft.title, timing: describeTiming(draft) },
    }
  },
}

export const listSchedulesTool: ToolSpec = {
  name: 'list_schedules',
  description:
    '列出当前工作区已排的定时任务：触发方式、下次预计时刻、上次跑的时间与错误。' +
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
    const now = Date.now()
    const mine = (await loadSchedules()).filter((s) => s.workspaceRoot === ctx.workspaceRoot)
    if (mine.length === 0) {
      return { status: 'success', message: '当前工作区没有定时任务。', data: { schedules: [] } }
    }

    const rows = mine.map((s) => ({
      id: s.id,
      title: s.title,
      timing: describeTiming(s),
      enabled: s.enabled,
      nextRunAt: nextRunAt(s, now),
      lastRunAt: s.lastRunAt ?? null,
      lastError: s.lastError ?? null,
    }))

    return {
      status: 'success',
      message: rows
        .map((r) =>
          [
            `${r.id}  ${r.title}  ${r.timing}`,
            r.enabled ? '' : '  [已停用]',
            r.nextRunAt === null ? '' : `  下次 ${stamp(r.nextRunAt)}`,
            r.lastRunAt === null ? '  未执行过' : `  上次 ${stamp(r.lastRunAt)}`,
            r.lastError === null ? '' : `  上次报错：${r.lastError}`,
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
    const id = String(args.id ?? '').trim()
    if (!id) return { status: 'failure', message: '缺少 id' }

    // 「在不在」与「删掉」放进**同一次**串行的读-改-写。分成先 load 再 update
    // 两步的话，中间这段 await 里设置页可能已经删掉了同一条，
    // 而这里仍然回一句「已删除」——模型据此告诉用户任务没了，实际是别人删的。
    const removed: Schedule[] = []
    await updateSchedules((cur) =>
      cur.filter((s) => {
        const hit = s.id === id && s.workspaceRoot === ctx.workspaceRoot
        if (hit) removed.push(s)
        return !hit
      }),
    )

    const gone = removed[0]
    return gone
      ? { status: 'success', message: `已删除定时任务「${gone.title}」`, data: { id } }
      : {
          status: 'failure',
          message: `当前工作区没有 id 为 ${id} 的定时任务`,
          errorKind: 'not_found',
        }
  },
}
