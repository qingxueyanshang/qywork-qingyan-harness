/**
 * 桌面占用与观察记账。
 *
 * 覆盖范围：`desktop/coordinator.ts` 的占用、排队、撤销、释放、目标读数、局部读取参数、
 * 控件短编号的发放规则（按身份跨观察稳定、不复用、弱身份、上限淘汰、按窗口隔离）、
 * 与宿主之间双向的 ref 转换、
 * 动作与等待之后按读取范围整份替换观察、窗口标题随整窗读取刷新、等待的四种终态，以及图像采集的取景参数、imageRef 的
 * 换算与四条失效判据、控件包围盒与选择容器选中项名单的透传。同目录的 `bridge.test.ts`
 * 覆盖宿主连接与代际配对，`assembly.test.ts` 覆盖端口注入。
 *
 * 使用真实的 `serve()` 与基于真实 WebSocket 的模拟宿主：占用判定与在途调用的收尾必须按固定顺序配合，
 * 使用模拟 bridge 测试会跳过两者之间的顺序。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopSnapshot, DesktopWindowInfo } from '@qywork/agent'
import type {
  DesktopNode,
  DesktopObservation,
  DesktopRequestFrame,
  DesktopResultFrame,
  DesktopTargetEvent,
} from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import { serve } from '../server.ts'
import { type DesktopCoordinator, MAX_WINDOW_REFS } from './coordinator.ts'
import { FakeDesktopHost, HOST_KEY, WINDOW } from './fixtures.ts'

/** 第二个窗口。两个执行者各操作一个窗口时，「正在操作」读数能够区分二者。 */
const OTHER = { ...WINDOW, handle: 67, pid: 901, app: '计算器', title: '计算器' }

/** 包含两个分组、五个控件的控件树。同名控件分属两个分组。 */
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
  windowCovered: false,
  completeness: { complete: true, truncatedBy: [], filteredBy: [], visited: NODES.length },
  nodeCount: NODES.length,
  nodes: NODES.map((n) => ({ ...n, actions: [...n.actions] })),
}

/** 仅覆盖「乙」分组的子树读取结果。动作与等待之后宿主返回的观察采用这种结构。 */
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
    // Windows 上 SQLite 的文件句柄释放有延迟，临时目录删除失败与被测行为无关。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return handle
}

/** 让已排队的微任务与计时器执行完毕，用于断言这段时间内未发送任何帧。 */
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

/** 执行一次窗口发现，使两个不透明 id 写入本地窗口表。 */
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

/** 执行一次窗口发现与一次整窗观察，返回该观察的快照。 */
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

/** 读取一次控件树并以观察应答，返回宿主收到的请求帧。 */
async function observed(
  host: FakeDesktopHost,
  pending: Promise<unknown>,
): Promise<DesktopRequestFrame> {
  const frame = await host.next()
  host.reply(frame, treeOf(frame))
  await pending
  return frame
}

test('同一时刻只有一个执行者在窗口上执行动作，后到者排队等待其释放', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())

  const readA = await observed(host, a.observe({ windowId: 'dw_1' }))

  // B 请求同一个桌面：A 释放之前不得发出 B 的读取控件树请求。
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

test('排队中撤销：执行者在轮到之前释放后不再获得桌面，后续执行者照常获得', async () => {
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

  // B 仍在排队时被父任务停止撤销。
  const releasedB = b.release()
  await expect(observeB).rejects.toThrow('本次执行的电脑控制已经结束')
  host.settle(await host.next(), 'not_dispatched')
  await releasedB

  const releasedA = a.release()
  host.settle(await host.next(), 'not_dispatched')
  await releasedA

  // 桌面交给 C，而不是已撤销的 B。
  const readC = await host.next()
  expect(readC.op).toBe('read_tree')
  host.reply(readC, treeOf(readC))
  await observeC
})

test('释放时执行状态未知则不放行下一个执行者，宿主代际变化后解除', async () => {
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
  // 宿主无法确定该执行者名下的请求是否执行完毕。
  host.settle(cancel, 'unknown')
  await released
  await expect(observeB).rejects.toThrow('尚未确认结束')

  // 阻塞期间新到达的执行者同样被拒绝，且不发送任何帧。
  const c = desktop.portFor('cv_c')
  const before = host.received.length
  await expect(c.observe({ windowId: 'dw_1' })).rejects.toThrow('尚未确认结束')
  expect(host.received.length).toBe(before)

  // 执行实例更换后，旧实例名下的请求均已作废，桌面随之可用。
  host.ready({ hostEpoch: 9 })
  await tick()
  const d = desktop.portFor('cv_d')
  const [first] = await discover(host, () => d.windows())
  if (!first) throw new Error('窗口发现应当交回两个窗口')
  const readD = await observed(host, d.observe({ windowId: first.windowId }))
  expect(readD.op).toBe('read_tree')
  expect(readD.hostEpoch).toBe(9)
})

