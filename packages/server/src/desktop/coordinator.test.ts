/**
 * 桌面占用与观察记账。
 *
 * 覆盖范围：`desktop/coordinator.ts` 的占用、排队、撤销、释放、目标读数、局部查询参数、
 * 动作后观察的并入与目标级失效、等待的四种终态，以及图像采集的取景参数、imageRef 的
 * 换算与四条失效判据、控件包围盒与选择容器选中项名单的透传。同目录的 `bridge.test.ts`
 * 覆盖宿主连接与代际配对，`assembly.test.ts` 覆盖端口注入。
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
  actions: [{ action: 'set_value', delivery: ['background'] }],
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
  actions: [{ action: 'invoke', delivery: ['background'] }],
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
  if (!desktop) throw new Error('这个 serve 应当装配了电脑控制协调器')
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
  await expect(observeB).rejects.toThrow('本次执行的电脑控制已经结束')
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

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  expect(frame.op).toBe('act')
  expect(frame.action).toEqual({ kind: 'invoke' })
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

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'invoke' },
  })
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

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  host.reply(frame, { dispatch: 'unknown', observationError: '窗口已关闭' })
  const result = await acting
  expect(result.dispatch).toBe('unknown')
  expect(result.observation).toBeNull()
  expect(a.elements('dw_1', first.observationId)).toBeNull()
})

/**
 * 调用没返回时宿主不重读目标窗口，改带一份窗口清单。那份清单要走 `desktop_windows`
 * 同一条登记路径：同一个窗口在两条路径上拿到的是同一个 id，新窗口拿到就能直接观察。
 */
test('动作调用未返回：窗口清单按同一条路径登记，新窗口当场可观察', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  const dialog = { handle: 77, pid: WINDOW.pid, processStartedAt: WINDOW.processStartedAt }
  const dialogTarget = {
    window: dialog.handle,
    pid: dialog.pid,
    processStartedAt: dialog.processStartedAt,
  }
  host.reply(frame, {
    dispatch: 'submitted',
    reason: '调用尚未返回，目标窗口已被禁用',
    observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
    blocking: [
      { ...WINDOW, appeared: false },
      { ...dialog, app: WINDOW.app, title: '另存为', appeared: true },
    ],
  })
  const result = await acting

  expect(result.dispatch).toBe('submitted')
  expect(result.observation).toBeNull()
  // 目标窗口沿用原来那个 id，不因为走了另一条路径就换号。
  expect(result.blocking?.[0]).toEqual({
    windowId: 'dw_1',
    app: WINDOW.app,
    title: WINDOW.title,
    appeared: false,
  })
  const appeared = result.blocking?.[1]
  expect(appeared?.appeared).toBe(true)
  expect(appeared?.windowId).not.toBe('dw_1')

  // 新窗口当场可观察：不必先再列一次窗口。
  if (!appeared) throw new Error('回执里没有新窗口')
  const observing = a.observe({ windowId: appeared.windowId })
  const next = await host.next()
  expect(next.op).toBe('read_tree')
  expect(next.target).toEqual(dialogTarget)
  host.reply(next, { observation: { ...TREE, window: dialog.handle } })
  expect((await observing).elements.length).toBeGreaterThan(0)
})

