/**
 * 桌面宿主连接的准入、代际配对与断线收尾。
 *
 * 覆盖范围：`desktop/bridge.ts` 全部、`desktop/capability.ts`、`desktop/coordinator.ts`
 * 中的窗口身份映射与观察代际，`server.ts` 中 `/native/desktop` 的升级与帧分派，
 * 以及 `handshake.ts` 报告的 `capabilities.desktop` 与两条进程级状态事件。
 *
 * 使用真实 WebSocket 连接真实的 `serve()`：凭据判定、回环判定与按路径分派宿主种类均位于
 * `server.ts` 的 fetch 中，使用假 socket 测试会跳过被测代码。
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
    // Windows 上 SQLite 的文件句柄释放有延迟，临时目录删除失败与被测行为无关。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return handle
}

/** 连接一个假宿主，清理操作登记到本文件的清理队列。 */
const connect = (port: number, key = HOST_KEY) => FakeDesktopHost.connect(port, key, cleanups)

/** 等待事件循环派发完已到达的帧。 */
const settle = () => new Promise((r) => setTimeout(r, 30))

/** 网络帧何时到达由事件循环决定，不能用固定延迟代替收到帧。 */
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  expect(check()).toBe(true)
}

/**
 * 取得一次调用失败的原因。
 *
 * 不使用 `expect(...).rejects`：该断言在等待一个须由 WebSocket 响应帧才能结算的
 * Promise 时不会让出事件循环，响应帧因此永远无法到达，测试只会超时。
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

test('凭据错误或缺少凭据的连接一律拒绝，不进入宿主生命周期', async () => {
  const handle = fresh()
  expect(await failure(connect(handle.port, 'wrong-key'))).toBeInstanceOf(Error)
  const bare = new WebSocket(`ws://127.0.0.1:${handle.port}${NATIVE_DESKTOP_PATH}`)
  await new Promise<void>((resolve) => {
    bare.onclose = () => resolve()
    bare.onerror = () => resolve()
  })
  expect(handle.desktop?.available()).toBe(false)
})

test('普通配对连接发送桌面宿主帧时无法注册宿主', async () => {
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

test('三项能力位分别报告，worker 未就绪或未授权时不发布能力', async () => {
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

test('用户未启用时宿主连接后也不发布能力', async () => {
  const handle = fresh(config(false))
  const host = await connect(handle.port)
  host.ready()
  await settle()
  expect(handle.desktop?.available()).toBe(false)
})

/**
 * 握手报告的状态与事件推送的状态来自同一个判定。
 *
 * 宿主在应用启动之后才连接：只在握手中报告时，界面要等到下一次重连才能显示状态。
 */
test('握手报告三项能力位，宿主连接之后由事件推送同一份投影', async () => {
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
  await waitFor(() => frames.some((f) => f.type === 'hello.ok'))
  const hello = frames.find((f) => f.type === 'hello.ok') as
    | { capabilities: { desktop: unknown } }
    | undefined
  expect(hello?.capabilities.desktop).toEqual({
    connected: false,
    workerReady: false,
    authorized: false,
    missing: [],
  })

  const host = await connect(handle.port)
  host.ready()
  await waitFor(() => frames.some((f) => (f.event as { type?: string })?.type === 'desktop.state'))
  const state = frames
    .map((f) => f.event)
    .find((e) => (e as { type?: string })?.type === 'desktop.state')
  expect(state).toEqual({
    type: 'desktop.state',
    desktop: { connected: true, workerReady: true, authorized: true, missing: [] },
  })

  // 当前操作的应用：执行者访问窗口时推送，释放时推送 null。
  const port = handle.desktop?.portFor('cv_a')
  const listing = port?.windows()
  host.reply(await host.next())
  await listing
  // 有意不返回读取控件树的回执：目标在发送请求之前登记，界面无需等待响应即可显示操作对象。
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

test('请求帧携带全部身份字段：连接代际、执行实例、执行者与截止时刻', async () => {
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
  // OS 句柄不经端口传出：模型取得的只有不透明 id 与应用名。
  expect(await pending).toEqual([{ windowId: 'dw_1', app: '记事本', title: '未命名' }])
})

test('首次连接、补发与更换事件流后重连均恢复当前桌面目标及其所属会话', async () => {
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
    let currentSeq: number | undefined
    let snapshotReceived = false
    client.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data))
      if (frame.type === 'hello.ok') currentSeq = frame.currentSeq
      if (frame.event?.type === 'desktop.target') {
        events.push(frame.event)
        // 补发帧不代表快照已到达；当前快照的序号大于握手时的序号。
        if (currentSeq !== undefined && frame.seq > currentSeq) snapshotReceived = true
      }
    }
    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve()
      client.onerror = () => reject(new Error('配对连接应当能建立'))
    })
    cleanups.push(() => client.close())
    // 即使只订阅其他会话，快照仍保留实际归属，切回时无需等待目标再次变化。
    client.send(
      JSON.stringify({
        type: 'hello',
        token: handle.token,
        origin: 'desktop',
        subscribe: ['cv_other'],
        ...(resume ? { resume } : {}),
      }),
    )
    const deadline = Date.now() + 2_000
    while (!snapshotReceived && Date.now() < deadline) await Bun.sleep(10)
    expect(snapshotReceived).toBe(true)
    client.close()
    return events
  }

  const active = { conversationId: 'cv_wechat', app: '记事本', foreground: false }
  expect((await snapshot()).at(-1)?.target).toEqual(active)
  const releasing = port?.release()
  await observing
  host.reply(await host.next())
  await releasing

  // 补发的帧中包含旧目标；最后一帧必须是当前已释放的快照。
  const replayed = await snapshot({ streamId: handle.bus.streamId, lastSeq: 0 })
  expect(replayed.some((event) => event.target?.conversationId === 'cv_wechat')).toBe(true)
  expect(replayed.at(-1)?.target).toBeNull()
  expect((await snapshot({ streamId: 'previous-server', lastSeq: 9000 })).at(-1)?.target).toBeNull()
})

