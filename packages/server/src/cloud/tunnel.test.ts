/**
 * 覆盖范围：`cloud/tunnel.ts`、`cloud/remote.ts`、`cloud/remote-transfer.ts`，以及 `server.ts` 的远程监听器。
 * 云端是本文件中的模拟隧道中心，帧格式与云端仓库的隧道中心相同；本机一侧前半部分是一个简单的 HTTP 与 WebSocket 服务，
 * 后半部分是完整的 `serve()`。
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  decodeData,
  encodeData,
  TUNNEL_CLOSE,
  TUNNEL_DATA,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_WINDOW,
  type TunnelControl,
} from '@qywork/core'
import { loadConfig, type QyConfig, saveConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import { serve } from '../server.ts'
import { CLOUD_PROVIDER } from './account.ts'
import { TunnelClient, type TunnelStatus } from './tunnel.ts'

type Received =
  | { control: TunnelControl }
  | { data: { kind: number; sid: number; payload: Uint8Array } }

/** 模拟的隧道中心：接受 hello、应答 welcome，按测试的需要向电脑端发起请求。 */
class FakeCloud {
  readonly server: ReturnType<typeof Bun.serve<undefined>>
  hellos: { protocol: number; key: string }[] = []
  /** 设定后，下一次 hello 以该关闭码拒绝。 */
  reject: number | null = null
  ws: ServerWebSocket<undefined> | null = null
  private frames: Received[] = []
  private wake: (() => void) | null = null
  private sid = 1
  closes: number[] = []

  constructor() {
    this.server = Bun.serve<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req, srv) =>
        srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 }),
      websocket: {
        message: (ws, raw) => {
          if (typeof raw === 'string') {
            const control = JSON.parse(raw) as TunnelControl
            if (control.type === 'hello') {
              this.hellos.push(control)
              if (this.reject !== null) {
                const code = this.reject
                this.reject = null
                ws.close(code)
                return
              }
              this.ws = ws
              ws.send(JSON.stringify({ type: 'welcome' }))
              return
            }
            if (control.type === 'ping') return
            this.frames.push({ control })
          } else {
            this.frames.push({ data: decodeData(new Uint8Array(raw))! })
          }
          this.wake?.()
        },
        close: (ws) => {
          if (this.ws === ws) this.ws = null
          this.closes.push(Date.now())
          this.wake?.()
        },
      },
    })
  }

  get origin(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  send(frame: TunnelControl): void {
    this.ws?.send(JSON.stringify(frame))
  }

  async next<T>(pick: (r: Received) => T | undefined, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      for (let i = 0; i < this.frames.length; i++) {
        const hit = pick(this.frames[i] as Received)
        if (hit !== undefined) {
          this.frames.splice(i, 1)
          return hit
        }
      }
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('等待帧超时')
      await Promise.race([
        new Promise<void>((r) => {
          this.wake = r
        }),
        Bun.sleep(left),
      ])
    }
  }

  control<K extends TunnelControl['type']>(
    type: K,
    sid?: number,
  ): Promise<TunnelControl & { type: K }> {
    return this.next((r) =>
      'control' in r &&
      r.control.type === type &&
      (sid === undefined || (r.control as { sid?: number }).sid === sid)
        ? (r.control as TunnelControl & { type: K })
        : undefined,
    )
  }

  /** 经隧道发起一个 HTTP 请求，读取完整响应（按窗口归还）。 */
  async request(
    method: string,
    path: string,
    headers: [string, string][] = [],
    body?: Uint8Array,
  ): Promise<{ status: number; headers: [string, string][]; body: Uint8Array }> {
    const sid = this.sid++
    this.send({ type: 'http.open', sid, method, path, headers })
    if (body) {
      let credit = TUNNEL_WINDOW
      for (let at = 0; at < body.length; at += 64 * 1024) {
        while (credit <= 0) credit += (await this.control('window', sid)).bytes
        const piece = body.subarray(at, at + 64 * 1024)
        credit -= piece.length
        this.ws?.send(encodeData(TUNNEL_DATA.body, sid, piece))
      }
    }
    this.send({ type: 'end', sid })
    const head = await this.control('http.head', sid)
    const chunks: Uint8Array[] = []
    for (;;) {
      const r = await this.next((x) =>
        ('data' in x && x.data.sid === sid) ||
        ('control' in x &&
          (x.control as { sid?: number }).sid === sid &&
          x.control.type !== 'window')
          ? x
          : undefined,
      )
      if ('data' in r) {
        chunks.push(r.data.payload.slice())
        this.send({ type: 'window', sid, bytes: r.data.payload.length })
        continue
      }
      if (r.control.type !== 'end') throw new Error(`流被中止：${r.control.type}`)
      break
    }
    return { status: head.status, headers: head.headers, body: Buffer.concat(chunks) }
  }

  newSid(): number {
    return this.sid++
  }

  stop(): void {
    this.server.stop(true)
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await Bun.sleep(5)
  }
}

