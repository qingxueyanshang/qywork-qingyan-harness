/**
 * 覆盖范围：`reload-supervisor.ts` 的全部策略（防抖合并、有进行中的 run 时不替换、替换过程中
 * 出现新改动、restart 抛错后不停滞、崩溃后重启），`isConsoleInterrupt` 的识别，`isSourceChange` 与 `isWebSourceChange` 的过滤，以及 `dev.ts` 初次启动
 * 立即失败时的退出路径。
 *
 * 定时器为注入的模拟实现：真实等待 300ms / 2s 会使本测试耗时达到秒级，且时序断言会随机失败。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createReloadSupervisor,
  isConsoleInterrupt,
  isSourceChange,
  isWebSourceChange,
} from './reload-supervisor.ts'

test('控制台中断只在 Windows 上按原始或截断的状态码识别，其他退出码不视为中断', () => {
  for (const code of [58, 0xc000013a, -1073741510]) {
    expect(isConsoleInterrupt(code, 'win32')).toBe(true)
  }
  for (const code of [null, 0, 1, 2, 101, 130]) {
    expect(isConsoleInterrupt(code, 'win32')).toBe(false)
  }
  expect(isConsoleInterrupt(58, 'linux')).toBe(false)
  expect(isConsoleInterrupt(58, 'darwin')).toBe(false)
})

function unusedPort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

/** 手动推进的定时器。按策略设计，同一时刻至多有一个待触发的定时器。 */
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
    /** 下一次触发的等待毫秒数；没有待触发的定时器时为 null。 */
    waiting: () => pending?.ms ?? null,
    /** 触发定时器，并执行完 restart 所在 promise 链上的全部微任务。 */
    async fire() {
      const p = pending
      pending = null
      p?.fn()
      await Bun.sleep(0)
      await Bun.sleep(0)
    },
  }
}

