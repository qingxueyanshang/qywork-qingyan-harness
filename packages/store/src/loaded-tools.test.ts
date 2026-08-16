/**
 * 已加载外部工具的存储。
 *
 * 覆盖范围：`loaded-tools.ts` 全部。测的是**语义**不是调用次数——它要回答的是
 * 「这条会话上一轮装过哪几个」，答错的表现是模型每轮重装一遍（白花一次往返），
 * 或者装到别的会话头上。
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
  const c = createConversation(store, { workspaceId: ws.id, model: 'm' })
  return { store, id: c.id }
}

describe('已加载的外部工具', () => {
  test('默认一条都没有 —— 新会话从头判断要不要装', () => {
    const { store, id } = conv()
    expect(listLoadedTools(store, id).size).toBe(0)
    store.close()
  })

  test('记下来之后读得回来', () => {
    const { store, id } = conv()
    recordLoadedTools(store, id, ['mcp__github__search', 'demo__count'])
    expect([...listLoadedTools(store, id)].sort()).toEqual(['demo__count', 'mcp__github__search'])
    store.close()
  })

  test('同一个工具记两次不报错也不重复', () => {
    const { store, id } = conv()
    recordLoadedTools(store, id, ['mcp__github__search'])
    recordLoadedTools(store, id, ['mcp__github__search'])
    expect([...listLoadedTools(store, id)]).toEqual(['mcp__github__search'])
    store.close()
  })

  /** 它**只属于这一条会话**：另一条会话该自己重新判断装不装。 */
  test('只影响这一条会话', () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const a = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const b = createConversation(store, { workspaceId: ws.id, model: 'm' })

    recordLoadedTools(store, a.id, ['mcp__github__search'])
    expect(listLoadedTools(store, a.id).size).toBe(1)
    expect(listLoadedTools(store, b.id).size).toBe(0)
    store.close()
  })

  test('会话被删时级联清掉', () => {
    const { store, id } = conv()
    recordLoadedTools(store, id, ['mcp__github__search'])
    store.db.query('DELETE FROM conversations WHERE id = ?').run(id)
    expect(listLoadedTools(store, id).size).toBe(0)
    store.close()
  })
})
