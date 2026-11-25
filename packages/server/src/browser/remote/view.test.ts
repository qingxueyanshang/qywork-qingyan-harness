/**
 * 覆盖 `remote/` 下的 `pages.ts`、`view.ts`、`controls.ts`、`uploads.ts` 与 `api/browser.ts`，以及 `server.ts` 中
 * `/browser/view` 的升级与帧分派：
 * 页签清单（`browser.tabs`）只列入页签条的页并随宿主变化；新建、关闭与导航转为宿主操作；查看连接按标记附加到页面，
 * 画面在途不超过 `BROWSER_VIEW_INFLIGHT` 帧，输入转为 `Input.*`；页面关闭时通知客户端并关闭连接。
 *
 * 宿主与调试端点都是真实的 WebSocket 连接上的假实现：升级判定与帧分派位于 `server.ts` 的 fetch 中。
 */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BROWSER_VIEW_PATH,
  type BrowserRequestFrame,
  type BrowserTabView,
  type HostReadyFrame,
  NATIVE_BROWSER_PATH,
  NATIVE_HOST_KEY_HEADER,
  type NativeBrowserUpFrame,
} from '@qywork/core'
import { until } from '@qywork/core/until.test-helper'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store, upsertWorkspace } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import { serve } from '../../server.ts'
import { uploadName } from './uploads.ts'

const HOST_KEY = 'remote-view-host-key'
const MARKER = 'mk_view'

const config: QyConfig = {
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
}

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-remote-view-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  const ws = upsertWorkspace(store, dir, 'W')
  const handle = serve({
    store,
    config,
    content,
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
    hostKey: HOST_KEY,
  })
  cleanups.push(async () => {
    await handle.stop()
    content.close()
    store.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return { handle, workspaceId: ws.id }
}

interface Command {
  id: number
  method: string
  sessionId?: string
  params?: Record<string, unknown>
}

/** 假调试端点：一个页面目标，标记为 `MARKER`。`replies` 按方法给出其余命令的结果。 */
class FakeDevtools {
  server: Bun.Server<undefined>
  received: Command[] = []
  socket: ServerWebSocket<undefined> | null = null
  replies = new Map<string, (cmd: Command) => Record<string, unknown>>()

  constructor() {
    const self = this
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/json/version') {
          return Response.json({
            webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/x`,
          })
        }
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) {
          self.socket = ws
        },
        message(ws, raw) {
          const cmd = JSON.parse(String(raw)) as Command
          self.received.push(cmd)
          const custom = self.replies.get(cmd.method)?.(cmd)
          const result = custom
            ? custom
            : cmd.method === 'Target.getTargets'
              ? { targetInfos: [{ targetId: 'tg_1', type: 'page' }] }
              : cmd.method === 'Target.attachToTarget'
                ? { sessionId: 'ss_1' }
                : cmd.method === 'Runtime.evaluate'
                  ? { result: { value: MARKER } }
                  : {}
          ws.send(JSON.stringify({ id: cmd.id, result }))
        },
      },
    })
    cleanups.push(() => this.server.stop(true))
  }

  get port(): number {
    return this.server.port ?? 0
  }

  frame(id: number, bytes: number[]): void {
    this.socket?.send(
      JSON.stringify({
        method: 'Page.screencastFrame',
        sessionId: 'ss_1',
        params: {
          data: Buffer.from(bytes).toString('base64'),
          sessionId: id,
          metadata: { deviceWidth: 800, deviceHeight: 600 },
        },
      }),
    )
  }

  sent(method: string): Command[] {
    return this.received.filter((c) => c.method === method)
  }

  event(method: string, params: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify({ method, sessionId: 'ss_1', params }))
  }
}

/** 假宿主：样例快照改为一个可见页与一个隐藏页，调试端口指向 `devtools`。 */
async function host(port: number, devtools: FakeDevtools, workspaceId: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${NATIVE_BROWSER_PATH}`, {
    headers: { [NATIVE_HOST_KEY_HEADER]: HOST_KEY },
  })
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('宿主连接失败'))
  })
  cleanups.push(() => socket.close())
  const requests: BrowserRequestFrame[] = []
  socket.onmessage = (ev) => {
    const frame = JSON.parse(String(ev.data)) as BrowserRequestFrame
    requests.push(frame)
    const reply: NativeBrowserUpFrame = {
      type: 'browser.result',
      requestId: frame.requestId,
      connectionEpoch: frame.connectionEpoch,
      ok: frame.url !== 'bad address',
      ...(frame.url === 'bad address' ? { error: '地址无法解析' } : {}),
      data: { tabId: 'bt_new', url: frame.url ?? '', title: '' },
    }
    socket.send(JSON.stringify(reply))
  }
  const samples = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        '..',
        '..',
        '..',
        '..',
        'core',
        'src',
        'protocol',
        'native-browser.samples.json',
      ),
      'utf8',
    ),
  ) as { hostReady: HostReadyFrame }
  const send = (frame: NativeBrowserUpFrame) => socket.send(JSON.stringify(frame))
  send({
    ...samples.hostReady,
    debugPort: devtools.port,
    tabs: [
      {
        tabId: 'bt_1',
        url: 'http://a.test/',
        title: 'A',
        marker: MARKER,
        workspaceId,
        conversationId: null,
        hidden: false,
      },
      {
        tabId: 'bt_2',
        url: 'file:///x.html',
        title: '',
        marker: 'mk_2',
        workspaceId,
        conversationId: null,
        hidden: true,
      },
    ],
  })
  return { socket, requests, send, epoch: samples.hostReady.connectionEpoch }
}

