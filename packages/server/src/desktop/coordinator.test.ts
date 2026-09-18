/**
 * 桌面占用与观察记账。
 *
 * 覆盖范围：`desktop/coordinator.ts` 的占用、排队、撤销、释放、目标读数、局部查询参数、
 * 动作后观察的并入与目标级失效，以及等待的四种终态。同目录的 `bridge.test.ts` 覆盖宿主
 * 连接与代际配对，`assembly.test.ts` 覆盖端口注入。
 *
 * 用真 `serve()` 加真 WebSocket 假宿主：占用判定要和在途调用的收尾按固定顺序配合，
 * 拿假 bridge 测等于把这两者之间的顺序跳过去。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopWindowInfo } from '@qywork/agent'
import type {
  DesktopNode,
  DesktopObservation,
  DesktopRequestFrame,
  DesktopResultFrame,
} from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import { serve } from '../server.ts'
import type { DesktopCoordinator } from './coordinator.ts'
import { FakeDesktopHost, HOST_KEY, WINDOW } from './fixtures.ts'

/** 第二个窗口。两个执行者各操作一个，「正在操作」读数才区分得开。 */
const OTHER = { ...WINDOW, handle: 67, pid: 901, app: '计算器', title: '计算器' }

/** 一棵两组五控件的小树。同名控件分在两个组下，合并与失效按组划界。 */
const 窗口根: DesktopNode = {
  ref: 'w#1',
  depth: 0,
  role: 'window',
  name: '夹具',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 甲组: DesktopNode = {
  ref: 'w.0#2',
  parentRef: 'w#1',
  depth: 1,
  role: 'group',
  name: '甲',
  automationId: 'a',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 甲输入框: DesktopNode = {
  ref: 'w.0.0#3',
  parentRef: 'w.0#2',
  depth: 2,
  role: 'edit',
  name: 'field',
  automationId: 'field',
  value: '',
  enabled: true,
  offscreen: false,
  actions: ['set_value'],
}
const 乙组: DesktopNode = {
  ref: 'w.1#4',
  parentRef: 'w#1',
  depth: 1,
  role: 'group',
  name: '乙',
  automationId: 'b',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 乙按钮: DesktopNode = {
  ref: 'w.1.0#5',
  parentRef: 'w.1#4',
  depth: 2,
  role: 'button',
  name: '保存',
  automationId: 'save',
  enabled: true,
  offscreen: false,
  actions: ['invoke'],
}

const NODES: DesktopNode[] = [窗口根, 甲组, 甲输入框, 乙组, 乙按钮]

const TREE: Extract<DesktopObservation, { kind: 'tree' }> = {
  kind: 'tree',
  window: WINDOW.handle,
  capturedAt: 7,
  windowEnabled: true,
  completeness: { complete: true, truncatedBy: [], filteredBy: [], visited: NODES.length },
  nodeCount: NODES.length,
  nodes: NODES.map((n) => ({ ...n, actions: [...n.actions] })),
}

/** 只覆盖「乙」那一组的子树读取。动作与等待之后回的就是这种形状。 */
function subtree(
  over: Partial<Extract<DesktopObservation, { kind: 'tree' }>> = {},
): Extract<DesktopObservation, { kind: 'tree' }> {
  return {
    ...TREE,
    capturedAt: 8,
    scope: 'w.1#4',
    completeness: { complete: true, truncatedBy: [], filteredBy: [], visited: 2 },
    nodeCount: 2,
    nodes: [乙组, { ...乙按钮, name: '保存（已改）' }],
    ...over,
  }
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

/** 走一次窗口发现加一次整窗观察，返回那份快照。 */
async function firstLook(
  host: FakeDesktopHost,
  port: {
    windows: () => Promise<DesktopWindowInfo[]>
    observe: (input: { windowId: string }) => Promise<{ observationId: string }>
  },
): Promise<{ observationId: string }> {
  await discover(host, () => port.windows())
  const pending = port.observe({ windowId: 'dw_1' })
  const frame = await host.next()
  host.reply(frame, treeOf(frame))
  return pending
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

test('局部查询的子树根、角色、文字与字段选择逐项落在帧上', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)

  const pending = a.observe({
    windowId: 'dw_1',
    root: 'w.1#4',
    role: 'button',
    query: '保存',
    includeValue: false,
  })
  const frame = await host.next()
  expect(frame.op).toBe('read_tree')
  expect(frame.root).toBe('w.1#4')
  expect(frame.role).toBe('button')
  expect(frame.nameContains).toBe('保存')
  expect(frame.includeValue).toBe(false)
  host.reply(frame, {
    observation: subtree({
      completeness: { complete: true, truncatedBy: [], filteredBy: ['role=button'], visited: 2 },
      nodeCount: 1,
      nodes: [乙按钮],
    }),
  })
  const snapshot = await pending
  // 被筛掉与被截断分两格，调用方分得出「没有」和「筛掉了」。
  expect(snapshot.filteredBy).toEqual(['role=button'])
  expect(snapshot.truncated).toBe(false)
  expect(snapshot.visited).toBe(2)
})

/** 子树根要来自本执行者见过的那一份观察，现编一个不发帧。 */
test('没见过的子树根在本地就拒绝，一帧都不发', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)
  const before = host.received.length
  await expect(a.observe({ windowId: 'dw_1', root: 'w.9#9' })).rejects.toThrow('没有控件')
  await tick()
  expect(host.received.length).toBe(before)
})

test('动作同次带回新观察：目标子树换掉，无关区域的旧引用仍在表里', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.invoke({ windowId: 'dw_1', observationId: first.observationId, ref: 'w.1.0#5' })
  const frame = await host.next()
  expect(frame.op).toBe('invoke')
  // 动作也带三个上限：宿主要用它们读目标所在的子树。
  expect(frame.maxNodes).toBeGreaterThan(0)
  expect(frame.maxDepth).toBeGreaterThan(0)
  expect(frame.timeBudgetMs).toBeGreaterThan(0)
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  const result = await acting

  expect(result.dispatch).toBe('submitted')
  if (!result.observation) throw new Error('动作回执应当带回新的观察')
  expect(result.observation.observationId).not.toBe(first.observationId)
  const refs = result.observation.elements.map((e) => e.ref)
  // 目标子树重读了：那一段是新读到的。
  expect(result.observation.elements.find((e) => e.ref === 'w.1.0#5')?.name).toBe('保存（已改）')
  // 无关区域没被动过：旧引用还在这份表里，顺序也没乱。
  expect(refs).toEqual(['w#1', 'w.0#2', 'w.0.0#3', 'w.1#4', 'w.1.0#5'])
  // 旧编号作废，新编号可用。
  expect(a.elements('dw_1', first.observationId)).toBeNull()
  expect(a.elements('dw_1', result.observation.observationId)).toHaveLength(5)
})

