/**
 * 工具读到的视频：怎么进请求、怎么计读数。
 *
 * 覆盖范围：`loop/request.ts` 的 `toolResultContent` / `videosOf` / `envelopeResult` / `omitImages`
 * 对视频块的处理，`ai` 的 `estimateContent` 对视频计 0，`loop/context.ts` 的 `contextEvent` 标出未计的视频，
 * `loop/turn-end.ts` 不拿带视频的请求当锚点。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateContent, estimateRequest, lookupModel } from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import { AgentLoop } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, call, noopPersistence } from './fixtures.test-helper.ts'
import { envelopeResult, omitImages, toolResultContent } from './request.ts'

const VIDEO = { path: '/w/generated/a.mp4', mime: 'video/mp4' }

describe('工具结果里的视频块', () => {
  test('按路径挂在信封旁边，信封里不留路径', () => {
    const content = toolResultContent('{"summary":"读取"}', { videos: [VIDEO], note: 1 })
    expect(content).toEqual([
      { type: 'text', text: '{"summary":"读取"}' },
      { type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path: VIDEO.path } },
    ])
    expect(envelopeResult({ videos: [VIDEO], note: 1 })).toEqual({ note: 1 })
  })

  test('已送达过的视频同图片一样摘掉，信封标 images_omitted', () => {
    const message: WireMessage = {
      role: 'tool',
      toolCallId: 'c1',
      content: toolResultContent(
        JSON.stringify({ call_id: 'c1', tool: 'read_file', status: 'success', summary: '读取' }),
        { videos: [VIDEO] },
      ),
    }
    const omitted = omitImages(message)
    expect(typeof omitted.content).toBe('string')
    expect(JSON.parse(omitted.content as string).images_omitted).toContain('图像或视频')
  })

  test('估算不含视频；图片仍按固定值计', () => {
    const video = estimateContent(
      [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path: VIDEO.path } }],
      DEFAULT_DENSITY,
      2,
    )
    const image = estimateContent(
      [{ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'x' } }],
      DEFAULT_DENSITY,
      2,
    )
    expect(video).toBe(0)
    expect(image).toBe(2000)
  })
})

/** 第一轮调一个读视频的工具，第二轮（带着视频块）回报 5 万输入 token 后结束。 */
function adapter(): LlmAdapter & { seen: ChatRequest[] } {
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
          inputTokens: first ? 1_000 : 50_000,
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

test('带视频的请求标出未计的视频；它的回执不当锚点，读数不跳到含视频的真值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qy-video-'))
  const real = { path: join(dir, 'a.mp4'), mime: 'video/mp4' }
  await writeFile(real.path, new Uint8Array([0, 0, 0, 24]))
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
    fn: async () => ({ status: 'success', message: '读取（视频）', data: { videos: [real] } }),
  })
  const a = adapter()
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
  const contexts = events.filter((e) => e.type === 'context')
  // 第二次请求带着视频块；发出前的读数标出 1 段未计。
  const withVideo = a.seen[1]!.messages.some(
    (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'video'),
  )
  expect(withVideo).toBe(true)
  expect(contexts.some((e) => e.type === 'context' && e.unmeasuredVideos === 1)).toBe(true)
  // 收尾的读数不采用那次含视频的 5 万真值。
  const last = contexts.at(-1)
  expect(last?.type === 'context' && last.tokens).toBeLessThan(50_000)
  expect(last?.type === 'context' && last.unmeasuredVideos).toBeFalsy()
})