test('等待撤销回执期间宿主代际变化，桌面不再被阻塞：旧执行实例名下的请求均已作废', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  await observed(host, a.observe({ windowId: 'dw_1' }))

  const released = a.release()
  const cancel = await host.next()
  expect(cancel.op).toBe('cancel')
  // 撤销回执到达之前，worker 先发生代际变化。
  host.ready({ hostEpoch: 9 })
  host.settle(cancel, 'unknown')
  await released

  // 代际变化后，「无法确认是否结束」这一原因所指的执行实例已不存在，不应再阻塞桌面。
  const b = desktop.portFor('cv_b')
  const [first] = await discover(host, () => b.windows())
  if (!first) throw new Error('窗口发现应当交回两个窗口')
  const readB = await observed(host, b.observe({ windowId: first.windowId }))
  expect(readB.hostEpoch).toBe(9)
})

test('父任务停止只释放所属执行者：其他执行者的在途调用与窗口发现不受影响', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())

  // A 占用桌面且有一次读取控件树的调用在途；B 只执行窗口发现，无需占用。
  const observeA = a.observe({ windowId: 'dw_1' })
  const readA = await host.next()
  const listB = b.windows()
  const listFrame = await host.next()
  expect(listFrame.op).toBe('list_windows')
  expect(listFrame.executorId).not.toBe(readA.executorId)

  const released = a.release()
  // A 的在途读取请求按已派发收尾：该帧已经发出。
  await expect(observeA).rejects.toThrow()
  const cancel = await host.next()
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(readA.executorId)
  host.settle(cancel, 'not_dispatched')
  await released

  // B 的窗口发现仍可取得结果：释放只回收自身名下的请求，不影响其他执行者，也不回收 worker。
  host.reply(listFrame, {
    observation: { kind: 'windows', capturedAt: 2, windows: [WINDOW, OTHER] },
  })
  expect((await listB).map((w) => w.windowId)).toEqual(['dw_1', 'dw_2'])
  expect(host.received.filter((f) => f.op === 'cancel')).toHaveLength(1)
})

test('「正在操作」读数跟随占用，不被排队中的执行者覆盖', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const seen: DesktopTargetEvent['target'][] = []
  cleanups.push(desktop.onTargetChange((target) => seen.push(target)))
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  await discover(host, () => a.windows())

  await observed(host, a.observe({ windowId: 'dw_1' }))
  const targetA = { conversationId: 'cv_a', app: WINDOW.app, foreground: false }
  expect(seen).toEqual([targetA])

  // B 仍在排队，无法改写该读数。
  const observeB = b.observe({ windowId: 'dw_2' })
  await tick()
  expect(seen).toEqual([targetA])

  const released = a.release()
  host.settle(await host.next(), 'not_dispatched')
  await released
  const readB = await host.next()
  host.reply(readB, treeOf(readB))
  await observeB
  const targetB = { conversationId: 'cv_b', app: OTHER.app, foreground: false }
  expect(seen).toEqual([targetA, null, targetB])
  expect(desktop.target()).toEqual(targetB)
  host.socket.close()
  await tick()
  expect(desktop.target()).toBeNull()
  expect(seen.at(-1)).toBeNull()
})

test('局部读取的子树根与字段选择写入请求帧，快照返回读取范围', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)

  const pending = a.observe({ windowId: 'dw_1', root: 'e4', includeValue: false })
  const frame = await host.next()
  expect(frame.op).toBe('read_tree')
  expect(frame.root).toBe('w.1#4')
  expect(frame.includeValue).toBe(false)
  // 角色与文字筛选只作用于交给模型的视图，不发给宿主：若发给宿主，筛选出的少数控件会成为当前观察。
  expect(frame.role).toBeUndefined()
  expect(frame.nameContains).toBeUndefined()
  host.reply(frame, {
    observation: subtree({
      completeness: {
        complete: true,
        truncatedBy: [],
        filteredBy: ['root=w.1#4', 'includeValue=false'],
        visited: 2,
      },
    }),
  })
  const snapshot = await pending
  // 宿主响应中的范围与 `root=` 一项均转换为短编号，端口外部不出现宿主的 ref。
  expect(snapshot.scope).toBe('e4')
  expect(snapshot.filteredBy).toEqual(['root=e4', 'includeValue=false'])
  expect(snapshot.elements.map((e) => e.ref)).toEqual(['e4', 'e5'])
  expect(snapshot.elements[1]?.parentRef).toBe('e4')
  // 子树读取的根不是窗口元素。
  expect(snapshot.elements[0]?.windowRoot).toBeUndefined()
  expect(snapshot.truncated).toBe(false)
  expect(snapshot.visited).toBe(2)
})

/** 子树根必须来自本执行者已取得的观察；自行构造的子树根不发送帧。 */
test('本执行者未观察到的子树根在本地被拒绝，不发送任何帧', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)
  const before = host.received.length
  await expect(a.observe({ windowId: 'dw_1', root: 'e9' })).rejects.toThrow('没有控件')
  await tick()
  expect(host.received.length).toBe(before)
})

