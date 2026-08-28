/**
 * `qy serve` 的完整链路端到端——**用假 provider，不花钱，进 `bun test`**。
 *
 * **为什么要有这一层。** 只有 `bun test`（免费、无网络、只测单元）和 `scripts/smoke-serve.ts`（真
 * key、五分钟、跑真模型）两档的话，**中间是空的**，而那道缝真的漏过缺陷：`bun test` 看不见 serve
 * 的装配，smoke-serve 要真 key 才跑、因此少有人跑，一条不再成立的断言长期留在缝里没有变红。
 *
 * 这一层验的是**协议与装配**，不验模型：握手鉴权、订阅、指令 fail-closed、
 * 一轮完整的 run（工具调用 → 文件改动 → 收尾）、seq 单调、断线补发。
 * 模型的行为由脚本化的 SSE 决定，所以它是确定性的——
 * 一次红就是一次真的回归，不是 provider 抖动。
 *
 * **假 provider 的形状。** 一个 `Bun.serve`，按调用次数返回不同的 SSE：第一轮发工具调用，
 * 第二轮发文本并收尾。这样才走得到「工具执行 → 结果回灌 → 再请求」
 * 那条最容易在装配上出错的路——只发一轮文本的话，
 * 整个工具链路一行都没被执行到。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, EventEnvelope } from '@qywork/core'
import { toPosixPath } from '@qywork/core'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store } from '@qywork/store'
import { MAX_ENTRY_CHARS } from '@qywork/tools'
import { serve } from './server.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

/** 第一轮：调 write_file 往工作区写一个文件。 */
function toolTurn(path: string, content: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_fake_1' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'write_file' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      delta: JSON.stringify({ path, content }),
    },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fake_1',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ])
}

/** 第二轮：纯文本收尾。 */
function textTurn(text: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_fake_2' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fake_2',
        status: 'completed',
        usage: { input_tokens: 20, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ])
}

let calls = 0
/** 假 provider 收到的请求体。附件链路的断言要看模型**实际收到了什么**。 */
const seenBodies: string[] = []
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    seenBodies.push(await req.text())
    calls++
    const body = calls === 1 ? toolTurn('out.txt', 'written by fake\n') : textTurn('已经写好了。')
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  },
})

// ───────────────────────── 装配 ─────────────────────────

let ws_dir = ''
let handle: ReturnType<typeof serve>
let store: Store
let content: ContentStore
let prevHome: string | undefined

beforeAll(async () => {
  ws_dir = await mkdtemp(join(tmpdir(), 'qywork-e2e-'))
  await writeFile(join(ws_dir, 'calc.js'), 'module.exports = { add: (a, b) => a + b }\n', 'utf8')

  const dbPath = join(ws_dir, 'e2e.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  const config: QyConfig = {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {}, 'deepseek-v4-flash-vision-exp': {} },
      },
    },
    mode: 'auto',
  }

  /*
   * **配置只有一个真源：`configPath()` 那个文件。**
   *
   * 先写文件，再 `loadConfig()` 读回来交给 `serve` ——和 `qy serve` 一模一样。
   * 直接把上面那个对象递进去也能跑，但那样测试手里就有两份（一份在内存、
   * 一份在盘上），改一处漏一处时的表现是「界面读到 A、请求发去 B」。
   *
   * `QYWORK_HOME` 指到临时目录，不是另开一条路径——`configPath()` 全仓只有
   * 一处实现，这里换的是它的落点。跑在开发机那份真配置上的话，测试会按
   * 开发者本人配的接口发请求，配置那几条用例还会写他的文件。
   */
  prevHome = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qywork-e2e-home-'))
  await writeFile(configPath(), JSON.stringify(config), 'utf8')

  handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: ws_dir,
    content,
    port: 0,
    host: '127.0.0.1',
  })
})

afterAll(async () => {
  // 同一个进程里跑着别的测试文件，QYWORK_HOME 不还回去会跟着漏过去。
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  handle?.stop()
  provider.stop(true)
  store?.close()
  content?.close()
  // 临时目录删不掉不该让整个测试文件红。Windows 上 SQLite 的文件句柄
  // 释放有延迟，而「临时目录还在」与被测行为毫无关系——
  // 让它红等于用一条与结论无关的噪声掩盖真正的失败。
  await rm(ws_dir, { recursive: true, force: true }).catch(() => {})
})

const base = () => `http://127.0.0.1:${handle.port}`
const auth = () => ({ authorization: `Bearer ${handle.token}` })