/** 动作回执里那份清单只覆盖目标进程，拿它剪会把别的进程的窗口一并作废。 */
test('动作回执的窗口清单不剪掉别的窗口', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const other = {
    handle: 88,
    pid: 901,
    processStartedAt: 1_700_000_000_001,
    app: '别的',
    title: '别的窗口',
  }
  const listing = a.windows()
  const listFrame = await host.next()
  host.reply(listFrame, {
    observation: { kind: 'windows', capturedAt: 1, windows: [WINDOW, other] },
  })
  const listed = await listing
  expect(listed).toHaveLength(2)
  const otherId = listed[1]?.windowId
  if (!otherId) throw new Error('第二个窗口没有拿到 id')

  // 不能再走一次窗口发现：那一次会按整机清单剪掉这里刚登记的第二个窗口。
  const looking = a.observe({ windowId: 'dw_1' })
  const look = await host.next()
  host.reply(look, treeOf(look))
  const first = await looking

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  host.reply(frame, {
    dispatch: 'submitted',
    observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
    blocking: [{ ...WINDOW, appeared: false }],
  })
  await acting

  // 另一个进程的窗口没被这份清单剪掉：它此刻仍然指得动。
  const observing = a.observe({ windowId: otherId })
  const next = await host.next()
  expect(next.target?.window).toBe(other.handle)
  host.reply(next, { observation: { ...TREE, window: other.handle } })
  await observing
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

/** 一张整窗图的观察。几何的形状与本机实测一致：窗口矩形与可见边框差 7 像素。 */
const IMAGE: Extract<DesktopObservation, { kind: 'image' }> = {
  kind: 'image',
  window: WINDOW.handle,
  capturedAt: 11,
  source: 'wgc',
  geometry: {
    imageWidth: 506,
    imageHeight: 453,
    screen: { x: 87, y: 80, width: 506, height: 453 },
    dpi: 96,
    generation: '80,80,520,460@96#65537',
  },
  mime: 'image/png',
  bytes: 'iVBORw0KGgo=',
}

/** 采一张整窗图，返回它的 imageRef 与宿主收到的那一帧。 */
async function captured(
  host: FakeDesktopHost,
  pending: Promise<{ imageRef: string }>,
): Promise<{ imageRef: string; frame: DesktopRequestFrame }> {
  const frame = await host.next()
  host.reply(frame, { observation: { ...IMAGE, window: frame.target?.window ?? 0 } })
  const image = await pending
  return { imageRef: image.imageRef, frame }
}

test('整窗采集只带上限，不带区域与代际', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const { frame } = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))
  expect(frame.op).toBe('capture_image')
  expect(frame.maxEdge).toBe(1568)
  expect(frame.maxBytes).toBe(4 * 1024 * 1024)
  expect(frame.region).toBeUndefined()
  expect(frame.expectGeneration).toBeUndefined()
  // 目标身份三项照常带：采集也要在派发前核对窗口还是不是同一个。
  expect(frame.target).toEqual({
    window: WINDOW.handle,
    pid: WINDOW.pid,
    processStartedAt: WINDOW.processStartedAt,
  })
})

test('给了屏幕矩形就原样下去，不带代际', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const { frame } = await captured(
    host,
    a.captureImage({
      windowId: 'dw_1',
      maxEdge: 1568,
      region: { x: 280, y: 180, width: 160, height: 64 },
    }),
  )
  expect(frame.region).toEqual({ x: 280, y: 180, width: 160, height: 64 })
  expect(frame.expectGeneration).toBeUndefined()
})

/**
 * imageRef 的换算与核对路径：图像矩形在这里算成屏幕矩形，窗口几何代际一起下去，
 * 由宿主在派发前重新核对窗口矩形。
 */
test('按上一张图的区域重采：换算成屏幕矩形并带上几何代际', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const first = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))
  const { frame } = await captured(
    host,
    a.captureImage({
      windowId: 'dw_1',
      maxEdge: 1568,
      imageRef: first.imageRef,
      imageRect: { x: 10, y: 20, width: 100, height: 50 },
    }),
  )
  // 这张图是 1:1 的，换算就是一次平移：87+10、80+20。
  expect(frame.region).toEqual({ x: 97, y: 100, width: 100, height: 50 })
  expect(frame.expectGeneration).toBe('80,80,520,460@96#65537')
})

test('缩过的图按比例换算，不按 DPI', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const pending = a.captureImage({ windowId: 'dw_1', maxEdge: 1568 })
  const frame = await host.next()
  host.reply(frame, {
    observation: {
      ...IMAGE,
      window: frame.target?.window ?? 0,
      geometry: {
        imageWidth: 1568,
        imageHeight: 882,
        screen: { x: 10, y: 20, width: 3840, height: 2160 },
        dpi: 192,
        generation: '10,20,3840,2160@192#65537',
      },
    },
  })
  const image = await pending

  const { frame: second } = await captured(
    host,
    a.captureImage({
      windowId: 'dw_1',
      maxEdge: 1568,
      imageRef: image.imageRef,
      imageRect: { x: 100, y: 100, width: 200, height: 100 },
    }),
  )
  expect(second.region).toEqual({ x: 255, y: 265, width: 490, height: 245 })
})

