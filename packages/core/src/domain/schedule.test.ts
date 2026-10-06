import { describe, expect, test } from 'bun:test'
import { diagnoseSchedule, isDue, nextRunAt, type Schedule } from './schedule.ts'

const base: Schedule = {
  id: 's1',
  workspaceRoot: '/w',
  title: 't',
  prompt: 'p',
  kind: 'interval',
  everyMinutes: 30,
  enabled: true,
  createdAt: 0,
  newConversation: false,
}

/** 本地时区某日某时的时间戳。不使用 UTC 常量：daily 按本地时间定义。 */
const localAt = (y: number, m: number, d: number, h: number, mi = 0) =>
  new Date(y, m - 1, d, h, mi, 0, 0).getTime()

describe('isDue：间隔', () => {
  test('从未执行过时以创建时刻为基准，保存时不立即触发', () => {
    const s = { ...base, createdAt: 1_000_000 }
    expect(isDue(s, 1_000_000)).toBe(false)
    expect(isDue(s, 1_000_000 + 29 * 60_000)).toBe(false)
    expect(isDue(s, 1_000_000 + 30 * 60_000)).toBe(true)
  })

  test('执行过之后从 lastRunAt 重新计时', () => {
    const s = { ...base, createdAt: 0, lastRunAt: 5_000_000 }
    expect(isDue(s, 5_000_000 + 29 * 60_000)).toBe(false)
    expect(isDue(s, 5_000_000 + 30 * 60_000)).toBe(true)
  })

  test('已禁用的任务不触发', () => {
    expect(isDue({ ...base, enabled: false, createdAt: 0 }, 1e12)).toBe(false)
  })

  test('间隔为 0 时不触发，否则调度器每个 tick 都会创建一个新会话', () => {
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

  test('未到设定时刻不触发，到达时触发', () => {
    expect(isDue(daily, localAt(2026, 8, 10, 8, 59))).toBe(false)
    expect(isDue(daily, localAt(2026, 8, 10, 9, 0))).toBe(true)
  })

  test('当天已执行过则不再触发', () => {
    const s = { ...daily, lastRunAt: localAt(2026, 8, 10, 9, 0) }
    expect(isDue(s, localAt(2026, 8, 10, 14, 0))).toBe(false)
  })

  test('次日到达设定时刻时再次触发', () => {
    const s = { ...daily, lastRunAt: localAt(2026, 8, 10, 9, 0) }
    expect(isDue(s, localAt(2026, 8, 11, 9, 0))).toBe(true)
  })

  test('关闭期间错过的执行不逐次补齐：停用三天后重新开启只触发一次而不是三次', () => {
    // 语义检查：isDue 返回布尔值，一次 tick 最多产生一次触发；
    // 触发后 lastRunAt 更新为当天，同一天内不会再为错过的两天补充执行。
    const s = { ...daily, lastRunAt: localAt(2026, 8, 7, 9, 0) }
    expect(isDue(s, localAt(2026, 8, 10, 10, 0))).toBe(true)
    const after = { ...s, lastRunAt: localAt(2026, 8, 10, 10, 0) }
    expect(isDue(after, localAt(2026, 8, 10, 10, 1))).toBe(false)
    expect(isDue(after, localAt(2026, 8, 10, 23, 59))).toBe(false)
  })
})

describe('diagnoseSchedule', () => {
  test('合法配置不报告问题', () => {
    expect(diagnoseSchedule(base)).toEqual([])
    expect(diagnoseSchedule({ ...base, kind: 'daily', atHour: 9, atMinute: 30 })).toEqual([])
  })

  test('空标题与空内容各报告一条问题', () => {
    const p = diagnoseSchedule({ ...base, title: '  ', prompt: '' })
    expect(p).toContain('标题不能为空')
    expect(p).toContain('任务内容不能为空')
  })

  test('间隔小于 1 分钟被拒绝：调度器以分钟为粒度，更短的间隔无效', () => {
    expect(diagnoseSchedule({ ...base, everyMinutes: 0 }).length).toBe(1)
    expect(diagnoseSchedule({ ...base, everyMinutes: 0.5 }).length).toBe(1)
  })

  test('超出范围的时刻被拒绝', () => {
    expect(diagnoseSchedule({ ...base, kind: 'daily', atHour: 24, atMinute: 0 }).length).toBe(1)
    expect(diagnoseSchedule({ ...base, kind: 'daily', atHour: 9, atMinute: 60 }).length).toBe(1)
  })
})

describe('nextRunAt', () => {
  test('间隔：上次 + 间隔', () => {
    expect(nextRunAt({ ...base, lastRunAt: 1000 }, 2000)).toBe(1000 + 30 * 60_000)
  })

  test('每天：今天未到时刻则为今天，已过或已执行则为明天', () => {
    const daily: Schedule = { ...base, kind: 'daily', atHour: 9, atMinute: 0, createdAt: 0 }
    expect(nextRunAt(daily, localAt(2026, 8, 10, 7, 0))).toBe(localAt(2026, 8, 10, 9, 0))
    expect(nextRunAt(daily, localAt(2026, 8, 10, 10, 0))).toBe(localAt(2026, 8, 11, 9, 0))
  })

  test('已禁用的任务返回 null，不生成虚假的下次时间', () => {
    expect(nextRunAt({ ...base, enabled: false }, 0)).toBe(null)
  })
})
