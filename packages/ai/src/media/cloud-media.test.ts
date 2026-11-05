/**
 * 覆盖 `adapters/qywork.ts`（云端生成协议）与 `catalog.ts` 中云端规格的取得：参数表按原协议、报价按云端单价。
 * 云端是本文件中的模拟服务，按云端 `/v1/media/jobs` 的形状应答。
 */

import { afterAll, expect, test } from 'bun:test'
import type { StoredMediaSpec } from '@qywork/core'
import { lookupMediaModel, quoteMedia } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { MediaError } from './types.ts'

const submitted: { request: unknown; files: string[] }[] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (req.headers.get('authorization') !== 'Bearer device-key')
      return new Response('unauthorized', { status: 401 })
    if (req.method === 'POST' && path === '/v1/media/jobs') {
      const form = await req.formData()
      const request = JSON.parse(String(form.get('request'))) as { model: string }
      submitted.push({ request, files: [...form.keys()].filter((k) => k !== 'request') })
      return Response.json(
        { id: request.model === 'lost' ? 'mj_lost' : 'mj_ok', status: 'queued' },
        { status: 201 },
      )
    }
    if (path === '/v1/media/jobs/mj_ok')
      return Response.json({
        status: 'succeeded',
        error: null,
        unknownReason: null,
        credits: 0.4,
        files: 2,
      })
    if (path === '/v1/media/jobs/mj_lost')
      return Response.json({
        status: 'unknown',
        error: null,
        unknownReason: 'submit_lost',
        credits: 0,
        files: 0,
      })
    if (path.startsWith('/v1/media/jobs/mj_ok/files/'))
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { 'content-type': 'image/png' },
      })
    if (path === '/v1/media/jobs/mj_started/cancel')
      return Response.json(
        { error: { code: 'already_started', message: '上游已开始生成，无法撤销' } },
        { status: 409 },
      )
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => server.stop(true))

const spec: StoredMediaSpec = {
  cloud: { kind: 'openai_images', spec: { base: 'gpt-image-2' }, unit: 'image', unitPrice: 0.2 },
}
const adapter = (model: string) =>
  buildMediaAdapter({
    kind: 'qywork_images',
    model,
    apiKey: 'device-key',
    baseUrl: `http://127.0.0.1:${server.port}`,
    spec,
  })
const run = (model: string) =>
  adapter(model).run(
    {
      operation: 'generate',
      prompt: '猫',
      inputs: [{ role: 'reference', bytes: new Uint8Array([1]), mime: 'image/png', path: '' }],
      params: { n: 2 },
    },
    { signal: new AbortController().signal },
  )

test('云端规格：参数表与操作按原协议取得，协议为云端协议；发送前按云端单价报价', () => {
  const s = lookupMediaModel('cloud-image', 'qywork_images', spec)
  expect(s.kind).toBe('qywork_images')
  expect(s.operations).toEqual(['generate', 'edit'])
  expect(s.params.map((p) => p.name)).toContain('n')
  expect(quoteMedia(s, { n: 3 }, { images: 0, videos: 0 })).toEqual({
    cost: 0.6000000000000001,
    currency: 'CREDIT',
  })
})

test('提交到云端任务接口，取回全部结果文件；金额取云端回报的扣费', async () => {
  const result = await run('cloud-image')
  expect(submitted.at(-1)).toEqual({
    request: {
      model: 'cloud-image',
      operation: 'generate',
      prompt: '猫',
      params: { n: 2 },
      mimes: ['image/png'],
    },
    files: ['input.reference'],
  })
  expect(result.files).toHaveLength(2)
  expect(result.files[0]?.mime).toBe('image/png')
  expect(result.usage).toEqual({ images: 2, billed: { amount: 0.4, currency: 'CREDIT' } })
})

test('云端任务结果不明时以终态失败返回原因，不带任务号（云端已退回，不再接续）', async () => {
  const err = await run('lost').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(MediaError)
  expect((err as MediaError).message).toContain('结果不明，积分已退回：提交时连接中断')
  expect((err as MediaError).pendingTaskId).toBeUndefined()
})

test('撤销：云端回答上游已开始生成时为 started（按结果计费）', async () => {
  expect(await adapter('x').cancel?.('mj_started', new AbortController().signal)).toBe('started')
})