test('代际不一致的迟到回执不得完成本次调用', async () => {
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
    // 调用仍处于待决状态：断开连接后它因断开而失败，证明未被该帧结算。
    host.socket.close()
    const err = await failure(pending)
    expect(err.message).toMatch(/断开/)
  }
})

test('断线时在途调用按已派发结束，不记为未执行', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  await host.next()
  host.socket.close()
  const err = await failure(pending)
  // 帧已写出，宿主是否收到无法确定，因此必须记为 unknown。
  expect(err.dispatch).toBe('unknown')
  await settle()
  expect(handle.desktop?.available()).toBe(false)
})

test('同一条 WS 上更换执行实例：旧的待决调用结束，能力按新代际重建', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  const stale = await host.next()
  // 更换 worker：hostId 与连接不变，只有执行实例代际递增。
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

test('worker 离线的状态事件撤销能力，并结束在途调用', async () => {
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
    authorized: false,
    missing: [],
  })
  expect((await failure(pending)).dispatch).toBe('unknown')
  await settle()
  expect(handle.desktop?.available()).toBe(false)
})

/**
 * 授权状态在同一个执行实例内变化：worker 启动时未授权，用户在系统设置中开启后由事件推送，
 * 无需重连，也无需更换 worker。只缺少屏幕录制权限时能力照常发布，缺项原样交给界面。
 */
test('授权变化经状态事件更新能力与缺项，不更换执行实例', async () => {
  const handle = fresh()
  const client = new WebSocket(
    `ws://127.0.0.1:${handle.port}/stream?origin=desktop&token=${handle.token}`,
  )
  const frames: { type: string; event?: { type?: string; desktop?: unknown } }[] = []
  client.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)))
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve()
    client.onerror = () => reject(new Error('配对连接应当能建立'))
  })
  cleanups.push(() => client.close())
  client.send(JSON.stringify({ type: 'hello', token: handle.token, origin: 'desktop' }))
  await settle()

  const host = await connect(handle.port)
  host.ready({ authorized: false, missing: ['accessibility', 'screen_recording'] })
  await settle()
  expect(handle.desktop?.available()).toBe(false)

  const event = (authorized: boolean, missing: ('accessibility' | 'screen_recording')[]) =>
    host.send({
      type: 'desktop.event',
      connectionEpoch: 3,
      hostId: 'h1',
      hostEpoch: 2,
      kind: 'worker.state',
      workerReady: true,
      authorized,
      missing,
    })
  event(true, ['screen_recording'])
  await settle()
  expect(handle.desktop?.available()).toBe(true)
  event(true, [])
  await settle()
  const states = frames
    .map((f) => f.event)
    .filter((e) => e?.type === 'desktop.state')
    .map((e) => e?.desktop)
  expect(states).toEqual([
    {
      connected: true,
      workerReady: true,
      authorized: false,
      missing: ['accessibility', 'screen_recording'],
    },
    { connected: true, workerReady: true, authorized: true, missing: ['screen_recording'] },
    { connected: true, workerReady: true, authorized: true, missing: [] },
  ])
})

test('代际不一致的状态事件不得改变能力', async () => {
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
    missing: [],
  })
  await settle()
  expect(handle.desktop?.available()).toBe(true)
})

test('窗口消失后旧的不透明 id 在本地被拒绝，不发送任何帧', async () => {
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
  expect(err.message).toMatch(/无法识别的窗口/)
  expect(host.received.length).toBe(before)
})

test('释放之后端口失效，并向宿主发送按执行者撤销的请求', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  // 失败处理必须在释放之前注册：`release` 同步结束在途调用，晚于释放注册会产生一次未处理的拒绝。
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
  // 释放是幂等的，重复调用不再发送第二条撤销。
  const count = host.received.filter((f) => f.op === 'cancel').length
  await port?.release()
  await settle()
  expect(host.received.filter((f) => f.op === 'cancel').length).toBe(count)
  expect((await failure(port?.windows())).message).toMatch(/已经结束/)
})

/**
 * 前台开关随每条请求下发。
 *
 * 宿主与 worker 均不缓存它：缓存时，用户在运行中关闭前台接管要等宿主更换代际
 * 才生效，期间的每一次派发仍携带旧值。
 */
test('前台开关在每条请求时实时读取，运行中关闭后下一次派发即生效', async () => {
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
  expect(port?.foregroundEnabled()).toBe(true)
  host.reply(on)
  await first

  cfg.desktopForeground = false
  const second = port?.windows()
  const off = await host.next()
  expect(off.foreground).toBe(false)
  expect(port?.foregroundEnabled()).toBe(false)
  host.reply(off)
  await second
})

/** 未配置时，端口报告与请求帧均启用前台操作。 */
test('未配置前台开关时默认启用', async () => {
  const handle = fresh()
  const host = await connect(handle.port)
  host.ready()
  await settle()
  const port = handle.desktop?.portFor('cv_a')
  const pending = port?.windows()
  const frame = await host.next()
  expect(frame.foreground).toBe(true)
  expect(port?.foregroundEnabled()).toBe(true)
  host.reply(frame)
  await pending
})

/**
 * 运行态读数区分后台与前台。
 *
 * 只进不退：一次前台点击之后焦点已位于目标应用，之后的后台读取无法改变这一事实；
 * 执行者释放时与应用名一起清除。
 */
test('前台接管之后运行态读数如实反映，释放时清除', async () => {
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

  // 后台观察：目标已登记，但尚未前台接管。
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
