/**
 * 原生视频的两道处理：发送前按模型规格的时长范围改为抽帧说明；接口仍拒绝时，本轮改为说明重发，
 * 同一会话之后不再向该接口直接发送视频。
 *
 * 覆盖范围：`agent/loop/request.ts` 的 `runDensity` / `materialize` 对视频的处理、`agent/loop/attempt.ts`
 * 的被拒分支、`session.ts` 从会话记录推导该状态与附件的视频块、`store/repos.ts` 的记录写入与查询。
 * 经真实 `Session`、真实 `read_file`、真实 `Store` 与本地 HTTP 端点执行，断言针对端点实际收到的请求体。
 *
 * 原始失败形状：Qwen3.8 Flash 收到 0.5 秒的视频返回 400「The video file is too short」，整轮失败，
 * 视频留在之后的每次请求中，继续执行时再次被拒。
 */

import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ConversationId } from '@qywork/core'
import {
  ContentStore,
  conversationRejectsVideos,
  listProviderRequests,
  listRuns,
  Store,
} from '@qywork/store'
import type { QyConfig } from './config.ts'
import { Session } from './session.ts'

const blobs = new ContentStore(':memory:')

/** 百炼对过短视频返回的正文，取自 2026-10-27 的实测。 */
const TOO_SHORT = {
  error: {
    code: 'invalid_parameter_error',
    message:
      'The video modality input does not meet the requirements because: The video file is too short.',
  },
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

/** 只有索引的 mp4：`mvhd` 写入时长，`tkhd` 写入画面尺寸；时长与尺寸由 `videoMetaOf` 读出。 */
function mp4(seconds: number): Buffer {
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt32BE(1000, 12)
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16)
  const tkhd = Buffer.alloc(84)
  tkhd.writeInt32BE(0x10000, 40)
  tkhd.writeUInt32BE(640 * 65536, 76)
  tkhd.writeUInt32BE(360 * 65536, 80)
  return Buffer.concat([
    box('ftyp', Buffer.from('isom0000', 'latin1')),
    box('mdat', Buffer.alloc(4096)),
    box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd))),
  ])
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
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'clip.mp4' }) },
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

/** 经真实 `Session` 执行；模型为接受原生视频的 qwen3.8-flash，接口不能上传，视频以 base64 内联。 */
async function harness(respond: (body: string) => Response, seconds: number) {
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
    active: { provider: 'relay', model: 'qwen3.8-flash' },
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'qwen3.8-flash': {} },
      },
    },
  }
  const workspaceRoot = await mkdtemp(
    join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'video-rejection-'),
  )
  await writeFile(join(workspaceRoot, 'clip.mp4'), mp4(seconds))
  let conversationId: ConversationId | undefined
  const sessions: Session[] = []
  const ask = async (prompt: string, withClip = false) => {
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
    for await (const ev of session.ask(
      prompt,
      conversationId,
      withClip
        ? {
            attachments: [
              { type: 'video', name: 'clip.mp4', mime: 'video/mp4', size: 0, path: 'clip.mp4' },
            ],
          }
        : undefined,
    )) {
      events.push(ev)
      if (ev.type === 'run.started') conversationId = ev.conversationId as ConversationId
    }
    return events
  }
  const runs = () => listRuns(store, conversationId!)
  const close = () => {
    for (const session of sessions) session.dispose()
    store.close()
    provider.stop(true)
  }
  return { bodies, store, ask, runs, close }
}

function finished(events: AgentEvent[]) {
  return events.find(
    (e): e is Extract<AgentEvent, { type: 'run.finished' }> => e.type === 'run.finished',
  )
}

const hasVideo = (body: string) => body.includes('"video_url"')

test('接口拒绝视频后本轮改为抽帧说明重发，同一会话之后不再直接发送视频', async () => {
  const script: (() => Response)[] = [
    () => toolCall('call_1'),
    () => text('视频无法直接查看。'),
    () => toolCall('call_2'),
    () => text('完成'),
  ]
  const h = await harness((body) => {
    if (hasVideo(body)) return Response.json(TOO_SHORT, { status: 400 })
    return (script.shift() ?? (() => text('完成')))()
  }, 10)
  try {
    // 第一轮：读取视频 → 携带视频的请求被拒 → 视频改为说明后重发 → 本轮完成。
    const firstEvents = await h.ask('看视频')
    expect(firstEvents.filter((e) => e.type === 'run.error')).toEqual([])
    expect(finished(firstEvents)?.status).toBe('done')
    expect(h.bodies.map(hasVideo)).toEqual([false, true, false])
    expect(h.bodies[2]).toContain('接口拒绝视频输入，此视频未发送')
    expect(h.bodies[2]).toContain('read_file')
    expect(h.bodies[2]).toContain('The video file is too short')

    const firstRun = h.runs()[0]!
    const rows = listProviderRequests(h.store, firstRun.id).filter((r) => r.purpose === 'turn')
    expect(rows.map((r) => r.status)).toEqual(['received', 'rejected', 'received'])
    expect(rows[1]!.diagnostic?.retry.decision).toBe('videos_removed')
    expect(
      conversationRejectsVideos(h.store, firstRun.conversationId, 'relay', 'qwen3.8-flash'),
    ).toBe(true)

    // 第二轮：再次读取视频时改为抽帧，之后的请求都不再直接携带视频。
    const secondEvents = await h.ask('再看一次')
    expect(finished(secondEvents)?.status).toBe('done')
    expect(h.bodies.length).toBeGreaterThan(3)
    expect(h.bodies.slice(3).some(hasVideo)).toBe(false)
  } finally {
    h.close()
  }
}, 20_000)

test('时长短于模型规格的视频附件发送前即改为说明，不发出必然被拒的请求', async () => {
  const h = await harness((body) => {
    if (hasVideo(body)) return Response.json(TOO_SHORT, { status: 400 })
    return text('收到')
  }, 0.5)
  try {
    const events = await h.ask('这是录制好的视频', true)
    expect(finished(events)?.status).toBe('done')
    expect(h.bodies).toHaveLength(1)
    expect(hasVideo(h.bodies[0]!)).toBe(false)
    expect(h.bodies[0]).toContain('该视频时长 0.5 秒，短于当前模型接受的 2 秒，未直接发送')
    expect(h.bodies[0]).toContain('read_file')
    const rows = listProviderRequests(h.store, h.runs()[0]!.id)
    expect(rows.map((r) => r.status)).toEqual(['received'])
  } finally {
    h.close()
  }
}, 20_000)
