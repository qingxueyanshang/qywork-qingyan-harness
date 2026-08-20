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
  DRAIN_TICKS,
  freshPace,
  MAX_CHARS,
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

describe('每档放多少', () => {
  test('空的时候是 0 —— 定时器据此停掉自己', () => {
    expect(sliceSize(0)).toBe(0)
    expect(sliceSize(-1)).toBe(0)
  })

  /**
   * 每档没有保底字数，这条锁的是「别加回来」——保底会把按批到达的一批提前排空，
   * 剩下的时间无字可放。理由与实测见文件头。
   */
  test('少量积压就少放，每档不设下限', () => {
    expect(sliceSize(1)).toBe(1)
    expect(sliceSize(DRAIN_TICKS)).toBe(1)
    expect(sliceSize(DRAIN_TICKS + 1)).toBe(2)
  })

  /**
   * 硬顶是这条里唯一真正挡事的：软目标是「剩余 ÷ 24」，
   * 积压一万字时那也是一次 417 字——一帧糊出去，正是要避免的那个画面。
   */
  test('积压再多也不超过硬顶', () => {
    expect(sliceSize(10_000)).toBe(MAX_CHARS)
    expect(sliceSize(MAX_CHARS * DRAIN_TICKS * 5)).toBe(MAX_CHARS)
  })

  test('中间区间按剩余量线性放快', () => {
    const n = sliceSize(DRAIN_TICKS * 10)
    expect(n).toBe(10)
    expect(n).toBeLessThanOrEqual(MAX_CHARS)
  })

  /** 积压越多每档越大——不然积压只会越拖越远。 */
  test('单调不减', () => {
    let prev = 0
    for (const n of [1, 50, 200, 600, 2000, 50_000]) {
      const s = sliceSize(n)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })
})

/**
 * 上游按批转发时也要匀速。
 *
 * 原始失败形状：中转站每约 960ms 给 37 字一批（2026-08-20 实测），而每档保底 6 字
 * 会在 350ms 内把一批排空，剩下 650ms 一个字都放不出来——界面一秒顿一次，
 * 六成以上的档是空的。这条锁的是「一批的字要铺到下一批到达」。
 */
describe('批量到达也要匀速', () => {
  test('每 960ms 到 37 字：中间不断档', () => {
    const st = freshPace()
    const ticksPerBatch = Math.round(960 / TICK_MS)
    let idle = 0
    for (let batch = 0; batch < 6; batch++) {
      st.pending += 'x'.repeat(37)
      for (let k = 0; k < ticksPerBatch; k++) if (takeSlice(st) === '') idle++
    }
    expect(idle).toBe(0)
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
    const pacer = createPacer({
      write: (id, chunk) => written.push([id, chunk]),
      schedule: (f) => {
        fn = f
        return () => {
          fn = null
        }
      },
    })
    return {
      pacer,
      written,
      running: () => fn !== null,
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
    // 尾部按 `ceil(剩余 ÷ 24)` 递减到 1 字一档，200 字铺得比硬顶算出来的档数长。
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
