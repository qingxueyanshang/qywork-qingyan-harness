/**
 * 覆盖 `monitor/envelopes.ts`：`saveRequestEnvelope`、`requestEnvelopeItems`、`pruneRequestEnvelopes`；
 * 读取时的按比例对齐由 core 的 `alignGroupItems` 完成，对齐的字面值在此锁定；
 * 以及 `repos.ts` 的 `deleteConversation` 删除会话后清除孤立明细。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationId, RunId } from '@qywork/core'
import { emptyBreakdown } from '@qywork/core'
import { Store } from '../db.ts'
import {
  createConversation,
  createRun,
  deleteConversation,
  openProviderRequest,
  upsertWorkspace,
} from '../repos.ts'
import { type EnvelopeItem, requestEnvelopeItems, saveRequestEnvelope } from './envelopes.ts'

function fingerprints(store: Store): string[] {
  return store.db
    .query<{ fingerprint: string }, []>(
      'SELECT fingerprint FROM request_envelopes ORDER BY fingerprint',
    )
    .all()
    .map((r) => r.fingerprint)
}

function newRun(store: Store, conversationId: ConversationId, key: string): RunId {
  return createRun(store, {
    conversationId,
    workspaceId: upsertWorkspace(store, 'C:/ws', 'ws').id,
    model: 'm',
    clientRequestId: key,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
}

/** 按持久化层的顺序写入：先写请求行，再按指纹写入明细。 */
function request(store: Store, runId: RunId, turnIndex: number, fingerprint: string): void {
  openProviderRequest(store, {
    runId,
    turnIndex,
    retryIndex: 0,
    model: 'm',
    measuredInputTokens: 0,
    sentCategories: emptyBreakdown(),
    omittedCategories: { historyOriginal: 0, intermediateOriginal: 0 },
    payloadHash: 'h',
    cacheRouteFingerprint: fingerprint,
  })
  saveRequestEnvelope(store, fingerprint, () => [{ group: 'systemPrompt', name: null, tokens: 1 }])
}

const ITEMS: EnvelopeItem[] = [
  { group: 'systemPrompt', name: null, tokens: 100 },
  { group: 'systemTools', name: 'read_file', tokens: 30 },
  { group: 'systemTools', name: 'write_file', tokens: 70 },
  { group: 'mcpTools', name: 'mcp__demo__ping', tokens: 10 },
]

describe('写入', () => {
  test('同一指纹只估算并写入一次', () => {
    const store = new Store({ path: ':memory:' })
    let calls = 0
    const estimate = () => {
      calls++
      return ITEMS
    }
    saveRequestEnvelope(store, 'fp_a', estimate)
    saveRequestEnvelope(store, 'fp_a', () => {
      calls++
      return []
    })
    saveRequestEnvelope(store, 'fp_b', estimate)
    expect(calls).toBe(2)
    expect(fingerprints(store)).toEqual(['fp_a', 'fp_b'])
    expect(
      requestEnvelopeItems(store, 'fp_a', { systemPrompt: 100, systemTools: 100, mcpTools: 10 }),
    ).toEqual(ITEMS)
    store.close()
  })
})

describe('读取', () => {
  test('各分组的逐项值按占比对齐到分组值，余数归入最大的一项', () => {
    const store = new Store({ path: ':memory:' })
    saveRequestEnvelope(store, 'fp', () => ITEMS)
    expect(
      requestEnvelopeItems(store, 'fp', { systemPrompt: 104, systemTools: 111, mcpTools: 12 }),
    ).toEqual([
      { group: 'systemPrompt', name: null, tokens: 104 },
      { group: 'systemTools', name: 'read_file', tokens: 33 },
      { group: 'systemTools', name: 'write_file', tokens: 78 },
      { group: 'mcpTools', name: 'mcp__demo__ping', tokens: 12 },
    ])
    store.close()
  })

  test('分组内各项全为零时分组值归入第一项；没有明细的指纹返回 null', () => {
    const store = new Store({ path: ':memory:' })
    saveRequestEnvelope(store, 'fp', () => [
      { group: 'systemPrompt', name: null, tokens: 0 },
      { group: 'systemTools', name: 'a', tokens: 0 },
      { group: 'systemTools', name: 'b', tokens: 0 },
    ])
    expect(
      requestEnvelopeItems(store, 'fp', { systemPrompt: 0, systemTools: 9, mcpTools: 4 }),
    ).toEqual([
      { group: 'systemPrompt', name: null, tokens: 0 },
      { group: 'systemTools', name: 'a', tokens: 9 },
      { group: 'systemTools', name: 'b', tokens: 0 },
    ])
    expect(
      requestEnvelopeItems(store, 'fp_none', { systemPrompt: 1, systemTools: 1, mcpTools: 1 }),
    ).toBeNull()
    store.close()
  })
})

describe('删除会话', () => {
  test('只清除不再被任何请求行引用的明细', () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const a = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const b = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const runA = newRun(store, a.id, 'a')
    const runB = newRun(store, b.id, 'b')
    request(store, runA, 0, 'fp_only_a')
    request(store, runA, 1, 'fp_shared')
    request(store, runB, 0, 'fp_shared')
    expect(fingerprints(store)).toEqual(['fp_only_a', 'fp_shared'])

    expect(deleteConversation(store, a.id)).toBe(true)
    expect(fingerprints(store)).toEqual(['fp_shared'])

    expect(deleteConversation(store, b.id)).toBe(true)
    expect(fingerprints(store)).toEqual([])
    store.close()
  })
})