/** 读取一次整窗，以给定节点应答，返回快照。 */
async function lookWith(
  host: FakeDesktopHost,
  port: { observe: (input: { windowId: string }) => Promise<DesktopSnapshot> },
  nodes: DesktopNode[],
  windowId = 'dw_1',
): Promise<DesktopSnapshot> {
  const pending = port.observe({ windowId })
  const frame = await host.next()
  host.reply(frame, {
    observation: { ...TREE, window: frame.target?.window ?? 0, nodeCount: nodes.length, nodes },
  })
  return pending
}

/**
 * 原始失败形状：端口直接返回宿主的 ref（下标路径加身份段），前方插入一个兄弟控件后，
 * 同一控件的 ref 随之改变，相邻两份观察逐字不同。编号必须按身份绑定控件，
 * 发给宿主的则是当前观察中的新路径。
 */
test('同一控件在两份观察中编号相同，路径改变时编号不变，动作发送新路径的完整 ref', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  // 在甲组之前插入一个新分组：甲组及其后控件的下标路径均改变，RuntimeId 不变。
  const shifted: DesktopNode[] = [
    窗口根,
    { ...甲组, ref: 'w.0#6', name: '新', automationId: 'n' },
    { ...甲组, ref: 'w.1#2' },
    { ...甲输入框, ref: 'w.1.0#3', parentRef: 'w.1#2' },
    { ...乙组, ref: 'w.2#4' },
    { ...乙按钮, ref: 'w.2.0#5', parentRef: 'w.2#4' },
  ]
  const second = await lookWith(host, a, shifted)
  expect(second.observationId).not.toBe(first.observationId)
  expect(second.elements.map((e) => e.ref)).toEqual(['e1', 'e6', 'e2', 'e3', 'e4', 'e5'])
  expect(second.elements.map((e) => e.parentRef)).toEqual([undefined, 'e1', 'e1', 'e2', 'e1', 'e4'])
  expect(second.elements[0]?.windowRoot).toBe(true)
  expect(second.elements.filter((e) => e.windowRoot === true)).toHaveLength(1)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: second.observationId,
    ref: 'e5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  expect(frame.ref).toBe('w.2.0#5')
  host.reply(frame, { dispatch: 'submitted', observation: { ...TREE, nodes: shifted } })
  expect((await acting).observation?.elements.map((e) => e.ref)).toEqual(
    second.elements.map((e) => e.ref),
  )
})

test('新控件获得新编号，消失控件的编号不分配给其他控件；用该编号发起动作在本地被拒绝', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)

  // 乙按钮消失，同一位置换成另一个控件。
  const replaced = [
    窗口根,
    甲组,
    甲输入框,
    乙组,
    { ...乙按钮, ref: 'w.1.0#9', name: '取消', automationId: 'cancel' },
  ]
  const second = await lookWith(host, a, replaced)
  expect(second.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e6'])

  const before = host.received.length
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: second.observationId,
      ref: 'e5',
      action: { kind: 'invoke' },
    }),
  ).rejects.toThrow('中没有控件 e5')
  await tick()
  expect(host.received.length).toBe(before)

  // 乙按钮重新出现：其身份仍在编号表中，沿用原编号。
  const third = await lookWith(host, a, NODES)
  expect(third.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
})

/** 属性指纹对角色与名称相同的兄弟控件不唯一，单独作为键会使两个控件得到同一编号。 */
test('没有 RuntimeId 的控件按完整 ref 编号：指纹相同的兄弟控件各得一个编号，位置改变即得到新编号', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const 弱甲: DesktopNode = { ...乙按钮, ref: 'w.1.0#~abc', weakIdentity: true }
  const 弱乙: DesktopNode = { ...乙按钮, ref: 'w.1.1#~abc', weakIdentity: true }
  const first = await lookWith(host, a, [窗口根, 乙组, 弱甲, 弱乙])
  expect(first.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4'])
  const again = await lookWith(host, a, [窗口根, 乙组, 弱甲, 弱乙])
  expect(again.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4'])

  const moved = await lookWith(host, a, [窗口根, 乙组, { ...弱甲, ref: 'w.1.2#~abc' }])
  expect(moved.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e5'])
  const acting = a.act({
    windowId: 'dw_1',
    observationId: moved.observationId,
    ref: 'e5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  expect(frame.ref).toBe('w.1.2#~abc')
  host.reply(frame, { dispatch: 'unknown', observationError: '宿主没有回传' })
  await acting
})

/** 遗漏任何一处转换，宿主收到的都是无法识别的编号。 */
test('发往宿主的控件引用均转换回完整 ref：子树根、动作目标、拖拽终点、重读范围、读取文本与等待目标', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)

  const scoped = a.observe({ windowId: 'dw_1', root: 'e4' })
  const read = await host.next()
  expect(read.root).toBe('w.1#4')
  host.reply(read, { observation: subtree() })
  const inScope = await scoped

  const acting = a.act({
    windowId: 'dw_1',
    observationId: inScope.observationId,
    ref: 'e5',
    action: { kind: 'drag', to: { kind: 'ref', ref: 'e4' } },
  })
  const act = await host.next()
  expect(act.ref).toBe('w.1.0#5')
  expect(act.root).toBe('w.1#4')
  expect(act.action).toEqual({ kind: 'drag', to: { kind: 'ref', ref: 'w.1#4' } })
  host.reply(act, { dispatch: 'submitted', observation: subtree() })
  const acted = await acting
  const observationId = acted.observation?.observationId ?? ''

  const reading = a.readText({ windowId: 'dw_1', observationId, ref: 'e5', maxChars: 100 })
  const text = await host.next()
  expect(text.ref).toBe('w.1.0#5')
  host.reply(text, {
    observation: {
      kind: 'text',
      window: WINDOW.handle,
      capturedAt: 9,
      scope: 'w.1.0#5',
      text: '正文',
      truncated: false,
      selectionSupport: 'none',
      selection: [],
    },
  })
  expect((await reading).text).toBe('正文')

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId,
    until: 'enabled',
    ref: 'e5',
    timeoutMs: 1_000,
  })
  const wait = await host.next()
  expect(wait.ref).toBe('w.1.0#5')
  expect(wait.root).toBe('w.1#4')
  host.reply(wait, { observation: { ...subtree(), kind: 'wait', found: true } })
  expect((await waiting).observation?.scope).toBe('e4')
})