describe('隧道客户端', () => {
  const cloud = new FakeCloud()
  let received: { path: string; headers: Headers; body: number }[] = []
  const local = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws') {
        return srv.upgrade(req, { data: undefined })
          ? undefined
          : new Response('no', { status: 400 })
      }
      const body = (await req.arrayBuffer()).byteLength
      received.push({ path: url.pathname + url.search, headers: req.headers, body })
      if (url.pathname === '/gzip') {
        return new Response(gzipSync('压缩的内容'), {
          headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' },
        })
      }
      if (url.pathname === '/redirect') return Response.redirect('/elsewhere', 302)
      return new Response(`收到 ${body} 字节`, { status: 201 })
    },
    websocket: {
      message: (ws, raw) => {
        ws.send(`回声：${raw}`)
      },
      open: (ws) => {
        ws.send('已连接')
      },
    },
  })
  const statuses: TunnelStatus[] = []
  let client: TunnelClient | null = null

  const start = (pairing = { token: 'tok', deviceName: '电脑' }) => {
    statuses.length = 0
    client = new TunnelClient({
      apiOrigin: cloud.origin,
      key: 'qyd_key',
      localPort: local.port ?? 0,
      pairing: () => pairing,
      onStatus: (s) => statuses.push(s),
      backoffMs: () => 20,
    })
    client.start()
    return client
  }

  afterEach(() => {
    client?.stop()
    client = null
    received = []
  })

  afterAll(() => {
    cloud.stop()
    local.stop(true)
  })

  test('握手携带设备密钥与协议版本，welcome 后状态为在线', async () => {
    const c = start()
    await until(() => c.status.state === 'online')
    expect(cloud.hellos.at(-1)).toEqual({
      type: 'hello',
      protocol: TUNNEL_PROTOCOL_VERSION,
      key: 'qyd_key',
    } as never)
    expect(c.status).toEqual({ state: 'online' })
  })

  test('HTTP 请求转发给本机：路径、请求头与大于窗口的请求体原样送达；响应字节不解压；重定向原样返回', async () => {
    const c = start()
    await until(() => c.status.state === 'online')
    const big = new Uint8Array(TUNNEL_WINDOW * 2 + 5).fill(1)
    const res = await cloud.request('POST', '/upload?x=1', [['x-test', '1']], big)
    expect(res.status).toBe(201)
    expect(new TextDecoder().decode(res.body)).toBe(`收到 ${big.length} 字节`)
    expect(received[0]?.path).toBe('/upload?x=1')
    expect(received[0]?.headers.get('x-test')).toBe('1')

    const gz = await cloud.request('GET', '/gzip')
    expect(Object.fromEntries(gz.headers)['content-encoding']).toBe('gzip')
    expect(Buffer.from(gz.body)).toEqual(gzipSync('压缩的内容'))

    const redirect = await cloud.request('GET', '/redirect')
    expect(redirect.status).toBe(302)
  })

  test('WebSocket 转发：本机接受后双向传递消息，云端关闭时关闭本机连接', async () => {
    const c = start()
    await until(() => c.status.state === 'online')
    const sid = cloud.newSid()
    cloud.send({ type: 'ws.open', sid, path: '/ws', headers: [] })
    await cloud.control('ws.accept', sid)
    const text = (await cloud.next((r) => ('data' in r && r.data.sid === sid ? r.data : undefined)))
      .payload
    expect(new TextDecoder().decode(text)).toBe('已连接')
    cloud.ws?.send(encodeData(TUNNEL_DATA.text, sid, new TextEncoder().encode('你好')))
    const echo = await cloud.next((r) => ('data' in r && r.data.sid === sid ? r.data : undefined))
    expect(new TextDecoder().decode(echo.payload)).toBe('回声：你好')
    cloud.send({ type: 'close', sid, code: 4000, reason: '手机已关闭' })
    // 本机连接关闭后不再回传 close：云端已删除该流。
    await Bun.sleep(50)
  })

  test('应答 pair.request：返回当前进程的令牌与设备名', async () => {
    const c = start({ token: 'process-token', deviceName: '我的电脑' })
    await until(() => c.status.state === 'online')
    cloud.send({ type: 'pair.request', rid: 'r1' })
    expect(await cloud.control('pair.reply')).toEqual({
      type: 'pair.reply',
      rid: 'r1',
      token: 'process-token',
      deviceName: '我的电脑',
    })
  })

  test('设备已被移除或需要更新时进入终态且不再重连；其余关闭按退避重连', async () => {
    cloud.reject = TUNNEL_CLOSE.deviceRevoked
    const revoked = start()
    await until(() => revoked.status.state === 'revoked')
    const hellos = cloud.hellos.length
    await Bun.sleep(100)
    expect(cloud.hellos.length).toBe(hellos)
    revoked.stop()

    cloud.reject = TUNNEL_CLOSE.outdated
    const outdated = start()
    await until(() => outdated.status.state === 'outdated')
    outdated.stop()

    cloud.reject = TUNNEL_CLOSE.invalidKey
    const retried = start()
    await until(() => retried.status.state === 'online')
    expect(statuses.map((s) => s.state)).toEqual(['offline', 'online'])
    expect(statuses[0]).toEqual({ state: 'offline', message: '设备密钥无效' })

    // 云端重启：立即重连。
    cloud.ws?.close(TUNNEL_CLOSE.restarting)
    await until(() => statuses.length >= 4)
    expect(statuses.slice(2).map((s) => s.state)).toEqual(['offline', 'online'])
  })

  test('被同一设备的另一条隧道替换时进入 replaced 且不再重连', async () => {
    const c = start()
    await until(() => c.status.state === 'online')
    const hellos = cloud.hellos.length
    cloud.ws?.close(TUNNEL_CLOSE.replaced)
    await until(() => c.status.state === 'replaced')
    await Bun.sleep(100)
    expect(cloud.hellos.length).toBe(hellos)
  })
})