describe('HTTP 面', () => {
  test('健康检查免鉴权', async () => {
    const r = (await (await fetch(`${base()}/api/health`)).json()) as {
      ok?: boolean
    }
    expect(r.ok).toBe(true)
  })

  test('无令牌 / 错令牌一律 401', async () => {
    expect((await fetch(`${base()}/api/workspaces`)).status).toBe(401)
    const bad = await fetch(`${base()}/api/workspaces`, {
      headers: { authorization: `Bearer ${'0'.repeat(handle.token.length)}` },
    })
    expect(bad.status).toBe(401)
  })

  test('跨源预检在鉴权之前答复，正常响应带 CORS 头', async () => {
    // 桌面端的页面与本服务不同源（dev 是 vite 的 5180，装机版是 tauri 的 asset 协议）。
    // 预检不带 Authorization：拿它去验令牌会得到 401，而预检 401 意味着真正的请求
    // 不会发出——表现是 WebSocket 连着、所有面板却永远停在「读取中」。
    const pre = await fetch(`${base()}/api/config`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5180',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization')

    const ok = await fetch(`${base()}/api/config`, {
      headers: { ...auth(), origin: 'http://localhost:5180' },
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
  })

  /**
   * 附件上传的自定义头必须在预检的放行名单里。
   *
   * 漏掉它的表现极具误导性：整条上传链路 100% 失败，而前端拿到的是裸的
   * `TypeError: Failed to fetch`——没有状态码、没有响应体，看不出是被浏览器
   * 在发出之前挡下的。这条断言锁的就是那个名字。
   */
  test('预检放行附件上传的 x-attachment-name', async () => {
    const pre = await fetch(`${base()}/api/attachments`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5180',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-attachment-name',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-attachment-name')
  })

  test('不带 providers 的配置 PUT 被挡住，不会把接口清空', async () => {
    /*
     * `mergeConfig` 从 `incoming.providers ?? {}` **重建**接口表——
     * 一次只带 mode 的 PUT 会把所有接口抹掉。
     *
     * 界面上的 ModeChip 因此是**先读全量再写回**的。但那只是调用方守规矩，
     * 真正兜底的必须是服务端：这条断言锁的是「即使客户端写错了，也不会落盘」。
     * 表现如果失守，是用户点一下权限开关，所有 API Key 配置消失。
     */
    const before = (await (await fetch(`${base()}/api/config`, { headers: auth() })).json()) as {
      config: { active: { provider: string; model: string }; providers: Record<string, unknown> }
    }
    expect(Object.keys(before.config.providers).length).toBeGreaterThan(0)

    const res = await fetch(`${base()}/api/config`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ config: { active: before.config.active, mode: 'full' } }),
    })
    // 校验先于落盘：active 指向一个不存在的接口，422 且不写。
    expect(res.status).toBe(422)

    const after = (await (await fetch(`${base()}/api/config`, { headers: auth() })).json()) as {
      config: { providers: Record<string, unknown> }
    }
    expect(Object.keys(after.config.providers)).toEqual(Object.keys(before.config.providers))
  })

  test('记忆可增可删，非法 key 与超长内容被挡在落盘之前', async () => {
    // agent 能写记忆，人却看不到也删不掉——这条接口就是补那个不对称的。
    const put = await fetch(`${base()}/api/memory/build-commands`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ content: '构建用 bun run gate，不要单独跑 tsc。' }),
    })
    expect(put.status).toBe(200)

    const list = (await (await fetch(`${base()}/api/memory`, { headers: auth() })).json()) as {
      entries?: { key: string; preview: string }[]
    }
    expect(list.entries?.some((e) => e.key === 'build-commands')).toBe(true)

    // 校验先于落盘：超长直接 422，不写一半。上限与 `write_memory` **共用同一个常数**
    // （`@qywork/tools` 导出），两处各写一个数迟早漂成两个。
    const tooLong = await fetch(`${base()}/api/memory/build-commands`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(MAX_ENTRY_CHARS + 1) }),
    })
    expect(tooLong.status).toBe(422)
    // 边界值本身要能存进去——差一位的上限是最容易写错的那种。
    const atLimit = await fetch(`${base()}/api/memory/at-limit`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(MAX_ENTRY_CHARS) }),
    })
    expect(atLimit.status).toBe(200)
    await fetch(`${base()}/api/memory/at-limit`, { method: 'DELETE', headers: auth() })

    // 路径穿越：安全化之后不该还能碰到 .qy/memory 之外。
    const traversal = await fetch(
      `${base()}/api/memory/${encodeURIComponent('../../etc/passwd')}`,
      { method: 'DELETE', headers: auth() },
    )
    expect(traversal.status).toBeGreaterThanOrEqual(400)

    const del = await fetch(`${base()}/api/memory/build-commands`, {
      method: 'DELETE',
      headers: auth(),
    })
    expect(del.status).toBe(200)
    // 删一个不存在的回 404 而不是静默成功——静默成功会让「删了却还在」查不出原因。
    const again = await fetch(`${base()}/api/memory/build-commands`, {
      method: 'DELETE',
      headers: auth(),
    })
    expect(again.status).toBe(404)
  })

  /**
   * 附件的两条出口。
   *
   * **只有拿不到源路径时才走上传**——桌面端拖入给的是绝对路径，那条在前端就地
   * 组装，不经过这个接口。所以这里测的是「剪贴板位图 / 浏览器上传」那一条：
   * 落进会话自己的目录，删会话时整个目录一起走。
   */
  test('附件上传：落进会话目录，回可直接发的 Attachment，超限 413', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const created = (await (
      await fetch(`${base()}/api/conversations`, { method: 'POST', headers: auth() })
    ).json()) as { conversation: { id: string } }
    const cid = created.conversation.id
    const post = (name: string, body: Uint8Array, conversation = cid) =>
      fetch(`${base()}/api/attachments?conversation=${encodeURIComponent(conversation)}`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'image/png', 'x-attachment-name': name },
        body,
      })

    // 没有会话就没有归属：附件目录按会话删，落一份没人认领的等于造孤儿。
    const orphan = await fetch(`${base()}/api/attachments`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'image/png', 'x-attachment-name': 'a.png' },
      body: png,
    })
    expect(orphan.status).toBe(422)

    // 会话 id 要进路径，分隔符必须被挡掉，否则写入点能被带到目录之外。
    const traversal = await post('a.png', png, '../../evil')
    expect(traversal.status).toBe(422)

    const up = await post(encodeURIComponent('截图 1.png'), png)
    expect(up.status).toBe(200)
    const { attachment } = (await up.json()) as { attachment: import('@qywork/core').Attachment }
    // 分类按扩展名，与「发出去时内联哪些」同一份判据。
    expect(attachment.type).toBe('image')
    expect(attachment.mime).toBe('image/png')
    expect(attachment.size).toBe(png.length)
    // 落在会话自己的目录里，与会话库同一棵树——不是工作区。
    const home = process.env.QYWORK_HOME as string
    expect(attachment.path).toContain(`/attachments/${cid}/`)
    expect(attachment.path.startsWith(toPosixPath(home))).toBe(true)
    // 一律正斜杠：这个值要跨端传，反斜杠在别处会被当转义。
    expect(attachment.path).not.toContain(String.fromCharCode(92))
    // 中文名安全化后仍要保留可读的部分，不能被削成空串。
    expect(attachment.path).toContain('.png')
    expect(await readFile(attachment.path)).toEqual(png)

    // 按路径回读原始字节，供界面显示缩略图——不再存第二份。
    const raw = await fetch(
      `${base()}/api/attachments/raw?path=${encodeURIComponent(attachment.path)}`,
      { headers: auth() },
    )
    expect(raw.status).toBe(200)
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new Uint8Array(png))

    // 同名再传一次不能覆盖上一份——否则上一条消息引用的图会被下一条换掉。
    const second = (await (await post('a.png', png)).json()) as { attachment: { path: string } }
    const third = (await (await post('a.png', png)).json()) as { attachment: { path: string } }
    expect(second.attachment.path).not.toBe(third.attachment.path)

    // 超限挡在写盘之前。
    const tooBig = await fetch(
      `${base()}/api/attachments?conversation=${encodeURIComponent(cid)}`,
      {
        method: 'POST',
        headers: {
          ...auth(),
          'content-type': 'application/octet-stream',
          'x-attachment-name': 'b.bin',
        },
        body: new Uint8Array(10 * 1024 * 1024 + 1),
      },
    )
    expect(tooBig.status).toBe(413)

    /*
     * 删会话把目录一起带走——这就是「附件属于会话」的全部实现，
     * 不再需要「扫目录找没人引用的孤儿」那套回收。
     */
    const del = await fetch(`${base()}/api/conversations/${cid}`, {
      method: 'DELETE',
      headers: auth(),
    })
    expect(del.status).toBe(200)
    expect(
      await readFile(attachment.path).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test('文件接口走同一套路径约束', async () => {
    // HTTP 入口和工具入口不能有两套安全策略——两套必然漂移，
    // 而漂移的方向通常是 HTTP 那套更松（它看起来「只是给 UI 用的」）。
    const esc = await fetch(`${base()}/api/files/preview?path=../../../etc/passwd`, {
      headers: auth(),
    })
    expect(esc.status).toBeGreaterThanOrEqual(400)
  })
})