test('编号表已满时淘汰最久未出现的身份，该身份再次出现时获得新编号', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)

  // 除窗口根外再加入 MAX_WINDOW_REFS - 1 个新身份：超出上限被淘汰的四个是甲组、甲输入框、
  // 乙组与乙按钮；窗口根在本次观察中出现过，保留在表中。
  const crowd: DesktopNode[] = Array.from({ length: MAX_WINDOW_REFS - 1 }, (_, i) => ({
    ...甲输入框,
    ref: `w.2.${i}#${1000 + i}`,
    parentRef: 'w#1',
  }))
  const crowded = await lookWith(host, a, [窗口根, ...crowd])
  expect(crowded.elements[0]?.ref).toBe('e1')
  expect(crowded.elements.at(-1)?.ref).toBe(`e${MAX_WINDOW_REFS + 4}`)

  const back = await lookWith(host, a, NODES)
  const next = MAX_WINDOW_REFS + 5
  expect(back.elements.map((e) => e.ref)).toEqual([
    'e1',
    `e${next}`,
    `e${next + 1}`,
    `e${next + 2}`,
    `e${next + 3}`,
  ])
})

test('窗口关闭后重新打开会得到新的 windowId，编号表随之重建', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)
  const trimmed = await lookWith(host, a, [窗口根, 乙组, 乙按钮])
  expect(trimmed.elements.map((e) => e.ref)).toEqual(['e1', 'e4', 'e5'])

  const reborn = { ...WINDOW, processStartedAt: WINDOW.processStartedAt + 1 }
  const listing = a.windows()
  const list = await host.next()
  host.reply(list, { observation: { kind: 'windows', capturedAt: 2, windows: [reborn] } })
  const [again] = await listing
  if (!again) throw new Error('窗口发现应当交回重开的窗口')
  expect(again.windowId).not.toBe('dw_1')

  const fresher = await lookWith(host, a, [窗口根, 乙组, 乙按钮], again.windowId)
  expect(fresher.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3'])
})

test('整窗观察之后的动作按整窗重读：请求帧不带范围，重读结果整份替换观察', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  expect(frame.op).toBe('act')
  expect(frame.ref).toBe('w.1.0#5')
  expect(frame.action).toEqual({ kind: 'invoke' })
  expect(frame.root).toBeUndefined()
  // 动作请求同样携带三个上限：宿主在动作之后重读时使用。
  expect(frame.maxNodes).toBeGreaterThan(0)
  expect(frame.maxDepth).toBeGreaterThan(0)
  expect(frame.timeBudgetMs).toBeGreaterThan(0)
  const reread = NODES.map((n) => (n.ref === 'w.1.0#5' ? { ...n, name: '保存（已改）' } : n))
  host.reply(frame, {
    dispatch: 'submitted',
    observation: { ...TREE, capturedAt: 9, nodes: reread },
  })
  const result = await acting

  expect(result.dispatch).toBe('submitted')
  if (!result.observation) throw new Error('动作回执应当带回新的观察')
  expect(result.observation.observationId).not.toBe(first.observationId)
  expect(result.observation.scope).toBeUndefined()
  expect(result.observation.capturedAt).toBe(9)
  expect(result.observation.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  expect(result.observation.elements.find((e) => e.ref === 'e5')?.name).toBe('保存（已改）')
  // 旧编号作废，新编号可用。
  expect(a.elements('dw_1', first.observationId)).toBeNull()
  expect(a.elements('dw_1', result.observation.observationId)).toHaveLength(5)
})

/**
 * 原始失败形状：上一份观察被截断，动作之后只重读了一棵子树，合并控件表时把上一份的旧节点
 * 连同新编号、新时刻与本次读取的完整性一并返回，旧观察被截断的事实因此被覆盖。
 */
