/**
 * 桌面宿主连接的准入、代际配对与断线收尾。
 *
 * 覆盖范围：`desktop/bridge.ts` 全部、`desktop/capability.ts`、`desktop/coordinator.ts`
 * 里的窗口身份映射与观察代际，`server.ts` 里 `/native/desktop` 的升级与帧分派，
 * 以及 `handshake.ts` 报出的 `capabilities.desktop` 与两条进程级状态事件。
 *
 * 用真 WebSocket 连真 `serve()`：凭据判定、回环判定、按路径分派宿主种类三件事都在
 * `server.ts` 的 fetch 里，拿假 socket 测等于把被测那一段跳过去。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopResultFrame, DesktopTargetEvent, HelloFrame } from '@qywork/core'
import { NATIVE_DESKTOP_PATH } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import { serve } from '../server.ts'
import { FakeDesktopHost, HOST_KEY, READY } from './fixtures.ts'

function config(desktopEnabled = true): QyConfig {
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
    desktopEnabled,
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

function fresh(cfg = config()): ReturnType<typeof serve> {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-desktop-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  upsertWorkspace(store, dir, 'W')
  const handle = serve({
    store,
    config: cfg,
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

/** 连一条假宿主，收尾登记进本文件的清理队列。 */
const connect = (port: number, key = HOST_KEY) => FakeDesktopHost.connect(port, key, cleanups)

/** 让事件循环把已经到达的帧派发完。 */
const settle = () => new Promise((r) => setTimeout(r, 30))

/**
 * 取一次失败的原因。
 *
 * 不用 `expect(...).rejects`：那个断言在等一条要靠 WebSocket 回帧才结得掉的
 * Promise 时不会让出事件循环，回帧因此永远到不了，测试只会撞超时。
 */
async function failure(
  pending: Promise<unknown> | undefined,
): Promise<Error & { dispatch?: string }> {
  const settled = Symbol('resolved')
  const out = await Promise.resolve(pending).then(
    () => settled,
    (err: unknown) => err,
  )
  if (out === settled) throw new Error('这条调用本应失败')
  return out as Error & { dispatch?: string }
}

test('凭据不对或缺凭据的连接一律拒绝，不进入宿主生命周期', async () => {
  const handle = fresh()
  expect(await failure(connect(handle.port, 'wrong-key'))).toBeInstanceOf(Error)
  const bare = new WebSocket(`ws://127.0.0.1:${handle.port}${NATIVE_DESKTOP_PATH}`)
  await new Promise<void>((resolve) => {
    bare.onclose = () => resolve()
    bare.onerror = () => resolve()
  })
  expect(handle.desktop?.available()).toBe(false)
})

test('普通配对连接发桌面宿主帧也注册不了宿主', async () => {
  const handle = fresh()
  const ws = new WebSocket(
    `ws://127.0.0.1:${handle.port}/stream?origin=desktop&token=${handle.token}`,
  )
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('配对连接应当能建立'))
  })
  cleanups.push(() => ws.close())
  ws.send(JSON.stringify(READY))
  await settle()
  expect(handle.desktop?.available()).toBe(false)
})

test('三项能力位分开报，worker 没就绪或没授权时不发布能力', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready({ workerReady: false })
  await settle()
  expect(handle.desktop?.available()).toBe(false)

  host.ready({ authorized: false })
  await settle()
  expect(handle.desktop?.available()).toBe(false)

  host.ready()
  await settle()
  expect(handle.desktop?.available()).toBe(true)
})

test('用户没启用时宿主连上也不发布能力', async () => {
  const handle = fresh(config(false))
  const host = await connect(handle.port)
  host.ready()
  await settle()
  expect(handle.desktop?.available()).toBe(false)
})

/**
 * 握手报的那一份与事件推的那一份是同一个判定。
 *
 * 宿主在应用启动之后才连上来：只有握手那一份的话，界面要等下一次重连才看得见状态。
 */
test('握手报出三项能力位，宿主连上之后由事件推同一份投影', async () => {
  const handle = fresh()
  const client = new WebSocket(
    `ws://127.0.0.1:${handle.port}/stream?origin=desktop&token=${handle.token}`,
  )
  const frames: { type: string; [k: string]: unknown }[] = []
  client.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)))
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve()
    client.onerror = () => reject(new Error('配对连接应当能建立'))
  })
  cleanups.push(() => client.close())
  client.send(JSON.stringify({ type: 'hello', token: handle.token, origin: 'desktop' }))
  await settle()
  const hello = frames.find((f) => f.type === 'hello.ok') as
    | { capabilities: { desktop: unknown } }
    | undefined
  expect(hello?.capabilities.desktop).toEqual({
    connected: false,
    workerReady: false,
    authorized: false,
  })

  const host = await connect(handle.port)
  host.ready()
  await settle()
  const state = frames
    .map((f) => f.event)
    .find((e) => (e as { type?: string })?.type === 'desktop.state')
  expect(state).toEqual({
    type: 'desktop.state',
    desktop: { connected: true, workerReady: true, authorized: true },
  })

  // 正在操作哪个应用：执行者碰到窗口时推上去，释放时推回 null。
  const port = handle.desktop?.portFor('cv_a')
  const listing = port?.windows()
  host.reply(await host.next())
  await listing
  // 读树的回执故意不给：目标在发请求之前就登记，界面不必等回包才说得出在操作谁。
  const observing = port?.observe({ windowId: 'dw_1' }).catch(() => null)
  await host.next()
  await settle()
  const targets = frames
    .map((f) => f.event as DesktopTargetEvent | undefined)
    .filter((e) => e?.type === 'desktop.target')
  expect(targets.at(-1)?.target).toEqual({
    conversationId: 'cv_a',
    app: '记事本',
    foreground: false,
  })
  const releasing = port?.release()
  await observing
  host.reply(await host.next())
  await releasing
  await settle()
  const cleared = frames
    .map((f) => f.event as DesktopTargetEvent | undefined)
    .filter((e) => e?.type === 'desktop.target')
  expect(cleared.at(-1)?.target).toBe(null)
})