function tabsSeen(handle: ReturnType<typeof serve>): BrowserTabView[][] {
  const seen: BrowserTabView[][] = []
  cleanups.push(
    handle.bus.subscribe({
      id: `probe_${crypto.randomUUID()}`,
      origin: 'desktop',
      conversations: null,
      send: (frame) => {
        if (frame.event.type === 'browser.tabs') seen.push(frame.event.tabs)
      },
    }),
  )
  return seen
}

async function view(port: number, token: string, tabId = 'bt_1') {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}${BROWSER_VIEW_PATH}?tabId=${tabId}&token=${token}`,
  )
  socket.binaryType = 'arraybuffer'
  const messages: (string | ArrayBuffer)[] = []
  let closed = false
  socket.onmessage = (e) => messages.push(e.data as string | ArrayBuffer)
  socket.onclose = () => {
    closed = true
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('查看连接失败'))
  })
  cleanups.push(() => socket.close())
  return { socket, messages, closed: () => closed }
}

test('页签清单只列入页签条的页，随页面新建、关闭与宿主断开变化', async () => {
  const { handle, workspaceId } = fresh()
  const seen = tabsSeen(handle)
  const devtools = new FakeDevtools()
  const h = await host(handle.port, devtools, workspaceId)
  await until(() => seen.at(-1)?.length === 1, '宿主连接后的清单')
  expect(seen.at(-1)).toEqual([{ tabId: 'bt_1', url: 'http://a.test/', title: 'A', workspaceId }])

  h.send({
    type: 'browser.event',
    connectionEpoch: h.epoch,
    seq: 1,
    kind: 'opened',
    tabId: 'bt_3',
    url: 'http://c.test/',
    title: 'C',
    marker: 'mk_3',
    workspaceId,
    conversationId: null,
    hidden: false,
  })
  await until(() => seen.at(-1)?.length === 2, '新页进入清单')
  h.send({ type: 'browser.event', connectionEpoch: h.epoch, seq: 2, kind: 'closed', tabId: 'bt_1' })
  await until(
    () => seen.at(-1)?.length === 1 && seen.at(-1)?.[0]?.tabId === 'bt_3',
    '关闭的页移出清单',
  )

  h.socket.close()
  await until(() => seen.at(-1)?.length === 0, '宿主断开后清单为空')
})

test('新建、导航与关闭转为宿主操作；宿主拒绝的地址以宿主的说明返回', async () => {
  const { handle, workspaceId } = fresh()
  const devtools = new FakeDevtools()
  const h = await host(handle.port, devtools, workspaceId)
  await until(() => handle.browser?.available() === true, '宿主完成注册')
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${handle.token}` },
    })

  const created = await api(`/api/browser/pages?ws=${workspaceId}`, {
    method: 'POST',
    body: JSON.stringify({ url: 'file:///C:/w/a.html', hidden: true }),
  })
  expect(await created.json()).toMatchObject({ tabId: 'bt_new', workspaceId })
  expect(h.requests.at(-1)).toMatchObject({
    op: 'create',
    workspaceId,
    url: 'file:///C:/w/a.html',
    hidden: true,
  })

  const nav = await api('/api/browser/pages/navigate', {
    method: 'POST',
    body: JSON.stringify({ tabId: 'bt_1', action: 'goto', url: 'example.com' }),
  })
  expect(nav.status).toBe(200)
  expect(h.requests.at(-1)).toMatchObject({
    op: 'navigate',
    tabId: 'bt_1',
    action: 'goto',
    url: 'example.com',
  })

  const bad = await api('/api/browser/pages/navigate', {
    method: 'POST',
    body: JSON.stringify({ tabId: 'bt_1', action: 'goto', url: 'bad address' }),
  })
  expect(bad.status).toBe(400)
  expect(await bad.json()).toMatchObject({ message: '地址无法解析' })

  const closed = await api('/api/browser/pages?tabId=bt_1', { method: 'DELETE' })
  expect(closed.status).toBe(200)
  expect(h.requests.at(-1)).toMatchObject({ op: 'close', tabId: 'bt_1' })
})

