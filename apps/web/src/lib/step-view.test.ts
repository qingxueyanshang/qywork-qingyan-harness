/**
 * 工具步骤呈现逻辑的口径。覆盖 `lib/step-view.ts`。
 *
 * 这些函数原本待在 `Transcript.tsx` 里，测不了——`bun test` 加载 `.tsx`
 * 会去找 JSX runtime 然后炸。它们每一个都有真实的边界条件，
 * 靠肉眼看渲染结果验不出来，所以先拆再测。
 */

import { describe, expect, test } from 'bun:test'
import {
  argsRows,
  CLAMP,
  clamp,
  compact,
  diffFrom,
  displayTarget,
  fileDelta,
  firstString,
  hitRate,
  listOf,
  sanitizeTarget,
  statusWord,
  TARGET_MAX,
} from './step-view.ts'

/** 命中率的入参只用到这几格，其余字段测里一律不造。 */
function usage(over: {
  inputTokens?: number
  cachedTokens?: number | null
  cacheWriteTokens?: number | null
  turns?: { input: number; cached: number | null; cacheWrite: number | null }[]
}) {
  return {
    inputTokens: over.inputTokens ?? 0,
    cachedTokens: over.cachedTokens === undefined ? 0 : over.cachedTokens,
    cacheWriteTokens: over.cacheWriteTokens ?? null,
    turns: over.turns ?? [],
  }
}

describe('target 截断方向', () => {
  test('短的原样返回，空白压成单个空格', () => {
    expect(sanitizeTarget('src/lib.ts')).toBe('src/lib.ts')
    expect(sanitizeTarget('  a   b\nc ')).toBe('a b c')
  })

  /**
   * 这条是这个函数存在的全部理由：**路径的信息在末尾，模式串的信息在开头**。
   * 两类都截同一侧，必然有一类被截掉有用的那半。
   */
  test('路径保尾部，非路径保头部', () => {
    const long = `packages/server/src/${'x'.repeat(60)}/git.ts`
    const cut = sanitizeTarget(long)
    expect(cut.length).toBe(TARGET_MAX)
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('git.ts')).toBe(true)

    const pattern = `${'8'.repeat(60)}|abc`
    const cut2 = sanitizeTarget(pattern)
    expect(cut2.length).toBe(TARGET_MAX)
    expect(cut2.endsWith('…')).toBe(true)
    expect(cut2.startsWith('8888')).toBe(true)
  })
})

describe('外置工具的目标剥前缀', () => {
  test('只剥开头那一段，路径里的冒号不动', () => {
    expect(displayTarget('mcp:github/search')).toBe('github/search')
    expect(displayTarget('plugin:demo/count')).toBe('demo/count')
    // 剥的是前缀不是子串：文件名里带 `mcp:` 的不该被削掉。
    expect(displayTarget('src/mcp:notes.ts')).toBe('src/mcp:notes.ts')
    expect(displayTarget('bun test')).toBe('bun test')
    // 只剥一层——`mcp:` 开头的 server 名本身仍要留在目标里。
    expect(displayTarget('mcp:mcp:x')).toBe('mcp:x')
  })
})

describe('改了多少行', () => {
  test('多个文件求和，两个数都是 0 就不给角标', () => {
    expect(fileDelta(undefined)).toBeNull()
    expect(fileDelta([])).toBeNull()
    expect(fileDelta([{ additions: 0, deletions: 0 }])).toBeNull()
    expect(fileDelta([{ additions: 1, deletions: 2 }])).toEqual({ additions: 1, deletions: 2 })
    expect(
      fileDelta([
        { additions: 1, deletions: 2 },
        { additions: 3, deletions: 0 },
      ]),
    ).toEqual({ additions: 4, deletions: 2 })
  })

  /** 删空一个文件：加了 0 行，但角标必须出现，否则那次调用看起来什么都没做。 */
  test('只有一侧非零也要出角标', () => {
    expect(fileDelta([{ additions: 0, deletions: 12 }])).toEqual({ additions: 0, deletions: 12 })
  })
})

