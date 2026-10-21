/**
 * 覆盖 `index.ts`（拉取型号）：本地服务按 2026-10-21 取得的 hongcheng 与木木响应片段应答，
 * 核对分类、渠道规格、价格，以及没有计费清单时退回型号列表。
 */

import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PullError, pullModels } from './index.ts'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '../fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >

const servers: ReturnType<typeof Bun.serve>[] = []
afterAll(() => {
  for (const s of servers) s.stop(true)
})

/** 公开接口按地址的来源（origin）请求，因此每个站点一个本地服务。 */
function site(routes: Record<string, unknown>) {
  const seen: { path: string; auth: string | null }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      seen.push({ path, auth: req.headers.get('authorization') })
      return path in routes
        ? Response.json(routes[path])
        : new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  return {
    seen,
    target: {
      kind: 'openai_chat_completions' as const,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'sk-test',
    },
  }
}

const signal = () => new AbortController().signal

test('木木：计费清单区分对话、图像与视频，视频带渠道规格与价格', async () => {
  const data = fixture('newapi-mumugofe.json')
  const { target, seen } = site({
    '/api/pricing': data.pricing,
    '/api/status': data.status,
    '/docs/typetale-models.json': data.typetale,
  })
  const result = await pullModels(target, signal())
  expect(result.source).toBe('pricing')
  const by = new Map(result.models.map((m) => [m.id, m]))
  expect(by.get('X-SD25-301010')).toEqual({
    id: 'X-SD25-301010',
    output: 'video',
    kind: 'openai_videos',
    spec: {
      channel: 'mumugofe',
      seconds: [30],
      ratios: ['16:9', '9:16'],
      resolutions: ['720p'],
      sizes: { '720p': [1280, 720] },
      maxImages: 30,
      maxVideos: 0,
      maxAudios: 0,
      publicUrls: true,
      price: { per: 'request', amount: 7, currency: 'CNY' },
    },
  })
  // 按尺寸分档的型号按分辨率档位分别保存单价。
  expect(by.get('007系列/sd2.5(30图10音/480P/720P)')).toMatchObject({
    output: 'video',
    spec: {
      resolutions: ['480p', '720p'],
      price: { per: 'second', amount: { '480p': 0.4, '720p': 0.6 }, currency: 'CNY' },
    },
  })
  // 表单上传；计费清单按请求中的 resolution 计价，规格标记提交时发送该字段，两档分别定价。
  expect(by.get('sd-2.0-vip')).toMatchObject({
    output: 'video',
    spec: {
      multipart: true,
      resolutionField: true,
      price: { per: 'second', amount: { '720p': 0.676, '1080p': 1.56 }, currency: 'CNY' },
    },
  })
  // 渠道说明：每次生成 1 张，0.052 元。
  expect(by.get('gpt-image-2')).toMatchObject({
    output: 'image',
    kind: 'openai_images',
    spec: {
      channel: 'mumugofe',
      resolutions: ['1K', '2K', '4K'],
      maxImages: 10,
      price: { per: 'request', amount: 0.052, currency: 'CNY' },
    },
  })
  expect(by.get('claude-sonnet-5-5')).toMatchObject({
    output: 'chat',
    known: true,
    price: { input: 1.8, output: 9, currency: 'CNY' },
  })
  expect(by.get('deepseek-v4.1-flash')).toMatchObject({
    id: 'deepseek-v4.1-flash',
    output: 'chat',
    known: false,
    price: { input: 1.04, output: 4.16, offPeak: { rate: 0.5 } },
  })
  // 公开接口不携带凭证。
  expect(seen.every((s) => s.auth === null)).toBe(true)
})

test('hongcheng：工作台目录给出规格，按秒与按次价格', async () => {
  const data = fixture('newapi-hongcheng.json')
  const { target } = site({
    '/api/pricing': data.pricing,
    '/api/status': data.status,
    '/api/workbench-models': data.workbench,
  })
  const result = await pullModels(target, signal())
  const by = new Map(result.models.map((m) => [m.id, m]))
  expect(by.get('TTseadanco2.5-720')).toMatchObject({
    output: 'video',
    spec: { channel: 'hongcheng', maxVideos: 10, price: { per: 'second', amount: 0.42 } },
  })
  expect(by.get('seedance-2.5-yy-720p')).toMatchObject({
    spec: { seconds: expect.arrayContaining([4, 30]), price: { per: 'request', amount: 7.3 } },
  })
  // 计费清单中有、工作台目录中没有的型号不带规格。
  expect(by.get('bb2.5')).toMatchObject({ output: 'video', kind: 'openai_videos' })
})

test('站点状态读取失败时价格不明，型号照常列出', async () => {
  const data = fixture('newapi-mumugofe.json')
  const { target } = site({ '/api/pricing': data.pricing })
  const result = await pullModels(target, signal())
  expect(result.models.find((m) => m.id === 'claude-sonnet-5-5')).toEqual({
    id: 'claude-sonnet-5-5',
    output: 'chat',
    known: true,
  })
})

test('没有计费清单时退回型号列表，带凭证请求，按生成目录归类', async () => {
  const { target, seen } = site({
    '/v1/models': { data: [{ id: 'gpt-5.6-sol' }, { id: 'veo-3.1-generate-preview' }] },
  })
  const result = await pullModels(target, signal())
  expect(result).toEqual({
    source: 'models',
    models: [
      { id: 'gpt-5.6-sol', output: 'chat', known: true },
      { id: 'veo-3.1-generate-preview', output: 'video', kind: 'veo_videos' },
    ],
  })
  expect(seen.find((s) => s.path === '/v1/models')?.auth).toBe('Bearer sk-test')
})

test('两种来源都无法读取时报告失败的地址', async () => {
  const { target } = site({})
  await expect(pullModels(target, signal())).rejects.toThrow(PullError)
  await expect(pullModels(target, signal())).rejects.toThrow('/v1/models 返回 HTTP 404')
})