test('查看连接校验令牌与页面', async () => {
  const { handle, workspaceId } = fresh()
  const devtools = new FakeDevtools()
  await host(handle.port, devtools, workspaceId)
  await until(() => handle.browser?.available() === true, '宿主完成注册')
  const upgrade = (query: string) =>
    fetch(`http://127.0.0.1:${handle.port}${BROWSER_VIEW_PATH}?${query}`, {
      headers: { upgrade: 'websocket' },
    })
  expect((await upgrade(`tabId=bt_1&token=${'0'.repeat(handle.token.length)}`)).status).toBe(401)
  expect((await upgrade(`tabId=bt_9&token=${handle.token}`)).status).toBe(404)
})

/**
 * 原始失败形状：桌面外壳以外的客户端无法查看内置浏览器的页面（页面在电脑上，画面与输入只经外壳）。
 * 画面在途不超过 2 帧：第 3 帧在客户端确认之前不确认浏览器，浏览器随之停止产生新帧，画面不在线路上排队。
 */
test('查看连接按标记附加，画面在途不超过上限，输入转为 Input 命令', async () => {
  const { handle, workspaceId } = fresh()
  const devtools = new FakeDevtools()
  await host(handle.port, devtools, workspaceId)
  await until(() => handle.browser?.available() === true, '宿主完成注册')
  const v = await view(handle.port, handle.token)
  await until(() => devtools.sent('Page.enable').length === 1, '附加到页面')
  // 收到显示区域之前不推送画面：此前的画面是电脑上的尺寸。
  expect(devtools.sent('Page.startScreencast')).toEqual([])
  // 页面视口按客户端的显示区域设定；像素比不超过 2，画面上限为视口乘像素比。
  v.socket.send(JSON.stringify({ type: 'size', width: 390, height: 700, scale: 2.6 }))
  await until(() => devtools.sent('Page.startScreencast').length === 1, '按显示区域推送画面')
  expect(devtools.sent('Emulation.setDeviceMetricsOverride')[0]?.params).toEqual({
    width: 390,
    height: 700,
    deviceScaleFactor: 2,
    mobile: false,
  })
  expect(devtools.sent('Page.startScreencast')[0]?.params).toMatchObject({
    maxWidth: 780,
    maxHeight: 1400,
  })
  // 不初始化受控页会话：不拦截 file 请求、不启用观察所需的域。
  expect(devtools.sent('Fetch.enable')).toEqual([])
  expect(devtools.sent('Accessibility.enable')).toEqual([])

  devtools.frame(1, [0xff, 0xd8, 1])
  devtools.frame(2, [0xff, 0xd8, 2])
  await until(() => v.messages.length === 2, '客户端收到两帧')
  const first = new Uint8Array(v.messages[0] as ArrayBuffer)
  const head = new DataView(first.buffer).getUint32(0)
  expect(JSON.parse(new TextDecoder().decode(first.subarray(4, 4 + head)))).toEqual({
    width: 800,
    height: 600,
  })
  expect([...first.subarray(4 + head)]).toEqual([0xff, 0xd8, 1])
  // 第 1 帧发出时在途 1 帧，立即确认；第 2 帧发出时在途 2 帧，等待客户端确认。
  await until(() => devtools.sent('Page.screencastFrameAck').length === 1, '第 1 帧立即确认')
  expect(devtools.sent('Page.screencastFrameAck')[0]?.params).toEqual({ sessionId: 1 })
  v.socket.send(JSON.stringify({ type: 'ack' }))
  await until(
    () => devtools.sent('Page.screencastFrameAck').length === 2,
    '客户端确认后确认第 2 帧',
  )
  expect(devtools.sent('Page.screencastFrameAck')[1]?.params).toEqual({ sessionId: 2 })

  // 主框架导航后重新设定视口并重新开始推送；子框架导航不重新设定。
  devtools.socket?.send(
    JSON.stringify({
      method: 'Page.frameNavigated',
      sessionId: 'ss_1',
      params: { frame: { id: 'f2', parentId: 'f1' } },
    }),
  )
  devtools.socket?.send(
    JSON.stringify({
      method: 'Page.frameNavigated',
      sessionId: 'ss_1',
      params: { frame: { id: 'f1' } },
    }),
  )
  await until(() => devtools.sent('Page.startScreencast').length === 2, '导航后重新推送画面')
  expect(devtools.sent('Emulation.setDeviceMetricsOverride')).toHaveLength(2)
  // 所在的页未显示（尺寸为 0）时停止推送，再次显示时恢复。
  const stops = devtools.sent('Page.stopScreencast').length
  v.socket.send(JSON.stringify({ type: 'size', width: 0, height: 0, scale: 2.6 }))
  await until(() => devtools.sent('Page.stopScreencast').length === stops + 1, '隐藏时停止推送')
  v.socket.send(JSON.stringify({ type: 'size', width: 390, height: 700, scale: 2.6 }))
  await until(() => devtools.sent('Page.startScreencast').length === 3, '再次显示时恢复推送')

  v.socket.send(
    JSON.stringify({ type: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 }),
  )
  v.socket.send(JSON.stringify({ type: 'mouse', action: 'move', x: 30, y: 40, button: 'none' }))
  v.socket.send(
    JSON.stringify({ type: 'mouse', action: 'up', x: 30, y: 40, button: 'left', clickCount: 1 }),
  )
  v.socket.send(JSON.stringify({ type: 'key', code: 'Enter', held: [] }))
  v.socket.send(JSON.stringify({ type: 'text', text: '你好' }))
  await until(() => devtools.sent('Input.insertText').length === 1, '输入转为命令')
  expect(devtools.sent('Input.dispatchMouseEvent').map((c) => c.params)).toEqual([
    { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseMoved', x: 30, y: 40, button: 'none', buttons: 1, clickCount: 0 },
    { type: 'mouseReleased', x: 30, y: 40, button: 'left', buttons: 0, clickCount: 1 },
  ])
  expect(devtools.sent('Input.dispatchKeyEvent').map((c) => c.params?.type)).toEqual([
    'keyDown',
    'keyUp',
  ])
  expect(devtools.sent('Input.dispatchKeyEvent')[0]?.params).toMatchObject({
    code: 'Enter',
    text: '\r',
  })
  expect(devtools.sent('Input.insertText')[0]?.params).toEqual({ text: '你好' })
  expect(devtools.sent('Input.dispatchMouseEvent').every((c) => c.sessionId === 'ss_1')).toBe(true)
})

test('页面关闭时通知客户端并关闭查看连接', async () => {
  const { handle, workspaceId } = fresh()
  const devtools = new FakeDevtools()
  const h = await host(handle.port, devtools, workspaceId)
  await until(() => handle.browser?.available() === true, '宿主完成注册')
  const v = await view(handle.port, handle.token)
  v.socket.send(JSON.stringify({ type: 'size', width: 390, height: 700, scale: 1 }))
  await until(() => devtools.sent('Page.startScreencast').length === 1, '开始推送画面')
  h.send({ type: 'browser.event', connectionEpoch: h.epoch, seq: 5, kind: 'closed', tabId: 'bt_1' })
  await until(() => v.closed(), '查看连接关闭')
  expect(v.messages).toContainEqual(JSON.stringify({ type: 'closed' }))
  // 页面恢复原尺寸。
  await until(
    () => devtools.sent('Emulation.clearDeviceMetricsOverride').length === 1,
    '清除视口设定',
  )
})

/** 查看连接已附加并开始推送画面。 */
async function attached() {
  const { handle, workspaceId } = fresh()
  const devtools = new FakeDevtools()
  const h = await host(handle.port, devtools, workspaceId)
  await until(() => handle.browser?.available() === true, '宿主完成注册')
  const v = await view(handle.port, handle.token)
  v.socket.send(JSON.stringify({ type: 'size', width: 390, height: 700, scale: 1 }))
  await until(() => devtools.sent('Page.startScreencast').length === 1, '开始推送画面')
  const notices = () =>
    v.messages
      .filter((m): m is string => typeof m === 'string')
      .map((m) => JSON.parse(m) as Record<string, unknown> & { type: string })
  return { handle, devtools, h, v, notices }
}

/**
 * 原始失败形状：下拉框的弹出层不在画面中，远程查看时点击下拉框不显示选项。
 * 按下落在下拉框上时不交给网页（弹出层不打开），客户端得到选项；回答写入该元素。
 */
test('按下落在下拉框上时由客户端显示选项，选择结果写入该元素', async () => {
  const { devtools, v, notices } = await attached()
  devtools.replies.set('Runtime.evaluate', (cmd) =>
    String(cmd.params?.expression).includes('elementFromPoint')
      ? { result: { type: 'object', objectId: 'obj_select' } }
      : { result: { value: MARKER } },
  )
  devtools.replies.set('Runtime.callFunctionOn', (cmd) =>
    String(cmd.params?.functionDeclaration).includes('getBoundingClientRect')
      ? {
          result: {
            value: {
              type: 'select',
              rect: { x: 10, y: 20, width: 100, height: 30 },
              value: '0',
              options: [
                { label: '苹果', value: '0', disabled: false, group: '' },
                { label: '香蕉', value: '1', disabled: false, group: '' },
              ],
            },
          },
        }
      : { result: {} },
  )
  v.socket.send(JSON.stringify({ type: 'mouse', action: 'move', x: 50, y: 30, button: 'none' }))
  v.socket.send(
    JSON.stringify({ type: 'mouse', action: 'down', x: 50, y: 30, button: 'left', clickCount: 1 }),
  )
  v.socket.send(
    JSON.stringify({ type: 'mouse', action: 'up', x: 50, y: 30, button: 'left', clickCount: 1 }),
  )
  await until(() => notices().some((n) => n.type === 'select'), '客户端收到下拉框')
  expect(notices().find((n) => n.type === 'select')).toMatchObject({
    id: 1,
    value: '0',
    rect: { x: 10, y: 20, width: 100, height: 30 },
    options: [{ label: '苹果' }, { label: '香蕉' }],
  })
  // 只有移动交给网页，按下与抬起都不交给网页。
  await until(() => devtools.sent('Input.dispatchMouseEvent').length === 1, '移动交给网页')
  expect(devtools.sent('Input.dispatchMouseEvent')[0]?.params?.type).toBe('mouseMoved')

  v.socket.send(JSON.stringify({ type: 'answer', id: 1, value: '1' }))
  await until(() => devtools.sent('Runtime.releaseObject').length === 1, '回答后释放元素')
  const apply = devtools
    .sent('Runtime.callFunctionOn')
    .find((c) => String(c.params?.functionDeclaration).includes('dispatchEvent'))
  expect(apply?.params).toMatchObject({
    objectId: 'obj_select',
    arguments: [{ value: '1' }],
    userGesture: true,
  })
  // 之后不在控件上的点击照常交给网页。
  devtools.replies.delete('Runtime.evaluate')
  v.socket.send(
    JSON.stringify({ type: 'mouse', action: 'down', x: 5, y: 5, button: 'left', clickCount: 1 }),
  )
  await until(() => devtools.sent('Input.dispatchMouseEvent').length === 2, '普通点击交给网页')
  expect(devtools.sent('Input.dispatchMouseEvent')[1]?.params?.type).toBe('mousePressed')
})

test('网页对话框交给客户端，回答经 Page.handleJavaScriptDialog 写回；电脑上处理后客户端收起', async () => {
  const { devtools, v, notices } = await attached()
  devtools.event('Page.javascriptDialogOpening', {
    type: 'prompt',
    message: '名字？',
    defaultPrompt: '张三',
  })
  await until(() => notices().some((n) => n.type === 'dialog'), '客户端收到对话框')
  expect(notices().find((n) => n.type === 'dialog')).toEqual({
    type: 'dialog',
    kind: 'prompt',
    message: '名字？',
    defaultPrompt: '张三',
  })
  v.socket.send(JSON.stringify({ type: 'dialog', accept: true, text: '李四' }))
  await until(() => devtools.sent('Page.handleJavaScriptDialog').length === 1, '写回对话框')
  expect(devtools.sent('Page.handleJavaScriptDialog')[0]?.params).toEqual({
    accept: true,
    promptText: '李四',
  })
  devtools.event('Page.javascriptDialogClosed', { result: true })
  await until(() => notices().some((n) => n.type === 'dismiss'), '客户端收起')
})

/**
 * 原始失败形状：网页的上传按钮在电脑上打开系统的文件对话框，远程查看时无法选择文件。
 * 查看期间拦截文件选择；客户端上传的文件按编号交给该输入框，文件名只保留最后一段，页面关闭时删除。
 */
test('文件选择交给客户端，上传的文件交给网页的输入框，页面关闭时删除', async () => {
  const { handle, devtools, h, v, notices } = await attached()
  expect(devtools.sent('Page.setInterceptFileChooserDialog')[0]?.params).toEqual({ enabled: true })
  devtools.replies.set('DOM.resolveNode', () => ({ object: { objectId: 'node_7' } }))
  devtools.replies.set('Runtime.callFunctionOn', () => ({ result: { value: 'image/*' } }))
  devtools.event('Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectSingle' })
  await until(() => notices().some((n) => n.type === 'files'), '客户端收到文件选择')
  const prompt = notices().find((n) => n.type === 'files')
  expect(prompt).toMatchObject({ multiple: false, accept: 'image/*' })

  const upload = (tabId: string) =>
    fetch(
      `http://127.0.0.1:${handle.port}/api/browser/uploads?tabId=${tabId}&name=${encodeURIComponent('../a<1>.png')}`,
      { method: 'POST', headers: { authorization: `Bearer ${handle.token}` }, body: 'hello' },
    )
  expect((await upload('bt_9')).status).toBe(400)
  const { upload: id } = (await (await upload('bt_1')).json()) as { upload: string }
  v.socket.send(JSON.stringify({ type: 'files', id: prompt?.id, uploads: [id, 'not-an-id'] }))
  await until(() => devtools.sent('DOM.setFileInputFiles').length === 1, '交给输入框')
  const set = devtools.sent('DOM.setFileInputFiles')[0]?.params as {
    files: string[]
    backendNodeId: number
  }
  expect(set.backendNodeId).toBe(7)
  expect(set.files).toHaveLength(1)
  const file = set.files[0] ?? ''
  expect(file.endsWith(join('uploads', 'bt_1', id, 'a1.png'))).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('hello')

  h.send({ type: 'browser.event', connectionEpoch: h.epoch, seq: 9, kind: 'closed', tabId: 'bt_1' })
  await until(() => !existsSync(file), '页面关闭后删除上传的文件')
})

