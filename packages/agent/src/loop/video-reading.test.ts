/**
 * 工具读取的视频：如何写入请求、如何计入读数。
 *
 * 覆盖范围：`loop/request.ts` 的 `toolResultContent` / `videosOf` / `envelopeResult` / `omitImages`
 * 对视频块的处理与 `runDensity` / `videoDelivery` 的同一判定，`ai` 的 `estimateContent` 按时长与画面尺寸计视频，
 * `loop/context.ts` 的 `contextEvent` 与 `loop/run-state.ts` 的 `unmeasuredVideos` 只标出读不出元数据的视频，
 * `loop/turn-end.ts` 的回执准入。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, LlmAdapter, ProviderEvent, VideoMeta, WireMessage } from '@qywork/ai'
import {
  DEFAULT_DENSITY,
  estimateContent,
  estimateImage,
  estimateRequest,
  estimateVideo,
  lookupModel,
  unestimatedVideosOf,
} from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import { AgentLoop } from '../index.ts'
import { mp4Bytes } from '../mp4.test-helper.ts'
import { ToolRegistry } from '../registry.ts'
import { videoMetaOf } from '../video-meta.ts'
import { baseCtx, call, noopPersistence } from './fixtures.test-helper.ts'
import {
  envelopeResult,
  MEDIA_RETAIN_HIGH_BYTES,
  omitImages,
  runDensity,
  toolResultContent,
  videoDelivery,
} from './request.ts'

const VIDEO = { path: '/w/generated/a.mp4', mime: 'video/mp4' }

async function videoFile(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qy-video-'))
  const path = join(dir, 'a.mp4')
  await writeFile(path, bytes)
  return path
}

describe('工具结果中的视频块', () => {
  test('按路径作为信封之后的内容块，带容器索引中的元数据，信封中不保留路径', async () => {
    const path = await videoFile(mp4Bytes(10, 1280, 720))
    const content = toolResultContent('{"summary":"读取"}', {
      videos: [{ path, mime: 'video/mp4' }, VIDEO],
      note: 1,
    })
    expect(content).toEqual([
      { type: 'text', text: '{"summary":"读取"}' },
      {
        type: 'video',
        mimeType: 'video/mp4',
        source: { kind: 'path', path },
        meta: { bytes: 4096, seconds: 10, size: { width: 1280, height: 720 } },
      },
      // 文件已不存在：发送时替换为说明，估算记 0。
      {
        type: 'video',
        mimeType: 'video/mp4',
        source: { kind: 'path', path: VIDEO.path },
        meta: null,
      },
    ])
    expect(envelopeResult({ videos: [VIDEO], note: 1 })).toEqual({ note: 1 })
  })

  test('已送达的视频与图片一样被移除，信封标记 images_omitted', () => {
    const message: WireMessage = {
      role: 'tool',
      toolCallId: 'c1',
      content: toolResultContent(
        JSON.stringify({ call_id: 'c1', tool: 'read_file', status: 'success', summary: '读取' }),
        { videos: [VIDEO] },
      ),
    }
    const omitted = omitImages(message, 'omitted')
    expect(typeof omitted.content).toBe('string')
    expect(JSON.parse(omitted.content as string).images_omitted).toContain('图像或视频')
  })
})

describe('视频估算', () => {
  const glm = lookupModel('glm-5.3-flashx', 'openai_chat_completions').density
  const meta: VideoMeta = { bytes: 1_000_000, seconds: 10, size: { width: 1280, height: 720 } }

  test('按时长与画面尺寸计：GLM 10 秒 720p 实测 12,022，单段上限 205,870', () => {
    expect(estimateVideo(meta, glm)).toBe(12_031)
    expect(estimateVideo({ ...meta, seconds: 600 }, glm)).toBe(205_870)
    // 不足一秒的部分按一帧计：实测 10.5 秒 13,224。
    expect(estimateVideo({ ...meta, seconds: 10.5 }, glm)).toBe(13_234)
    expect(
      estimateContent(
        [
          {
            type: 'video',
            mimeType: 'video/mp4',
            source: { kind: 'path', path: VIDEO.path },
            meta,
          },
        ],
        glm,
      ),
    ).toBe(12_031)
  })

  test('不原生发送、超过字节上限、文件已不存在、读不出时长或尺寸时记 0；只有最后一种计入「未计」', () => {
    const block = (m: VideoMeta | null) =>
      ({
        type: 'video',
        mimeType: 'video/mp4',
        source: { kind: 'path', path: VIDEO.path },
        meta: m,
      }) as const
    const narrowed = { ...glm, video: { ...glm.video!, maxBytes: 500_000 } }
    expect(estimateVideo(meta, { ...glm, video: null })).toBe(0)
    expect(estimateVideo(meta, narrowed)).toBe(0)
    expect(estimateVideo(null, glm)).toBe(0)
    expect(estimateVideo({ ...meta, seconds: null }, glm)).toBe(0)
    const messages: WireMessage[] = [
      { role: 'user', content: [block(meta), block(null), block({ ...meta, size: null })] },
    ]
    expect(unestimatedVideosOf(messages, glm)).toBe(1)
    expect(unestimatedVideosOf(messages, { ...glm, video: null })).toBe(0)
    const image = estimateContent(
      [{ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'x' } }],
      DEFAULT_DENSITY,
    )
    expect(image).toBe(estimateImage(null, DEFAULT_DENSITY))
  })

  test('本轮密度与发送方式同一判定：不接受视频时不计，不能上传时超过常驻上限不计，能上传时不限', () => {
    const spec = { ...lookupModel('glm-5.3-flashx', 'openai_chat_completions'), video: true }
    const inline = { spec, transmits: { effort: true, video: true } }
    const upload = {
      spec,
      transmits: { effort: true, video: true, mediaUploadAbove: 2 * 1024 * 1024 },
    }
    expect(
      runDensity({ spec: { ...spec, video: false }, transmits: inline.transmits }).video,
    ).toBeNull()
    expect(runDensity({ spec, transmits: { effort: true, video: false } }).video).toBeNull()
    expect(runDensity(inline).video?.maxBytes).toBe(MEDIA_RETAIN_HIGH_BYTES)
    expect(runDensity(upload).video?.maxBytes).toBe(Number.POSITIVE_INFINITY)
    const big = MEDIA_RETAIN_HIGH_BYTES + 1
    expect(videoDelivery(big, { video: true })).toBe('frames')
    expect(estimateVideo({ ...meta, bytes: big }, runDensity(inline))).toBe(0)
    expect(videoDelivery(big, { video: true, mediaUploadAbove: 2 * 1024 * 1024 })).toBe('upload')
    expect(estimateVideo({ ...meta, bytes: big }, runDensity(upload))).toBe(12_031)
  })
})

/** 第一轮调用一个读取视频的工具，第二轮（携带视频块）回报 `input` 个输入 token 后结束。 */
function adapter(input: number): LlmAdapter & { seen: ChatRequest[] } {
  const spec = { ...lookupModel('qwen3.6-plus', 'openai_chat_completions'), video: true }
  const seen: ChatRequest[] = []
  let turn = 0
  return {
    kind: 'openai_chat_completions',
    transmits: { effort: true, video: true },
    spec,
    seen,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      const first = turn++ === 0
      yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, spec.density) }
      if (first) yield { type: 'tool_calls', calls: [call('look')], at: Date.now() }
      else yield { type: 'text_delta', delta: '看完了', at: Date.now() }
      yield {
        type: 'usage',
        usage: {
          inputTokens: first ? 1_000 : input,
          outputTokens: 5,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          source: 'provider',
        },
      }
      yield { type: 'done', stopReason: first ? 'tool_use' : 'end_turn', rawStopReason: '' }
    },
  }
}