test('认不出的 imageRef 在本地就被拒，一帧都不发', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  const before = host.received.length
  const failed = await a
    .captureImage({
      windowId: 'dw_1',
      maxEdge: 1568,
      imageRef: 'di_404',
      imageRect: { x: 0, y: 0, width: 10, height: 10 },
    })
    .catch((err: unknown) => err as Error & { executed?: boolean })
  expect(String(failed)).toContain('认不出的图')
  expect((failed as { executed?: boolean }).executed).toBe(false)
  await tick()
  expect(host.received.length).toBe(before)
})

/** 换代之后采集那一刻的几何已经不成立，拿它换算出来的矩形指的是另一块界面。 */
test('宿主换代之后旧 imageRef 失效', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  const first = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  host.ready({ hostEpoch: 9 })
  await tick()
  // 换代之后窗口表也作废，重新发现一次才有可用的不透明 id。
  const again = (await discover(host, () => a.windows()))[0]?.windowId ?? ''

  const before = host.received.length
  const failed = await a
    .captureImage({
      windowId: again,
      maxEdge: 1568,
      imageRef: first.imageRef,
      imageRect: { x: 0, y: 0, width: 10, height: 10 },
    })
    .catch((err: unknown) => String(err))
  expect(String(failed)).toContain('换过代际')
  await tick()
  expect(host.received.length).toBe(before)
})

/** 窗口关掉重开之后句柄会被复用，旧图指的是上一个窗口。 */
test('窗口身份变了之后旧 imageRef 失效', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  const first = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  // 同一个句柄，进程启动时刻换了：这是另一个窗口，不透明 id 因此也换了一个。
  const reborn = { ...WINDOW, processStartedAt: WINDOW.processStartedAt + 1 }
  const listing = a.windows()
  const frame = await host.next()
  host.reply(frame, { observation: { kind: 'windows', capturedAt: 2, windows: [reborn] } })
  const windows = await listing
  const again = windows[0]?.windowId ?? ''
  expect(again).not.toBe('dw_1')

  const failed = await a
    .captureImage({
      windowId: again,
      maxEdge: 1568,
      imageRef: first.imageRef,
      imageRect: { x: 0, y: 0, width: 10, height: 10 },
    })
    .catch((err: unknown) => String(err))
  expect(String(failed)).toContain('采的不是这个窗口')
})

test('矩形落在图外时在本地就被拒', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  const first = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  const failed = await a
    .captureImage({
      windowId: 'dw_1',
      maxEdge: 1568,
      imageRef: first.imageRef,
      imageRect: { x: 600, y: 0, width: 50, height: 50 },
    })
    .catch((err: unknown) => String(err))
  expect(String(failed)).toContain('不在')
})

/** 释放之后这个端口报废，它交出去的图一并作废。 */
test('释放之后旧 imageRef 不再能用', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  const first = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  const releasing = a.release()
  const cancel = await host.next()
  host.settle(cancel, 'not_dispatched')
  await releasing

  const failed = await a
    .captureImage({
      windowId: 'dw_1',
      maxEdge: 1568,
      imageRef: first.imageRef,
      imageRect: { x: 0, y: 0, width: 10, height: 10 },
    })
    .catch((err: unknown) => String(err))
  expect(String(failed)).toContain('已经结束')
})

/** 采集要先占桌面：两个执行者同时采图会互相看见对方改出来的窗口状态。 */
test('采集与观察走同一把占用', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())
  await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  const queued = b.captureImage({ windowId: 'dw_1', maxEdge: 1568 })
  const before = host.received.length
  await tick()
  expect(host.received.length).toBe(before)

  const releasing = a.release()
  const cancel = await host.next()
  host.settle(cancel, 'not_dispatched')
  await releasing
  await captured(host, queued)
})