test('子树范围的观察之后，动作按同一范围重读，新观察只含这次读到的节点', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  const whole = a.observe({ windowId: 'dw_1' })
  const wholeFrame = await host.next()
  host.reply(wholeFrame, {
    observation: {
      ...TREE,
      completeness: { complete: false, truncatedBy: ['max_nodes'], filteredBy: [], visited: 5 },
    },
  })
  await whole
  const scoped = a.observe({ windowId: 'dw_1', root: 'e4' })
  const scopedFrame = await host.next()
  host.reply(scopedFrame, { observation: subtree() })
  const inScope = await scoped
  expect(inScope.scope).toBe('e4')

  const acting = a.act({
    windowId: 'dw_1',
    observationId: inScope.observationId,
    ref: 'e5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  expect(frame.root).toBe('w.1#4')
  host.reply(frame, {
    dispatch: 'submitted',
    observation: subtree({
      capturedAt: 200,
      nodes: [乙组, { ...乙按钮, name: '保存（第二次）' }],
    }),
  })
  const result = await acting
  if (!result.observation) throw new Error('动作回执应当带回新的观察')
  expect(result.observation.elements.map((e) => e.ref)).toEqual(['e4', 'e5'])
  expect(result.observation.scope).toBe('e4')
  expect(result.observation.capturedAt).toBe(200)
  expect(result.observation.visited).toBe(2)
})

test('动作之后窗口被模态窗口遮挡：整份观察作废，只保留重读到的部分', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  host.reply(frame, {
    dispatch: 'submitted',
    observation: subtree({ windowEnabled: false, windowCovered: true }),
  })
  const result = await acting
  if (!result.observation) throw new Error('动作回执应当带回新的观察')
  expect(result.observation.windowEnabled).toBe(false)
  expect(result.observation.windowCovered).toBe(true)
  expect(result.observation.elements.map((e) => e.ref)).toEqual(['e4', 'e5'])
})

/**
 * 未派发的动作不改变观察记账。
 *
 * 宿主拒绝派发时未发出任何系统调用，控件表保持原状且仍然有效。将其作废会使下一个动作
 * 持同一编号时得到「观察已失效」，而该失败的成因是上一次拒绝，不是观察本身。
 */
test('动作被宿主拒绝派发：观察编号仍然有效，下一个动作正常发出', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const refused = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'click', button: 'left', count: 1 },
  })
  host.reply(await host.next(), { dispatch: 'not_dispatched', reason: 'occluded: 680,853' })
  const result = await refused
  expect(result.dispatch).toBe('not_dispatched')
  expect(result.observation).toBeNull()
  expect(a.elements('dw_1', first.observationId)?.map((e) => e.ref)).toEqual([
    'e1',
    'e2',
    'e3',
    'e4',
    'e5',
  ])

  // 使用同一编号发送下一个动作：请求正常发出，不报「观察已失效」。
  const next = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'activate' },
  })
  const frame = await host.next()
  expect(frame.op).toBe('act')
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  expect((await next).dispatch).toBe('submitted')
})

test('输入未派发但窗口准备后的重读失败：旧观察作废，保留失败原因', async () => {
  const { host, desktop } = await connected(fresh())
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)
  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'click', button: 'left', count: 1 },
  })
  host.reply(await host.next(), {
    dispatch: 'not_dispatched',
    reason: 'geometry_changed: minimized → restored',
    observationError: 'provider_timeout: 窗口准备后重读失败',
  })
  expect(await acting).toMatchObject({
    dispatch: 'not_dispatched',
    observation: null,
    observationError: 'provider_timeout: 窗口准备后重读失败',
  })
  expect(a.elements('dw_1', first.observationId)).toBeNull()
})

test('输入未派发但窗口准备返回新观察：更换编号，不再接受旧观察', async () => {
  const { host, desktop } = await connected(fresh())
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)
  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'click', button: 'left', count: 1 },
  })
  host.reply(await host.next(), {
    dispatch: 'not_dispatched',
    reason: 'geometry_changed: minimized → restored',
    observation: subtree(),
  })
  const result = await acting
  expect(result.dispatch).toBe('not_dispatched')
  if (!result.observation) throw new Error('窗口准备后的新观察不应丢失')
  expect(result.observation.observationId).not.toBe(first.observationId)
  expect(a.elements('dw_1', first.observationId)).toBeNull()
  expect(a.elements('dw_1', result.observation.observationId)?.map((e) => e.ref)).toEqual([
    'e4',
    'e5',
  ])
})

test('动作之后没有重读：该窗口的控件表整份作废', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
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
 * 调用未返回时宿主不重读目标窗口，改为返回一份窗口清单。该清单必须使用与 `desktop_windows`
 * 相同的登记路径：同一窗口经两条路径取得同一个 id，新窗口取得 id 后即可直接观察。
 */
test('动作调用未返回：窗口清单按同一路径登记，新窗口可立即观察', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
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
    observationError: 'target_blocked',
    blocking: [
      { ...WINDOW, appeared: false },
      { ...dialog, app: WINDOW.app, title: '另存为', appeared: true },
    ],
  })
  const result = await acting

  expect(result.dispatch).toBe('submitted')
  expect(result.observation).toBeNull()
  // 目标窗口沿用原有 id，不因经由另一条路径而更换。
  expect(result.blocking?.[0]).toEqual({
    windowId: 'dw_1',
    app: WINDOW.app,
    title: WINDOW.title,
    appeared: false,
  })
  const appeared = result.blocking?.[1]
  expect(appeared?.appeared).toBe(true)
  expect(appeared?.windowId).not.toBe('dw_1')

  // 新窗口可立即观察：无需再次列出窗口。
  if (!appeared) throw new Error('回执里没有新窗口')
  const observing = a.observe({ windowId: appeared.windowId })
  const next = await host.next()
  expect(next.op).toBe('read_tree')
  expect(next.target).toEqual(dialogTarget)
  host.reply(next, { observation: { ...TREE, window: dialog.handle } })
  expect((await observing).elements.length).toBeGreaterThan(0)
})

