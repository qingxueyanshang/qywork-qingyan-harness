/** 各协议的陌生状态不能变成假排队或终态失败；恢复必须沿用原任务，不产生新 POST。 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { MediaKind } from '@qywork/core'
import { buildMediaAdapter } from './index.ts'
import { taskPhase } from './task.ts'
import { MediaError } from './types.ts'

let server: ReturnType<typeof Bun.serve>
let reply: Record<string, unknown> = {}
let calls: string[] = []
beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      calls.push(req.method)
      if (new URL(req.url).pathname.endsWith('/content'))
        return new Response(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), {
          headers: { 'content-type': 'video/mp4' },
        })
      return Response.json(reply)
    },
  })
})
afterAll(() => server.stop(true))
const request = { operation: 'text_to_video' as const, prompt: '', inputs: [], params: {} }
const taskId = 'saved-task'

test.each([false, true])(
  'multipart 提交不重发，缺失回执或保存失败保留准确状态：id=%s',
  async (hasId) => {
    calls = []
    reply = hasId ? { id: taskId } : {}
    const adapter = buildMediaAdapter({
      kind: 'openai_videos',
      model: 'video-sd25-30s',
      apiKey: 'test',
      baseUrl: `http://127.0.0.1:${server.port}`,
    })
    let submits = 0
    const error = await adapter
      .run(
        {
          ...request,
          operation: 'reference_to_video',
          inputs: [
            {
              role: 'reference',
              bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
              mime: 'image/png',
              path: '/ref.png',
            },
          ],
        },
        {
          signal: new AbortController().signal,
          onSubmit: () => {
            submits++
          },
          onTask: async () => {
            throw new Error('save failed')
          },
        },
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MediaError)
    expect(calls).toEqual(['POST'])
    expect(submits).toBe(1)
    if (hasId) expect((error as MediaError).pendingTaskId).toBe(taskId)
    else expect((error as MediaError).diagnostic?.outcome).toBe('unknown')
  },
)

const cases: {
  kind: MediaKind
  model?: string
  body: (status?: string) => Record<string, unknown>
}[] = [
  { kind: 'openai_videos', body: (status) => ({ status }) },
  {
    kind: 'openai_videos',
    model: 'video-sd25-30s',
    body: (status) => ({ data: { status } }),
  },
  { kind: 'ark_videos', body: (status) => ({ status }) },
  { kind: 'dashscope_videos', body: (status) => ({ output: { task_status: status } }) },
  { kind: 'kling_videos', body: (status) => ({ code: 0, data: [{ id: taskId, status }] }) },
  { kind: 'gemini_videos', body: (status) => ({ id: taskId, status }) },
  { kind: 'xai_videos', body: (status) => ({ status }) },
]
for (const item of cases) {
  for (const status of [
    undefined,
    'unrecognized-status',
    ...(item.kind === 'dashscope_videos' ? ['UNKNOWN'] : []),
  ]) {
    test(`${item.model ?? item.kind} ${status ?? '缺失状态'} 保留任务号且不冒充排队`, async () => {
      calls = []
      reply = item.body(status)
      const adapter = buildMediaAdapter({
        kind: item.kind,
        model: item.model ?? 'test',
        apiKey: 'test',
        baseUrl: `http://127.0.0.1:${server.port}`,
      })
      const phases: string[] = []
      const error = await adapter
        .run(request, {
          signal: new AbortController().signal,
          resumeTaskId: taskId,
          onStatus: (s) => phases.push(s),
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MediaError)
      expect((error as MediaError).pendingTaskId).toBe(taskId)
      expect(phases).toEqual([])
      expect(calls).toEqual(['GET'])
    })
  }
}

for (const kind of [
  'openai_videos',
  'ark_videos',
  'dashscope_videos',
  'kling_videos',
  'gemini_videos',
  'veo_videos',
  'xai_videos',
] as const) {
  test(`${kind} 提交返回 200 但无任务号时结果未知，仅发送一次`, async () => {
    calls = []
    reply = {}
    const adapter = buildMediaAdapter({
      kind,
      model: 'test',
      apiKey: 'test',
      baseUrl: `http://127.0.0.1:${server.port}`,
    })
    const tasks: string[] = []
    const error = await adapter
      .run(request, {
        signal: new AbortController().signal,
        onTask: (id) => {
          tasks.push(id)
        },
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MediaError)
    expect((error as MediaError).diagnostic).toMatchObject({
      stage: 'generate',
      outcome: 'unknown',
      status: 200,
    })
    expect(tasks).toEqual([])
    expect(calls).toEqual(['POST'])
  })
}

test('收到有效任务号后本地保存出错仍返回原任务号，不重发生成', async () => {
  calls = []
  reply = { id: taskId }
  const adapter = buildMediaAdapter({
    kind: 'openai_videos',
    model: 'test',
    apiKey: 'test',
    baseUrl: `http://127.0.0.1:${server.port}`,
  })
  await expect(
    adapter.run(request, {
      signal: new AbortController().signal,
      onTask: () => {
        throw new Error('写入失败')
      },
    }),
  ).rejects.toMatchObject({ pendingTaskId: taskId, message: expect.stringContaining('写入失败') })
  expect(calls).toEqual(['POST'])
})

test('xAI pending 显示生成中，百炼 PENDING 仍为排队中', async () => {
  calls = []
  reply = { status: 'pending' }
  const abort = new AbortController()
  const phases: (string | null)[] = []
  const adapter = buildMediaAdapter({
    kind: 'xai_videos',
    model: 'test',
    apiKey: 'test',
    baseUrl: `http://127.0.0.1:${server.port}`,
  })
  await adapter
    .run(request, {
      signal: abort.signal,
      resumeTaskId: taskId,
      onStatus: (s) => {
        phases.push(taskPhase(s))
        abort.abort()
      },
    })
    .catch(() => {})
  expect(phases).toEqual(['running'])
  expect(taskPhase('PENDING')).toBe('queued')
  expect(calls).toEqual(['GET'])
})

test('异常查询后再次取回只查询、下载原任务，不重新 POST', async () => {
  calls = []
  const adapter = buildMediaAdapter({
    kind: 'openai_videos',
    model: 'test',
    apiKey: 'test',
    baseUrl: `http://127.0.0.1:${server.port}`,
  })
  const opts = { signal: new AbortController().signal, resumeTaskId: taskId }
  reply = {}
  await expect(adapter.run(request, opts)).rejects.toMatchObject({ pendingTaskId: taskId })
  reply = { status: 'completed' }
  expect((await adapter.run(request, opts)).files).toHaveLength(1)
  expect(calls).toEqual(['GET', 'GET', 'GET'])
})

test('Veo 空查询响应保留任务；仅携带 name 的未完成 Operation 仍能继续等待', async () => {
  const id = 'operations/veo-task'
  const adapter = buildMediaAdapter({
    kind: 'veo_videos',
    model: 'test',
    apiKey: 'test',
    baseUrl: `http://127.0.0.1:${server.port}`,
  })
  calls = []
  reply = {}
  await expect(
    adapter.run(request, { signal: new AbortController().signal, resumeTaskId: id }),
  ).rejects.toMatchObject({ pendingTaskId: id })
  expect(calls).toEqual(['GET'])
  reply = { name: id }
  const abort = new AbortController()
  const phases: (string | null)[] = []
  await adapter
    .run(request, {
      signal: abort.signal,
      resumeTaskId: id,
      onStatus: (s) => {
        phases.push(taskPhase(s))
        abort.abort()
      },
    })
    .catch(() => {})
  expect(phases).toEqual(['running'])
  expect(calls).toEqual(['GET', 'GET'])
})

for (const [kind, body] of [
  ['ark_videos', { status: 'succeeded', content: {} }],
  ['dashscope_videos', { output: { task_status: 'SUCCEEDED' } }],
  ['kling_videos', { data: [{ id: taskId, status: 'succeeded', outputs: [] }] }],
  ['xai_videos', { status: 'done', video: {} }],
  ['gemini_videos', { status: 'completed', steps: [] }],
  ['veo_videos', { done: true, response: {} }],
] as const) {
  test(`${kind} 成功回执缺少产物时保留原任务，不误报远端失败`, async () => {
    calls = []
    reply = body
    const id = kind === 'veo_videos' ? 'operations/veo-task' : taskId
    const adapter = buildMediaAdapter({
      kind,
      model: 'test',
      apiKey: 'test',
      baseUrl: `http://127.0.0.1:${server.port}`,
    })
    await expect(
      adapter.run(request, { signal: new AbortController().signal, resumeTaskId: id }),
    ).rejects.toMatchObject({ pendingTaskId: id })
    expect(calls).toEqual(['GET'])
  })
}