/** 控件包围盒与图用同一套坐标，树那一侧不能把它丢掉。 */
test('控件包围盒随观察交到端口外面', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const pending = a.observe({ windowId: 'dw_1' })
  const frame = await host.next()
  host.reply(frame, {
    observation: {
      ...TREE,
      window: frame.target?.window ?? 0,
      nodes: NODES.map((n) =>
        n.ref === 'w.0.0#3'
          ? { ...n, actions: [...n.actions], rect: { x: 300, y: 200, width: 120, height: 24 } }
          : { ...n, actions: [...n.actions] },
      ),
    },
  })
  const snapshot = await pending
  expect(snapshot.elements.find((e) => e.ref === 'w.0.0#3')?.rect).toEqual({
    x: 300,
    y: 200,
    width: 120,
    height: 24,
  })
  expect(snapshot.elements.find((e) => e.ref === 'w#1')?.rect).toBeUndefined()
})

/** 选中项名单与它的截断标记随观察交到端口外面；worker 没给时端口不造一份。 */
test('选择容器的选中项名单随观察交到端口外面', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const pending = a.observe({ windowId: 'dw_1' })
  const frame = await host.next()
  host.reply(frame, {
    observation: {
      ...TREE,
      window: frame.target?.window ?? 0,
      nodes: NODES.map((n) =>
        n.ref === 'w.0#2'
          ? {
              ...n,
              actions: [...n.actions],
              selection: {
                multiple: true,
                required: false,
                selected: ['甲', '乙'],
                truncated: true,
              },
            }
          : { ...n, actions: [...n.actions] },
      ),
    },
  })
  const snapshot = await pending
  expect(snapshot.elements.find((e) => e.ref === 'w.0#2')?.selection).toEqual({
    multiple: true,
    required: false,
    selected: ['甲', '乙'],
    truncated: true,
  })
  expect(snapshot.elements.find((e) => e.ref === 'w#1')?.selection).toBeUndefined()
})

/**
 * 按图定位的动作：图像坐标在这里换算成屏幕坐标，窗口几何代际一起下去，
 * 由宿主在派发前重新核对窗口矩形。控件与图像点只能给一个。
 */
test('按图定位的指针动作换算成屏幕坐标并带上几何代际', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)
  const image = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  const acting = a.act({
    windowId: 'dw_1',
    observationId: 'do_ignored',
    at: { imageRef: image.imageRef, x: 10, y: 20 },
    action: { kind: 'click', button: 'left', count: 1 },
  })
  const frame = await host.next()
  expect(frame.op).toBe('act')
  // 这张图是 1:1 的，换算就是一次平移：87+10、80+20。
  expect(frame.point).toEqual({ x: 97, y: 100 })
  expect(frame.expectGeneration).toBe('80,80,520,460@96#65537')
  expect(frame.ref).toBeUndefined()
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  expect((await acting).dispatch).toBe('submitted')
})

test('控件与图像点只能给一个，两种都给或都不给都在本地拒绝', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)
  const image = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))
  const before = host.received.length

  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: first.observationId,
      ref: 'w.1.0#5',
      at: { imageRef: image.imageRef, x: 1, y: 1 },
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('只能给一个')
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: first.observationId,
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('要给控件或图像点')
  // 键盘与窗口动作没有落点可言。
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: first.observationId,
      at: { imageRef: image.imageRef, x: 1, y: 1 },
      action: { kind: 'activate' },
    }),
  ).rejects.toThrow('只能按控件执行')
  await tick()
  expect(host.received.length).toBe(before)
})

/**
 * 键盘输入两样都不给时目标是窗口本身，帧里 `ref` 与 `point` 都缺席。
 *
 * 自绘界面不暴露业务控件，要求点名一个控件等于对它们关掉整条键盘路径。准入判定在
 * worker 那一侧（前台窗口就是目标窗口），这里只负责不拦、不伪造一个 ref。
 */
test('不点名控件的键盘输入按窗口派发，帧里没有 ref 也没有 point', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    action: { kind: 'type_text', text: '你好 hello' },
  })
  const frame = await host.next()
  expect(frame.op).toBe('act')
  expect(frame.ref).toBeUndefined()
  expect(frame.point).toBeUndefined()
  expect(frame.action).toEqual({ kind: 'type_text', text: '你好 hello' })
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  expect((await acting).dispatch).toBe('submitted')
})

