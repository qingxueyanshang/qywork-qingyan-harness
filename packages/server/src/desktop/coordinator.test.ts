/**
 * 桌面占用：排队、排队中撤销、释放中仍占用，以及「正在操作」读数跟随占用。
 *
 * 覆盖范围：`desktop/coordinator.ts` 的占用、排队、撤销、释放与目标读数。同目录的
 * `bridge.test.ts` 覆盖宿主连接与代际配对，`assembly.test.ts` 覆盖端口注入。
 *
 * 用真 `serve()` 加真 WebSocket 假宿主：占用判定要和在途调用的收尾按固定顺序配合，
 * 拿假 bridge 测等于把这两者之间的顺序跳过去。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopWindowInfo } from '@qywork/agent'
import type { DesktopObservation, DesktopRequestFrame, DesktopResultFrame } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import { serve } from '../server.ts'
import type { DesktopCoordinator } from './coordinator.ts'
import { FakeDesktopHost, HOST_KEY, WINDOW } from './fixtures.ts'

/** 第二个窗口。两个执行者各操作一个，「正在操作」读数才区分得开。 */
const OTHER = { ...WINDOW, handle: 67, pid: 901, app: '计算器', title: '计算器' }

const TREE: Extract<DesktopObservation, { kind: 'tree' }> = {
  kind: 'tree',
  window: WINDOW.handle,
  capturedAt: 7,
  completeness: { complete: true, truncatedBy: [] },
  nodeCount: 1,
  root: {
    ref: 'w.0#1.2',
    role: 'edit',
    name: 'field',
    automationId: 'field',
    value: '',
    enabled: true,
    offscreen: false,
    actions: ['set_value'],
    children: [],
  },
}

function config(): QyConfig {
  return {
    active: { provider: 'fake', model: 'm' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: { m: {} },
      },
    },
    mode: 'auto',
    desktopEnabled: true,
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

function fresh(): ReturnType<typeof serve> {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-desktop-slot-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  upsertWorkspace(store, dir, 'W')
  const handle = serve({
    store,
    config: config(),
    content,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    hostKey: HOST_KEY,
  })
  cleanups.push(() => {
    handle.stop()
    content.close()
    store.close()
    // Windows 上 SQLite 的文件句柄释放有延迟，临时目录删不掉与被测行为无关。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return handle
}

/** 让已经排上的微任务与计时器跑完。用来断言「这段时间里一帧都没发出去」。 */
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

async function connected(handle: ReturnType<typeof serve>): Promise<{
  host: FakeDesktopHost
  desktop: DesktopCoordinator
}> {
  const host = await FakeDesktopHost.connect(handle.port, HOST_KEY, cleanups)
  host.ready()
  await tick()
  const desktop = handle.desktop
  if (!desktop) throw new Error('这个 serve 应当装配了电脑操作协调器')
  return { host, desktop }
}

/** 走一次窗口发现，让两个不透明 id 进本地表。 */
async function discover(
  host: FakeDesktopHost,
  list: () => Promise<DesktopWindowInfo[]>,
): Promise<DesktopWindowInfo[]> {
  const pending = list()
  const frame = await host.next()
  host.reply(frame, {
    observation: { kind: 'windows', capturedAt: 1, windows: [WINDOW, OTHER] },
  })
  return pending
}

function treeOf(frame: DesktopRequestFrame): Partial<DesktopResultFrame> {
  return { observation: { ...TREE, window: frame.target?.window ?? 0 } }
}

/** 读一次树并回一份观察。返回宿主收到的那一帧。 */
async function observed(
  host: FakeDesktopHost,
  pending: Promise<unknown>,
): Promise<DesktopRequestFrame> {
  const frame = await host.next()
  host.reply(frame, treeOf(frame))
  await pending
  return frame
}

test('同一时刻只有一个执行者在窗口上动作，后来的排队等它释放', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())

  const readA = await observed(host, a.observe({ windowId: 'dw_1' }))

  // B 要同一个桌面：它的读树请求在 A 释放之前不许发出去。
  const observeB = b.observe({ windowId: 'dw_2' })
  const before = host.received.length
  await tick()
  expect(host.received.length).toBe(before)

  const released = a.release()
  const cancel = await host.next()
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(readA.executorId)
  host.settle(cancel, 'not_dispatched')
  await released

  const readB = await host.next()
  expect(readB.op).toBe('read_tree')
  expect(readB.executorId).not.toBe(readA.executorId)
  expect(readB.target?.window).toBe(OTHER.handle)
  host.reply(readB, treeOf(readB))
  expect((await observeB).windowId).toBe('dw_2')
})

test('排队中撤销：轮到它之前就释放，它不再进场，后面的照常进', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  const c = desktop.portFor('cv_c')
  await discover(host, () => a.windows())
  await observed(host, a.observe({ windowId: 'dw_1' }))

  const observeB = b.observe({ windowId: 'dw_2' })
  const observeC = c.observe({ windowId: 'dw_2' })
  await tick()

  // B 还在排队时就被父级停止撤下来。
  const releasedB = b.release()
  await expect(observeB).rejects.toThrow('本次执行的电脑操作已经结束')
  host.settle(await host.next(), 'not_dispatched')
  await releasedB

  const releasedA = a.release()
  host.settle(await host.next(), 'not_dispatched')
  await releasedA

  // 桌面交给 C，不是那个已经撤销的 B。
  const readC = await host.next()
  expect(readC.op).toBe('read_tree')
  host.reply(readC, treeOf(readC))
  await observeC
})

