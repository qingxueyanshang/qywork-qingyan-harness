/**
 * 工具读取的视频：如何写入请求、如何计入读数。
 *
 * 覆盖范围：`loop/request.ts` 的 `toolResultContent` / `videosOf` / `envelopeResult` / `omitImages`
 * 对视频块的处理与 `runDensity` / `videoDelivery` 的同一判定，`ai` 的 `estimateContent` 按时长与画面尺寸计视频，
 * 读不出时长或画面尺寸的视频发送前替换为说明（`materialize`），读数（`loop/context.ts` 的 `contextEvent`）与
 * 回执准入（`loop/turn-end.ts`）因此只依据本地估算。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, LlmAdapter, ProviderEvent, VideoMeta, WireMessage } from '@qywork/ai'
import {
  ANY_VIDEO,
  DEFAULT_DENSITY,
  estimateContent,
  estimateImage,
  estimateRequest,
  estimateVideo,
  lookupModel,
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
  videoRangeCause,
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
        meta: { bytes: 4096, seconds: 10, size: { width: 1280, height: 720 }, audio: false },
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
  const meta: VideoMeta = {
    bytes: 1_000_000,
    seconds: 10,
    size: { width: 1280, height: 720 },
    audio: false,
  }

  test('按时长与画面尺寸计：GLM 10 秒 720p 实测 12,022，单段上限 205,870', () => {
    expect(estimateVideo(meta, glm)).toBe(12_022)
    expect(estimateVideo({ ...meta, seconds: 600 }, glm)).toBe(205_870)
    // 帧数四舍五入：实测 10.5 秒 13,224，4.04 秒的成片 4,810（4 帧）。
    expect(estimateVideo({ ...meta, seconds: 10.5 }, glm)).toBe(13_224)
    expect(estimateVideo({ ...meta, seconds: 4.04 }, glm)).toBe(4_810)
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
    ).toBe(12_022)
  })

  /**
   * 要防止的形状：浏览器录制的 WebM 不写时长，百炼与智谱都以 400 拒绝；读不出画面尺寸的 mp4 同样被拒。
   * 这类视频发送前改为抽帧，说明写明原因，估算记 0。
   */
  test('不原生发送、超出范围、读不出时长或尺寸、文件已不存在时记 0，读不出元数据的改为抽帧', () => {
    const narrowed = {
      ...glm,
      video: { ...glm.video!, accepts: { ...ANY_VIDEO, maxBytes: 500_000 } },
    }
    expect(estimateVideo(meta, { ...glm, video: null })).toBe(0)
    expect(estimateVideo(meta, narrowed)).toBe(0)
    expect(estimateVideo(null, glm)).toBe(0)
    for (const unknown of [
      { ...meta, seconds: null },
      { ...meta, size: null },
    ]) {
      expect(estimateVideo(unknown, glm)).toBe(0)
      expect(videoDelivery(unknown, glm.video, undefined)).toBe('frames')
      expect(videoRangeCause(unknown, glm.video!.accepts)).toBe(
        '该视频的容器中读不出时长或画面尺寸（录制时未写入时长，或文件不完整），接口无法解析',
      )
    }
    const image = estimateContent(
      [{ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'x' } }],
      DEFAULT_DENSITY,
    )
    expect(image).toBe(estimateImage(null, DEFAULT_DENSITY))
  })

  /**
   * Omni 实测：没有时间标记，每段另加 7；全部组合计约 1.84 亿像素，720p 的 300 秒每组缩为 32×18 格（172,807）；
   * 有音轨时每秒另计 7，153 秒的成片实测 91,959。
   */
  test('Omni 按总像素预算缩小每帧，有音轨时按时长另计音频', () => {
    const omni = lookupModel('qwen3.8-omni-flash', 'openai_chat_completions').density
    const hd = { width: 1280, height: 720 }
    expect(estimateVideo({ bytes: 1, seconds: 10, size: hd, audio: false }, omni)).toBe(5_947)
    expect(estimateVideo({ bytes: 1, seconds: 300, size: hd, audio: false }, omni)).toBe(172_807)
    expect(estimateVideo({ bytes: 1, seconds: 600, size: hd, audio: false }, omni)).toBe(165_607)
    expect(estimateVideo({ bytes: 1, seconds: 153.003, size: hd, audio: true }, omni)).toBe(91_960)
    // 不理解声音的模型不计音频。
    const flash = lookupModel('qwen3.8-flash', 'openai_chat_completions').density
    expect(estimateVideo({ ...meta, audio: true }, flash)).toBe(estimateVideo(meta, flash))
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
    expect(runDensity(inline).video?.accepts.maxBytes).toBe(MEDIA_RETAIN_HIGH_BYTES)
    expect(runDensity(upload).video?.accepts.maxBytes).toBe(Number.POSITIVE_INFINITY)
    const big = { ...meta, bytes: MEDIA_RETAIN_HIGH_BYTES + 1 }
    expect(videoDelivery(big, runDensity(inline).video, undefined)).toBe('frames')
    expect(estimateVideo(big, runDensity(inline))).toBe(0)
    expect(videoDelivery(big, runDensity(upload).video, 2 * 1024 * 1024)).toBe('upload')
    expect(estimateVideo(big, runDensity(upload))).toBe(12_022)
  })

  /**
   * 要防止的形状：Qwen3.8 Flash 收到 0.5 秒的视频时接口返回 400「The video file is too short」，整轮失败。
   * 时长范围按百炼规格页写入模型规格（2 秒至 2 小时），超出时发送前即改为抽帧。
   */
  test('时长超出模型规格的视频发送前改为抽帧，估算记 0，说明写明原因', () => {
    const upload = 2 * 1024 * 1024
    const density = runDensity({
      spec: lookupModel('qwen3.8-flash', 'openai_chat_completions'),
      transmits: { effort: true, video: true, mediaUploadAbove: upload },
    })
    const rule = density.video!
    expect(rule.accepts).toMatchObject({ minSeconds: 2, maxSeconds: 7200 })
    const short = { ...meta, seconds: 0.5 }
    const long = { ...meta, seconds: 7300 }
    for (const m of [short, long]) {
      expect(videoDelivery(m, rule, upload)).toBe('frames')
      expect(estimateVideo(m, density)).toBe(0)
    }
    expect(videoRangeCause(short, rule.accepts)).toBe('该视频时长 0.5 秒，短于当前模型接受的 2 秒')
    expect(videoRangeCause(long, rule.accepts)).toBe(
      '该视频时长 7300 秒，长于当前模型接受的 7200 秒',
    )
    expect(videoDelivery({ ...meta, seconds: 2 }, rule, upload)).toBe('inline')
    expect(videoRangeCause({ ...meta, seconds: 2 }, rule.accepts)).toBeNull()
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

/** 读取 `path` 处的视频，第二次请求回报 `input` 个输入 token；返回第二次请求与全部读数事件。 */
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
  return { second: a.seen[1]!, contexts: events.flatMap((e) => (e.type === 'context' ? [e] : [])) }
}

const hasVideo = (req: ChatRequest) =>
  req.messages.some(
    (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'video'),
  )

test('读得出时长与尺寸的视频原生发送并计入发送前的读数；回执之后读数采用真值', async () => {
  const path = await videoFile(mp4Bytes(10, 1280, 720, 100_000))
  const video = estimateVideo(videoMetaOf(path), DEFAULT_DENSITY)
  expect(video).toBeGreaterThan(10_000)
  const { second, contexts } = await readVideoRun(path, 14_000)
  expect(hasVideo(second)).toBe(true)
  // 第二次请求发出前：读数 = 第一次的 1,005 真值 + 本地估算的增量，增量含这段视频。
  expect(contexts.some((e) => e.tokens >= 1_005 + video && e.source === 'projected')).toBe(true)
  const last = contexts.at(-1)
  expect(last?.tokens).toBe(14_005)
  expect(last?.source).toBe('actual')
})

test('读不出时长与尺寸的视频发送前替换为说明，不发出必然被拒的请求', async () => {
  // 10 万字节、没有 moov：接口无法解析这类文件。
  const bytes = new Uint8Array(100_000)
  bytes.set([0, 0, 0, 24])
  const { second, contexts } = await readVideoRun(await videoFile(bytes), 2_000)
  expect(hasVideo(second)).toBe(false)
  expect(JSON.stringify(second.messages)).toContain('读不出时长或画面尺寸')
  expect(JSON.stringify(second.messages)).toContain('read_file')
  expect(contexts.at(-1)?.source).toBe('actual')
})