/** 动作回执中的清单只覆盖目标进程，据此裁剪会把其他进程的窗口一并作废。 */
test('动作回执的窗口清单不裁剪其他窗口', async () => {
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

  // 此处不能再执行窗口发现：窗口发现会按整机清单裁剪刚登记的第二个窗口。
  const looking = a.observe({ windowId: 'dw_1' })
  const look = await host.next()
  host.reply(look, treeOf(look))
  const first = await looking

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'invoke' },
  })
  const frame = await host.next()
  host.reply(frame, {
    dispatch: 'submitted',
    observationError: 'target_blocked',
    blocking: [{ ...WINDOW, appeared: false }],
  })
  await acting

  // 另一个进程的窗口未被该清单裁剪，此时仍可作为目标。
  const observing = a.observe({ windowId: otherId })
  const next = await host.next()
  expect(next.target?.window).toBe(other.handle)
  host.reply(next, { observation: { ...TREE, window: other.handle } })
  await observing
})

test('等待的条件与两个时限写入请求帧，条件满足后返回新观察', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'value',
    ref: 'e3',
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
  // 请求帧中的绝对期限必须大于等待时长：宿主到期后还要重读一次才发送回执。
  expect(frame.deadline - Date.now()).toBeGreaterThan(5_000)
  // 整窗观察之后的等待按整窗重读，请求帧不带范围。
  expect(frame.root).toBeUndefined()
  host.reply(frame, { observation: { ...TREE, kind: 'wait', found: true } })
  const result = await waiting
  expect(result.found).toBe(true)
  if (!result.observation) throw new Error('等待回执应当带回当时的控件表')
  expect(result.observation.observationId).not.toBe(first.observationId)
  expect(result.observation.elements).toHaveLength(NODES.length)
})

test('等待携带当前观察的范围与 appears 的角色、文字', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await firstLook(host, a)
  const scoped = a.observe({ windowId: 'dw_1', root: 'e4' })
  const scopedFrame = await host.next()
  host.reply(scopedFrame, { observation: subtree() })
  const inScope = await scoped

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: inScope.observationId,
    until: 'appears',
    role: 'button',
    query: '保存',
    timeoutMs: 1_000,
  })
  const frame = await host.next()
  expect(frame.root).toBe('w.1#4')
  expect(frame.role).toBe('button')
  expect(frame.nameContains).toBe('保存')
  host.reply(frame, { observation: { ...subtree(), kind: 'wait', found: true } })
  const result = await waiting
  expect(result.observation?.scope).toBe('e4')
})

/** 窗口表只在发现窗口时写入标题；页面切换后，依靠整窗读取得到的窗口元素名称刷新标题。 */
test('整窗读取将窗口元素的名称刷新为窗口标题，子树读取不修改标题', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())

  const whole = a.observe({ windowId: 'dw_1' })
  const wholeFrame = await host.next()
  host.reply(wholeFrame, {
    observation: { ...TREE, nodes: [{ ...窗口根, name: '新页面 - 浏览器' }, ...NODES.slice(1)] },
  })
  expect((await whole).title).toBe('新页面 - 浏览器')

  const scoped = a.observe({ windowId: 'dw_1', root: 'e4' })
  const scopedFrame = await host.next()
  host.reply(scopedFrame, { observation: subtree() })
  expect((await scoped).title).toBe('新页面 - 浏览器')
})

test('等待到期：如实返回未满足及对应时刻的状态，不视为执行失败', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'enabled',
    ref: 'e3',
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
 * 等待期间释放：撤销帧必须在等待回执之前发出，等待以 cancelled 收尾，
 * 桌面随即交给下一个执行者。等待若持续占用桌面，后续执行者将无法获得桌面。
 */
test('等待期间释放：发出撤销帧，等待按撤销收尾，桌面交给下一个执行者', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const b = desktop.portFor('cv_b')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'enabled',
    ref: 'e3',
    timeoutMs: 60_000,
  })
  const waitFrame = await host.next()
  expect(waitFrame.op).toBe('wait')

  // B 在队列中等待：A 的等待收到回执之前，不发送 B 的任何帧。
  const observeB = b.observe({ windowId: 'dw_2' })
  const before = host.received.length
  await tick()
  expect(host.received.length).toBe(before)

  const released = a.release()
  const cancel = await host.next()
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(waitFrame.executorId)
  // 宿主撤销该等待，并答复该执行者名下已没有执行中的请求。
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

