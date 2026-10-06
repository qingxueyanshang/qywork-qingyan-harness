/**
 * `qy serve` 完整链路的端到端测试：**使用假 provider，不产生费用，纳入 `bun test`**。
 *
 * **本层的必要性。** `bun test`（免费、无网络、只测单元）与 `scripts/smoke-serve.ts`（真实
 * key、耗时五分钟、调用真实模型）之间存在覆盖空缺：`bun test`
 * 不覆盖 serve 的装配，smoke-serve 需要真实 key 才能运行、因此很少运行，失效的断言会长期
 * 未被发现。
 *
 * 本层验证**协议与装配**，不验证模型：握手鉴权、订阅、指令 fail-closed（未知指令、处理抛出）、
 * 一轮完整的 run（工具调用 → 文件改动 → 收尾）、seq 单调、断线补发。
 * 模型的行为由脚本化的 SSE 决定，因此结果是确定的：
 * 一次失败即一次真实的回归，而不是 provider 的波动。
 *
 * **假 provider 的结构。** 一个 `Bun.serve`，按调用次数返回不同的 SSE：第一轮发出工具调用，
 * 第二轮发出文本并结束。这样才能覆盖「工具执行 → 结果回传 → 再次请求」
 * 这条最容易在装配上出错的路径；只发一轮文本时，工具链路的代码完全不会被执行。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  Attachment,
  ConversationHistoryPageResponse,
  EventEnvelope,
} from '@qywork/core'
import { toPosixPath } from '@qywork/core'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store } from '@qywork/store'
import { MEMORY_DIR } from '@qywork/tools'
import { serve } from './server.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

/** 第一轮：调用 write_file 向工作区写入一个文件。 */
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
      delta: JSON.stringify({ path, mode: 'create', content }),
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

/** 第二轮：以纯文本结束。 */
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

function chatTextTurn(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n'
  )
}