test('请求帧带齐身份字段：连接代际、执行实例、执行者与截止时刻', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  const frame = await host.next()
  expect(frame.type).toBe('desktop.request')
  expect(frame.op).toBe('list_windows')
  expect(frame.hostId).toBe('h1')
  expect(frame.hostEpoch).toBe(2)
  expect(frame.connectionEpoch).toBe(3)
  expect(frame.executorId).toMatch(/^dx_/)
  expect(frame.deadline).toBeGreaterThan(Date.now())
  host.reply(frame)
  // OS 句柄不出端口：模型拿到的只有不透明 id 与应用名。
  expect(await pending).toEqual([{ windowId: 'dw_1', app: '记事本', title: '未命名' }])
})

test('首连、补发和换流重连都恢复当前桌面目标及其所属会话', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_wechat')
  const listing = port?.windows()
  host.reply(await host.next())
  await listing
  const observing = port?.observe({ windowId: 'dw_1' }).catch(() => null)
  await host.next()

  const snapshot = async (resume?: HelloFrame['resume']) => {
    const client = new WebSocket(
      `ws://127.0.0.1:${handle.port}/stream?origin=desktop&token=${handle.token}`,
    )
    const events: DesktopTargetEvent[] = []
    client.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data))
      if (frame.event?.type === 'desktop.target') events.push(frame.event)
    }
    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve()
      client.onerror = () => reject(new Error('配对连接应当能建立'))
    })
    cleanups.push(() => client.close())
    // 即使只订阅别的会话，快照仍保留实际归属，切回时无需等待目标再次变化。
    client.send(
      JSON.stringify({
        type: 'hello',
        token: handle.token,
        origin: 'desktop',
        subscribe: ['cv_other'],
        ...(resume ? { resume } : {}),
      }),
    )
    await settle()
    client.close()
    return events
  }

  const active = { conversationId: 'cv_wechat', app: '记事本', foreground: false }
  expect((await snapshot()).at(-1)?.target).toEqual(active)
  const releasing = port?.release()
  await observing
  host.reply(await host.next())
  await releasing

  // 补发里有旧目标；最后一帧必须是现在已释放的快照。
  const replayed = await snapshot({ streamId: handle.bus.streamId, lastSeq: 0 })
  expect(replayed.some((event) => event.target?.conversationId === 'cv_wechat')).toBe(true)
  expect(replayed.at(-1)?.target).toBeNull()
  expect((await snapshot({ streamId: 'previous-server', lastSeq: 9000 })).at(-1)?.target).toBeNull()
})

test('代际对不上的迟到回执不得完成这次调用', async () => {
  for (const broken of [
    { connectionEpoch: 4 },
    { hostEpoch: 9 },
    { hostId: 'h2' },
  ] as Partial<DesktopResultFrame>[]) {
    const handle = fresh()
    const host = await connect(handle.port)
    host.ready()
    await settle()
    const port = handle.desktop?.portFor('cv_a')
    const pending = port?.windows()
    const frame = await host.next()
    host.reply(frame, broken)
    await settle()
    // 调用仍然待决——用断开来证明它没有被那一帧结掉。
    host.socket.close()
    const err = await failure(pending)
    expect(err.message).toMatch(/断开/)
  }
})

test('断线让在途调用按已派发收尾，不记成未执行', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  await host.next()
  host.socket.close()
  const err = await failure(pending)
  // 帧已经写出去了，宿主收没收到无从确定：这一条必须是 unknown。
  expect(err.dispatch).toBe('unknown')
  await settle()
  expect(handle.desktop?.available()).toBe(false)
})

test('同一条 WS 上换执行实例：旧待决收尾，能力按新代际重建', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  const stale = await host.next()
  // worker 被换掉：hostId 与连接都没变，只有执行实例代际推进。
  host.ready({ hostEpoch: 3 })
  const err = await failure(pending)
  expect(err.dispatch).toBe('unknown')
  // 旧执行实例的迟到回执不得完成任何调用。
  host.reply(stale)
  await settle()
  expect(handle.desktop?.available()).toBe(true)
  const again = port?.windows()
  const frame = await host.next()
  expect(frame.hostEpoch).toBe(3)
  host.reply(frame)
  expect(await again).toHaveLength(1)
})