describe('WebSocket 协议与一轮完整 run', () => {
  test('握手期错误令牌被拒', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${handle.port}/stream?token=wrong`)
    const closed = await new Promise<boolean>((res) => {
      bad.addEventListener('close', () => res(true), { once: true })
      bad.addEventListener('error', () => res(true), { once: true })
      setTimeout(() => res(false), 3000)
    })
    expect(closed).toBe(true)
  })

  test('握手 → 下发 → 工具执行 → 收尾，全链路走通', async () => {
    const created = (await (
      await fetch(`${base()}/api/conversations`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'e2e' }),
      })
    ).json()) as { conversation: { id: string } }
    const conversationId: string = created.conversation.id
    expect(conversationId.startsWith('cv_')).toBe(true)

    const ws = new WebSocket(
      `ws://127.0.0.1:${handle.port}/stream?token=${handle.token}&origin=desktop`,
    )
    const frames: EventEnvelope<AgentEvent>[] = []
    const rejections: { command?: string; reason?: string }[] = []
    const helloReady = Promise.withResolvers<{
      type?: string
      capabilities?: {
        pty?: boolean
        sandbox?: { backend?: string; active?: boolean; reason?: string }
      }
    }>()
    const done = Promise.withResolvers<void>()

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.ok') {
        helloReady.resolve(msg)
        return
      }
      if (msg.type === 'command.rejected') {
        rejections.push(msg)
        return
      }
      if (!msg.seq || !msg.event) return
      frames.push(msg)
      const ev = msg.event as AgentEvent
      if (ev.type === 'run.finished' || ev.type === 'run.error') done.resolve()
    })

    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })

    ws.send(
      JSON.stringify({
        type: 'hello',
        token: handle.token,
        origin: 'desktop',
        subscribe: [conversationId],
      }),
    )
    const hello = (await helloReady.promise) as {
      type?: string
      capabilities?: {
        pty?: boolean
        mode?: string
        sandbox?: { backend?: string; active?: boolean; reason?: string }
      }
    }
    expect(hello?.type).toBe('hello.ok')

    /*
     * 权限模式也走握手，理由和沙箱同一条：它回答的是「这一轮跑在什么边界里」。
     * 界面上那个 chip 读的就是这个字段——不进握手的话，客户端只能自己再拉一次
     * 配置，因此同一个值有两条来路。**只有两种模式**，多出第三种就是 bug。
     */
    expect(['auto', 'full']).toContain(hello?.capabilities?.mode ?? '')

    /*
     * 沙箱状态必须**进握手**。
     *
     * 桌面端和手机端用户唯一能知道「这条命令跑在什么边界里」的地方就是界面——
     * `qy config` 他们不会去跑。而「看着被拦住、实际没拦」是这套权限模型
     * 最危险的误解，所以这条不能是个加了没人验的字段。
     *
     * 断言的是**形状与自洽**，不是具体后端：CI 跑在什么平台上不该决定这条测试的成败。
     */
    const sb = hello?.capabilities?.sandbox
    expect(sb).toBeDefined()
    expect(typeof sb?.active).toBe('boolean')
    // 报后端名而不是布尔值——合并成一个 boolean 在插件侧出过同一个问题。
    expect(typeof sb?.backend).toBe('string')
    // 「没有沙箱」也必须说得出为什么、下一步怎么办。
    expect((sb?.reason ?? '').length).toBeGreaterThan(10)
    if (sb?.backend === 'none') expect(sb.active).toBe(false)

    // 指令 fail-closed：未实现的指令必须有回执。
    // 静默吞掉的话，客户端永远等不到反馈，而「服务端正在处理」与
    // 「服务端没收到」在界面上完全无法区分。
    ws.send(JSON.stringify({ type: 'no.such.command' }))
    await Bun.sleep(150)
    expect(rejections.some((r) => r.reason === 'unknown_command')).toBe(true)

    /*
     * **另开一个客户端，明确一条会话事件都不订阅。**
     *
     * 左栏那一行的转圈就靠它：客户端只订阅当前会话，别的会话在跑时它一条 run
     * 事件都收不到——原始失败形状是「只有点开的那条会话才转得起来」。
     * 忙闲必须是工作区级的（信封不带归属），而正文仍然按订阅拦住。
     */
    const peer = new WebSocket(
      `ws://127.0.0.1:${handle.port}/stream?token=${handle.token}&origin=mobile`,
    )
    const peerFrames: EventEnvelope<AgentEvent>[] = []
    const peerReady = Promise.withResolvers<{ busyConversations?: string[] }>()
    peer.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.ok') {
        peerReady.resolve(msg)
        return
      }
      if (msg.seq && msg.event) peerFrames.push(msg)
    })
    await new Promise<void>((res, rej) => {
      peer.addEventListener('open', () => res(), { once: true })
      peer.addEventListener('error', () => rej(new Error('peer ws 连接失败')), { once: true })
    })
    peer.send(
      JSON.stringify({ type: 'hello', token: handle.token, origin: 'mobile', subscribe: [] }),
    )
    expect((await peerReady.promise).busyConversations).toEqual([])

    ws.send(
      JSON.stringify({
        type: 'message.send',
        clientRequestId: crypto.randomUUID(),
        conversationId,
        content: '写一个 out.txt',
      }),
    )

    const timer = setTimeout(() => done.reject(new Error('run 超时')), 20_000)
    await done.promise
    clearTimeout(timer)

    const types = new Set(frames.map((f) => f.event.type))
    expect(types.has('run.started')).toBe(true)
    expect(types.has('tool.started')).toBe(true)
    expect(types.has('tool.finished')).toBe(true)
    expect(types.has('text.delta')).toBe(true)
    expect(types.has('file.changed')).toBe(true)

    // 工具**真的执行了**，不是只发了事件。
    expect(await readFile(join(ws_dir, 'out.txt'), 'utf8')).toBe('written by fake\n')

    const finished = frames.find((f) => f.event.type === 'run.finished')?.event as
      | Extract<AgentEvent, { type: 'run.finished' }>
      | undefined
    expect(finished?.status).toBe('done')

    // 收尾那一下（`runs.unregister`）在 run.finished 之后，等它到齐再看。
    await Bun.sleep(300)
    const peerBusy = peerFrames
      .filter((f) => f.event.type === 'conversation.busy')
      .map((f) => f.event as Extract<AgentEvent, { type: 'conversation.busy' }>)
    // 一开一收，两头都要有：只有开头的话左栏那一行会永远转下去。
    expect(peerBusy.map((e) => e.busy)).toEqual([true, true, false])
    expect(peerBusy.every((e) => e.conversationId === conversationId)).toBe(true)
    // 正文仍然按订阅拦住——退订了还收到正文，那是另一个方向的串台。
    expect(peerFrames.some((f) => f.event.type === 'text.delta')).toBe(false)
    peer.close()

    // seq 严格单调递增：断线补发的缺口计算全靠它。
    const seqs = frames.map((f) => f.seq)
    expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] as number))).toBe(true)

    // 断线补发：从中途的 seq 要能补出后面全部，已同步的补出空。
    // 订阅传 null = 还没声明过订阅，全收——这里验的是缺口计算，不是过滤
    // （过滤本身在 bus.test.ts 里单独锁）。
    const anySub = { id: 'x', origin: 'cli', conversations: null, send: () => {} } as const
    const stream = handle.bus.streamId
    const mid = seqs[Math.floor(seqs.length / 2)] as number
    expect(
      handle.bus.replayFrom({ streamId: stream, lastSeq: mid }, anySub)?.length ?? 0,
    ).toBeGreaterThan(0)
    expect(
      handle.bus.replayFrom({ streamId: stream, lastSeq: handle.bus.currentSeq }, anySub)?.length,
    ).toBe(0)

    ws.close()
  }, 30_000)
})