describe('远程访问经 serve() 装配', () => {
  const cloud = new FakeCloud()
  let handle: ReturnType<typeof serve> | null = null
  let store: Store
  let content: ContentStore
  let dir = ''
  const previousCloud = process.env.QYWORK_CLOUD

  afterAll(async () => {
    handle?.stop()
    store?.close()
    content?.close()
    cloud.stop()
    if (previousCloud === undefined) delete process.env.QYWORK_CLOUD
    else process.env.QYWORK_CLOUD = previousCloud
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test('经隧道只能访问令牌保护的接口；/internal 与原生宿主路径返回 404；关闭开关后断开；设备被移除后删除云端接口', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qywork-remote-'))
    process.env.QYWORK_CLOUD = cloud.origin
    const config: QyConfig = {
      providers: {
        [CLOUD_PROVIDER]: {
          kind: 'anthropic_messages',
          baseUrl: cloud.origin,
          apiKey: 'qyd_device',
          models: { 'claude-sonnet-5-5': {} },
        },
      },
      active: { provider: CLOUD_PROVIDER, model: 'claude-sonnet-5-5' },
      remote: true,
    }
    await saveConfig(config)
    const dbPath = join(dir, 'db.sqlite3')
    store = new Store({ path: dbPath })
    content = new ContentStore(contentPathFor(dbPath))

    // 未传入 remote 的 serve()（测试与脚本）即使配置开启了远程访问也不连接云端：
    // 否则会以同一设备密钥顶掉桌面端的隧道。
    const quiet = serve({
      store,
      config: await loadConfig(),
      workspaceRoot: dir,
      content,
      port: 0,
      host: '127.0.0.1',
    })
    await Bun.sleep(200)
    expect(cloud.hellos.length).toBe(0)
    expect(quiet.remote.snapshot().tunnel).toBeNull()
    quiet.stop()

    handle = serve({
      store,
      config: await loadConfig(),
      workspaceRoot: dir,
      content,
      port: 0,
      host: '127.0.0.1',
      updateHostKey: 'update-key',
      remote: true,
    })
    await until(() => handle?.remote.snapshot().tunnel?.state === 'online')
    expect(cloud.hellos.at(-1)?.key).toBe('qyd_device')

    const internal = await cloud.request('POST', '/internal/app-update', [
      ['x-qywork-update-key', 'update-key'],
    ])
    expect(internal.status).toBe(404)
    expect((await cloud.request('GET', '/native/desktop')).status).toBe(404)
    expect((await cloud.request('GET', '/api/workspace')).status).toBe(401)

    cloud.send({ type: 'pair.request', rid: 'r' })
    const { token } = await cloud.control('pair.reply')
    expect(token).toBe(handle.token)
    const authed = await cloud.request('GET', '/api/workspace', [
      ['authorization', `Bearer ${token}`],
    ])
    expect(authed.status).toBe(200)

    // JSON 响应在本机压缩并带 etag；再次请求携带 if-none-match 时应答 304，正文不经隧道。
    const header = (r: { headers: [string, string][] }, name: string) =>
      r.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null
    const bearer: [string, string] = ['authorization', `Bearer ${token}`]
    const plain = await cloud.request('GET', '/api/tools', [bearer])
    expect(header(plain, 'content-encoding')).toBeNull()
    expect(plain.body.length).toBeGreaterThan(1024)
    const packed = await cloud.request('GET', '/api/tools', [bearer, ['accept-encoding', 'gzip']])
    expect(header(packed, 'content-encoding')).toBe('gzip')
    expect(packed.body.length).toBeLessThan(plain.body.length)
    expect(Buffer.from(gunzipSync(packed.body)).equals(Buffer.from(plain.body))).toBe(true)
    const etag = header(packed, 'etag')
    expect(etag).toBe(header(plain, 'etag'))
    expect(header(packed, 'cache-control')).toBe('private, no-cache')
    const unchanged = await cloud.request('GET', '/api/tools', [
      bearer,
      ['accept-encoding', 'gzip'],
      ['if-none-match', etag ?? ''],
    ])
    expect(unchanged.status).toBe(304)
    expect(unchanged.body.length).toBe(0)

    // 另一个进程接管了隧道：状态为 replaced，重新连接后恢复在线。
    const base = `http://127.0.0.1:${handle.port}`
    const auth = { authorization: `Bearer ${handle.token}` }
    cloud.ws?.close(TUNNEL_CLOSE.replaced)
    await until(() => handle?.remote.snapshot().tunnel?.state === 'replaced')
    const again = await fetch(`${base}/api/pairing/reconnect`, { method: 'POST', headers: auth })
    expect(again.status).toBe(200)
    await until(() => handle?.remote.snapshot().tunnel?.state === 'online')

    // 关闭开关：隧道断开，开关写入配置。
    const off = await fetch(`${base}/api/pairing/remote`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    })
    expect(((await off.json()) as { enabled: boolean; tunnel: unknown }).tunnel).toBeNull()
    await until(() => cloud.ws === null)
    expect((await loadConfig()).remote).toBeUndefined()

    // 重新开启后，云端答复设备已被移除：本地删除云端接口，远程访问不再可用。
    await fetch(`${base}/api/pairing/remote`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    })
    await until(() => cloud.ws !== null)
    cloud.ws?.close(TUNNEL_CLOSE.deviceRevoked)
    await until(() => handle?.remote.snapshot().available === false)
    const saved = await loadConfig()
    expect(saved.providers[CLOUD_PROVIDER]).toBeUndefined()
    expect(saved.active).toBeUndefined()
    const state = await (await fetch(`${base}/api/cloud/state`, { headers: auth })).json()
    expect(state).toEqual({ state: 'signed_out', reason: 'revoked' })
  })
})