test('等待期间宿主代际变化：等待取得终态，旧观察随执行实例作废', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const waiting = a.wait({
    windowId: 'dw_1',
    observationId: first.observationId,
    until: 'enabled',
    ref: 'e3',
    timeoutMs: 60_000,
  })
  await host.next()
  // worker 代际变化：旧执行实例名下的待决调用按已派发收尾。
  host.ready({ hostEpoch: 9 })
  const result = await waiting
  expect(result.found).toBe(false)
  expect(result.observation).toBeNull()
  expect(a.elements('dw_1', first.observationId)).toBeNull()
})

/** 整窗图像的观察。几何数据的结构与本机实测一致：窗口矩形与可见边框相差 7 像素。 */
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

/** 采集一张整窗图像，返回其 imageRef 与宿主收到的请求帧。 */
async function captured(
  host: FakeDesktopHost,
  pending: Promise<{ imageRef: string }>,
): Promise<{ imageRef: string; frame: DesktopRequestFrame }> {
  const frame = await host.next()
  host.reply(frame, { observation: { ...IMAGE, window: frame.target?.window ?? 0 } })
  const image = await pending
  return { imageRef: image.imageRef, frame }
}

test('整窗采集只携带上限，不携带区域与代际', async () => {
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
  // 目标身份三项照常携带：采集同样需要在派发前核对窗口是否仍为同一个。
  expect(frame.target).toEqual({
    window: WINDOW.handle,
    pid: WINDOW.pid,
    processStartedAt: WINDOW.processStartedAt,
  })
})