/**
 * 文字投递方式与剪贴板去向要原样到调用方。
 *
 * 少了这一段，走粘贴的那一次在回执里与逐键注入完全一样，模型说不出剪贴板被动过。
 */
test('宿主回的投递方式与剪贴板恢复状态原样透传', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    action: { kind: 'type_text', text: '哦哦行，' },
  })
  const frame = await host.next()
  host.reply(frame, {
    dispatch: 'submitted',
    delivery: 'paste',
    clipboardRestored: false,
    observation: subtree(),
  })
  const result = await acting
  expect(result.delivery).toBe('paste')
  expect(result.clipboardRestored).toBe(false)
})

test('图外的坐标在本地就被拒，一帧都不发', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)
  const image = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))
  const before = host.received.length
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: 'do_ignored',
      at: { imageRef: image.imageRef, x: 5000, y: 1 },
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('覆盖的范围')
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: 'do_ignored',
      at: { imageRef: image.imageRef, x: -1, y: 1 },
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('覆盖的范围')
  await tick()
  expect(host.received.length).toBe(before)
})

test('认不出的图在本地就被拒，一帧都不发', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)
  const before = host.received.length
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: 'do_ignored',
      at: { imageRef: 'di_404', x: 1, y: 1 },
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('认不出的图')
  await tick()
  expect(host.received.length).toBe(before)
})

/** 拖拽终点写在动作里：像素偏移原样下去，控件终点要来自本执行者见过的观察。 */
test('拖拽的像素偏移原样下去，控件终点要在观察里', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'drag', to: { kind: 'offset', dx: 80, dy: 0 } },
  })
  const frame = await host.next()
  expect(frame.action).toEqual({ kind: 'drag', to: { kind: 'offset', dx: 80, dy: 0 } })
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  const next = await acting
  const now = next.observation?.observationId ?? first.observationId

  const before = host.received.length
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: now,
      ref: 'w.1.0#5',
      action: { kind: 'drag', to: { kind: 'ref', ref: 'w.9#9' } },
    }),
  ).rejects.toThrow('没有控件')
  await tick()
  expect(host.received.length).toBe(before)
})

/**
 * 前台接管的读数按回执上调。
 *
 * 宿主拒绝派发时桌面没有被碰，那时说「正在前台操作」是一句假话；派发出去之后不再退回，
 * 一次前台点击已经把焦点留在目标应用上了。
 */
test('前台接管的读数只在宿主真的派发之后才上调', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const seen: [string | null, boolean][] = []
  cleanups.push(desktop.onTargetChange((app, foreground) => seen.push([app, foreground])))
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)
  expect(seen.at(-1)).toEqual(['记事本', false])

  // 宿主拒绝派发：读数不动。
  const refused = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'click', button: 'left', count: 1 },
  })
  let frame = await host.next()
  host.reply(frame, { dispatch: 'not_dispatched', reason: 'foreground_disabled: 前台操作没有启用' })
  expect((await refused).dispatch).toBe('not_dispatched')
  expect(desktop.targetForeground()).toBe(false)

  // 拒绝派发时没有重读，这个窗口的控件表整份作废：重新观察一次再往下走。
  const again = await firstLook(host, a)

  // 派发出去了：读数上调，之后的后台读取不把它退回去。
  const acting = a.act({
    windowId: 'dw_1',
    observationId: again.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'click', button: 'left', count: 1 },
  })
  frame = await host.next()
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  const done = await acting
  expect(desktop.targetForeground()).toBe(true)
  expect(seen.at(-1)).toEqual(['记事本', true])

  const reading = a.act({
    windowId: 'dw_1',
    observationId: done.observation?.observationId ?? again.observationId,
    ref: 'w.1.0#5',
    action: { kind: 'invoke' },
  })
  frame = await host.next()
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  await reading
  expect(desktop.targetForeground()).toBe(true)

  // 释放时随应用名一起清回去。
  const releasing = a.release()
  host.reply(await host.next())
  await releasing
  expect(desktop.targetForeground()).toBe(false)
  expect(seen.at(-1)).toEqual([null, false])
})
