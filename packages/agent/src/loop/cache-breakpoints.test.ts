/**
 * 消息级缓存断点的位置与每一步的缓存命中。
 *
 * 覆盖范围：`loop/index.ts` 的 `buildRequest` 打在 history 末条、最后一批工具调用所属的
 * assistant 消息与末尾的三个断点，以及它们与 `loop/request.ts` 的 `omitImages` 的配合。
 * 断言落在适配器收到的请求上，按 Anthropic 的缓存规则算每一步命中到哪一条。
 *
 * 原始失败形状：工具每一步带回一张图，上一批的图在下一步被摘掉，上一步末尾断点的前缀随之
 * 对不上；最后一批工具调用上没有断点时，缓存只命中到 history 末条，其后的内容每一步整段重写。
 */

import { expect, test } from 'bun:test'
import type { LlmAdapter, WireMessage } from '@qywork/ai'
import { ToolRegistry } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { AgentLoop } from './index.ts'

/** 1×1 的 PNG。 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 请求体里的字节：内部标记（`_` 前缀）与断点标记不影响前缀是否相同。 */
function wire(m: WireMessage): string {
  return JSON.stringify(m, (k, v) => (k === 'cacheBreakpoint' || k.startsWith('_') ? undefined : v))
}

/**
 * 按 Anthropic 的缓存规则算每一步命中的消息条数：条目只写在断点处，命中取以往请求写过
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

/** 这一步与上一步第一处不同的消息下标；上一步整段未变时为上一步的条数。 */
function firstChange(prev: readonly WireMessage[], cur: readonly WireMessage[]): number {
  const i = prev.findIndex((m, at) => wire(m) !== wire(cur[at]!))
  return i < 0 ? prev.length : i
}

function hasImage(m: WireMessage | undefined): boolean {
  return Array.isArray(m?.content) && m.content.some((b) => b.type === 'image')
}

test('工具每一步带回一张图：每一步的缓存命中到上一批的图被摘掉之前', async () => {
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
        data: { images: [{ data: PNG, mime: 'image/png' }] },
      }
    },
  })
  const scripted = fakeAdapter([
    [call('screenshot')],
    [call('screenshot')],
    [call('screenshot')],
    [call('screenshot')],
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
    // 断言落在适配器收到的请求上。
  }

  expect(seen).toHaveLength(5)
  // 只有最后一批带图，更早的批次都换成了 images_omitted 信封。
  const tools = (seen[4] ?? []).filter((m) => m.role === 'tool')
  expect(tools.map(hasImage)).toEqual([false, false, false, true])
  for (const m of tools.slice(0, -1)) {
    expect((JSON.parse(String(m.content)) as { images_omitted?: true }).images_omitted).toBe(true)
  }
  const changes = seen.slice(1).map((cur, k) => firstChange(seen[k]!, cur))
  // 从第三步起，上一步末条的图都被摘掉：场景确实走到了改写上一步前缀的路径。
  for (const [k, at] of changes.entries()) {
    if (k >= 1) expect(at).toBeLessThan(seen[k]!.length)
  }
  expect(cachedPrefixes(seen).slice(1)).toEqual(changes)
  // 系统提示词另占一个，Anthropic 一次请求最多 4 个断点。
  for (const messages of seen) {
    expect(messages.filter((m) => m.cacheBreakpoint).length).toBeLessThanOrEqual(3)
  }
})