test('worker 掉线的状态事件让能力下线，并收掉在途调用', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  await host.next()
  host.send({
    type: 'desktop.event',
    connectionEpoch: 3,
    hostId: 'h1',
    hostEpoch: 2,
    kind: 'worker.state',
    workerReady: false,
    authorized: true,
  })
  expect((await failure(pending)).dispatch).toBe('unknown')
  await settle()
  expect(handle.desktop?.available()).toBe(false)
})

test('代际对不上的状态事件改不了能力', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  host.send({
    type: 'desktop.event',
    connectionEpoch: 3,
    hostId: 'h1',
    hostEpoch: 1,
    kind: 'worker.state',
    workerReady: false,
    authorized: false,
  })
  await settle()
  expect(handle.desktop?.available()).toBe(true)
})

test('窗口消失后旧的不透明 id 在本地就被拒绝，一帧都不发', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const first = port?.windows()
  host.reply(await host.next())
  expect(await first).toHaveLength(1)

  const second = port?.windows()
  host.reply(await host.next(), {
    observation: { kind: 'windows', capturedAt: 2, windows: [] },
  })
  expect(await second).toEqual([])

  const before = host.received.length
  const err = await failure(port?.observe({ windowId: 'dw_1' }))
  expect(err.message).toMatch(/认不出的窗口/)
  expect(host.received.length).toBe(before)
})

test('释放之后端口报废，并向宿主发出按执行者撤销', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  // 失败处理要在释放之前挂上：`release` 同步收掉在途调用，晚一步挂就是一次未处理的拒绝。
  const pending = failure(port?.windows())
  const frame = await host.next()
  const cancelling = host.next()
  const releasing = port?.release()
  expect((await pending).dispatch).toBe('unknown')
  const cancel = await cancelling
  expect(cancel.op).toBe('cancel')
  expect(cancel.executorId).toBe(frame.executorId)
  host.reply(cancel)
  await releasing
  // 释放是幂等的，重复调用不再发第二条撤销。
  const count = host.received.filter((f) => f.op === 'cancel').length
  await port?.release()
  await settle()
  expect(host.received.filter((f) => f.op === 'cancel').length).toBe(count)
  expect((await failure(port?.windows())).message).toMatch(/已经结束/)
})

/**
 * 前台开关随每条请求下发。
 *
 * 宿主与 worker 都不缓存它：缓存一份的话，用户在运行中关掉前台接管要等宿主换代际
 * 才生效，而那中间的每一次派发都还带着旧值。
 */
test('前台开关每条请求现读一次，运行中关掉在下一次派发就生效', async () => {
  const cfg = config()
  cfg.desktopForeground = true
  const handle = fresh(cfg)
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')

  const first = port?.windows()
  const on = await host.next()
  expect(on.foreground).toBe(true)
  host.reply(on)
  await first

  cfg.desktopForeground = false
  const second = port?.windows()
  const off = await host.next()
  expect(off.foreground).toBe(false)
  host.reply(off)
  await second
})

/** 缺席按关：配置里没有这一项时，请求帧里那一格是假而不是缺席。 */
test('没配过前台开关时请求帧仍带一个明确的假', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  const frame = await host.next()
  expect(frame.foreground).toBe(false)
  host.reply(frame)
  await pending
})

/**
 * 运行态读数区分后台与前台。
 *
 * 只进不退：一次前台点击之后焦点已经在目标应用上，之后的后台读取改不回来这件事；
 * 执行者释放时随应用名一起清回去。
 */
test('前台接管过之后运行态读数说得出这一点，释放时清回去', async () => {
  const cfg = config()
  cfg.desktopForeground = true
  const handle = fresh(cfg)
  const client = new WebSocket(
    `ws://127.0.0.1:${handle.port}/stream?origin=desktop&token=${handle.token}`,
  )
  const frames: {
    type: string
    event?: DesktopTargetEvent
  }[] = []
  client.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)))
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve()
    client.onerror = () => reject(new Error('配对连接应当能建立'))
  })
  cleanups.push(() => client.close())
  client.send(JSON.stringify({ type: 'hello', token: handle.token, origin: 'desktop' }))
  await settle()

  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const listing = port?.windows()
  host.reply(await host.next())
  await listing

  const targets = () => frames.map((f) => f.event).filter((e) => e?.type === 'desktop.target')

  // 后台观察：目标登记上去，但还没有前台接管。
  const observing = port?.observe({ windowId: 'dw_1' }).catch(() => null)
  await host.next()
  await settle()
  expect(targets().at(-1)?.target).toEqual({
    conversationId: 'cv_a',
    app: '记事本',
    foreground: false,
  })

  const releasing = port?.release()
  await observing
  host.reply(await host.next())
  await releasing
  await settle()
  expect(targets().at(-1)?.target).toBeNull()
})
