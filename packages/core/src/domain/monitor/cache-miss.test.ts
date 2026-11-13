/**
 * 覆盖 `domain/monitor/cache-miss.ts` 的 `attributeCacheMisses`：
 * 普通追加、工具前压缩后、发送前压缩后、压缩记录没有压缩后占用、容量拒绝后、切换型号后（含只换接口）、
 * 信封指纹变化、长停顿后、压缩与长停顿同时成立、上一次请求没有用量、第一次请求、命中为零的冷启动、
 * 命中量未回报、没有可识别原因、缓存有效期按线路的分档值取值（1 小时档 5 至 60 分钟不计为缓存过期）。
 * 每个用例都断言各项之和等于未命中量。
 */

import { describe, expect, test } from 'bun:test'
import {
  attributeCacheMisses,
  type CacheMissAttribution,
  type CacheMissCompaction,
  type CacheMissRequest,
} from './cache-miss.ts'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 13, 8, 0, 0)

interface Usage {
  input: number
  cached: number | null
  write?: number | null
  write1h?: number
}

/** 在 `at` 创建、1 毫秒后发出、20 秒后完成的主请求。`usage` 为 null 表示没有用量。 */
function request(
  at: number,
  usage: Usage | null,
  line: Partial<CacheMissRequest> = {},
): CacheMissRequest {
  return {
    model: 'claude-opus-5-5',
    providerName: 'relay',
    providerKind: 'anthropic_messages',
    cacheRouteFingerprint: 'fp-a',
    providerInputTokens: usage ? usage.input : null,
    providerCachedTokens: usage ? usage.cached : null,
    providerCacheWriteTokens: usage ? (usage.write ?? 0) : null,
    providerCacheWrite1hTokens: usage?.write1h ?? null,
    createdAt: at,
    sentAt: at + 1,
    completedAt: at + 20_000,
    ...line,
  }
}

function compaction(
  at: number,
  occupancy: number,
  occupancyAfter?: number,
  manifestRevision = 2,
): CacheMissCompaction {
  return {
    createdAt: at,
    manifestRevision,
    occupancy,
    ...(occupancyAfter === undefined ? {} : { occupancyAfter }),
  }
}

function only(parts: Partial<CacheMissAttribution>): CacheMissAttribution {
  return {
    newContent: 0,
    compaction: 0,
    modelSwitch: 0,
    toolChange: 0,
    cacheExpiry: 0,
    other: 0,
    ...parts,
  }
}

/** 运行归因，并断言每条已归因请求的各项之和等于其未命中量。 */
function attribute(
  requests: CacheMissRequest[],
  compactions: CacheMissCompaction[] = [],
): (CacheMissAttribution | null)[] {
  const results = attributeCacheMisses(requests, compactions)
  expect(results).toHaveLength(requests.length)
  results.forEach((result, i) => {
    if (result === null) return
    const r = requests[i]!
    const miss = (r.providerInputTokens ?? 0) + (r.providerCacheWriteTokens ?? 0)
    expect(Object.values(result).reduce((a, b) => a + b, 0)).toBe(miss)
    for (const v of Object.values(result)) expect(v).toBeGreaterThanOrEqual(0)
  })
  return results
}

