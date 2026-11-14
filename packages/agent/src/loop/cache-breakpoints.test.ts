/**
 * 消息级缓存断点的位置与每一步的缓存命中。
 *
 * 覆盖范围：`loop/index.ts` 的 `buildRequest` 设置在 history 末条、最后一批工具调用所属的
 * assistant 消息与末尾消息上的三个断点，以及它们与 `loop/request.ts` 的 `evictedMedia` 换出的配合。
 * 断言针对适配器收到的请求，按 Anthropic 的缓存规则计算每一步命中到哪一条消息。
 *
 * 检查三项：图片保留在请求中时，每一步命中上一步的全部内容；媒体超过保留上限时，只有换出的那一步
 * 改写一次前缀，之后恢复整段命中：缩略图每次物化的字节相同；逐步追加截图时，改写前缀的步之间至少相隔
 * 余量所能容纳的张数。
 */

import { expect, test } from 'bun:test'
import type { ContentBlock, LlmAdapter, WireMessage } from '@qywork/ai'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { AgentLoop } from './index.ts'
import { IMAGES_REDUCED, MEDIA_RETAIN_HIGH_BYTES, THUMBNAIL_RETAIN_BYTES } from './request.ts'

/** 1×1 的 PNG。 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 请求体中的字节：内部标记（`_` 前缀）与断点标记不影响前缀是否相同。 */
function wire(m: WireMessage): string {
  return JSON.stringify(m, (k, v) => (k === 'cacheBreakpoint' || k.startsWith('_') ? undefined : v))
}

/**
 * 按 Anthropic 的缓存规则计算每一步命中的消息条数：缓存条目只在断点处写入，命中取以往请求已写入
 * 条目的最长相同前缀。
 */
function cachedPrefixes(requests: readonly WireMessage[][]): number[] {
  const entries = new Set<string>()
  return requests.map((messages) => {
    const lines = messages.map(wire)
    let hit = 0
    for (let n = lines.length; n > 0 && hit === 0; n--) {
      if (entries.has(lines.slice(0, n).join('\n'))) hit = n
    }
    for (const [i, m] of messages.entries()) {
      if (m.cacheBreakpoint) entries.add(lines.slice(0, i + 1).join('\n'))
    }
    return hit
  })
}

/** 本步与上一步第一处不同的消息下标；上一步整段未变时为上一步的消息条数。 */
function firstChange(prev: readonly WireMessage[], cur: readonly WireMessage[]): number {
  const i = prev.findIndex((m, at) => wire(m) !== wire(cur[at]!))
  return i < 0 ? prev.length : i
}

function hasImage(m: WireMessage | undefined): boolean {
  return Array.isArray(m?.content) && m.content.some((b) => b.type === 'image')
}

/** 每一步截取一张图、共执行 `steps` 步，返回每次请求的消息。`image` 给出第 n 张图在工具结果中的条目。 */
async function shootSteps(
  steps: number,
  image: (n: number) => Record<string, unknown>,
): Promise<WireMessage[][]> {
  const registry = new ToolRegistry()
  let shots = 0
  registry.register({
    name: 'screenshot',
    description: '截取窗口。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    actionKind: 'read',
    objectLabel: '窗口',
    category: 'session',
    facet: '测试',
    summary: '测试夹具',
    permissionEffect: 'internal_control',
    async fn() {
      shots++
      return {
        status: 'success',
        message: `第 ${shots} 张截图`,
        data: { images: [image(shots)] },
      }
    },
  })
  const scripted = fakeAdapter([
    ...Array.from({ length: steps - 1 }, () => [call('screenshot')]),
    null,
  ])
  const seen: WireMessage[][] = []
  const adapter: LlmAdapter = {
    ...scripted,
    stream(req) {
      seen.push(JSON.parse(JSON.stringify(req.messages)) as WireMessage[])
      return scripted.stream(req)
    },
  }
  const loop = new AgentLoop({
    adapter,
    registry,
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist: noopPersistence(),
  })
  for await (const _ of loop.run({
    compactPercent: 80,
    runId: 'rn_cache' as never,
    history: [{ role: 'user', content: '截图', _group: 'historyMessages' }],
    signal: new AbortController().signal,
  })) {
    // 断言针对适配器收到的请求。
  }
  return seen
}