function harness(
  opts: { busy?: () => boolean | Promise<boolean>; restart?: () => Promise<void> } = {},
) {
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

describe('替换代码的时机', () => {
  test('异步空闲确认失败时保留旧进程，恢复后再替换', async () => {
    let available = false
    const { c, sup, restarts } = harness({
      busy: async () => {
        if (!available) throw new Error('sidecar 暂时无法应答')
        return false
      },
    })
    sup.onChange()
    await c.fire()
    expect(restarts).toEqual([])
    expect(c.waiting()).toBe(2000)
    available = true
    await c.fire()
    expect(restarts).toEqual([1])
  })

  test('查询空闲期间进程退出时仍会重新启动，旧查询的结果不触发重复重启', async () => {
    let answer!: (busy: boolean) => void
    const { c, sup, restarts } = harness({
      busy: () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    })
    sup.onChange()
    await c.fire()
    sup.onExit(1)
    await Bun.sleep(0)
    expect(restarts).toEqual([1])
    answer(false)
    await Bun.sleep(0)
    expect(restarts).toEqual([1])
  })

  test('连续多次改动只替换一次：一次保存会产生多个事件', async () => {
    const { c, sup, restarts } = harness()
    sup.onChange()
    sup.onChange()
    sup.onChange()
    expect(c.waiting()).toBe(300)
    await c.fire()
    expect(restarts.length).toBe(1)
    // 合并处理后不再有待触发的定时器，不会重复触发。
    expect(c.waiting()).toBeNull()
  })

  test('有 run 进行时不替换，按复查间隔排队；执行完毕后才替换', async () => {
    let running = true
    const { c, sup, restarts } = harness({ busy: () => running })

    sup.onChange()
    await c.fire()
    expect(restarts.length).toBe(0)
    // 排队使用复查间隔而不是防抖间隔：两者混用时，有任务运行期间会每 300ms 重复检查一次。
    expect(c.waiting()).toBe(2000)

    await c.fire()
    expect(restarts.length).toBe(0)
    expect(c.waiting()).toBe(2000)

    running = false
    await c.fire()
    expect(restarts.length).toBe(1)
  })

  /** 原始失败形状：一轮已运行 8 分钟，中途保存源码，该轮必须持续到执行完毕。 */
  test('复现原始形状：运行中的一轮不会被代码替换中断', async () => {
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

  test('替换过程中出现新改动：排到之后处理，不并发替换两次', async () => {
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

    // 第一次替换尚未完成时出现新改动。
    sup.onChange()
    await c.fire()
    expect(started).toBe(1)
    expect(c.waiting()).toBe(300)

    release()
    await Bun.sleep(0)
    await c.fire()
    expect(started).toBe(2)
  })

  test('restart 抛错不会导致自身停滞：下一次改动仍会替换', async () => {
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
    expect(logs.some((l) => l.includes('重启 sidecar 失败'))).toBe(true)

    fail = false
    sup.onChange()
    await c.fire()
    expect(calls).toBe(2)
  })
})

describe('哪些文件属于源码变化', () => {
  test('带子目录的相对路径能识别出 src', () => {
    expect(isSourceChange('tools\\src\\files.ts')).toBe(true)
    expect(isSourceChange('tools/src/files.ts')).toBe(true)
  })

  test('测试文件、构建产物与非 ts 文件均不属于源码变化', () => {
    expect(isSourceChange('tools\\src\\files.test.ts')).toBe(false)
    expect(isSourceChange('core\\dist\\bundle.ts')).toBe(false)
    expect(isSourceChange('tools\\src\\readme.md')).toBe(false)
    expect(isSourceChange('core')).toBe(false)
  })

  /** watch 的回调可能传入 null（无法取得文件名），此时不能视为「有改动」。 */
  test('无法取得文件名时不算作改动', () => {
    expect(isSourceChange(null)).toBe(false)
    expect(isSourceChange(undefined)).toBe(false)
  })

  test('前端 TSX、样式与资源都触发同一个替换判定，测试文件不触发', () => {
    expect(isWebSourceChange('components\\ConversationPanel.tsx')).toBe(true)
    expect(isWebSourceChange('styles\\transcript.css')).toBe(true)
    expect(isWebSourceChange('assets\\status.svg')).toBe(true)
    expect(isWebSourceChange('components\\ConversationPanel.test.tsx')).toBe(false)
    expect(isWebSourceChange('__tests__\\fixture.ts')).toBe(false)
    expect(isWebSourceChange(null)).toBe(false)
  })
})
describe('sidecar 自行退出', () => {
  test('崩溃后重新启动，否则界面无法连接后端', async () => {
    const { c, sup, restarts } = harness()
    sup.onExit(1)
    await Bun.sleep(0)
    await Bun.sleep(0)
    expect(restarts.length).toBe(1)
    // 崩溃后的重启不经过防抖：不合并等待，立即重启。
    expect(c.waiting()).toBeNull()
  })

  /** 替换代码时的退出由 supervisor 自身发起，不是崩溃；再次重启会启动两个进程。 */
  test('替换代码期间的退出不算崩溃', async () => {
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

  test('连续启动失败后停止重试，并说明原因', async () => {
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

  test('成功替换一次代码之后，崩溃计数清零', async () => {
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

    // 修改一次代码并替换成功后计数清零，之后的崩溃仍会触发重启。
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

describe('开发编排初次启动', () => {
  test('sidecar 立即退出时打印原始失败，不访问未初始化的 supervisor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-start-'))
    try {
      writeFileSync(join(dir, 'qywork.sqlite3'), 'not a sqlite database')
      const proc = Bun.spawn([process.execPath, 'run', 'scripts/dev.ts'], {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, QYWORK_HOME: dir, QYWORK_PORT: String(unusedPort()) },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])

      expect(code).toBe(1)
      expect(stderr).toContain('[dev] sidecar 启动失败')
      expect(stderr).not.toContain("Cannot access 'supervisor' before initialization")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
})
