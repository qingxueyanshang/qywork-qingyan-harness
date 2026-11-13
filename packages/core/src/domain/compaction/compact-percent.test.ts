/**
 * 覆盖 `domain/compaction/compact-percent.ts`：窗口分档的边界、按档取设置值与缺省值、
 * 配置值的合法性判定（类型、档名、整数、步长、各档范围）。
 */

import { describe, expect, test } from 'bun:test'
import {
  COMPACT_PERCENT_DEFAULT,
  COMPACT_TIERS,
  compactPercentOf,
  compactPercentProblems,
  compactTierOf,
  isCompactPercent,
} from './compact-percent.ts'

describe('窗口分档', () => {
  test('80 万及以上为 1M 档，30 万至 80 万为 500K 档，30 万以下为 256K 档', () => {
    expect(compactTierOf(1_050_000).label).toBe('1M')
    expect(compactTierOf(1_000_000).label).toBe('1M')
    expect(compactTierOf(800_000).label).toBe('1M')
    expect(compactTierOf(799_999).label).toBe('500K')
    expect(compactTierOf(500_000).label).toBe('500K')
    expect(compactTierOf(300_000).label).toBe('500K')
    expect(compactTierOf(299_999).label).toBe('256K')
    expect(compactTierOf(262_144).label).toBe('256K')
    expect(compactTierOf(128_000).label).toBe('256K')
    expect(compactTierOf(0).label).toBe('256K')
  })

  test('各档范围：1M 与 500K 为 30–80，256K 为 60–80', () => {
    expect(COMPACT_TIERS.map((t) => [t.key, t.label, t.min, t.max])).toEqual([
      ['large', '1M', 30, 80],
      ['medium', '500K', 30, 80],
      ['small', '256K', 60, 80],
    ])
  })
})

describe('按档取设置值', () => {
  test('只取窗口所在档的值，缺少该档时为 80', () => {
    const setting = { large: 50, small: 65 }
    expect(compactPercentOf(1_000_000, setting)).toBe(50)
    expect(compactPercentOf(500_000, setting)).toBe(COMPACT_PERCENT_DEFAULT)
    expect(compactPercentOf(262_144, setting)).toBe(65)
    expect(compactPercentOf(1_000_000, undefined)).toBe(80)
    expect(compactPercentOf(200_000, {})).toBe(80)
  })
})

describe('合法性判定', () => {
  test('缺省与各档范围内 5 的倍数合法', () => {
    expect(compactPercentProblems(undefined)).toEqual([])
    expect(compactPercentProblems({})).toEqual([])
    expect(compactPercentProblems({ large: 30, medium: 80, small: 60 })).toEqual([])
    for (const tier of COMPACT_TIERS) {
      for (let v = tier.min; v <= tier.max; v += 5) expect(isCompactPercent(tier, v)).toBe(true)
    }
  })

  test('1M 档 90、256K 档 50、任一档 42 不合法', () => {
    expect(compactPercentProblems({ large: 90 })).toHaveLength(1)
    expect(compactPercentProblems({ small: 50 })).toHaveLength(1)
    expect(compactPercentProblems({ large: 42 })).toHaveLength(1)
    expect(compactPercentProblems({ medium: 42 })).toHaveLength(1)
    expect(compactPercentProblems({ small: 42 })).toHaveLength(1)
    expect(compactPercentProblems({ large: 25 })[0]).toBe(
      'compactPercent.large 必须是 30 至 80 之间 5 的倍数的整数，当前为 25',
    )
  })

  test('字符串、小数、null、未知的档与非对象不合法', () => {
    expect(compactPercentProblems({ large: '50' })[0]).toContain('当前为 "50"')
    expect(compactPercentProblems({ large: 50.5 })).toHaveLength(1)
    expect(compactPercentProblems({ medium: null })).toHaveLength(1)
    expect(compactPercentProblems({ huge: 50 })[0]).toContain('compactPercent.huge 不是有效的档')
    expect(compactPercentProblems(80)).toHaveLength(1)
    expect(compactPercentProblems(null)).toHaveLength(1)
    expect(compactPercentProblems([80])).toHaveLength(1)
  })
})