describe('读数格式', () => {
  test('大数收成 K / M，小数不动', () => {
    expect(compact(999)).toBe('999')
    expect(compact(1234)).toBe('1.2K')
    expect(compact(86_800)).toBe('87K')
    expect(compact(1_430_000)).toBe('1.43M')
  })

  /** null 是「provider 没回报」，与真实零命中是两回事——显示成 0 会让人以为配置错了。 */
  test('命中率：null 与 0 必须区分', () => {
    expect(hitRate(usage({ cachedTokens: null }))).toBe('未回报')
    expect(hitRate(usage({ inputTokens: 1000, cachedTokens: 0 }))).toBe('0.00%')
    // 分母是输入总量：277 未命中 + 723 命中 = 1000。
    expect(hitRate(usage({ inputTokens: 277, cachedTokens: 723 }))).toBe('72.30%')
    // 一个 token 都没有时不能除出 Infinity。
    expect(hitRate(usage({ inputTokens: 0, cachedTokens: 0 }))).toBe('—')
  })

  /*
   * 三家适配器的 `inputTokens` 都是**排他**的（只装未命中部分），拿它当分母
   * 会把命中那一大块从分母里抠掉。这个形状照着用户截图的量级来：
   * 794K 命中、2K 未命中——旧公式打印 39700%，一眼假。
   */
  test('命中率：分母含命中与写入，不会超过 100%', () => {
    const s = hitRate(usage({ inputTokens: 2_000, cachedTokens: 794_000 }))
    expect(s).toBe('99.75%')
    expect(Number.parseFloat(s)).toBeLessThanOrEqual(100)
    // 写入也占输入总量，同样进分母。
    expect(hitRate(usage({ inputTokens: 100, cachedTokens: 800, cacheWriteTokens: 100 }))).toBe(
      '80.00%',
    )
  })

  /*
   * 一轮里第一次调用必然未命中，累计口径会把它摊进去，长轮次的率被压低。
   * 用户看这个数字是想知道「现在缓存生效了吗」，所以取最后一次可观测的调用。
   */
  test('命中率：有逐轮记录时取最后一次可观测的调用', () => {
    const u = usage({
      inputTokens: 1_100,
      cachedTokens: 900,
      turns: [
        { input: 1_000, cached: 0, cacheWrite: 1_000 },
        { input: 100, cached: 900, cacheWrite: 0 },
      ],
    })
    // 累计是 900/2000 = 45%，最后一次是 900/1000 = 90%。
    expect(hitRate(u)).toBe('90.00%')
  })

  /** 老数据没有逐轮记录。回落到累计，**不能显示 `—`**——那读起来像「没有缓存」。 */
  test('命中率：没有逐轮记录时回落到整轮累计', () => {
    expect(hitRate(usage({ inputTokens: 250, cachedTokens: 750, turns: [] }))).toBe('75.00%')
  })

  test('成功不写字，只有失败写', () => {
    expect(statusWord('success')).toBe('')
    expect(statusWord('running')).toBe('')
    expect(statusWord(undefined)).toBe('')
    expect(statusWord('failure')).toBe('失败')
  })
})

describe('结果取值', () => {
  test('按 entries / matches / files 的顺序认列表，非全字符串不算', () => {
    expect(listOf({ entries: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(listOf({ matches: ['x'] })).toEqual(['x'])
    // 空数组不算——渲染出来是一个空块。
    expect(listOf({ entries: [] })).toBeNull()
    // 混入非字符串就不是「一行一条」那种形状。
    expect(listOf({ files: ['a', 1] })).toBeNull()
    expect(listOf({ other: ['a'] })).toBeNull()
  })

  test('截断要说清还剩多少', () => {
    const short = 'x'.repeat(10)
    expect(clamp(short)).toBe(short)
    const long = 'y'.repeat(CLAMP + 25)
    const cut = clamp(long)
    expect(cut.startsWith('y'.repeat(100))).toBe(true)
    expect(cut).toContain('还有 25 字')
  })
})

describe('参数表', () => {
  test('跳过空值，对象序列化，超长的走专用块不进表', () => {
    expect(
      argsRows({ path: 'a.ts', empty: '', nothing: null, gone: undefined, opts: { deep: 1 } }),
    ).toEqual([
      ['path', 'a.ts'],
      ['opts', '{"deep":1}'],
    ])
    // 长文本进表会把卡片撑爆，它该走代码块。
    expect(argsRows({ content: 'z'.repeat(401) })).toEqual([])
    expect(argsRows({ content: 'z'.repeat(400) })).toHaveLength(1)
  })

  test('firstString 按给定顺序取第一个非空字符串', () => {
    expect(firstString({ a: '', b: '  ', c: 'hit' }, 'a', 'b', 'c')).toBe('hit')
    expect(firstString({ a: 1 }, 'a')).toBe('')
    expect(firstString({}, 'a')).toBe('')
  })
})

describe('diff 提取', () => {
  test('成对字段优先，红绿各带前缀', () => {
    const d = diffFrom({ old_string: 'a', new_string: 'b' })
    expect(d?.removed.startsWith('- a')).toBe(true)
    expect(d?.added).toBe('+ b')
  })

  test('只有一侧也成立——新建与删除都是合法的编辑', () => {
    expect(diffFrom({ new_string: 'only' })?.removed).toBe('')
    expect(diffFrom({ old_string: 'only' })?.added).toBe('')
  })

  test('回落到整段 patch，按行首符号分拣', () => {
    const d = diffFrom({ patch: ['-old', '+new', ' ctx'].join('\n') })
    expect(d?.removed).toBe('-old')
    expect(d?.added).toBe('+new')
  })

  /** 取不到就返回 null：返回一个空 diff 会在界面上画出一个空的红绿框。 */
  test('什么都取不到返回 null', () => {
    expect(diffFrom({})).toBeNull()
    expect(diffFrom({ path: 'a.ts' })).toBeNull()
  })
})
