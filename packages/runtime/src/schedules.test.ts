import { describe, expect, test } from 'bun:test'
import { diagnoseSchedule, isDue, nextRunAt, type Schedule } from './schedules.ts'

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