test('释放中执行状态未知时不放行下一个执行者，宿主换代际才解除', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())
  await observed(host, a.observe({ windowId: 'dw_1' }))

  const observeB = b.observe({ windowId: 'dw_2' })
  await tick()

  const released = a.release()
  const cancel = await host.next()
  // 宿主答不出这个执行者名下的请求有没有执行完。
  host.settle(cancel, 'unknown')
  await released
  await expect(observeB).rejects.toThrow('还没有确认结清')

  // 挡住期间新来的也进不去，且一帧都不发。
  const c = desktop.portFor('cv_c')
  const before = host.received.length
  await expect(c.observe({ windowId: 'dw_1' })).rejects.toThrow('还没有确认结清')
  expect(host.received.length).toBe(before)

  // 换执行实例：旧实例名下的一切本来就已作废，桌面随之可用。
  host.ready({ hostEpoch: 9 })
  await tick()
  const d = desktop.portFor('cv_d')
  const [first] = await discover(host, () => d.windows())
  if (!first) throw new Error('窗口发现应当交回两个窗口')
  const readD = await observed(host, d.observe({ windowId: first.windowId }))
  expect(readD.op).toBe('read_tree')
  expect(readD.hostEpoch).toBe(9)
})

test('等撤销回执期间宿主换了代际，桌面不再挡住：旧执行实例名下的一切本来就已作废', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  await observed(host, a.observe({ windowId: 'dw_1' }))

  const released = a.release()
  const cancel = await host.next()
  expect(cancel.op).toBe('cancel')
  // 撤销还没回执，worker 先换了一代。
  host.ready({ hostEpoch: 9 })
  host.settle(cancel, 'unknown')
  await released

  // 换代之后这条「说不清结清没有」的理由说的是一个已经不存在的执行实例，不该再挡着桌面。
  const b = desktop.portFor('cv_b')
  const [first] = await discover(host, () => b.windows())
  if (!first) throw new Error('窗口发现应当交回两个窗口')
  const readB = await observed(host, b.observe({ windowId: first.windowId }))
  expect(readB.hostEpoch).toBe(9)
})

test('父任务停止只释放所属执行者：别人的在途调用与窗口发现都不受影响', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())

  // A 占着桌面且有一次读树在途；B 只做窗口发现，不需要占用。
  const observeA = a.observe({ windowId: 'dw_1' })
  const readA = await host.next()
  const listB = b.windows()
  const listFrame = await host.next()
  expect(listFrame.op).toBe('list_windows')
  expect(listFrame.executorId).not.toBe(readA.executorId)

  const released = a.release()
  // A 的在途读树按已派发收尾——这一帧已经写出去了。
  await expect(observeA).rejects.toThrow()
  const cancel = await host.next()
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(readA.executorId)
  host.settle(cancel, 'not_dispatched')
  await released

  // B 的那一次仍然拿得到结果：释放只收自己名下的，不动别人的，也不收 worker。
  host.reply(listFrame, {
    observation: { kind: 'windows', capturedAt: 2, windows: [WINDOW, OTHER] },
  })
  expect((await listB).map((w) => w.windowId)).toEqual(['dw_1', 'dw_2'])
  expect(host.received.filter((f) => f.op === 'cancel')).toHaveLength(1)
})

test('「正在操作」读数跟随占用，不被排队中的执行者覆盖', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const seen: (string | null)[] = []
  cleanups.push(desktop.onTargetChange((app) => seen.push(app)))
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())

  await observed(host, a.observe({ windowId: 'dw_1' }))
  expect(seen).toEqual([WINDOW.app])

  // B 在排队，写不动这个读数。
  const observeB = b.observe({ windowId: 'dw_2' })
  await tick()
  expect(seen).toEqual([WINDOW.app])

  const released = a.release()
  host.settle(await host.next(), 'not_dispatched')
  await released
  const readB = await host.next()
  host.reply(readB, treeOf(readB))
  await observeB
  expect(seen).toEqual([WINDOW.app, null, OTHER.app])
})
