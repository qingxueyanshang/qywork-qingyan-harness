/**
 * 已加载外部工具的存储。
 *
 * 覆盖范围：`loaded-tools.ts` 全部。测试的是语义而不是调用次数：它回答的是
 * 「该会话之前加载过哪些工具」，回答错误时模型每轮重复加载（多一次无效往返），
 * 或加载记录归属到其他会话。
 */

import { describe, expect, test } from 'bun:test'
import {
  createConversation,
  listLoadedTools,
  recordLoadedTools,
  Store,
  upsertWorkspace,
} from './index.ts'

function conv() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, 'C:/ws', 'ws')
  const c = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  return { store, id: c.id }
}

describe('已加载的外部工具', () => {
  test('默认没有任何记录，新会话重新判断是否加载', () => {
    const { store, id } = conv()
    expect(listLoadedTools(store, id).size).toBe(0)
    store.close()
  })

  test('记录后能够读取', () => {
    const { store, id } = conv()
    recordLoadedTools(store, id, ['mcp__github__search', 'demo__count'])
    expect([...listLoadedTools(store, id)].sort()).toEqual(['demo__count', 'mcp__github__search'])
    store.close()
  })

  test('同一个工具记录两次时不报错也不重复', () => {
    const { store, id } = conv()
    recordLoadedTools(store, id, ['mcp__github__search'])
    recordLoadedTools(store, id, ['mcp__github__search'])
    expect([...listLoadedTools(store, id)]).toEqual(['mcp__github__search'])
    store.close()
  })

  /** 加载记录只属于当前会话：其他会话应自行重新判断是否加载。 */
  test('只影响当前会话', () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const a = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const b = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })

    recordLoadedTools(store, a.id, ['mcp__github__search'])
    expect(listLoadedTools(store, a.id).size).toBe(1)
    expect(listLoadedTools(store, b.id).size).toBe(0)
    store.close()
  })

  test('会话被删除时级联清除', () => {
    const { store, id } = conv()
    recordLoadedTools(store, id, ['mcp__github__search'])
    store.db.query('DELETE FROM conversations WHERE id = ?').run(id)
    expect(listLoadedTools(store, id).size).toBe(0)
    store.close()
  })
})