/**
 * 原始失败形状：独立窗口中的后台标签页没有 screencast 画面（实测 0 帧），手机查看该页时画面停止。
 * 浏览器报告不可见后改用截图取帧，在途帧数同样不超过上限；报告可见后停止截图。
 */
test('页面不可见时以截图取帧，在途不超过上限，可见后停止截图', async () => {
  const { devtools, v } = await attached()
  let shot = 0
  devtools.replies.set('Page.captureScreenshot', () => {
    shot += 1
    return { data: Buffer.from([0xff, 0xd8, shot]).toString('base64') }
  })
  devtools.event('Page.screencastVisibilityChanged', { visible: false })
  await until(() => v.messages.length === 2, '截图得到两帧')
  const first = new Uint8Array(v.messages[0] as ArrayBuffer)
  const head = new DataView(first.buffer).getUint32(0)
  expect(JSON.parse(new TextDecoder().decode(first.subarray(4, 4 + head)))).toEqual({
    width: 390,
    height: 700,
  })
  // 在途 2 帧：客户端确认之前不再截图。
  await Bun.sleep(300)
  expect(devtools.sent('Page.captureScreenshot')).toHaveLength(2)
  v.socket.send(JSON.stringify({ type: 'ack' }))
  await until(() => v.messages.length === 3, '确认后继续截图')

  devtools.event('Page.screencastVisibilityChanged', { visible: true })
  v.socket.send(JSON.stringify({ type: 'ack' }))
  v.socket.send(JSON.stringify({ type: 'ack' }))
  await Bun.sleep(300)
  const shots = devtools.sent('Page.captureScreenshot').length
  await Bun.sleep(300)
  expect(devtools.sent('Page.captureScreenshot')).toHaveLength(shots)
})

test('附加失败时客户端只收到 error，原因不出现在通知中', async () => {
  const { handle, workspaceId } = fresh()
  const devtools = new FakeDevtools()
  devtools.replies.set('Runtime.evaluate', () => ({ result: { value: 'other-marker' } }))
  await host(handle.port, devtools, workspaceId)
  await until(() => handle.browser?.available() === true, '宿主完成注册')
  const v = await view(handle.port, handle.token)
  await until(() => v.closed(), '查看连接关闭')
  expect(v.messages).toEqual([JSON.stringify({ type: 'error' })])
})

test('上传的文件名只保留最后一段并删除不允许的字符', () => {
  expect(uploadName('../../etc/passwd')).toBe('passwd')
  expect(uploadName('C:\\Users\\a\\报告.docx')).toBe('报告.docx')
  expect(uploadName('a<b>:c|d?.txt')).toBe('abcd.txt')
  expect(uploadName('..')).toBe('file')
  expect(uploadName('')).toBe('file')
})
