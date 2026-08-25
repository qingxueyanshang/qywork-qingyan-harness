import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import {
  createScheduleTool,
  deleteScheduleTool,
  diagnoseSchedule,
  isDue,
  listSchedulesTool,
  loadSchedules,
  nextRunAt,
  type Schedule,
} from './schedules.ts'

const base: Schedule = {
  id: 's1',
  workspaceRoot: '/w',
  title: 't',
  prompt: 'p',
  kind: 'interval',
  everyMinutes: 30,
  enabled: true,
  createdAt: 0,
}

/** 本地时区的某天某点，避免用 UTC 常量——daily 的语义就是本地时间。 */
const localAt = (y: number, m: number, d: number, h: number, mi = 0) =>
  new Date(y, m - 1, d, h, mi, 0, 0).getTime()

describe('isDue：间隔', () => {
  test('从没跑过时以创建时刻为基准，不在保存那一秒就触发', () => {
    const s = { ...base, createdAt: 1_000_000 }
    expect(isDue(s, 1_000_000)).toBe(false)
    expect(isDue(s, 1_000_000 + 29 * 60_000)).toBe(false)
    expect(isDue(s, 1_000_000 + 30 * 60_000)).toBe(true)
  })

  test('跑过之后从 lastRunAt 重新计时', () => {
    const s = { ...base, createdAt: 0, lastRunAt: 5_000_000 }
    expect(isDue(s, 5_000_000 + 29 * 60_000)).toBe(false)
    expect(isDue(s, 5_000_000 + 30 * 60_000)).toBe(true)
  })

  test('禁用的永远不触发', () => {
    expect(isDue({ ...base, enabled: false, createdAt: 0 }, 1e12)).toBe(false)
  })

  test('间隔为 0 不触发——否则调度器每个 tick 都会开一个新会话', () => {
    expect(isDue({ ...base, everyMinutes: 0, createdAt: 0 }, 1e12)).toBe(false)
  })
})

describe('isDue：每天', () => {
  const { everyMinutes: _drop, ...withoutInterval } = base
  const daily: Schedule = {
    ...withoutInterval,
    kind: 'daily',
    atHour: 9,
    atMinute: 0,
    createdAt: localAt(2026, 8, 1, 0),
  }

  test('没到点不触发，到点触发', () => {
    expect(isDue(daily, localAt(2026, 8, 10, 8, 59))).toBe(false)
    expect(isDue(daily, localAt(2026, 8, 10, 9, 0))).toBe(true)
  })

  test('当天已经跑过就不再触发', () => {
    const s = { ...daily, lastRunAt: localAt(2026, 8, 10, 9, 0) }
    expect(isDue(s, localAt(2026, 8, 10, 14, 0))).toBe(false)
  })

  test('隔天到点再触发', () => {
    const s = { ...daily, lastRunAt: localAt(2026, 8, 10, 9, 0) }
    expect(isDue(s, localAt(2026, 8, 11, 9, 0))).toBe(true)
  })

  test('错过的不补：关了三天再开，只触发一次而不是三次', () => {
    // 语义检查——isDue 是布尔，一次 tick 最多产生一次触发，
    // 触发后 lastRunAt 落到今天，同一天内不会再为「欠的那两天」补跑。
    const s = { ...daily, lastRunAt: localAt(2026, 8, 7, 9, 0) }
    expect(isDue(s, localAt(2026, 8, 10, 10, 0))).toBe(true)
    const after = { ...s, lastRunAt: localAt(2026, 8, 10, 10, 0) }
    expect(isDue(after, localAt(2026, 8, 10, 10, 1))).toBe(false)
    expect(isDue(after, localAt(2026, 8, 10, 23, 59))).toBe(false)
  })
})

describe('diagnoseSchedule', () => {
  test('合格的没有问题', () => {
    expect(diagnoseSchedule(base)).toEqual([])
    expect(diagnoseSchedule({ ...base, kind: 'daily', atHour: 9, atMinute: 30 })).toEqual([])
  })

  test('空标题、空内容各报一条', () => {
    const p = diagnoseSchedule({ ...base, title: '  ', prompt: '' })
    expect(p).toContain('标题不能为空')
    expect(p).toContain('任务内容不能为空')
  })

  test('间隔小于 1 分钟被拒——调度器是分钟级的，更密只会空转', () => {
    expect(diagnoseSchedule({ ...base, everyMinutes: 0 }).length).toBe(1)
    expect(diagnoseSchedule({ ...base, everyMinutes: 0.5 }).length).toBe(1)
  })

  test('越界的时刻被拒', () => {
    expect(diagnoseSchedule({ ...base, kind: 'daily', atHour: 24, atMinute: 0 }).length).toBe(1)
    expect(diagnoseSchedule({ ...base, kind: 'daily', atHour: 9, atMinute: 60 }).length).toBe(1)
  })
})