test('提供屏幕矩形时原样下发，不携带代际', async () => {
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
 * imageRef 的换算与核对路径：图像矩形在此处换算为屏幕矩形，与窗口几何代际一并下发，
 * 由宿主在派发前重新核对窗口矩形。
 */
test('按上一张图像的区域重新采集：换算为屏幕矩形并携带几何代际', async () => {
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
  // 该图像为 1:1，换算即一次平移：87+10、80+20。
  expect(frame.region).toEqual({ x: 97, y: 100, width: 100, height: 50 })
  expect(frame.expectGeneration).toBe('80,80,520,460@96#65537')
})

test('缩放过的图像按比例换算，不按 DPI 换算', async () => {
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

test('无法识别的 imageRef 在本地被拒绝，不发送任何帧', async () => {
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
  expect(String(failed)).toContain('无法识别的图像')
  expect((failed as { executed?: boolean }).executed).toBe(false)
  await tick()
  expect(host.received.length).toBe(before)
})

/** 代际变化后，采集时的几何数据已不成立，据此换算出的矩形指向其他界面区域。 */
test('宿主代际变化后旧 imageRef 失效', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  const first = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  host.ready({ hostEpoch: 9 })
  await tick()
  // 代际变化后窗口表同样作废，重新执行窗口发现后才有可用的不透明 id。
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
  expect(String(failed)).toContain('代际已变化')
  await tick()
  expect(host.received.length).toBe(before)
})

/** 窗口关闭后重新打开时句柄可能被复用，旧图像对应的是之前的窗口。 */
test('窗口身份改变后旧 imageRef 失效', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  await discover(host, () => a.windows())
  const first = await captured(host, a.captureImage({ windowId: 'dw_1', maxEdge: 1568 }))

  // 句柄相同而进程启动时刻不同：这是另一个窗口，不透明 id 因此改变。
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
  expect(String(failed)).toContain('不是从该窗口采集的')
})

test('矩形超出图像范围时在本地被拒绝', async () => {
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

/** 释放之后该端口失效，其返回的图像一并作废。 */
test('释放之后旧 imageRef 不再可用', async () => {
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

/** 采集必须先占用桌面：两个执行者同时采图时，会看到对方操作造成的窗口状态。 */
test('采集与观察使用同一个占用', async () => {
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

/** 控件包围盒与图像使用同一套坐标，控件树一侧不得丢弃包围盒。 */
test('控件包围盒随观察返回到端口外部', async () => {
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
  expect(snapshot.elements.find((e) => e.ref === 'e3')?.rect).toEqual({
    x: 300,
    y: 200,
    width: 120,
    height: 24,
  })
  expect(snapshot.elements.find((e) => e.ref === 'e1')?.rect).toBeUndefined()
})

/** 选中项名单及其截断标记随观察返回到端口外部；worker 未提供时端口不自行构造。 */
test('选择容器的选中项名单随观察返回到端口外部', async () => {
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
  expect(snapshot.elements.find((e) => e.ref === 'e2')?.selection).toEqual({
    multiple: true,
    required: false,
    selected: ['甲', '乙'],
    truncated: true,
  })
  expect(snapshot.elements.find((e) => e.ref === 'e1')?.selection).toBeUndefined()
})

/**
 * 按图像定位的动作：图像坐标在此处换算为屏幕坐标，与窗口几何代际一并下发，
 * 由宿主在派发前重新核对窗口矩形。控件与图像点只能提供其中一个。
 */
test('按图像定位的指针动作换算为屏幕坐标并携带几何代际', async () => {
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
  // 该图像为 1:1，换算即一次平移：87+10、80+20。
  expect(frame.point).toEqual({ x: 97, y: 100 })
  expect(frame.expectGeneration).toBe('80,80,520,460@96#65537')
  expect(frame.ref).toBeUndefined()
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  expect((await acting).dispatch).toBe('submitted')
})

test('控件与图像点只能提供其中一个，同时提供或均未提供时在本地拒绝', async () => {
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
      ref: 'e5',
      at: { imageRef: image.imageRef, x: 1, y: 1 },
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('只能提供其中一个')
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: first.observationId,
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('必须提供控件或图像点')
  // 键盘与窗口动作没有指针落点。
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
 * 键盘输入既未提供控件也未提供图像点时，目标是窗口本身，请求帧中没有 `ref` 与 `point`。
 *
 * 自绘界面不暴露业务控件，要求指定控件等于对这类界面关闭整条键盘输入路径。准入判定由
 * worker 执行（前台窗口即目标窗口），此处只负责不拦截、不伪造 ref。
 */
test('未指定控件的键盘输入按窗口派发，请求帧中没有 ref 与 point', async () => {
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

/** 全角标点与半角连字符不使文字经由第二条投递路径，请求帧与普通文字完全相同。 */
test('含全角标点的文字按原文下发，没有第二种投递方式', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    action: { kind: 'type_text', text: '哦哦行，那你先用这个号跑吧' },
  })
  const frame = await host.next()
  expect(frame.action).toEqual({ kind: 'type_text', text: '哦哦行，那你先用这个号跑吧' })
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  const result = await acting
  expect(result.dispatch).toBe('submitted')
  expect(Object.keys(result)).not.toContain('delivery')
})

test('图片范围外的坐标在本地被拒绝，不发送任何帧', async () => {
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
  ).rejects.toThrow('覆盖范围')
  await expect(
    a.act({
      windowId: 'dw_1',
      observationId: 'do_ignored',
      at: { imageRef: image.imageRef, x: -1, y: 1 },
      action: { kind: 'click', button: 'left', count: 1 },
    }),
  ).rejects.toThrow('覆盖范围')
  await tick()
  expect(host.received.length).toBe(before)
})

test('无法识别的图片在本地被拒绝，不发送任何帧', async () => {
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
  ).rejects.toThrow('无法识别的图像')
  await tick()
  expect(host.received.length).toBe(before)
})

/** 拖拽终点写在动作中：像素偏移原样下发，控件终点必须来自本执行者已取得的观察。 */
test('拖拽的像素偏移原样下发，控件终点必须在观察中', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)

  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
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
      ref: 'e5',
      action: { kind: 'drag', to: { kind: 'ref', ref: 'e9' } },
    }),
  ).rejects.toThrow('没有控件')
  await tick()
  expect(host.received.length).toBe(before)
})

/**
 * 前台接管的读数按回执上调。
 *
 * 宿主拒绝派发时桌面未被操作，此时显示「正在前台操作」与事实不符；派发之后不再撤回，
 * 因为一次前台点击已将焦点留在目标应用上。
 */
test('前台接管的读数只在宿主实际派发之后上调', async () => {
  const handle = fresh()
  const { host, desktop } = await connected(handle)
  const seen: DesktopTargetEvent['target'][] = []
  cleanups.push(desktop.onTargetChange((target) => seen.push(target)))
  const a = desktop.portFor('cv_a')
  const first = await firstLook(host, a)
  expect(seen.at(-1)).toEqual({ conversationId: 'cv_a', app: '记事本', foreground: false })

  // 宿主拒绝派发：读数不变。
  const refused = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'click', button: 'left', count: 1 },
  })
  let frame = await host.next()
  host.reply(frame, { dispatch: 'not_dispatched', reason: 'foreground_disabled: 前台操作未启用' })
  expect((await refused).dispatch).toBe('not_dispatched')
  expect(desktop.target()?.foreground).toBe(false)

  // 已派发：读数上调，之后的后台读取不将其回退。拒绝派发未改变观察记账，
  // 因此继续使用第一份观察的编号。
  const acting = a.act({
    windowId: 'dw_1',
    observationId: first.observationId,
    ref: 'e5',
    action: { kind: 'click', button: 'left', count: 1 },
  })
  frame = await host.next()
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  const done = await acting
  expect(desktop.target()?.foreground).toBe(true)
  expect(seen.at(-1)).toEqual({ conversationId: 'cv_a', app: '记事本', foreground: true })

  const reading = a.act({
    windowId: 'dw_1',
    observationId: done.observation?.observationId ?? first.observationId,
    ref: 'e5',
    action: { kind: 'invoke' },
  })
  frame = await host.next()
  host.reply(frame, { dispatch: 'submitted', observation: subtree() })
  await reading
  expect(desktop.target()?.foreground).toBe(true)

  // 释放时与应用名一并清除。
  const releasing = a.release()
  host.reply(await host.next())
  await releasing
  expect(desktop.target()).toBeNull()
  expect(seen.at(-1)).toBeNull()
})
