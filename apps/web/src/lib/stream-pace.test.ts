/**
 * 流式增量落地的口径：正文匀速与工具输出合帧。覆盖 `lib/stream-pace.ts` 全部导出。
 *
 * 这套机制唯一不可接受的失败是**丢字**——它在「收到」和「显示」之间插了一个
 * 缓冲区，缓冲区一旦漏，用户看到的回答就少了一截，而且没有任何报错。
 * 所以这里第一条测的就是「无论怎么切，拼回去必须逐字相等」。
 */

import { describe, expect, test } from 'bun:test'
import {
  CATCHUP_RATIO,
  createFramer,
  createPacer,
  freshPace,
  GAP_HOLD_INIT,
  MAX_CHARS,
  MAX_RESERVE_TICKS,
  MIN_RESERVE_TICKS,
  observe,
  reparseSkip,
  reserveTicks,
  sliceSize,
  TICK_MS,
  takeAll,
  takeSlice,
} from './stream-pace.ts'

/** 这些用例只看「每档放多少」的三条规则，蓄水池取满档，与现场深浅无关。 */
const FULL = MAX_RESERVE_TICKS

describe('不丢字', () => {
  test('连续 takeSlice 到空，拼回去和原文逐字相等', () => {
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
    expect(sliceSize(0, 2, FULL)).toBe(0)
    expect(sliceSize(-1, 2, FULL)).toBe(0)
  })

  /**
   * 主规则：按估计流速放，不跟着积压走。同一个流速下，积压翻倍每档也不该变——
   * 变了就说明又退回成比例式了，那正是忽快忽慢的来源。
   */
  test('积压在可控区间内时，每档只由流速决定', () => {
    // 流速 2 的可控区间是 [2×蓄水池, 2×蓄水池×CATCHUP] = [20, 80] 字。
    expect(sliceSize(30, 2, FULL)).toBe(2)
    expect(sliceSize(60, 2, FULL)).toBe(2)
  })

  /** 上界：积压见底就放慢，把剩下的铺开撑到下一批，而不是放完了空等。 */
  test('积压见底时按蓄水池档数铺开，压过流速', () => {
    expect(sliceSize(FULL, 5, FULL)).toBe(1)
    expect(sliceSize(FULL * 2, 5, FULL)).toBe(2)
  })

  /** 下界：流速估低时不能让积压只增不减，落后到上限就按上限排。 */
  test('积压超过 CATCHUP_RATIO 倍蓄水池时，按下界加速', () => {
    expect(sliceSize(FULL * CATCHUP_RATIO * 3, 1, FULL)).toBe(3)
  })

  test('积压再多也不超过硬顶', () => {
    expect(sliceSize(10_000, 2, FULL)).toBe(MAX_CHARS)
    expect(sliceSize(MAX_CHARS * FULL * CATCHUP_RATIO * 5, 1, FULL)).toBe(MAX_CHARS)
  })

  /** 还没算出流速时退回上界——铺开撑住，不是一次放完。 */
  test('流速未知时用上界', () => {
    expect(sliceSize(100, 0, FULL)).toBe(100 / FULL)
  })

  test('同一流速下单调不减', () => {
    let prev = 0
    for (const n of [1, 50, 200, 600, 2000, 50_000]) {
      const v = sliceSize(n, 2, FULL)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  /** 蓄水池浅了要更快放：同一份积压、同一个流速，浅的那档不许比深的少。 */
  test('蓄水池越浅，每档放得越多', () => {
    expect(sliceSize(200, 1, MIN_RESERVE_TICKS)).toBeGreaterThan(sliceSize(200, 1, FULL))
  })
})

/**
 * 蓄水池按实测到达间隔定。
 *
 * 原始失败形状：蓄水池是固定 10 档，因此不论上游多平顺，显示都恒定落后 500ms 左右，
 * 而这份落后会在终态被一次性倒出去——1200 字每秒的上游实测结尾蹦 486 字。
 * 这里锁的是「间隔短就存得浅」，以及**批量上游不受影响**（那 10 档是它需要的）。
 */
describe('蓄水池深度', () => {
  test('冷启动按最深的估 —— 还没量过间隔时不许冒进', () => {
    expect(reserveTicks(freshPace().gapHold)).toBe(MAX_RESERVE_TICKS)
    expect(GAP_HOLD_INIT).toBe(MAX_RESERVE_TICKS * TICK_MS)
  })

  test('档数跟着间隔走，两头都夹住', () => {
    expect(reserveTicks(0)).toBe(MIN_RESERVE_TICKS)
    expect(reserveTicks(TICK_MS * 5)).toBe(5)
    expect(reserveTicks(10_000)).toBe(MAX_RESERVE_TICKS)
  })

  /** 间隔变长要立刻跟上：漏一次就是一段空档，比多存几档难看得多。 */
  test('间隔变长立刻跟上，变短慢慢收', () => {
    const st = freshPace()
    observe(st, 20, 0)
    observe(st, 20, 900)
    expect(st.gapHold).toBe(900)
    observe(st, 20, 920)
    expect(st.gapHold).toBeLessThan(900)
    expect(st.gapHold).toBeGreaterThan(TICK_MS)
  })

  /** 卡顿不是节奏：拿六秒的空档撑大蓄水池，恢复之后的正文会一直欠着这份延迟。 */
  test('间隔超过 STALL_MS 的那一次不撑大蓄水池', () => {
    const st = freshPace()
    observe(st, 20, 0)
    observe(st, 20, 100)
    const before = st.gapHold
    observe(st, 20, 9000)
    expect(st.gapHold).toBe(before)
  })

  /**
   * 行为口径：平顺上游的稳态落后要显著小于批量上游，且结尾没什么可倒的。
   * 两个序列同一份代码跑，比的是「落后多少字」，不是内部取值。
   */
  test('平顺上游的落后远小于批量上游', () => {
    const backlog = (gapMs: number, chars: number, rounds: number) => {
      const st = freshPace()
      const perGap = Math.max(1, Math.round(gapMs / TICK_MS))
      let at = 0
      for (let i = 0; i < rounds; i++) {
        observe(st, chars, at)
        st.pending += 'x'.repeat(chars)
        for (let k = 0; k < perGap; k++) takeSlice(st)
        at += gapMs
      }
      return st.pending.length
    }
    // 两个上游都是 400 字每秒，只有到达节奏不同。
    const smooth = backlog(50, 20, 200)
    const batched = backlog(960, 384, 20)
    expect(smooth).toBeLessThan(batched / 3)
    // 终态一次倒出去的就是这些字：平顺上游不该攒够半行以上。
    expect(smooth).toBeLessThan(60)
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

/**
 * 渲染层的降频判据。
 *
 * 原始失败形状：渲染层自己挂了个 60ms 的定时器给 markdown 重解析限速，和这里的
 * 50ms 一档串起来是两个不同步的周期——稳态变成每 100ms 落地一次、每次蹦两档的量。
 * 匀速播放被压成跳变，正文成批出现而不是连续流出。改成数档数之后不会再拍频，
 * 但**短回复必须落在「每档都跟」这一档**，否则匀速依然是假的。
 */
describe('重解析降频', () => {
  test('便宜就每档都跟 —— 短回复要完全匀速', () => {
    expect(reparseSkip(0)).toBe(1)
    expect(reparseSkip(3.3)).toBe(1) // 实测 3000 字
    expect(reparseSkip(8.9)).toBe(1) // 实测 6000 字
    expect(reparseSkip(TICK_MS * 0.4)).toBe(1) // 正好占满预算，仍然每档都跟
  })

  test('贵了才跳档，跳几档跟着成本走', () => {
    expect(reparseSkip(28.5)).toBe(2) // 实测 12000 字
    expect(reparseSkip(71.3)).toBe(4) // 实测 20000 字
  })

  test('单调不减 —— 越贵不许跳得越少', () => {
    let prev = 0
    for (const cost of [0, 1, 5, 20, 40, 100, 400]) {
      const n = reparseSkip(cost)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
  })
})

describe('收敛', () => {
  /**
   * 一次大突发要在有限档内放完，而且档数得是个能看的数。
   * 硬顶 150 字 / 50ms = 3000 字每秒——一屏中文不到半秒，比一帧糊出来强，
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

  test('边 push 边 tick，最终一个字不差', () => {
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

/**
 * 工具中途输出的合帧。
 *
 * 原始失败形状：`tool.delta` 一条一落地，实测 367 次每秒（`git log --stat -n 400`，
 * 273 段 / 744ms），每次都要重渲染整块 `<pre>` 并写一次 `scrollTop`。
 * 这里锁两件事：**同一档里到的合成一次落地**，以及**一个字节都不少**。
 */
describe('工具输出合帧', () => {
  function harness() {
    const written: [string, string][] = []
    let fn: (() => void) | null = null
    const framer = createFramer({
      write: (id, chunk) => written.push([id, chunk]),
      schedule: (f) => {
        fn = f
        return () => {
          fn = null
        }
      },
    })
    return {
      framer,
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

  test('同一档里的若干段并成一次落地', () => {
    const h = harness()
    for (let i = 0; i < 20; i++) h.framer.push('s1', `第${i}行\n`)
    expect(h.written).toHaveLength(0) // push 本身不写
    h.tick()
    expect(h.written).toHaveLength(1)
    expect(h.text('s1')).toBe(Array.from({ length: 20 }, (_, i) => `第${i}行\n`).join(''))
  })

  /** 一波并发工具会同时产出，混成一桶就串卡片了。 */
  test('按 stepId 分桶，不串卡片', () => {
    const h = harness()
    h.framer.push('s1', 'aaa')
    h.framer.push('s2', 'bbb')
    h.framer.push('s1', 'ccc')
    h.tick()
    expect(h.text('s1')).toBe('aaaccc')
    expect(h.text('s2')).toBe('bbb')
  })

  test('flush 立刻落地并停表', () => {
    const h = harness()
    h.framer.push('s1', 'xyz')
    h.framer.flush()
    expect(h.text('s1')).toBe('xyz')
    expect(h.running()).toBe(false)
  })

  test('落完之后定时器自己停掉，不空转', () => {
    const h = harness()
    h.framer.push('s1', 'abc')
    expect(h.running()).toBe(true)
    h.tick(2)
    expect(h.running()).toBe(false)
    expect(h.text('s1')).toBe('abc')
  })

  /** 换会话是丢弃不是落地：那段输出属于上一份 transcript。 */
  test('discard 把攒着的扔掉，不写出去', () => {
    const h = harness()
    h.framer.push('s1', 'zzz')
    h.framer.discard()
    h.tick(3)
    expect(h.written).toHaveLength(0)
    expect(h.running()).toBe(false)
  })

  test('边 push 边 tick，最终一个字节不差', () => {
    const h = harness()
    let fed = ''
    for (let i = 0; i < 40; i++) {
      const chunk = `line ${i}\n`
      h.framer.push('s1', chunk)
      fed += chunk
      if (i % 3 === 0) h.tick()
    }
    h.framer.flush()
    expect(h.text('s1')).toBe(fed)
  })
})