let calls = 0
/** 假 provider 收到的请求体。附件链路的断言必须检查模型**实际收到的内容**。 */
const seenBodies: string[] = []
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    seenBodies.push(await req.text())
    if (new URL(req.url).pathname.endsWith('/chat/completions')) {
      return new Response(chatTextTurn('已经看完。'), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
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
      'fake-video': {
        kind: 'openai_chat_completions',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'qwen3.7-plus': {} },
      },
    },
    mode: 'auto',
  }

  /*
   * **配置只有一个真源：`configPath()` 指向的文件。**
   *
   * 先写入文件，再用 `loadConfig()` 读取后交给 `serve`，与 `qy serve` 完全一致。
   * 直接传入上面的对象也能运行，但测试中会存在两份配置（一份在内存、
   * 一份在磁盘），修改一处而遗漏另一处时，界面读取的配置与请求使用的配置不一致。
   *
   * `QYWORK_HOME` 指向临时目录，而不是另设一条路径：`configPath()` 全仓只有
   * 一处实现，这里改变的是它的位置。在开发机的真实配置上运行时，测试会按
   * 开发者本人配置的接口发送请求，配置相关的用例还会改写其配置文件。
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
  // 同一进程中还运行着其他测试文件，不恢复 QYWORK_HOME 会影响它们。
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  handle?.stop()
  provider.stop(true)
  store?.close()
  content?.close()
  // 临时目录删除失败不应使整个测试文件失败。Windows 上 SQLite 的文件句柄
  // 释放有延迟，而临时目录是否残留与被测行为无关；
  // 此时报告失败会以无关的噪声掩盖真正的失败。
  await rm(ws_dir, { recursive: true, force: true }).catch(() => {})
})

const base = () => `http://127.0.0.1:${handle.port}`
const auth = () => ({ authorization: `Bearer ${handle.token}` })

describe('HTTP 接口', () => {
  test('健康检查免鉴权', async () => {
    const r = (await (await fetch(`${base()}/api/health`)).json()) as {
      ok?: boolean
    }
    expect(r.ok).toBe(true)
  })

  test('缺少令牌或令牌错误一律返回 401', async () => {
    expect((await fetch(`${base()}/api/workspaces`)).status).toBe(401)
    const bad = await fetch(`${base()}/api/workspaces`, {
      headers: { authorization: `Bearer ${'0'.repeat(handle.token.length)}` },
    })
    expect(bad.status).toBe(401)
  })

  test('跨源预检在鉴权之前响应，正常响应带 CORS 头', async () => {
    // 桌面端的页面与本服务不同源（开发时是 vite 的 5180，安装版是 tauri 的 asset 协议）。
    // 预检不带 Authorization：对其校验令牌会返回 401，而预检返回 401 意味着真正的请求
    // 不会发出：WebSocket 保持连接，而所有经由 HTTP 读取数据的面板均无法取得数据。
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
   * 附件上传的自定义头必须在预检的允许列表中。
   *
   * 遗漏时整条上传链路全部失败，而前端只收到
   * `TypeError: Failed to fetch`，没有状态码与响应体，无法看出请求是被浏览器
   * 在发出之前拦截的。本断言锁定该头名。
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

  test('不带 providers 的配置 PUT 被拒绝，不会清空接口', async () => {
    /*
     * `mergeConfig` 从 `incoming.providers ?? {}` **重建**接口表，
     * 一次只带 mode 的 PUT 会清除所有接口。
     *
     * 因此界面上的 ModeChip **先读取全量再写回**。但这只是调用方遵守约定，
     * 最终的保障必须在服务端：本断言锁定「即使客户端写错，也不会写入磁盘」。
     * 该保障失效时，用户点击一次权限开关，所有 API Key 配置都会丢失。
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
    // 校验先于落盘：active 指向不存在的接口，返回 422 且不写入。
    expect(res.status).toBe(422)

    const after = (await (await fetch(`${base()}/api/config`, { headers: auth() })).json()) as {
      config: { providers: Record<string, unknown> }
    }
    expect(Object.keys(after.config.providers)).toEqual(Object.keys(before.config.providers))
  })

  test('记忆可查看、可删除，非法 key 被拒绝', async () => {
    // 该接口使用户能够查看与删除 agent 写入的记忆。写入只经由工具，
    // 此处按工具的写入位置直接放置一个文件。
    const dir = join(ws_dir, MEMORY_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'build-commands.md'), '构建用 bun run gate，不要单独跑 tsc。', 'utf8')

    const list = (await (await fetch(`${base()}/api/memory`, { headers: auth() })).json()) as {
      entries?: { key: string; preview: string }[]
    }
    expect(list.entries?.some((e) => e.key === 'build-commands')).toBe(true)

    // 路径穿越：安全化处理后不得访问 .qy/memory 之外的路径。
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
    // 删除不存在的条目返回 404 而不是静默成功：静默成功会使「已删除却仍存在」无法排查。
    const again = await fetch(`${base()}/api/memory/build-commands`, {
      method: 'DELETE',
      headers: auth(),
    })
    expect(again.status).toBe(404)
  })

  /**
   * 附件的两条路径。
   *
   * **只有无法取得源路径时才经由上传**：桌面端拖入提供的是绝对路径，该路径在前端直接
   * 组装，不经过此接口。因此这里测试的是「剪贴板位图 / 浏览器上传」路径：
   * 文件写入会话自己的目录，删除会话时整个目录一并删除。
   */
  test('附件上传：流式写入会话目录，返回可直接发送的 Attachment', async () => {
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

    // 没有会话即没有归属：附件目录按会话删除，写入无归属的文件会产生孤立文件。
    const orphan = await fetch(`${base()}/api/attachments`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'image/png', 'x-attachment-name': 'a.png' },
      body: png,
    })
    expect(orphan.status).toBe(422)

    // 会话 id 会进入路径，必须拒绝分隔符，否则写入位置可被引导到目录之外。
    const traversal = await post('a.png', png, '../../evil')
    expect(traversal.status).toBe(422)

    const up = await post(encodeURIComponent('截图 1.png'), png)
    expect(up.status).toBe(200)
    const { attachment } = (await up.json()) as { attachment: import('@qywork/core').Attachment }
    // 分类按扩展名，与「发送时内联哪些附件」使用同一判据。
    expect(attachment.type).toBe('image')
    expect(attachment.name).toBe('截图 1.png')
    expect(attachment.mime).toBe('image/png')
    expect(attachment.size).toBe(png.length)
    // 写入会话自己的目录，与会话库位于同一目录树，而不是工作区。
    const home = process.env.QYWORK_HOME as string
    expect(attachment.path).toContain(`/attachments/${cid}/`)
    expect(attachment.path.startsWith(toPosixPath(home))).toBe(true)
    // 一律使用正斜杠：该值需要跨端传输，反斜杠在其他环境中会被当作转义符。
    expect(attachment.path).not.toContain(String.fromCharCode(92))
    // 中文名安全化后仍须保留可读部分，不能被截成空字符串。
    expect(attachment.path).toContain('.png')
    expect(await readFile(attachment.path)).toEqual(png)

    // 按路径读取原始字节，供界面显示缩略图，不另存副本。
    const raw = await fetch(
      `${base()}/api/attachments/raw?path=${encodeURIComponent(attachment.path)}`,
      { headers: auth() },
    )
    expect(raw.status).toBe(200)
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new Uint8Array(png))

    // 同名文件再次上传不能覆盖前一份，否则上一条消息引用的图片会被下一条替换。
    const second = (await (await post('a.png', png)).json()) as { attachment: { path: string } }
    const third = (await (await post('a.png', png)).json()) as { attachment: { path: string } }
    expect(second.attachment.path).not.toBe(third.attachment.path)

    // 显示名称保留原文件名，存储名的安全化与长度限制不能改变它或丢失扩展名。
    for (const [name, type, extension] of [
      ['截图（第 1 张） #原图.png', 'image', '.png'],
      ['演示 视频 (修订版).mp4', 'video', '.mp4'],
      ['报告 [草稿] 100% + 附件.pdf', 'file', '.pdf'],
      ['.env.local', 'file', '.local'],
      [`${'截图'.repeat(50)}.png`, 'image', '.png'],
      [`${'视频'.repeat(50)}.mp4`, 'video', '.mp4'],
      [`${'报告'.repeat(50)}.docx`, 'file', '.docx'],
    ] as const) {
      const response = await post(encodeURIComponent(name), png)
      expect(response.status).toBe(200)
      const uploaded = (await response.json()) as { attachment: import('@qywork/core').Attachment }
      expect(uploaded.attachment.name).toBe(name)
      expect(uploaded.attachment.type).toBe(type)
      expect(uploaded.attachment.path.endsWith(extension)).toBe(true)
      expect(await readFile(uploaded.attachment.path)).toEqual(png)
    }

    // qywork 不使用统一的媒体阈值代替 Provider 裁决。
    const large = new Uint8Array(10 * 1024 * 1024 + 1)
    large[0] = 7
    large[large.length - 1] = 9
    const largeResponse = await post('clip.mp4', large)
    expect(largeResponse.status).toBe(200)
    const largeAttachment = (await largeResponse.json()) as {
      attachment: { path: string; size: number }
    }
    expect(largeAttachment.attachment.size).toBe(large.length)
    const storedLarge = await readFile(largeAttachment.attachment.path)
    expect(storedLarge.byteLength).toBe(large.length)
    expect(storedLarge[0]).toBe(7)
    expect(storedLarge[storedLarge.length - 1]).toBe(9)
    // 缩略图读取仍有独立的浏览器内存保护，不影响原文件写入磁盘与发送给模型。
    const largeRaw = await fetch(
      `${base()}/api/attachments/raw?path=${encodeURIComponent(largeAttachment.attachment.path)}`,
      { headers: auth() },
    )
    expect(largeRaw.status).toBe(413)

    /*
     * 删除会话时一并删除其目录：这就是「附件属于会话」的全部实现，
     * 无需另设「扫描目录查找无引用的孤立文件」的回收机制。
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

  test('文件接口使用同一套路径约束', async () => {
    // HTTP 入口与工具入口不能有两套安全策略：两套必然产生偏差，
    // 且偏差方向通常是 HTTP 一侧更宽松（它被视为「只供 UI 使用」）。
    const esc = await fetch(`${base()}/api/files/preview?path=../../../etc/passwd`, {
      headers: auth(),
    })
    expect(esc.status).toBeGreaterThanOrEqual(400)
  })
})

describe('WebSocket 协议与一轮完整 run', () => {
  test('握手阶段的错误令牌被拒绝', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${handle.port}/stream?token=wrong`)
    const closed = await new Promise<boolean>((res) => {
      bad.addEventListener('close', () => res(true), { once: true })
      bad.addEventListener('error', () => res(true), { once: true })
      setTimeout(() => res(false), 3000)
    })
    expect(closed).toBe(true)
  })

  test('握手 → 下发 → 工具执行 → 结束，全链路执行成功', async () => {
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
     * 权限模式同样经由握手下发，理由与沙箱相同：它说明本轮的运行边界。
     * 界面上的 chip 读取该字段；不进入握手时，客户端只能另行拉取一次
     * 配置，同一个值因此有两个来源。**只有两种模式**，出现第三种即为缺陷。
     */
    expect(['auto', 'full']).toContain(hello?.capabilities?.mode ?? '')

    /*
     * 沙箱状态必须**包含在握手中**。
     *
     * 桌面端与手机端用户只能通过界面了解命令的运行边界，
     * 他们不会运行 `qy config`。而「看似已拦截、实际未拦截」是这套权限模型
     * 最危险的误解，因此该字段必须有测试验证。
     *
     * 断言的是**结构与自洽**，不是具体后端：CI 运行的平台不应决定本测试的成败。
     */
    const sb = hello?.capabilities?.sandbox
    expect(sb).toBeDefined()
    expect(typeof sb?.active).toBe('boolean')
    // 报告后端名而不是布尔值：合并为一个 boolean 后无法区分不同的后端。
    expect(typeof sb?.backend).toBe('string')
    // 「没有沙箱」时也必须说明原因与后续操作。
    expect((sb?.reason ?? '').length).toBeGreaterThan(10)
    if (sb?.backend === 'none') expect(sb.active).toBe(false)

    // 指令 fail-closed：未实现的指令必须有回执。
    // 静默丢弃时，客户端永远收不到反馈，「服务端正在处理」与
    // 「服务端未收到」在界面上完全无法区分。
    ws.send(JSON.stringify({ type: 'no.such.command' }))
    await Bun.sleep(150)
    expect(rejections.some((r) => r.reason === 'unknown_command')).toBe(true)

    /*
     * **另开一个客户端，明确不订阅任何会话事件。**
     *
     * 左栏会话行的运行指示依赖于此：客户端只订阅当前会话，其他会话运行时它收不到任何
     * run 事件，原始失败形状是「只有已打开的会话才显示运行指示」。
     * 忙闲状态必须是工作区级的（信封不带归属），而正文仍按订阅过滤。
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

    // 工具**实际执行**，而不只是发出了事件。
    expect(await readFile(join(ws_dir, 'out.txt'), 'utf8')).toBe('written by fake\n')

    const finished = frames.find((f) => f.event.type === 'run.finished')?.event as
      | Extract<AgentEvent, { type: 'run.finished' }>
      | undefined
    expect(finished?.status).toBe('done')

    // 收尾动作（`runs.unregister`）在 run.finished 之后执行，等待其完成后再检查。
    await Bun.sleep(300)
    const peerBusy = peerFrames
      .filter((f) => f.event.type === 'conversation.busy')
      .map((f) => f.event as Extract<AgentEvent, { type: 'conversation.busy' }>)
    // 开始与结束都必须广播：只广播开始时，左栏的会话行会始终显示运行中。
    expect(peerBusy.map((e) => e.busy)).toEqual([true, true, false])
    expect(peerBusy.every((e) => e.conversationId === conversationId)).toBe(true)
    // 正文仍按订阅过滤：退订后仍收到正文，属于另一方向的会话串扰。
    expect(peerFrames.some((f) => f.event.type === 'text.delta')).toBe(false)
    peer.close()

    // seq 严格单调递增：断线补发的缺口计算完全依赖于此。
    const seqs = frames.map((f) => f.seq)
    expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] as number))).toBe(true)

    // 断线补发：从中途的 seq 开始必须能补发其后的全部事件，已同步时补发为空。
    // 订阅传 null 表示尚未声明订阅、全部接收；这里验证的是缺口计算，不是过滤
    // （过滤本身由 bus.test.ts 单独锁定）。
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

  /**
   * 指令处理抛出异常时的回执。
   *
   * 用 `PRAGMA query_only` 注入：`conversation.setModel` 的 UPDATE 因此抛出 SQLite
   * 错误。真实运行中，SQLite 写入会因并发写锁、磁盘已满、库文件只读而失败。
   *
   * 断言到「连接仍在、后一条指令正常得到答复」为止：没有回执时，问题不在于报错形式，
   * 而在于客户端收不到任何帧，界面停留在生成中直到重连。
   */
  test('指令处理抛出异常：回执带指令名，连接保持，后续指令正常处理', async () => {
    const created = (await (
      await fetch(`${base()}/api/conversations`, { method: 'POST', headers: auth() })
    ).json()) as { conversation: { id: string } }

    const ws = new WebSocket(`${base().replace('http', 'ws')}/stream?token=${handle.token}`)
    const rejections: { command?: string; reason?: string; message?: string }[] = []
    const seen: AgentEvent[] = []
    const helloReady = Promise.withResolvers<void>()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.ok') helloReady.resolve()
      else if (msg.type === 'command.rejected') rejections.push(msg)
      else if (msg.event) seen.push(msg.event as AgentEvent)
    })
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })
    ws.send(JSON.stringify({ type: 'hello', token: handle.token, origin: 'desktop' }))
    await helloReady.promise

    const setModel = JSON.stringify({
      type: 'conversation.setModel',
      conversationId: created.conversation.id,
      provider: 'fake',
      model: 'deepseek-v4-flash',
    })
    store.db.run('PRAGMA query_only = true')
    try {
      ws.send(setModel)
      await Bun.sleep(300)
    } finally {
      store.db.run('PRAGMA query_only = false')
    }

    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.command).toBe('conversation.setModel')
    expect(rejections[0]?.reason).toBe('internal_error')
    expect((rejections[0]?.message ?? '').length).toBeGreaterThan(0)
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // 写入恢复后同一条指令正常处理：广播到达即表明该连接仍在分发指令。
    ws.send(setModel)
    await Bun.sleep(300)
    expect(seen.some((e) => e.type === 'conversation.updated')).toBe(true)
    expect(rejections).toHaveLength(1)
    ws.close()
  })
})