describe('attributeCacheMisses', () => {
  test('普通追加：总量的增量全部计为新增内容', () => {
    const p = request(T0, { input: 2_000, cached: 90_000, write: 8_000 })
    const n = request(T0 + MIN, { input: 1_000, cached: 100_000, write: 5_000 })
    expect(attribute([p, n])[1]).toEqual(only({ newContent: 6_000 }))
  })

  test('没有可识别原因时余量计为其他，未改写 manifest 的压缩记录不参与', () => {
    const p = request(T0, { input: 2_000, cached: 90_000, write: 8_000 })
    const n = request(T0 + MIN, { input: 3_000, cached: 96_000, write: 7_000 })
    const skipped = compaction(T0 + 30_000, 100_000, 100_000, 0)
    expect(attribute([p, n], [skipped])[1]).toEqual(only({ newContent: 6_000, other: 4_000 }))
  })

  test('工具前压缩后：回收量加回之后的增量计为新增内容，余量计为压缩', () => {
    // P 的回复带工具调用；执行工具之前压缩一次，工具结果随 N 发出。
    const p = request(T0, { input: 3_000, cached: 190_000, write: 7_000 })
    const c = compaction(T0 + 21_000, 205_000, 60_000)
    const n = request(T0 + 40_000, { input: 2_000, cached: 20_000, write: 48_000 })
    expect(attribute([p, n], [c])[1]).toEqual(only({ newContent: 15_000, compaction: 35_000 }))
  })

  test('发送前压缩后：压缩与下一次请求行可在同一毫秒，余量计为压缩', () => {
    const p = request(T0, { input: 1_000, cached: 150_000, write: 9_000 })
    const at = T0 + 2 * MIN
    const c = compaction(at, 162_000, 40_000)
    const n = request(at, { input: 4_000, cached: 18_000, write: 30_000 })
    // 52k − 160k + 122k = 14k
    expect(attribute([p, n], [c])[1]).toEqual(only({ newContent: 14_000, compaction: 20_000 }))
  })

  test('压缩记录没有压缩后占用时回收量按 0 计，未命中全部计为压缩', () => {
    const p = request(T0, { input: 1_000, cached: 150_000, write: 9_000 })
    const c = compaction(T0 + MIN, 162_000)
    const n = request(T0 + 2 * MIN, { input: 4_000, cached: 18_000, write: 30_000 })
    expect(attribute([p, n], [c])[1]).toEqual(only({ compaction: 34_000 }))
  })

  test('容量拒绝后：被拒的请求不归因，重发的请求与拒绝之前最近一条带用量的请求比较', () => {
    const p = request(T0, { input: 5_000, cached: 880_000, write: 15_000 })
    const rejected = request(T0 + MIN, null)
    const c = compaction(T0 + MIN + 2_000, 1_050_000, 300_000)
    const resent = request(T0 + 2 * MIN, { input: 10_000, cached: 20_000, write: 280_000 })
    const results = attribute([p, rejected, resent], [c])
    expect(results[1]).toBeNull()
    // 310k − 900k + 750k = 160k
    expect(results[2]).toEqual(only({ newContent: 160_000, compaction: 130_000 }))
  })

  test('切换型号后：余量计为切换模型，先于长停顿判定', () => {
    const p = request(
      T0,
      { input: 4_000, cached: 116_000, write: null },
      { model: 'gpt-6.1-sol', providerName: 'gateway', providerKind: 'openai_responses' },
    )
    const n = request(T0 + 2 * 60 * MIN, { input: 3_000, cached: 0, write: 125_000 })
    expect(attribute([p, n])[1]).toEqual(only({ newContent: 8_000, modelSwitch: 120_000 }))
  })

  test('型号相同而接口名不同时同样计为切换模型', () => {
    const p = request(T0, { input: 2_000, cached: 90_000, write: 8_000 })
    const n = request(
      T0 + MIN,
      { input: 1_000, cached: 0, write: 105_000 },
      { providerName: 'relay-b' },
    )
    expect(attribute([p, n])[1]).toEqual(only({ newContent: 6_000, modelSwitch: 100_000 }))
  })

  test('信封指纹变化时余量计为工具变化', () => {
    const p = request(T0, { input: 2_000, cached: 90_000, write: 8_000 })
    const n = request(
      T0 + MIN,
      { input: 1_000, cached: 4_000, write: 98_000 },
      { cacheRouteFingerprint: 'fp-b' },
    )
    expect(attribute([p, n])[1]).toEqual(only({ newContent: 3_000, toolChange: 96_000 }))
  })

  test('长停顿后：没有分档值时按 5 分钟判定，余量计为缓存过期', () => {
    const p = request(T0, { input: 2_000, cached: 90_000, write: 8_000 })
    const n = request(T0 + 30 * MIN, { input: 1_000, cached: 0, write: 104_000 })
    expect(attribute([p, n])[1]).toEqual(only({ newContent: 5_000, cacheExpiry: 100_000 }))
  })

  test('压缩与长停顿同时成立：余量计为缓存过期', () => {
    const p = request(T0, { input: 2_000, cached: 90_000, write: 8_000 })
    const c = compaction(T0 + 10 * MIN, 100_000, 30_000)
    const n = request(T0 + 20 * MIN, { input: 1_000, cached: 0, write: 34_000 })
    // 35k − 100k + 70k = 5k
    expect(attribute([p, n], [c])[1]).toEqual(only({ newContent: 5_000, cacheExpiry: 30_000 }))
  })

  test('上一次请求没有用量：与更早一条带用量的请求比较', () => {
    const p = request(T0, { input: 2_000, cached: 90_000, write: 8_000 })
    const cut = request(T0 + MIN, null)
    const n = request(T0 + 2 * MIN, { input: 1_000, cached: 93_000, write: 9_000 })
    const results = attribute([p, cut, n])
    expect(results[1]).toBeNull()
    expect(results[2]).toEqual(only({ newContent: 3_000, other: 7_000 }))
  })

  test('第一次请求：未命中全部计为新增内容', () => {
    const n = request(T0, { input: 2_000, cached: 30_000, write: 50_000 })
    expect(attribute([n])[0]).toEqual(only({ newContent: 52_000 }))
  })

  test('命中为零的冷启动：命中回报为 0 时照常归因，未回报的写入按 0 计', () => {
    const n = request(
      T0,
      { input: 41_000, cached: 0, write: null },
      { providerKind: 'openai_chat_completions' },
    )
    expect(attribute([n])[0]).toEqual(only({ newContent: 41_000 }))
  })

  test('命中量未回报：不归因，但该请求仍作为下一次请求的比较对象', () => {
    const first = request(T0, { input: 1_000, cached: 45_000, write: 4_000 })
    const unreported = request(T0 + MIN, { input: 100_000, cached: null, write: null })
    const n = request(T0 + 2 * MIN, { input: 7_000, cached: 95_000, write: 0 })
    const results = attribute([first, unreported, n])
    expect(results[1]).toBeNull()
    expect(results[2]).toEqual(only({ newContent: 2_000, other: 5_000 }))
  })

  describe('缓存有效期', () => {
    test('1 小时档线路上 5 至 60 分钟的间隔不计为缓存过期，超过 60 分钟时计为缓存过期', () => {
      const first = request(T0, { input: 1_000, cached: 0, write: 60_000, write1h: 60_000 })
      // 全部命中、没有写入的请求不改变线路的有效期。
      const p = request(T0 + MIN, { input: 2_000, cached: 61_000, write: 0 })
      const c = compaction(T0 + 20 * MIN, 66_000, 20_000)
      const n = request(T0 + 40 * MIN, { input: 1_000, cached: 0, write: 24_000 })
      const late = request(T0 + 120 * MIN, { input: 1_000, cached: 0, write: 27_000 })
      const results = attribute([first, p, n, late], [c])
      // 25k − 63k + 46k = 8k
      expect(results[2]).toEqual(only({ newContent: 8_000, compaction: 17_000 }))
      expect(results[3]).toEqual(only({ newContent: 3_000, cacheExpiry: 25_000 }))
    })

    test('1 小时档线路上不超过 60 分钟、其间没有压缩时余量计为其他', () => {
      const p = request(T0, { input: 1_000, cached: 0, write: 60_000, write1h: 60_000 })
      const n = request(T0 + 30 * MIN, { input: 1_000, cached: 0, write: 63_000 })
      expect(attribute([p, n])[1]).toEqual(only({ newContent: 3_000, other: 61_000 }))
    })

    test('分档值表明写入全部在 5 分钟档时按 5 分钟判定', () => {
      const p = request(T0, { input: 1_000, cached: 0, write: 60_000, write1h: 0 })
      const n = request(T0 + 10 * MIN, { input: 1_000, cached: 0, write: 63_000 })
      expect(attribute([p, n])[1]).toEqual(only({ newContent: 3_000, cacheExpiry: 61_000 }))
    })

    test('其他线路的分档值不参与判定', () => {
      const other = request(
        T0,
        { input: 1_000, cached: 0, write: 60_000, write1h: 60_000 },
        { providerName: 'relay-b' },
      )
      const p = request(T0 + MIN, { input: 1_000, cached: 0, write: 60_000 })
      const n = request(T0 + 30 * MIN, { input: 1_000, cached: 0, write: 63_000 })
      expect(attribute([other, p, n])[2]).toEqual(only({ newContent: 3_000, cacheExpiry: 61_000 }))
    })
  })
})
