import { describe, expect, test } from 'bun:test'
import { newConversationId, newMessageId, newRunId, newStepId } from './ids.ts'

describe('ID 单调性', () => {
  /**
   * 回归用例。若只把毫秒时间戳编入前缀、后缀使用随机字节，
   * 同一毫秒内生成的 ID 字典序是随机的。
   *
   * 其后果不只是排序不美观：`listMessages` 用 `id <= upperBound` 划定 run 的消息高水位，
   * 顺序错乱会把同一毫秒写入的前序消息判定为「在水位之后」，从历史中直接丢失。
   */
  test('同一毫秒内连续生成的 ID 严格递增', () => {
    const ids = Array.from({ length: 5000 }, () => newMessageId())
    // 5000 个 ID 在同一或相邻几毫秒内产生，足以覆盖同一毫秒内的并发。
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
  })

  test('字典序排序等于生成顺序', () => {
    const ids = Array.from({ length: 2000 }, () => newRunId())
    expect([...ids].sort()).toEqual(ids)
  })

  test('ID 唯一', () => {
    const ids = Array.from({ length: 20_000 }, () => newStepId())
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('定宽：所有 ID 长度一致（变长时 z9 会排在 aaa 之前）', () => {
    const ids = Array.from({ length: 500 }, () => newConversationId())
    expect(new Set(ids.map((i) => i.length)).size).toBe(1)
  })

  test('带类型前缀，日志中可直接识别类型', () => {
    expect(newConversationId().startsWith('cv_')).toBe(true)
    expect(newMessageId().startsWith('ms_')).toBe(true)
    expect(newRunId().startsWith('rn_')).toBe(true)
    expect(newStepId().startsWith('st_')).toBe(true)
  })
})
