/**
 * 正文匀速呈现的口径。覆盖 `lib/stream-pace.ts`。
 *
 * 这套东西唯一不可接受的失败是**丢字**——它在「收到」和「显示」之间插了一个
 * 缓冲区，缓冲区一旦漏，用户看到的回答就少了一截，而且没有任何报错。
 * 所以这里第一条测的就是「无论怎么切，拼回去必须逐字相等」。
 */

import { describe, expect, test } from 'bun:test'
import {
  createPacer,
  freshPace,
  MAX_CHARS,
  MAX_LAG_TICKS,
  observe,
  RESERVE_TICKS,
  sliceSize,
  TICK_MS,
  takeAll,
  takeSlice,
} from './stream-pace.ts'

describe('不丢字', () => {
  test('一路 takeSlice 到空，拼回去和原文逐字相等', () => {
    const text = '这是一段中文正文，混着 ASCII 和 emoji 🙂，'.repeat(40)
    const st = freshPace()
    st.pending = text
    let out = ''
    let guard = 0
    while (st.pending.length > 0) {
      out += takeSlice(st)
      if (++guard > 10_000) throw new Error('没有收敛')
    }
    expect(out).toBe(text)
  })

  test('中途来新字也不丢——边放边收是常态', () => {
    const st = freshPace()
    let out = ''
    let fed = ''
    for (let i = 0; i < 50; i++) {
      const chunk = `第${i}段-`
      st.pending += chunk
      fed += chunk
      out += takeSlice(st)
    }
    out += takeAll(st)
    expect(out).toBe(fed)
  })

  test('takeAll 之后缓冲区是空的，再取是空串', () => {
    const st = freshPace()
    st.pending = 'abc'
    expect(takeAll(st)).toBe('abc')
    expect(st.pending).toBe('')
    expect(takeAll(st)).toBe('')
    expect(takeSlice(st)).toBe('')
  })
})