/** 读取 `path` 处的视频，第二次请求回报 `input` 个输入 token；返回两次请求与全部读数事件。 */
async function readVideoRun(path: string, input: number) {
  const registry = new ToolRegistry()
  registry.register({
    name: 'look',
    description: '读一段视频',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    actionKind: 'read',
    objectLabel: '视频',
    category: 'files',
    facet: '读写',
    summary: '读视频',
    permissionEffect: 'read',
    fn: async () => ({
      status: 'success',
      message: '读取（视频）',
      data: { videos: [{ path, mime: 'video/mp4' }] },
    }),
  })
  const a = adapter(input)
  const loop = new AgentLoop({
    adapter: a,
    registry,
    systemPrompt: 's',
    persist: noopPersistence(),
    makeToolContext: (runId) => baseCtx(runId),
  })
  const events: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: 'rn_video' as never,
    history: [{ role: 'user', content: '看看这段视频' }],
    signal: new AbortController().signal,
  })) {
    events.push(ev)
  }
  const withVideo = a.seen[1]!.messages.some(
    (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'video'),
  )
  expect(withVideo).toBe(true)
  return events.flatMap((e) => (e.type === 'context' ? [e] : []))
}

test('读得出时长与尺寸的视频计入发送前的读数，不标「未计」；回执之后读数采用真值', async () => {
  const path = await videoFile(mp4Bytes(10, 1280, 720, 100_000))
  const video = estimateVideo(videoMetaOf(path), DEFAULT_DENSITY)
  expect(video).toBeGreaterThan(10_000)
  const contexts = await readVideoRun(path, 14_000)
  // 第二次请求发出前：读数 = 第一次的 1,005 真值 + 本地估算的增量，增量含这段视频。
  expect(contexts.some((e) => e.tokens >= 1_005 + video && e.source === 'projected')).toBe(true)
  expect(contexts.every((e) => !e.unmeasuredVideos)).toBe(true)
  const last = contexts.at(-1)
  expect(last?.tokens).toBe(14_005)
  expect(last?.source).toBe('actual')
})

test('读不出时长与尺寸的视频发送前标出「未计」；含视频的回执按请求字节数准入', async () => {
  // 10 万字节、没有 moov：路径视频按编码后的大小计入请求字节数，含视频的 5 万回执因此可作为锚点。
  const bytes = new Uint8Array(100_000)
  bytes.set([0, 0, 0, 24])
  const contexts = await readVideoRun(await videoFile(bytes), 50_000)
  expect(contexts.some((e) => e.unmeasuredVideos === 1)).toBe(true)
  // 视频保留在请求中，此后每次都随请求发出：结束时的读数采用该次含视频的 5 万真值，不再标出未计入的视频。
  const last = contexts.at(-1)
  expect(last?.tokens).toBeGreaterThanOrEqual(50_000)
  expect(last?.unmeasuredVideos).toBeFalsy()
})
