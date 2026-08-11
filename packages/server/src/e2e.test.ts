/**
 * `qy serve` 的完整链路端到端——**用假 provider，不花钱，进 `bun test`**。
 *
 * ## 为什么要有这一层
 *
 * 原来的分层是两档：`bun test`（免费、无网络、只测单元）和
 * `scripts/smoke-serve.ts`（真 key、五分钟、跑真模型）。**中间是空的。**
 *
 * 那道缝真的漏过东西：改成两模式之后，`smoke-serve.ts:314` 那条
 * 「权限请求经 WebSocket 往返」的断言已经不成立了，而它在缝里躺了很久——
 * `bun test` 看不见 serve 的装配，而 smoke-serve 要真 key 才跑，
 * 于是没人跑它，也就没人看见那个红。
 *
 * 这一层验的是**协议与装配**，不验模型：握手鉴权、订阅、指令 fail-closed、
 * 一轮完整的 run（工具调用 → 文件改动 → 收尾）、seq 单调、断线补发。
 * 模型的行为由脚本化的 SSE 决定，所以它是确定性的——
 * 一次红就是一次真的回归，不是 provider 抖动。
 *
 * ## 假 provider 的形状
 *
 * 一个 `Bun.serve`，按调用次数返回不同的 SSE：第一轮发工具调用，
 * 第二轮发文本并收尾。这样才走得到「工具执行 → 结果回灌 → 再请求」
 * 那条最容易在装配上出错的路——只发一轮文本的话，
 * 整个工具链路一行都没被执行到。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, EventEnvelope } from '@qywork/core'
import { PROTOCOL_VERSION } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { ContentStore, contentPathFor, Store } from '@qywork/store'
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
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.text()
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

beforeAll(async () => {
  ws_dir = await mkdtemp(join(tmpdir(), 'qywork-e2e-'))
  await writeFile(join(ws_dir, 'calc.js'), 'module.exports = { add: (a, b) => a + b }\n', 'utf8')

  const dbPath = join(ws_dir, 'e2e.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  const config: QyConfig = {
    active: 'fake',
    profiles: {
      fake: {
        kind: 'openai_responses',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      },
    },
    mode: 'auto',
  }

  handle = serve({
    store,
    config,
    workspaceRoot: ws_dir,
    content,
    port: 0,
    host: '127.0.0.1',
  })
})

afterAll(async () => {
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
  test('健康检查免鉴权，且回报协议版本', async () => {
    const r = (await (await fetch(`${base()}/api/health`)).json()) as {
      ok?: boolean
      protocolVersion?: number
    }
    expect(r.ok).toBe(true)
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  test('无令牌 / 错令牌一律 401', async () => {
    expect((await fetch(`${base()}/api/workspaces`)).status).toBe(401)
    const bad = await fetch(`${base()}/api/workspaces`, {
      headers: { authorization: `Bearer ${'0'.repeat(handle.token.length)}` },
    })
    expect(bad.status).toBe(401)
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
    let helloOk: { type?: string; capabilities?: { pty?: boolean } } | null = null
    let permissionAsks = 0
    const done = Promise.withResolvers<void>()

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.ok') {
        helloOk = msg
        return
      }
      if (msg.type === 'command.rejected') {
        rejections.push(msg)
        return
      }
      if (!msg.seq || !msg.event) return
      frames.push(msg)
      const ev = msg.event as AgentEvent
      if (ev.type === 'permission.request') permissionAsks++
      if (ev.type === 'run.finished' || ev.type === 'run.error') done.resolve()
    })

    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })

    ws.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        token: handle.token,
        origin: 'desktop',
        subscribe: [conversationId],
      }),
    )
    await Bun.sleep(200)
    expect((helloOk as { type?: string } | null)?.type).toBe('hello.ok')

    // 指令 fail-closed：未实现的指令必须有回执。
    // 静默吞掉的话，客户端永远等不到反馈，而「服务端正在处理」与
    // 「服务端根本没收到」在界面上完全无法区分。
    ws.send(JSON.stringify({ type: 'no.such.command' }))
    await Bun.sleep(150)
    expect(rejections.some((r) => r.reason === 'unknown_command')).toBe(true)

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

    /*
     * **两模式的核心事实**：裁决在本地做，不弹窗、不往 WebSocket 上发请求。
     *
     * 这条断言就是 §29.2 那条坏掉的断言的替代品。原来的
     * `permissionAsks > 0` 验的行为已经不存在了，而它红在一个
     * 「要真 key 才跑」的脚本里，于是很久没人看见。
     */
    expect(permissionAsks).toBe(0)

    // seq 严格单调递增：断线补发的缺口计算全靠它。
    const seqs = frames.map((f) => f.seq)
    expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] as number))).toBe(true)

    // 断线补发：从中途的 seq 要能补出后面全部，已同步的补出空。
    const mid = seqs[Math.floor(seqs.length / 2)] as number
    expect(handle.bus.replayFrom(mid)?.length ?? 0).toBeGreaterThan(0)
    expect(handle.bus.replayFrom(handle.bus.currentSeq)?.length).toBe(0)

    ws.close()
  }, 30_000)
})