test('动作之后窗口被模态窗口挡住：整份观察作废，只剩重读到的那一段', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.invoke({ windowId: 'dw_1', observationId: first.observationId, ref: 'w.1.0#5' })
  const frame = await host.next()
  host.reply(frame, {
    dispatch: 'submitted',
    observation: subtree({ windowEnabled: false }),
  })
  const result = await acting
  if (!result.observation) throw new Error('动作回执应当带回新的观察')
  expect(result.observation.windowEnabled).toBe(false)
  expect(result.observation.elements.map((e) => e.ref)).toEqual(['w.1#4', 'w.1.0#5'])
})

test('动作之后没有重读：这个窗口的控件表整份作废', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.invoke({ windowId: 'dw_1', observationId: first.observationId, ref: 'w.1.0#5' })
  const frame = await host.next()
  host.reply(frame, { dispatch: 'unknown', observationError: '窗口已关闭' })
  const result = await acting
  expect(result.dispatch).toBe('unknown')
  expect(result.observation).toBeNull()
  expect(a.elements('dw_1', first.observationId)).toBeNull()
})

test('等待的条件与两个时限落在帧上，等到之后带回新观察', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'value',
    ref: 'w.0.0#3',
    value: '张三',
    timeoutMs: 5_000,
  })
  const frame = await host.next()
  expect(frame.op).toBe('wait')
  expect(frame.until).toBe('value')
  expect(frame.ref).toBe('w.0.0#3')
  expect(frame.value).toBe('张三')
  expect(frame.timeoutMs).toBe(5_000)
  expect(frame.pollMs).toBeGreaterThan(0)
  // 帧上的绝对期限要比等待时长宽：宿主到点之后还要重读一次才回执。
  expect(frame.deadline - Date.now()).toBeGreaterThan(5_000)
  host.reply(frame, { observation: { ...subtree(), kind: 'wait', found: true } })
  const result = await waiting
  expect(result.found).toBe(true)
  if (!result.observation) throw new Error('等待回执应当带回当时的控件表')
  expect(result.observation.observationId).not.toBe(first.observationId)
})

test('等待到期：如实回未满足与当时的状态，不算执行失败', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'enabled',
    ref: 'w.0.0#3',
    timeoutMs: 1_000,
  })
  const frame = await host.next()
  host.reply(frame, {
    observation: { ...subtree(), kind: 'wait', found: false, reason: 'timeout' },
  })
  const result = await waiting
  expect(result).toMatchObject({ found: false, reason: 'timeout' })
  expect(result.observation).not.toBeNull()
})

/**
 * 等待期间释放：撤销帧要在等待还没回执时就发出去，等待以 cancelled 收尾，
 * 桌面随即交给下一个执行者。等待若占着桌面不放，后面那个永远进不来。
 */
test('等待期间释放：撤销帧发出，等待按撤销收尾，桌面交给下一个', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'enabled',
    ref: 'w.0.0#3',
    timeoutMs: 60_000,
  })
  const waitFrame = await host.next()
  expect(waitFrame.op).toBe('wait')

  // B 排在后面，等待还没回执之前一帧都不发。
  const observeB = b.observe({ windowId: 'dw_2' })
  const before = host.received.length
  await tick()
  expect(host.received.length).toBe(before)

  const released = a.release()
  const cancel = await host.next()
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(waitFrame.executorId)
  // 宿主撤销了那条等待，并回答这个执行者名下已经没有在执行的请求。
  host.settle(waitFrame, 'not_dispatched')
  host.settle(cancel, 'not_dispatched')
  await released

  const result = await waiting
  expect(result).toMatchObject({ found: false, reason: 'cancelled' })

  const readB = await host.next()
  expect(readB.op).toBe('read_tree')
  host.reply(readB, treeOf(readB))
  await observeB
})

test('等待期间宿主换代：等待有终态，旧观察随执行实例作废', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'enabled',
    ref: 'w.0.0#3',
    timeoutMs: 60_000,
  })
  await host.next()
  // worker 换了一代：旧执行实例名下的待决调用按已派发收尾。
  host.ready({ hostEpoch: 9 })
  const result = await waiting
  expect(result.found).toBe(false)
  expect(result.observation).toBeNull()
  expect(a.elements('dw_1', first.observationId)).toBeNull()
})
