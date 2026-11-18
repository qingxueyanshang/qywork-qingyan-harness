/**
 * 覆盖 `extension.ts` 的两个登记接口，及其在 `catalog.ts`（`lookupMediaModel`、`meterParamsFor`、`cloudModelSpec`）、
 * `index.ts`（`buildMediaAdapter`）、`adapters/openai-videos.ts`（`openAIVideosAdapter` 的请求结构）与
 * `@qywork/core`（`mediaKindOutput`、`isMediaKind`、`defaultMediaKind`）中的效果。协议名、渠道名与主机名为合成数据。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  defaultMediaKind,
  isMediaKind,
  type MediaKind,
  mediaKindOutput,
  mediaKinds,
  registerMediaKind,
} from '@qywork/core'
import { openAIVideosAdapter } from './adapters/openai-videos.ts'
import { cloudModelSpec, lookupMediaModel, type MediaModelSpec, meterParamsFor } from './catalog.ts'
import { registerMediaChannel, registerMediaProtocol } from './extension.ts'
import { buildMediaAdapter } from './index.ts'
import type { MediaProfile } from './types.ts'

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])

let server: ReturnType<typeof Bun.serve>
const bodies: Record<string, unknown>[] = []
beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path === '/v1/videos') {
        bodies.push((await req.json()) as Record<string, unknown>)
        return Response.json({ id: 'task_1' })
      }
      if (path === '/v1/videos/task_1') return Response.json({ status: 'completed', seconds: '6' })
      if (path === '/v1/videos/task_1/content')
        return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
      return new Response('unexpected route', { status: 400 })
    },
  })
})
afterAll(() => server.stop(true))

/** 登记的协议：类别、主机名默认、协议默认规格、计量参数名与适配器。 */
const EXAMPLE_VIDEOS = registerMediaProtocol({
  kind: 'example_videos',
  output: 'video',
  hosts: ['video.example.com'],
  defaults: {
    vendor: null,
    operations: ['text_to_video'],
    inputs: { maxImages: 0, maxVideos: 0, transport: 'json' },
    params: [{ name: 'length', type: 'integer', description: '时长（秒）' }],
    catalogued: false,
  },
  meter: { seconds: 'length' },
  adapter: (profile, spec) => ({
    kind: profile.kind,
    spec,
    run: async () => ({ files: [{ bytes: MP4, mime: 'video/mp4' }] }),
  }),
})

/** 登记的渠道：只在 `openai_videos` 上使用保存的规格，请求结构另给。 */
registerMediaChannel({
  id: 'example',
  spec: (id, kind, saved) =>
    kind === 'openai_videos'
      ? ({
          ...lookupMediaModel(id, kind),
          vendor: 'Example',
          params: [{ name: 'seconds', type: 'string', default: '6', description: '时长' }],
          catalogued: true,
          displayName: (saved as { label?: string }).label ?? id,
        } satisfies MediaModelSpec)
      : undefined,
  adapter: (profile, spec) =>
    openAIVideosAdapter(profile, spec, {
      payload: async (req, ctx) => ({ seconds: req.params.seconds ?? '6', via: ctx.spec.vendor }),
    }),
})

const profile = (kind: MediaKind, spec?: MediaProfile['spec']): MediaProfile => ({
  kind,
  model: 'video-a',
  apiKey: 'sk-test',
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
  ...(spec ? { spec } : {}),
})

test('登记的协议有类别、计量参数名与协议默认规格，并作为该主机名的默认视频协议', () => {
  expect(mediaKindOutput(EXAMPLE_VIDEOS)).toBe('video')
  expect(isMediaKind('example_videos')).toBe(true)
  expect(isMediaKind('missing_videos')).toBe(false)
  expect(mediaKinds()).toContain(EXAMPLE_VIDEOS)
  expect(meterParamsFor(EXAMPLE_VIDEOS)).toEqual({ seconds: 'length' })
  expect(lookupMediaModel('video-a', EXAMPLE_VIDEOS)).toMatchObject({
    id: 'video-a',
    kind: EXAMPLE_VIDEOS,
    catalogued: false,
    params: [{ name: 'length' }],
  })
  expect(cloudModelSpec('video-a', EXAMPLE_VIDEOS).meter).toEqual({ seconds: 'length' })
  expect(defaultMediaKind('video', 'https://video.example.com/v1')).toBe(EXAMPLE_VIDEOS)
  expect(defaultMediaKind('image', 'https://video.example.com/v1')).toBe('openai_images')
  expect(defaultMediaKind('video', 'https://other.example.com/v1')).toBe('openai_videos')
})

test('协议名已存在时登记失败', () => {
  expect(() => registerMediaKind('openai_videos', 'video')).toThrow('已存在')
  expect(() => registerMediaKind('example_videos', 'video')).toThrow('已存在')
  expect(() => registerMediaChannel({ id: 'example', spec: () => undefined })).toThrow('已登记')
})

test('登记的协议按登记的适配器构造；未登记的协议构造失败，不按其他协议发送', async () => {
  const adapter = buildMediaAdapter(profile(EXAMPLE_VIDEOS))
  expect(adapter.kind).toBe(EXAMPLE_VIDEOS)
  const result = await adapter.run(
    { operation: 'text_to_video', prompt: 'p', inputs: [], params: {} },
    { signal: new AbortController().signal },
  )
  expect(result.files).toEqual([{ bytes: MP4, mime: 'video/mp4' }])
  expect(() => buildMediaAdapter(profile('missing_videos' as MediaKind))).toThrow('未登记')
  expect(() => mediaKindOutput('missing_videos' as MediaKind)).toThrow('未登记')
})

test('渠道规格只在渠道使用的协议上解析；请求经渠道的请求结构提交，任务由通用适配器等待与取回', async () => {
  const saved = { channel: 'example', label: '示例视频' }
  expect(lookupMediaModel('video-a', 'openai_videos', saved)).toMatchObject({
    displayName: '示例视频',
    vendor: 'Example',
  })
  expect(lookupMediaModel('video-a', 'ark_videos', saved).catalogued).toBe(false)
  // 渠道未登记时按协议默认解析。
  expect(lookupMediaModel('video-a', 'openai_videos', { channel: 'missing' }).vendor).toBeNull()

  const result = await buildMediaAdapter(profile('openai_videos', saved)).run(
    { operation: 'text_to_video', prompt: 'p', inputs: [], params: {} },
    { signal: new AbortController().signal },
  )
  expect(bodies).toEqual([{ model: 'video-a', prompt: 'p', seconds: '6', via: 'Example' }])
  expect(result).toMatchObject({ files: [{ bytes: MP4 }], usage: { seconds: 6 } })
})