/*
 * 这一块**必须放在文件最后**。
 *
 * 假 provider 是按调用次数发不同脚本的（第一次工具轮、之后文本轮）。
 * 把这个 describe 放在前面会占用前两次调用，因此「全链路走通」那条拿不到
 * 工具轮，断言 `tool.started` 直接红——而红的地方和真正的改动无关。
 */
describe('图片附件', () => {
  /**
   * 回归测试：**附件必须真的到达模型请求体**。
   *
   * 这条链路很容易变成死链路：`Attachment` 类型在、`messages.attachments` 列在、
   * `repos.ts` 会写、三个 provider 都会编码 image 块，而中间任一处把它丢在地上
   * （服务端不转发 / `session.ts` 落库不带 / 装配历史时只取 `content`），
   * 后果是有类型、有列、有编码器，就是没有数据。
   *
   * 所以断言不能停在「接口回了 200」，必须看**假 provider 收到的字节里有没有那张图**。
   */
  test('随消息发出的图片进入请求体的 image 块', async () => {
    // 一个 1x1 的 PNG，够小又是真图。
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await writeFile(join(ws_dir, 'shot.png'), png)

    const conv = (await (
      await fetch(`${base()}/api/conversations`, { method: 'POST', headers: auth() })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = conv.conversation?.id
    expect(conversationId).toBeTruthy()

    const before = seenBodies.length
    const ws = new WebSocket(`${base().replace('http', 'ws')}/stream?token=${handle.token}`)
    const settled = Promise.withResolvers<void>()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as { type?: string; event?: { type?: string } }
      if (msg.type === 'hello.ok') {
        // 默认那条模型不收图片（目录里 `vision: false`），图像块会被换成一句话。
        // 先切到收图片的那条——「要发图片就得挑一个收图片的模型」正是这条链路的前提。
        ws.send(
          JSON.stringify({
            type: 'conversation.setModel',
            conversationId,
            provider: 'fake',
            model: 'deepseek-v4-flash-vision-exp',
          }),
        )
        ws.send(
          JSON.stringify({
            type: 'message.send',
            clientRequestId: crypto.randomUUID(),
            conversationId,
            content: '看这张图',
            attachments: [
              {
                type: 'image',
                name: 'shot.png',
                mime: 'image/png',
                size: png.length,
                path: 'shot.png',
              },
            ],
          }),
        )
      }
      if (msg.event?.type === 'run.finished') settled.resolve()
    })
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          token: handle.token,
          origin: 'desktop',
          subscribe: [conversationId],
        }),
      )
    })

    const timer = setTimeout(() => settled.reject(new Error('run 超时')), 20_000)
    await settled.promise
    clearTimeout(timer)
    ws.close()

    const body = seenBodies.slice(before).join('')
    expect(body.length).toBeGreaterThan(0)
    // 图片以 base64 进 image 块——原始字节的前缀应当出现在请求体里。
    expect(body).toContain(png.toString('base64').slice(0, 40))
  })

  /**
   * 回归测试：**非图片附件给的是位置，不是字节**。
   *
   * 图片除了内联没有别的路（模型看不到工具读不出来的内容），其余附件只把路径
   * 写进正文，模型要看自己 `read_file`。省掉的是每一轮重放时那份 base64——
   * provider 无状态，一份 200 KB 的文档在二十轮的会话里会被发二十次。
   *
   * 两个方向都要断言：路径**在**请求体里、内容**不在**。只测前者的话，
   * 有人把内容也一起塞回去这条仍然是绿的。
   */
  test('随消息发出的文档只给路径，不给字节', async () => {
    const marker = 'MARKER_ONLY_IN_THE_FILE_BODY'
    await writeFile(
      join(ws_dir, 'notes.md'),
      `# 标题
${marker}
`,
      'utf8',
    )

    const conv = (await (
      await fetch(`${base()}/api/conversations`, { method: 'POST', headers: auth() })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = conv.conversation?.id

    const before = seenBodies.length
    const ws = new WebSocket(`${base().replace('http', 'ws')}/stream?token=${handle.token}`)
    const settled = Promise.withResolvers<void>()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as { type?: string; event?: { type?: string } }
      if (msg.type === 'hello.ok') {
        ws.send(
          JSON.stringify({
            type: 'message.send',
            clientRequestId: crypto.randomUUID(),
            conversationId,
            content: '看这个文件',
            attachments: [
              {
                type: 'file',
                name: 'notes.md',
                mime: 'text/markdown',
                size: 0,
                path: 'notes.md',
              },
            ],
          }),
        )
      }
      if (msg.event?.type === 'run.finished') settled.resolve()
    })
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          token: handle.token,
          origin: 'desktop',
          subscribe: [conversationId],
        }),
      )
    })
    const timer = setTimeout(() => settled.reject(new Error('run 超时')), 20_000)
    await settled.promise
    clearTimeout(timer)
    ws.close()

    const body = seenBodies.slice(before).join('')
    expect(body).toContain('notes.md')
    // 正文里给的是位置，不是内容——文件里那个标记一个字节都不该出现。
    expect(body).not.toContain(marker)
    expect(body).not.toContain(Buffer.from(marker).toString('base64'))
  })
})