describe('nextRunAt', () => {
  test('间隔：上次 + 间隔', () => {
    expect(nextRunAt({ ...base, lastRunAt: 1000 }, 2000)).toBe(1000 + 30 * 60_000)
  })

  test('每天：今天没到点就是今天，已过或已跑就是明天', () => {
    const daily: Schedule = { ...base, kind: 'daily', atHour: 9, atMinute: 0, createdAt: 0 }
    expect(nextRunAt(daily, localAt(2026, 8, 10, 7, 0))).toBe(localAt(2026, 8, 10, 9, 0))
    expect(nextRunAt(daily, localAt(2026, 8, 10, 10, 0))).toBe(localAt(2026, 8, 11, 9, 0))
  })

  test('禁用的返回 null，不编一个假的下次时间', () => {
    expect(nextRunAt({ ...base, enabled: false }, 0)).toBe(null)
  })
})

/*
 * 三个工具跑在真实的 `schedules.json` 上，`QYWORK_HOME` 指到临时目录。
 *
 * 不打桩落盘：这三个工具的全部要害都在落盘那一侧——归属过滤、
 * 与 HTTP 面同形的记录、走不走 `updateSchedules`。桩掉之后测的就只剩参数解析了。
 */
describe('定时任务工具', () => {
  let home = ''
  const prevHome = process.env.QYWORK_HOME

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'qywork-sched-'))
    process.env.QYWORK_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  })

  const ctx = (root: string): ToolContext => ({
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  })

  const create = (args: Record<string, unknown>, root = '/w1') =>
    createScheduleTool.fn(args, ctx(root))
  const list = (root = '/w1') => listSchedulesTool.fn({}, ctx(root))
  const del = (id: string, root = '/w1') => deleteScheduleTool.fn({ id }, ctx(root))

  test('建一条间隔任务，记录形状与 HTTP 面一致', async () => {
    const r = await create({
      title: '日报',
      prompt: '写今天的日报',
      kind: 'interval',
      every_minutes: 30,
    })
    expect(r.status).toBe('success')

    const all = await loadSchedules()
    expect(all.length).toBe(1)
    const s = all[0]!
    expect(s.id.startsWith('sch_')).toBe(true)
    expect(s.workspaceRoot).toBe('/w1')
    expect(s.enabled).toBe(true)
    expect(s.createdAt > 0).toBe(true)
    expect(s.kind).toBe('interval')
    expect(s.everyMinutes).toBe(30)
    // 每天那两个字段不该存在，不是存成 undefined。
    expect('atHour' in s).toBe(false)
  })

  test('回执里带着两条边界：关掉应用不会触发', async () => {
    const r = await create({ title: 't', prompt: 'p', kind: 'daily', at_hour: 9, at_minute: 0 })
    expect(r.message).toContain('应用关着不跑')
    expect(r.message).toContain('1 分钟')
  })

  test('kind=daily 少给时刻不落盘，报的是缺哪个而不是一句失败', async () => {
    const r = await create({ title: 't', prompt: 'p', kind: 'daily' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('小时必须在 0–23')
    expect(await loadSchedules()).toEqual([])
  })

  test('认不出的 kind 当场拒，不兜底成间隔任务', async () => {
    const r = await create({ title: 't', prompt: 'p', kind: 'weekly', every_minutes: 30 })
    expect(r.status).toBe('failure')
    expect(await loadSchedules()).toEqual([])
  })

  test('间隔小于 1 分钟被挡在落盘之前', async () => {
    const r = await create({ title: 't', prompt: 'p', kind: 'interval', every_minutes: 0 })
    expect(r.status).toBe('failure')
    expect(await loadSchedules()).toEqual([])
  })

  test('列表只给当前工作区的，别的项目的任务看不见', async () => {
    await create({ title: '我的', prompt: 'p', kind: 'interval', every_minutes: 30 }, '/w1')
    await create({ title: '别人的', prompt: 'p', kind: 'interval', every_minutes: 30 }, '/w2')

    const r = await list('/w1')
    expect(r.message).toContain('我的')
    expect(r.message).not.toContain('别人的')
    expect((r.data?.schedules as unknown[]).length).toBe(1)
  })

  test('删不掉别的工作区的任务，而且那条还在盘上', async () => {
    await create({ title: '别人的', prompt: 'p', kind: 'interval', every_minutes: 30 }, '/w2')
    const id = (await loadSchedules())[0]!.id

    const r = await del(id, '/w1')
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('not_found')
    expect((await loadSchedules()).length).toBe(1)
  })

  test('删自己的任务删得掉，删第二次报没有', async () => {
    await create({ title: '我的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    const id = (await loadSchedules())[0]!.id

    expect((await del(id)).status).toBe('success')
    expect(await loadSchedules()).toEqual([])
    expect((await del(id)).errorKind).toBe('not_found')
  })

  test('写入不整表覆盖：建第二条时别的工作区那条还在', async () => {
    await create({ title: '别人的', prompt: 'p', kind: 'interval', every_minutes: 30 }, '/w2')
    await create({ title: '我的', prompt: 'p', kind: 'daily', at_hour: 9, at_minute: 30 }, '/w1')

    const roots = (await loadSchedules()).map((s) => s.workspaceRoot).sort()
    expect(roots).toEqual(['/w1', '/w2'])
  })

  test('空表如实说没有，不算失败', async () => {
    const r = await list()
    expect(r.status).toBe('success')
    expect(r.data?.schedules).toEqual([])
  })
})