/*
 * 本 describe **必须放在文件末尾**。
 *
 * 假 provider 按调用次数返回不同脚本（第一次为工具轮，之后为文本轮）。
 * 把本 describe 放在前面会占用前两次调用，使「全链路执行成功」用例无法取得
 * 工具轮，断言 `tool.started` 失败，而失败位置与实际改动无关。
 */
describe('图片附件', () => {
  /**
   * 回归测试：**附件必须实际到达模型请求体**。
   *
   * 该链路很容易成为未接通的链路：`Attachment` 类型存在、`messages.attachments` 列存在、
   * `repos.ts` 会写入、三个 provider 都会编码 image 块，而中间任一环节丢弃附件
   * （服务端不转发 / `session.ts` 落库时不带 / 装配历史时只取 `content`），
   * 结果是类型、列、编码器俱全，却没有数据。
   *
   * 因此断言不能止于「接口返回 200」，必须检查**假 provider 收到的字节中是否包含该图片**。
   */
  test('随消息发出的图片进入请求体的 image 块', async () => {
    // 1x1 的 PNG：体积小且是有效图片。
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
        // 默认模型不接受图片（目录中 `vision: false`），图像块会被替换为一句文字。
        // 先切换到接受图片的模型：「发送图片必须选择接受图片的模型」正是该链路的前提。
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
    // 图片以 base64 写入 image 块：原始字节编码后的前缀应出现在请求体中。
    expect(body).toContain(png.toString('base64').slice(0, 40))
  })

  /** 媒体按字节预算移出（`agent` 的 `evictedMedia`）：小视频在上限内，下一轮仍保留在请求中。 */
  test('当前轮视频写入 video_url，下一轮在保留上限内仍包含该视频', async () => {
    const video = Buffer.from('native-video-e2e')
    await writeFile(join(ws_dir, 'clip.mp4'), video)
    const conv = (await (
      await fetch(`${base()}/api/conversations`, { method: 'POST', headers: auth() })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = conv.conversation?.id
    expect(conversationId).toBeTruthy()

    const before = seenBodies.length
    const ws = new WebSocket(`${base().replace('http', 'ws')}/stream?token=${handle.token}`)
    const settled = Promise.withResolvers<void>()
    let finished = 0
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as { type?: string; event?: { type?: string } }
      if (msg.type === 'hello.ok') {
        ws.send(
          JSON.stringify({
            type: 'conversation.setModel',
            conversationId,
            provider: 'fake-video',
            model: 'qwen3.7-plus',
          }),
        )
        ws.send(
          JSON.stringify({
            type: 'message.send',
            clientRequestId: crypto.randomUUID(),
            conversationId,
            content: '描述视频内容',
            attachments: [
              {
                type: 'video',
                name: 'clip.mp4',
                mime: 'video/mp4',
                size: video.length,
                path: 'clip.mp4',
              },
            ],
          }),
        )
      }
      if (msg.event?.type !== 'run.finished') return
      finished++
      if (finished === 1) {
        ws.send(
          JSON.stringify({
            type: 'message.send',
            clientRequestId: crypto.randomUUID(),
            conversationId,
            content: '继续',
          }),
        )
      } else settled.resolve()
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

    const bodies = seenBodies.slice(before)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain(`data:video/mp4;base64,${video.toString('base64')}`)
    expect(bodies[1]).toContain('附件 clip.mp4')
    expect(bodies[1]).toContain(`data:video/mp4;base64,${video.toString('base64')}`)
  })

  /**
   * 回归测试：**非图片附件提供的是路径，不是字节**。
   *
   * 图片只能内联（模型无法看到工具读不出的内容），其余附件只把路径
   * 写入正文，模型需要时自行调用 `read_file`。由此省去每一轮重放时的 base64：
   * provider 无状态，一份 200 KB 的文档在二十轮的会话中会被发送二十次。
   *
   * 两个方向都要断言：路径**在**请求体中、内容**不在**。只测前者时，
   * 内容被一并写回请求，本用例仍会通过。
   */
  test('随消息发出的文档只提供路径，不提供字节', async () => {
    const marker = 'MARKER_ONLY_IN_THE_FILE_BODY'
    const name = '会议记录（第 1 版） #讨论.md'

    const conv = (await (
      await fetch(`${base()}/api/conversations`, { method: 'POST', headers: auth() })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = conv.conversation?.id
    const uploaded = await fetch(`${base()}/api/attachments?conversation=${conversationId}`, {
      method: 'POST',
      headers: {
        ...auth(),
        'content-type': 'text/markdown',
        'x-attachment-name': encodeURIComponent(name),
      },
      body: `# 标题\n${marker}\n`,
    })
    expect(uploaded.status).toBe(200)
    const { attachment } = (await uploaded.json()) as { attachment: Attachment }
    expect(attachment.name).toBe(name)

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
            attachments: [attachment],
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
    expect(body).toContain(name)
    expect(body).toContain(attachment.path)
    // 正文中提供的是路径，不是内容：文件中的标记不应出现在请求体中。
    expect(body).not.toContain(marker)
    expect(body).not.toContain(Buffer.from(marker).toString('base64'))

    // 刷新后的附件卡片来自历史接口，必须与发送前的名称和资源一一对应。
    const history = (await (
      await fetch(`${base()}/api/conversations/${conversationId}/history`, { headers: auth() })
    ).json()) as ConversationHistoryPageResponse
    expect(history.messages[0]?.attachments).toEqual([attachment])
    expect(history.messages[0]?.attachments[0]?.name).toBe(name)
  })
})