test('工具每一步返回一张图：图片保留在请求中，每一步命中上一步的全部内容', async () => {
  const seen = await shootSteps(5, () => ({ data: PNG, mime: 'image/png' }))
  expect(seen).toHaveLength(5)
  const tools = (seen[4] ?? []).filter((m) => m.role === 'tool')
  expect(tools.map(hasImage)).toEqual([true, true, true, true])
  const changes = seen.slice(1).map((cur, k) => firstChange(seen[k]!, cur))
  expect(changes).toEqual(seen.slice(0, -1).map((m) => m.length))
  expect(cachedPrefixes(seen).slice(1)).toEqual(changes)
  // 系统提示词另占一个，Anthropic 一次请求最多 4 个断点。
  for (const messages of seen) {
    expect(messages.filter((m) => m.cacheBreakpoint).length).toBeLessThanOrEqual(3)
  }
})

/** 约 1.5 MB 的噪声 PNG（无法压缩）：第 6 张使总量超过 8 MB，前五张缩小为缩略图。 */
const LARGE_PNG = await (async () => {
  const photon = await import('@silvia-odwyer/photon-node')
  const width = 700
  const height = 560
  const pixels = new Uint8Array(width * height * 4)
  let seed = 1
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    pixels[i] = (i & 3) === 3 ? 255 : seed >>> 24
  }
  return Buffer.from(new photon.PhotonImage(pixels, width, height).get_bytes()).toString('base64')
})()
const LARGE = () => ({ data: LARGE_PNG, mime: 'image/png' })

test('媒体超过保留上限：只有换出的那一步改写前缀，之后恢复整段命中', async () => {
  const seen = await shootSteps(7, LARGE)
  expect(seen).toHaveLength(7)
  const tools = (seen[6] ?? []).filter((m) => m.role === 'tool')
  expect(tools.map(hasImage)).toEqual([true, true, true, true, true, true])
  for (const m of tools.slice(0, 5)) {
    const [text, image] = m.content as ContentBlock[]
    const env = JSON.parse(text?.type === 'text' ? text.text : '') as { images_reduced?: string }
    expect(env.images_reduced).toBe(IMAGES_REDUCED)
    const data = image?.type === 'image' && image.source.kind === 'base64' ? image.source.data : ''
    expect(data.length).toBeGreaterThan(0)
    expect(data.length).toBeLessThan(LARGE_PNG.length)
  }
  const changes = seen.slice(1).map((cur, k) => firstChange(seen[k]!, cur))
  const rewrites = changes.filter((at, k) => at < seen[k]!.length)
  expect(rewrites).toHaveLength(1)
  expect(cachedPrefixes(seen).slice(1)).toEqual(changes)
  // 每一步都构造超过保留上限的媒体内容，全部是计算，没有按真实时间的等待；较慢的构建机上超过默认的 5 秒上限。
}, 60_000)

/**
 * 工具结果中的图片是正文库引用，字节数按记录计入换出预算；测试不提供正文库，发出的请求中图片替换为说明，
 * 换出只体现在信封的 `images_reduced` 与 `images_omitted` 上。
 */
test('逐步追加约 300 KB 的截图：改写前缀的步之间至少相隔余量所能容纳的张数，其余各步只追加', async () => {
  const SHOT = 300 * 1024
  const seen = await shootSteps(80, (n) => ({
    mime: 'image/jpeg',
    resourceId: `rs_${n}`,
    bytes: SHOT,
    size: { width: 1280, height: 720 },
  }))
  expect(seen).toHaveLength(80)
  const changes = seen.slice(1).map((cur, k) => firstChange(seen[k]!, cur))
  const rewrites = changes.flatMap((at, k) => (at < seen[k]!.length ? [k + 1] : []))
  const room = Math.floor((MEDIA_RETAIN_HIGH_BYTES - THUMBNAIL_RETAIN_BYTES) / SHOT)
  const gaps = rewrites.slice(1).map((k, i) => k - rewrites[i]!)
  // 第 49 步缩略图合计超过下限，此后每次换出都把保护区之前的原图全部缩小。
  expect(rewrites.length).toBeGreaterThan(3)
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(room)
  // 不改写的步是上一步的严格前缀，整段命中上一步。
  const hits = cachedPrefixes(seen).slice(1)
  for (let k = 0; k < changes.length; k++) {
    if (!rewrites.includes(k + 1)) expect(hits[k]).toBe(seen[k]!.length)
  }
})