describe('不切半个字符', () => {
  /** 完整代理对按码点迭代会合成一个字符；孤立代理留下的是单个码元。 */
  const hasLoneSurrogate = (text: string) =>
    [...text].some(
      (ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff,
    )

  /**
   * emoji 占两个 UTF-16 码元，切在中间会让界面闪一帧 U+FFFD 方块。
   * 每档只放一两个字时几乎每个 emoji 都会被切一次——这条锁的就是那一刀。
   */
  test('逐档放出的正文里，任何一帧都不含孤立代理', () => {
    const st = freshPace()
    st.rate = 1.5
    const text = '好的🙂我来看看🎉这段👨‍👩‍👧文字'
    st.pending = text
    let shown = ''
    let guard = 0
    while (st.pending.length > 0) {
      shown += takeSlice(st)
      expect(hasLoneSurrogate(shown)).toBe(false)
      if (++guard > 200) throw new Error('没有收敛')
    }
    expect(shown).toBe(text)
  })
})

describe('每档放多少', () => {
  test('空的时候是 0 —— 定时器据此停掉自己', () => {
    expect(sliceSize(0, 2)).toBe(0)
    expect(sliceSize(-1, 2)).toBe(0)
  })

  /**
   * 主规则：按估计流速放，不跟着积压走。同一个流速下，积压翻倍每档也不该变——
   * 变了就说明又退回成比例式了，那正是忽快忽慢的来源。
   */
  test('积压在可控区间内时，每档只由流速决定', () => {
    // 流速 2 的可控区间是 [2×RESERVE, 2×MAX_LAG] = [20, 80] 字。
    expect(sliceSize(30, 2)).toBe(2)
    expect(sliceSize(60, 2)).toBe(2)
  })

  /** 上界：积压见底就放慢，把剩下的铺开撑到下一批，而不是放完了空等。 */
  test('积压见底时按 RESERVE_TICKS 铺开，压过流速', () => {
    expect(sliceSize(RESERVE_TICKS, 5)).toBe(1)
    expect(sliceSize(RESERVE_TICKS * 2, 5)).toBe(2)
  })

  /** 下界：流速估低时不能让积压只增不减，落后到上限就按上限排。 */
  test('积压超过 MAX_LAG_TICKS 倍流速时，按下界加速', () => {
    expect(sliceSize(MAX_LAG_TICKS * 3, 1)).toBe(3)
  })

  test('积压再多也不超过硬顶', () => {
    expect(sliceSize(10_000, 2)).toBe(MAX_CHARS)
    expect(sliceSize(MAX_CHARS * MAX_LAG_TICKS * 5, 1)).toBe(MAX_CHARS)
  })

  /** 还没算出流速时退回上界——铺开撑住，不是一次放完。 */
  test('流速未知时用上界', () => {
    expect(sliceSize(100, 0)).toBe(100 / RESERVE_TICKS)
  })

  test('同一流速下单调不减', () => {
    let prev = 0
    for (const n of [1, 50, 200, 600, 2000, 50_000]) {
      const v = sliceSize(n, 2)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('流速估计', () => {
  test('首批没有间隔可算，流速仍是 0', () => {
    const st = freshPace()
    observe(st, 37, 1000)
    expect(st.rate).toBe(0)
  })

  test('第二批起按到达间隔算：960ms 来 37 字约合 1.9 字每档', () => {
    const st = freshPace()
    observe(st, 37, 1000)
    observe(st, 37, 1960)
    expect(st.rate).toBeCloseTo((37 / 960) * TICK_MS, 2)
  })

  /**
   * 卡顿不是流速。把六秒的空档算进去，估计值会被拉到极低，
   * 恢复之后正文是一个字一个字往外挤的。
   */
  test('间隔超过 STALL_MS 的那一次不更新流速', () => {
    const st = freshPace()
    observe(st, 37, 1000)
    observe(st, 37, 1960)
    const before = st.rate
    observe(st, 37, 9000)
    expect(st.rate).toBe(before)
    // 但时刻要跟上，否则下一批会拿一个跨越卡顿的间隔来算。
    expect(st.lastPushAt).toBe(9000)
  })
})

/**
 * 上游按批转发时也要匀速。
 *
 * 原始失败形状：中转站每约 960ms 给 37 字一批（2026-08-20 实测）。按积压比例放的
 * 写法在这个序列上是 1↔3 字每档来回跳，500ms 窗口 10↔28 字——肉眼就是忽快忽慢。
 * 这条锁两件事：**不断档**，以及**窗口速率不忽高忽低**。
 */
describe('批量到达也要匀速', () => {
  test('每 960ms 到 37 字：不断档，窗口速率也稳', () => {
    const st = freshPace()
    const perBatch = Math.round(960 / TICK_MS)
    const out: number[] = []
    let at = 0
    for (let batch = 0; batch < 10; batch++) {
      observe(st, 37, at)
      st.pending += 'x'.repeat(37)
      for (let k = 0; k < perBatch; k++) out.push(takeSlice(st).length)
      at += 960
    }
    expect(out.filter((n) => n === 0)).toHaveLength(0)

    // 人眼看的是几百毫秒的平均，不是单档。取后半程（流速已经估准）来比。
    const tail = out.slice(Math.floor(out.length / 2))
    const win: number[] = []
    for (let k = 0; k + 10 <= tail.length; k++) {
      win.push(tail.slice(k, k + 10).reduce((a, b) => a + b, 0))
    }
    expect(Math.max(...win) - Math.min(...win)).toBeLessThanOrEqual(4)
  })
})

describe('收敛', () => {
  /**
   * 一次大突发要在有限档内放完，而且档数得是个能看的数。
   * 硬顶 40 字 / 50ms = 800 字每秒，一屏中文大约一秒——比一帧糊出来强，
   * 也不至于让人等。
   */
  test('两千字的突发在有限档内放完', () => {
    const st = freshPace()
    st.pending = 'x'.repeat(2000)
    let ticks = 0
    while (st.pending.length > 0) {
      takeSlice(st)
      ticks++
      if (ticks > 500) throw new Error('放不完')
    }
    expect(ticks).toBeLessThanOrEqual(250)
    expect(ticks).toBeGreaterThanOrEqual(2000 / MAX_CHARS)
  })
})

describe('定时器编排', () => {
  /** 手动步进的假调度：`tick()` 走一档，随时能查还有没有在跑。 */
  function harness() {
    const written: [string, string][] = []
    let fn: (() => void) | null = null
    let clock = 0
    const pacer = createPacer({
      write: (id, chunk) => written.push([id, chunk]),
      schedule: (f) => {
        fn = f
        return () => {
          fn = null
        }
      },
      now: () => clock,
    })
    return {
      pacer,
      written,
      running: () => fn !== null,
      advance: (ms: number) => {
        clock += ms
      },
      tick: (n = 1) => {
        for (let i = 0; i < n; i++) fn?.()
      },
      text: (id: string) =>
        written
          .filter(([w]) => w === id)
          .map(([, c]) => c)
          .join(''),
    }
  }

  test('一档一档往外放，不是一次全给', () => {
    const h = harness()
    h.pacer.push('s1', 'x'.repeat(200))
    expect(h.written).toHaveLength(0) // push 本身不写
    h.tick()
    expect(h.written).toHaveLength(1)
    expect(h.written[0]![1].length).toBeLessThanOrEqual(MAX_CHARS)
    // 还没有第二批可以算流速，走的是上界；积压见底时每档降到 1 字，铺得比硬顶长。
    h.tick(200)
    expect(h.text('s1')).toBe('x'.repeat(200))
  })

  test('放完之后定时器自己停掉，不空转', () => {
    const h = harness()
    h.pacer.push('s1', 'abc')
    expect(h.running()).toBe(true)
    // 三字三档放完，第四档取到空串才停表。
    h.tick(4)
    expect(h.running()).toBe(false)
    expect(h.text('s1')).toBe('abc')
  })

  /** 终态必须立刻全放出去：读数条和错误卡读的是同一份 transcript。 */
  test('flush 一次性放完并停表', () => {
    const h = harness()
    h.pacer.push('s1', 'y'.repeat(500))
    h.tick()
    h.pacer.flush()
    expect(h.text('s1')).toBe('y'.repeat(500))
    expect(h.running()).toBe(false)
  })

  /**
   * 换会话是**丢弃**不是冲出去——那段字属于上一份 transcript，
   * 冲进来会在新投影末尾多出一截无主的正文。
   */
  test('discard 把积压扔掉，不写出去', () => {
    const h = harness()
    h.pacer.push('s1', 'z'.repeat(500))
    h.tick()
    const before = h.text('s1').length
    h.pacer.discard()
    expect(h.text('s1').length).toBe(before)
    h.tick(10)
    expect(h.text('s1').length).toBe(before)
    expect(h.running()).toBe(false)
  })

  /** 换 step 时上一条要先落干净，否则它的尾巴会被记到新的那条上。 */
  test('换 step 不串行', () => {
    const h = harness()
    h.pacer.push('s1', 'aaa')
    h.pacer.push('s2', 'bbb')
    h.tick(5)
    expect(h.text('s1')).toBe('aaa')
    expect(h.text('s2')).toBe('bbb')
  })

  test('一路 push 一路 tick，最终一个字不差', () => {
    const h = harness()
    let fed = ''
    for (let i = 0; i < 30; i++) {
      const chunk = `第${i}段。`
      h.pacer.push('s1', chunk)
      fed += chunk
      h.tick()
    }
    h.pacer.flush()
    expect(h.text('s1')).toBe(fed)
  })
})
