/**
 * 接口拒绝图片输入后，本轮移除图片重发，同一会话之后不再向该接口发送图片。
 *
 * 覆盖范围：`agent/loop/attempt.ts` 的被拒分支、`agent/loop/index.ts` 的图片发送状态、
 * `session/turn/history.ts` 从会话记录推导该状态、`tools/files.ts` 读取图片时的直接返回、
 * `store/repos/steps.ts` 的记录写入与查询。经真实 `Session`、真实 `read_file`、真实 `Store` 与本地 HTTP 端点执行。
 *
 * 原始失败形状：`read_file` 读取图片成功，携带图片的下一次请求被 400 拒绝，本轮失败；
 * 图片留在之后的每次请求中，继续执行时再次被拒。断言针对端点实际收到的请求体。
 */

import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId } from '@qywork/core'
import {
  ContentStore,
  conversationRejectsImages,
  listProviderRequests,
  listRuns,
  listSteps,
  Store,
} from '@qywork/store'
import type { QyConfig } from './config.ts'
import { Session } from './session.ts'

const blobs = new ContentStore(':memory:')

/** 1×1 的 PNG：在缩放上限以内，`read_file` 按原样编码。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 第三方接口的后付费合约只包含文本时返回的正文，取自 2026-10-13 的失败记录。 */
const CONTRACT_REJECTION = {
  code: 'POSTPAID_REQUEST_NOT_INCLUDED',
  message: 'This contract currently includes text input and output only',
}

function sse(events: unknown[]): Response {
  return new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const USAGE = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }

function toolCall(id: string): Response {
  return sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'shot.png' }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    USAGE,
  ])
}

function text(content: string): Response {
  return sse([
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    USAGE,
  ])
}

/**
 * 经真实 `Session` 执行的夹具。端点对每个请求调用 `respond`，参数是请求体原文；
 * 每次 `ask` 前新建 `Session`，状态只能从同一个 `Store` 中的会话记录推导。
 */
async function harness(respond: (body: string) => Response) {
  const bodies: string[] = []
  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      bodies.push(body)
      return respond(body)
    },
  })
  const store = new Store({ path: ':memory:' })
  const config: QyConfig = {
    active: { provider: 'relay', model: 'claude-opus-5-5' },
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'claude-opus-5-5': {} },
      },
    },
  }
  const workspaceRoot = await mkdtemp(
    join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'image-rejection-'),
  )
  await writeFile(join(workspaceRoot, 'shot.png'), PNG_1X1)
  let conversationId: ConversationId | undefined
  const sessions: Session[] = []
  const ask = async (prompt: string) => {
    const session = new Session({
      content: blobs,
      store,
      config,
      workspaceRoot,
      signal: new AbortController().signal,
      allowedTools: ['read_file'],
    })
    sessions.push(session)
    const events: AgentEvent[] = []
    for await (const ev of session.ask(prompt, conversationId)) {
      events.push(ev)
      if (ev.type === 'run.started') conversationId = ev.conversationId as ConversationId
    }
    return events
  }
  const runs = () => listRuns(store, conversationId!)
  const close = async () => {
    await Promise.all(sessions.map((session) => session.dispose()))
    store.close()
    await provider.stop(true)
  }
  return { bodies, store, ask, runs, close }
}

function finished(events: AgentEvent[]) {
  return events.find(
    (e): e is Extract<AgentEvent, { type: 'run.finished' }> => e.type === 'run.finished',
  )
}

const hasImage = (body: string) => body.includes('"image_url"')

