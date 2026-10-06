/**
 * 流式增量的写入规则：正文匀速输出与工具输出合帧。覆盖 `lib/stream-pace.ts` 全部导出。
 *
 * 该机制唯一不可接受的失败是丢字：它在「收到」与「显示」之间插入了一个
 * 缓冲区，缓冲区一旦遗漏，用户看到的回答就会缺失一段，且没有任何报错。
 * 因此第一组用例测试「无论如何切分，拼接结果必须与原文逐字相等」。
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

/** 这些用例只测试每个节拍输出量的三条规则，缓冲储备取最大值，与运行时的实际深度无关。 */
const FULL = MAX_RESERVE_TICKS

describe('不丢字', () => {
  test('连续 takeSlice 直至为空，拼接结果与原文逐字相等', () => {
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

  test('输出过程中到达新文字也不丢失：边接收边输出是常态', () => {
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

  test('takeAll 之后缓冲区为空，再次读取得到空串', () => {
    const st = freshPace()
    st.pending = 'abc'
    expect(takeAll(st)).toBe('abc')
    expect(st.pending).toBe('')
    expect(takeAll(st)).toBe('')
    expect(takeSlice(st)).toBe('')
  })
})

describe('不切分出半个字符', () => {
  /** 完整代理对按码点迭代会合成一个字符；孤立代理留下的是单个码元。 */
  const hasLoneSurrogate = (text: string) =>
    [...text].some(
      (ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff,
    )

  /**
   * emoji 占两个 UTF-16 码元，在中间切分会使界面显示一帧 U+FFFD 方块。
   * 每个节拍只输出一两个字时，几乎每个 emoji 都会被切分一次，本用例锁定这一点。
   */
  test('逐个节拍输出的正文中，任何一帧都不含孤立代理', () => {
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

describe('每个节拍的输出量', () => {
  test('缓冲为空时为 0：定时器据此自行停止', () => {
    expect(sliceSize(0, 2, FULL)).toBe(0)
    expect(sliceSize(-1, 2, FULL)).toBe(0)
  })

  /**
   * 主规则：按估计流速输出，不随积压变化。同一流速下，积压加倍时每个节拍的输出量也不变；
   * 若发生变化，说明实现退回了比例式，即速度忽快忽慢的成因。
   */
  test('积压在可控区间内时，每个节拍的输出量只由流速决定', () => {
    // 流速 2 的可控区间是 [2×储备, 2×储备×CATCHUP] = [20, 80] 字。
    expect(sliceSize(30, 2, FULL)).toBe(2)
    expect(sliceSize(60, 2, FULL)).toBe(2)
  })

  /** 上界：积压接近耗尽时放慢，将剩余部分分摊到下一批到达之前，而不是输出完后空等。 */
  test('积压接近耗尽时按储备节拍数分摊，优先于流速', () => {
    expect(sliceSize(FULL, 5, FULL)).toBe(1)
    expect(sliceSize(FULL * 2, 5, FULL)).toBe(2)
  })

  /** 下界：流速估计偏低时不得使积压只增不减，落后达到上限时按上限输出。 */
  test('积压超过储备的 CATCHUP_RATIO 倍时，按下界加速', () => {
    expect(sliceSize(FULL * CATCHUP_RATIO * 3, 1, FULL)).toBe(3)
  })

  test('积压再多也不超过单节拍上限', () => {
    expect(sliceSize(10_000, 2, FULL)).toBe(MAX_CHARS)
    expect(sliceSize(MAX_CHARS * FULL * CATCHUP_RATIO * 5, 1, FULL)).toBe(MAX_CHARS)
  })

  /** 尚未得出流速时使用上界：分摊输出，而不是一次输出完毕。 */
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

  /** 储备越浅输出越快：积压与流速相同时，浅储备的输出量不得少于深储备。 */
  test('储备越浅，每个节拍输出越多', () => {
    expect(sliceSize(200, 1, MIN_RESERVE_TICKS)).toBeGreaterThan(sliceSize(200, 1, FULL))
  })
})

/**
 * 缓冲储备按实测到达间隔确定。
 *
 * 原始失败形状：储备固定为 10 个节拍，因此无论上游多平稳，显示都恒定落后约 500ms，
 * 且这部分落后会在终态一次性输出：1200 字每秒的上游实测结尾一次输出 486 字。
 * 本组锁定「间隔短则储备浅」，以及批量上游不受影响（它需要这 10 个节拍）。
 */
describe('缓冲储备深度', () => {
  test('冷启动时按最深储备估计：尚未测得间隔时不得冒进', () => {
    expect(reserveTicks(freshPace().gapHold)).toBe(MAX_RESERVE_TICKS)
    expect(GAP_HOLD_INIT).toBe(MAX_RESERVE_TICKS * TICK_MS)
  })

  test('节拍数随间隔变化，上下限均受限制', () => {
    expect(reserveTicks(0)).toBe(MIN_RESERVE_TICKS)
    expect(reserveTicks(TICK_MS * 5)).toBe(5)
    expect(reserveTicks(10_000)).toBe(MAX_RESERVE_TICKS)
  })

  /** 间隔变长时立即跟随：未跟随一次就会出现一段空白，影响远大于多储备几个节拍。 */
  test('间隔变长时立即跟随，变短时逐步收缩', () => {
    const st = freshPace()
    observe(st, 20, 0)
    observe(st, 20, 900)
    expect(st.gapHold).toBe(900)
    observe(st, 20, 920)
    expect(st.gapHold).toBeLessThan(900)
    expect(st.gapHold).toBeGreaterThan(TICK_MS)
  })

  /** 停顿不是节奏：用六秒的停顿扩大储备，恢复后的正文会持续带有这段延迟。 */
  test('间隔超过 STALL_MS 的那一次不扩大储备', () => {
    const st = freshPace()
    observe(st, 20, 0)
    observe(st, 20, 100)
    const before = st.gapHold
    observe(st, 20, 9000)
    expect(st.gapHold).toBe(before)
  })

  /**
   * 行为判据：平稳上游的稳态落后须显著小于批量上游，且结尾几乎没有积压。
   * 两个序列由同一份代码执行，比较的是落后的字数，不是内部取值。
   */
  test('平稳上游的落后远小于批量上游', () => {
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
    // 终态一次性输出的即这些字：平稳上游的积压不应超过半行。
    expect(smooth).toBeLessThan(60)
  })
})

describe('流速估计', () => {
  test('首批没有可计算的间隔，流速仍为 0', () => {
    const st = freshPace()
    observe(st, 37, 1000)
    expect(st.rate).toBe(0)
  })

  test('从第二批起按到达间隔计算：960ms 到达 37 字约合每个节拍 1.9 字', () => {
    const st = freshPace()
    observe(st, 37, 1000)
    observe(st, 37, 1960)
    expect(st.rate).toBeCloseTo((37 / 960) * TICK_MS, 2)
  })

  /**
   * 停顿不是流速。将六秒的停顿计入时，估计值会被拉到极低，
   * 恢复后正文会逐字缓慢输出。
   */
  test('间隔超过 STALL_MS 的那一次不更新流速', () => {
    const st = freshPace()
    observe(st, 37, 1000)
    observe(st, 37, 1960)
    const before = st.rate
    observe(st, 37, 9000)
    expect(st.rate).toBe(before)
    // 但时刻必须更新，否则下一批会用跨越停顿的间隔计算。
    expect(st.lastPushAt).toBe(9000)
  })
})

/**
 * 上游按批转发时同样须匀速输出。
 *
 * 原始失败形状：中转站约每 960ms 发送一批 37 字（2026-08-20 实测）。按积压比例输出的
 * 写法在该序列上每个节拍在 1↔3 字之间跳动，500ms 窗口在 10↔28 字之间跳动，视觉上忽快忽慢。
 * 本组锁定两项：不出现空节拍，以及窗口速率保持稳定。
 */
describe('批量到达时同样匀速', () => {
  test('每 960ms 到达 37 字：不出现空节拍，窗口速率稳定', () => {
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

    // 视觉感受取决于数百毫秒内的平均值，而不是单个节拍。取后半程（流速已估计准确）比较。
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
 * 原始失败形状：渲染层另设一个 60ms 定时器为 markdown 重解析限速，与此处
 * 50ms 的节拍是两个不同步的周期，稳态变为每 100ms 写入一次、每次输出两个节拍的量。
 * 匀速输出被压缩为跳变，正文成批出现而不是连续输出。按节拍计数可避免拍频，
 * 但短回复必须落在每个节拍都重解析的档位，否则匀速仍不成立。
 */
describe('重解析降频', () => {
  test('开销低时每个节拍都重解析：短回复须完全匀速', () => {
    expect(reparseSkip(0)).toBe(1)
    expect(reparseSkip(3.3)).toBe(1) // 实测 3000 字
    expect(reparseSkip(8.9)).toBe(1) // 实测 6000 字
    expect(reparseSkip(TICK_MS * 0.4)).toBe(1) // 恰好占满预算，仍每个节拍都重解析
  })

  test('开销高时才跳过节拍，跳过的数量随开销变化', () => {
    expect(reparseSkip(28.5)).toBe(2) // 实测 12000 字
    expect(reparseSkip(71.3)).toBe(4) // 实测 20000 字
  })

  test('单调不减：开销越高，跳过的节拍不得越少', () => {
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
   * 一次大量突发须在有限节拍内输出完毕，且节拍数在可接受范围内。
   * 单节拍上限 150 字 / 50ms = 3000 字每秒：一屏中文不到半秒，优于在一帧内全部显示，
   * 也不会使用户久等。
   */
  test('两千字的突发在有限节拍内输出完毕', () => {
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
  /** 手动步进的模拟调度：`tick()` 前进一个节拍，可随时查询是否仍在运行。 */
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

  test('逐个节拍输出，而不是一次全部输出', () => {
    const h = harness()
    h.pacer.push('s1', 'x'.repeat(200))
    expect(h.written).toHaveLength(0) // push 本身不写入
    h.tick()
    expect(h.written).toHaveLength(1)
    expect(h.written[0]![1].length).toBeLessThanOrEqual(MAX_CHARS)
    // 尚无第二批可计算流速，使用上界；积压接近耗尽时每个节拍降为 1 字，所需节拍数多于按单节拍上限计算的数量。
    h.tick(200)
    expect(h.text('s1')).toBe('x'.repeat(200))
  })

  test('输出完毕后定时器自行停止，不空转', () => {
    const h = harness()
    h.pacer.push('s1', 'abc')
    expect(h.running()).toBe(true)
    // 三个字在三个节拍内输出完毕，第四个节拍取得空串后停止定时器。
    h.tick(4)
    expect(h.running()).toBe(false)
    expect(h.text('s1')).toBe('abc')
  })

  /** 终态必须立即全部输出：读数条与错误卡读取的是同一份 transcript。 */
  test('flush 一次性输出并停止定时器', () => {
    const h = harness()
    h.pacer.push('s1', 'y'.repeat(500))
    h.tick()
    h.pacer.flush()
    expect(h.text('s1')).toBe('y'.repeat(500))
    expect(h.running()).toBe(false)
  })

  /**
   * 切换会话时丢弃积压，而不是输出：这段文字属于上一份 transcript，
   * 写入后会在新投影末尾多出一段不属于该会话的正文。
   */
  test('discard 丢弃积压，不写入', () => {
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

  /** 切换 step 时须先写完上一条，否则其末尾会被计入新的一条。 */
  test('切换 step 时内容不混入其他 step', () => {
    const h = harness()
    h.pacer.push('s1', 'aaa')
    h.pacer.push('s2', 'bbb')
    h.tick(5)
    expect(h.text('s1')).toBe('aaa')
    expect(h.text('s2')).toBe('bbb')
  })

  test('交替执行 push 与 tick，最终结果逐字一致', () => {
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
 * 原始失败形状：`tool.delta` 每条单独写入，实测每秒 367 次（`git log --stat -n 400`，
 * 273 段 / 744ms），每次都要重新渲染整个 `<pre>` 并写一次 `scrollTop`。
 * 本组锁定两项：同一节拍内到达的内容合并为一次写入，以及不丢失任何字节。
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

  test('同一节拍内的若干段合并为一次写入', () => {
    const h = harness()
    for (let i = 0; i < 20; i++) h.framer.push('s1', `第${i}行\n`)
    expect(h.written).toHaveLength(0) // push 本身不写入
    h.tick()
    expect(h.written).toHaveLength(1)
    expect(h.text('s1')).toBe(Array.from({ length: 20 }, (_, i) => `第${i}行\n`).join(''))
  })

  /** 一批并发工具会同时输出，合并到同一缓冲会使输出写入错误的卡片。 */
  test('按 stepId 分别缓冲，输出不写入错误的卡片', () => {
    const h = harness()
    h.framer.push('s1', 'aaa')
    h.framer.push('s2', 'bbb')
    h.framer.push('s1', 'ccc')
    h.tick()
    expect(h.text('s1')).toBe('aaaccc')
    expect(h.text('s2')).toBe('bbb')
  })

  test('flush 立即写入并停止定时器', () => {
    const h = harness()
    h.framer.push('s1', 'xyz')
    h.framer.flush()
    expect(h.text('s1')).toBe('xyz')
    expect(h.running()).toBe(false)
  })

  test('写入完毕后定时器自行停止，不空转', () => {
    const h = harness()
    h.framer.push('s1', 'abc')
    expect(h.running()).toBe(true)
    h.tick(2)
    expect(h.running()).toBe(false)
    expect(h.text('s1')).toBe('abc')
  })

  /** 切换会话时丢弃而不是写入：这段输出属于上一份 transcript。 */
  test('discard 丢弃缓冲内容，不写入', () => {
    const h = harness()
    h.framer.push('s1', 'zzz')
    h.framer.discard()
    h.tick(3)
    expect(h.written).toHaveLength(0)
    expect(h.running()).toBe(false)
  })

  test('交替执行 push 与 tick，最终结果逐字节一致', () => {
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
