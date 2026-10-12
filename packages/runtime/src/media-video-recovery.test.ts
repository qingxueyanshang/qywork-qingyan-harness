/** 通过真实端口核对视频提交不确定时防重发，以及原任务恢复不会 POST。 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { QyConfig } from './config.ts'
import { makeMediaPort } from './media.ts'

let server: ReturnType<typeof Bun.serve>
let status = 502
let methods: string[] = []
beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      methods.push(req.method)
      if (req.method === 'POST') return new Response('provider error', { status })
      if (new URL(req.url).pathname.endsWith('/content'))
        return new Response(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), {
          headers: { 'content-type': 'video/mp4' },
        })
      return Response.json({ status: 'completed' })
    },
  })
})
afterAll(() => server.stop(true))
const config = (): QyConfig => ({
  providers: {
    test: {
      kind: 'openai_chat_completions',
      models: {},
      apiKey: 'test',
      baseUrl: `http://127.0.0.1:${server.port}`,
      media: { video: { kind: 'openai_videos' } },
    },
  },
  mediaDefaults: { video: { provider: 'test', model: 'video' } },
})
const call = { type: 'video' as const, inputs: [], params: {}, prompt: '日落' }
test('网关提交结果未知后阻止同轮新生成，但允许取回原任务和用户下一轮明确发起', async () => {
  methods = []
  status = 502
  const media = makeMediaPort(config())
  const signal = new AbortController().signal
  expect(await media.generate(call, signal)).toMatchObject({
    ok: false,
    diagnostic: { stage: 'generate', outcome: 'unknown' },
  })
  expect(await media.generate(call, signal)).toMatchObject({
    ok: false,
    executed: false,
    message: expect.stringContaining('本轮视频结果尚未确认'),
  })
  expect(methods).toEqual(['POST'])
  expect(await media.generate({ ...call, resumeTaskId: 'existing' }, signal)).toMatchObject({
    ok: true,
  })
  expect(methods).toEqual(['POST', 'GET', 'GET'])
  await makeMediaPort(config()).generate(call, signal)
  expect(methods).toEqual(['POST', 'GET', 'GET', 'POST'])
})
test('余额不足等明确拒绝保留失败原文，不误判为结果未知', async () => {
  methods = []
  status = 402
  const media = makeMediaPort(config())
  const signal = new AbortController().signal
  expect(await media.generate(call, signal)).toMatchObject({
    ok: false,
    diagnostic: { outcome: 'rejected' },
  })
  expect(await media.generate(call, signal)).not.toHaveProperty('executed', false)
  expect(methods).toEqual(['POST', 'POST'])
})
