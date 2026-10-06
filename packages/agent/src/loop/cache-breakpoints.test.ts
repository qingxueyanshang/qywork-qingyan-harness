/**
 * 消息级缓存断点的位置与每一步的缓存命中。
 *
 * 覆盖范围：`loop/index.ts` 的 `buildRequest` 设置在 history 末条、最后一批工具调用所属的
 * assistant 消息与末尾消息上的三个断点，以及它们与 `loop/request.ts` 的 `evictedMedia` 换出的配合。
 * 断言针对适配器收到的请求，按 Anthropic 的缓存规则计算每一步命中到哪一条消息。
 *
 * 检查两项：图片保留在请求中时，每一步命中上一步的全部内容；媒体超过保留上限时，只有换出的那一步
 * 改写一次前缀，之后恢复整段命中。
 */

import { expect, test } from 'bun:test'
import type { LlmAdapter, WireMessage } from '@qywork/ai'
import { IMAGES_OMITTED } from '../compaction.ts'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { AgentLoop } from './index.ts'

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

/** 每一步截取一张图、共执行 `steps` 步，返回每次请求的消息。 */
async function shootSteps(steps: number, data: () => string): Promise<WireMessage[][]> {
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
        data: { images: [{ data: data(), mime: 'image/png' }] },
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
    runId: 'rn_cache' as never,
    history: [{ role: 'user', content: '截图', _group: 'historyMessages' }],
    signal: new AbortController().signal,
  })) {
    // 断言针对适配器收到的请求。
  }
  return seen
}

test('工具每一步返回一张图：图片保留在请求中，每一步命中上一步的全部内容', async () => {
  const seen = await shootSteps(5, () => PNG)
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

/** 解码后约 1.5 MB 的图片：第 4 张使总量超过 5 MB，换出前三张。 */
const LARGE = () => 'A'.repeat(2 * 1024 * 1024)

test('媒体超过保留上限：只有换出的那一步改写前缀，之后恢复整段命中', async () => {
  const seen = await shootSteps(5, LARGE)
  expect(seen).toHaveLength(5)
  const tools = (seen[4] ?? []).filter((m) => m.role === 'tool')
  expect(tools.map(hasImage)).toEqual([false, false, false, true])
  for (const m of tools.slice(0, 3)) {
    expect((JSON.parse(String(m.content)) as { images_omitted?: string }).images_omitted).toBe(
      IMAGES_OMITTED,
    )
  }
  const changes = seen.slice(1).map((cur, k) => firstChange(seen[k]!, cur))
  const rewrites = changes.filter((at, k) => at < seen[k]!.length)
  expect(rewrites).toHaveLength(1)
  expect(cachedPrefixes(seen).slice(1)).toEqual(changes)
})