test('接口拒绝图片后本轮移除图片重发，同一会话之后不再发送图片', async () => {
  /*
   * 端点：请求体含图像块即返回 400；其余请求依次取出脚本中的下一项。
   * 被拒的请求不消耗脚本，因此脚本只描述模型的正常回复。
   */
  const script: (() => Response)[] = [
    () => toolCall('call_1'),
    () => text('图片无法查看。'),
    () => toolCall('call_2'),
    () => text('仍无法查看图片。'),
  ]
  const h = await harness((body) => {
    if (hasImage(body)) return Response.json(CONTRACT_REJECTION, { status: 400 })
    return (script.shift() ?? (() => text('完成')))()
  })
  try {
    // 第一轮：读取图片 → 携带图片的请求被拒 → 移除图片后重发 → 本轮完成。
    const firstEvents = await h.ask('看图')
    expect(firstEvents.filter((e) => e.type === 'run.error')).toEqual([])
    expect(finished(firstEvents)?.status).toBe('done')
    expect(h.bodies.map(hasImage)).toEqual([false, true, false])
    expect(h.bodies[2]).toContain('接口拒绝图片输入，此图片未发送')
    expect(h.bodies[2]).toContain(CONTRACT_REJECTION.message)

    const firstRun = h.runs()[0]!
    const rows = listProviderRequests(h.store, firstRun.id).filter((r) => r.purpose === 'turn')
    expect(rows.map((r) => r.status)).toEqual(['received', 'rejected', 'received'])
    expect(rows[1]!.diagnostic?.retry.decision).toBe('images_removed')

    // 未送达的那次读取：工具 step 带有标记，实时事件携带同一个 step id。
    const readStep = listSteps(h.store, firstRun.id).find((s) => s.toolCallId === 'call_1')!
    expect(readStep.status).toBe('success')
    expect(readStep.payload).toMatchObject({ kind: 'tool_result', imagesUndelivered: true })
    expect(firstEvents).toContainEqual({
      type: 'tool.images_undelivered',
      runId: firstRun.id,
      stepIds: [readStep.id],
    })

    // 第二轮：请求不再携带图片，读取图片直接返回。
    const secondEvents = await h.ask('再看一次')
    expect(finished(secondEvents)?.status).toBe('done')
    expect(h.bodies).toHaveLength(5)
    expect(h.bodies.slice(3).some(hasImage)).toBe(false)
    const secondRun = h.runs()[1]!
    const reread = listSteps(h.store, secondRun.id).find((s) => s.toolCallId === 'call_2')!
    expect(reread.status).toBe('failure')
    expect(reread.payload).toMatchObject({
      kind: 'tool_result',
      outcome: { message: '接口拒绝图片输入，shot.png 未读取。' },
    })
    expect(listProviderRequests(h.store, secondRun.id).every((r) => r.status === 'received')).toBe(
      true,
    )
  } finally {
    await h.close()
  }
}, 20_000)

/** 失败路径的终态：移除图片后重发仍被拒，说明原因不在图片，本轮按不可重发的错误结束，只重发一次。 */
test('移除图片后重发仍被拒时本轮结束并显示接口原文', async () => {
  let first = true
  const h = await harness(() => {
    if (first) {
      first = false
      return toolCall('call_1')
    }
    return Response.json(CONTRACT_REJECTION, { status: 400 })
  })
  try {
    const events = await h.ask('看图')
    expect(finished(events)?.status).toBe('failed')
    expect(events.filter((e) => e.type === 'run.error')).toEqual([
      {
        type: 'run.error',
        runId: h.runs()[0]!.id,
        code: 'invalid_request',
        message: `HTTP 400 请求无效：${CONTRACT_REJECTION.message}`,
      },
    ])
    expect(h.bodies.map(hasImage)).toEqual([false, true, false])
    const decisions = listProviderRequests(h.store, h.runs()[0]!.id)
      .filter((r) => r.status === 'rejected')
      .map((r) => r.diagnostic?.retry.decision)
    expect(decisions).toEqual(['images_removed', 'not_retryable'])
    // 原因不在图片：执行事实与未送达标记都不写入，继续执行时照常发送图片。
    expect(events.some((e) => e.type === 'tool.images_undelivered')).toBe(false)
    expect(
      conversationRejectsImages(h.store, h.runs()[0]!.conversationId, 'relay', 'claude-opus-5-5'),
    ).toBe(false)
    const readStep = listSteps(h.store, h.runs()[0]!.id).find((s) => s.toolCallId === 'call_1')!
    expect(readStep.payload).not.toHaveProperty('imagesUndelivered')
  } finally {
    await h.close()
  }
}, 20_000)

/** 413 的原因是请求体大小，不是接口不接受图片：不移除图片、不写入记录，本轮按现有方式结束。 */
test('带图片的请求被 413 拒绝时不按接口拒绝图片处理', async () => {
  let first = true
  const h = await harness(() => {
    if (first) {
      first = false
      return toolCall('call_1')
    }
    return new Response('<html>413 Request Entity Too Large</html>', { status: 413 })
  })
  try {
    const events = await h.ask('看图')
    expect(finished(events)?.status).toBe('failed')
    expect(h.bodies.map(hasImage)).toEqual([false, true])
    const decisions = listProviderRequests(h.store, h.runs()[0]!.id)
      .filter((r) => r.status === 'rejected')
      .map((r) => r.diagnostic?.retry.decision)
    expect(decisions).toEqual(['not_retryable'])
    expect(
      conversationRejectsImages(h.store, h.runs()[0]!.conversationId, 'relay', 'claude-opus-5-5'),
    ).toBe(false)
  } finally {
    await h.close()
  }
}, 20_000)
