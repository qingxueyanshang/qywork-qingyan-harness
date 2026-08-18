/**
 * 覆盖范围：`reload-supervisor.ts` 的全部策略（防抖合并、有活时不换、换的过程中
 * 又来改动、restart 抛错后不卡死），以及 `isSourceChange` 的过滤。
 *
 * 定时器是注入的假的：真等 300ms / 2s 会让这份测试变成秒级，而且时序断言会随机红。
 */

import { describe, expect, test } from 'bun:test'
import { createReloadSupervisor, isSourceChange } from './reload-supervisor.ts'

/** 手动推进的定时器。同一时刻只可能有一个待触发的——策略本身就是这么设计的。 */
function clock() {
  let pending: { fn: () => void; ms: number; id: number } | null = null
  let seq = 1
  return {
    setTimer(fn: () => void, ms: number) {
      pending = { fn, ms, id: seq++ }
      return pending.id
    },
    clearTimer(handle: unknown) {
      if (pending && pending.id === handle) pending = null
    },
    /** 下一次触发要等多少毫秒；没有待触发的就是 null。 */
    waiting: () => pending?.ms ?? null,
    /** 触发它，并把 restart 那条 promise 链上的微任务放干净。 */
    async fire() {
      const p = pending
      pending = null
      p?.fn()
      await Bun.sleep(0)
      await Bun.sleep(0)
    },
  }
}

function harness(opts: { busy?: () => boolean; restart?: () => Promise<void> } = {}) {
  const c = clock()
  const restarts: number[] = []
  const logs: string[] = []
  const sup = createReloadSupervisor({
    busy: opts.busy ?? (() => false),
    restart:
      opts.restart ??
      (async () => {
        restarts.push(restarts.length + 1)
      }),
    debounceMs: 300,
    idlePollMs: 2000,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    log: (l) => void logs.push(l),
  })
  return { c, sup, restarts, logs }
}

describe('换代码的时机', () => {
  test('连着几次改动只换一次 —— 一次保存会来好几个事件', async () => {
    const { c, sup, restarts } = harness()
    sup.onChange()
    sup.onChange()
    sup.onChange()
    expect(c.waiting()).toBe(300)
    await c.fire()
    expect(restarts.length).toBe(1)
    // 攒完就没有下一次了，不会自己空转。
    expect(c.waiting()).toBeNull()
  })

  test('手上有 run 就不换，按回看间隔排队；跑完了才换', async () => {
    let running = true
    const { c, sup, restarts } = harness({ busy: () => running })

    sup.onChange()
    await c.fire()
    expect(restarts.length).toBe(0)
    // 排的是回看间隔，不是防抖——这两个数混了的话，有活时会 300ms 空转一轮又一轮。
    expect(c.waiting()).toBe(2000)

    await c.fire()
    expect(restarts.length).toBe(0)
    expect(c.waiting()).toBe(2000)

    running = false
    await c.fire()
    expect(restarts.length).toBe(1)
  })

  /** 原始失败形状：跑了 8 分钟的一轮，中途保存源码，它必须活到跑完。 */
  test('复现原始形状：跑着的那一轮不会被换代码打断', async () => {
    let running = true
    const killed: string[] = []
    const { c, sup } = harness({
      busy: () => running,
      restart: async () => {
        killed.push(running ? '打断了正在跑的那轮' : '空闲时换的')
      },
    })
    sup.onChange()
    for (let i = 0; i < 20; i++) {
      await c.fire()
      expect(killed).toEqual([])
    }
    running = false
    await c.fire()
    expect(killed).toEqual(['空闲时换的'])
  })

  test('换的过程中又有改动：排到后面，不并发换两次', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started = 0
    const { c, sup } = harness({
      restart: async () => {
        started++
        await gate
      },
    })

    sup.onChange()
    await c.fire()
    expect(started).toBe(1)

    // 第一次还没回来，这时又有改动。
    sup.onChange()
    await c.fire()
    expect(started).toBe(1)
    expect(c.waiting()).toBe(300)

    release()
    await Bun.sleep(0)
    await c.fire()
    expect(started).toBe(2)
  })

  test('restart 抛错不把自己卡死 —— 下一次改动照样换', async () => {
    let fail = true
    let calls = 0
    const { c, sup, logs } = harness({
      restart: async () => {
        calls++
        if (fail) throw new Error('端口还没放开')
      },
    })

    sup.onChange()
    await c.fire()
    expect(calls).toBe(1)
    expect(logs.some((l) => l.includes('换代码失败'))).toBe(true)

    fail = false
    sup.onChange()
    await c.fire()
    expect(calls).toBe(2)
  })
})

describe('哪些文件算源码变了', () => {
  test('带子目录的相对路径能判出 src', () => {
    expect(isSourceChange('tools\\src\\files.ts')).toBe(true)
    expect(isSourceChange('tools/src/files.ts')).toBe(true)
  })

  test('测试文件、构建产物、非 ts 都不算', () => {
    expect(isSourceChange('tools\\src\\files.test.ts')).toBe(false)
    expect(isSourceChange('core\\dist\\bundle.ts')).toBe(false)
    expect(isSourceChange('tools\\src\\readme.md')).toBe(false)
    expect(isSourceChange('core')).toBe(false)
  })

  /** watch 的回调可能给 null（拿不到文件名），那时不能当成「有改动」。 */
  test('拿不到文件名时不算', () => {
    expect(isSourceChange(null)).toBe(false)
    expect(isSourceChange(undefined)).toBe(false)
  })
})
describe('sidecar 自己没了', () => {
  test('崩了就重新起一个 —— 否则界面变成连不上后端的空壳', async () => {
    const { c, sup, restarts } = harness()
    sup.onExit(1)
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(restarts.length).toBe(1)
    // 崩溃重起不走防抖：不是「攒一下」，是立刻补上。
    expect(c.waiting()).toBeNull()
  })

  /** 换代码时是我们自己杀的，那不是崩溃——再补一次就成了双起。 */
  test('换代码期间的退出不算崩溃', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started = 0
    const { c, sup } = harness({
      restart: async () => {
        started++
        await gate
      },
    })
    sup.onChange()
    await c.fire()
    expect(started).toBe(1)

    sup.onExit(0)
    await Bun.sleep(0)
    expect(started).toBe(1)
    release()
  })

  test('连着起不来就停手，并说清楚', async () => {
    const { sup, logs } = harness({
      restart: async () => {
        throw new Error('端口被占着')
      },
    })
    for (let i = 0; i < 6; i++) {
      sup.onExit(1)
      await Bun.sleep(0)
      await Bun.sleep(0)
    }
    expect(logs.some((l) => l.includes('不再重试'))).toBe(true)
  })

  test('成功换过一次代码之后，崩溃计数清零', async () => {
    let fail = true
    let starts = 0
    const { c, sup, logs } = harness({
      restart: async () => {
        starts++
        if (fail) throw new Error('起不来')
      },
    })
    for (let i = 0; i < 4; i++) {
      sup.onExit(1)
      await Bun.sleep(0)
      await Bun.sleep(0)
    }
    expect(logs.some((l) => l.includes('不再重试'))).toBe(true)

    // 改一次代码并成功换上去，计数清零，之后崩溃还会再被接住。
    fail = false
    sup.onChange()
    await c.fire()
    const before = starts
    sup.onExit(1)
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(starts).toBe(before + 1)
  })
})
