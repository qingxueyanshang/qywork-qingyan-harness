/**
 * 会话级开关的存储。
 *
 * 覆盖范围：`extras.ts` 全部。测的是**语义**不是调用次数——
 * 「没有行 = 全开」这条一旦反过来，表现是「新装的技能在老会话里不生效」，
 * 而那是一条谁都不会去查的路径。
 */

import { describe, expect, test } from 'bun:test'
import {
  createConversation,
  listDisabledExtras,
  Store,
  setExtraEnabled,
  upsertWorkspace,
} from './index.ts'

function conv() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, 'C:/ws', 'ws')
  const c = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  return { store, id: c.id }
}

describe('会话级开关', () => {
  test('默认没有任何行 —— 新装的扩展自动就在', () => {
    const { store, id } = conv()
    expect(listDisabledExtras(store, id).size).toBe(0)
    store.close()
  })

  test('关掉一项之后它在集合里，开回来就消失', () => {
    const { store, id } = conv()
    setExtraEnabled(store, id, 'mcp:github', false)
    expect(listDisabledExtras(store, id).has('mcp:github')).toBe(true)

    setExtraEnabled(store, id, 'mcp:github', true)
    expect(listDisabledExtras(store, id).has('mcp:github')).toBe(false)
    store.close()
  })

  /** 开 = 删行，不是写一行 `enabled = 1`。两种表示同一状态的写法并存就是两本账。 */
  test('开回来是删行，不是留一行标记', () => {
    const { store, id } = conv()
    setExtraEnabled(store, id, 'skill:release', false)
    setExtraEnabled(store, id, 'skill:release', true)
    expect(listDisabledExtras(store, id).size).toBe(0)
    store.close()
  })

  test('重复关同一项不报错也不重复', () => {
    const { store, id } = conv()
    setExtraEnabled(store, id, 'plugin:foo', false)
    setExtraEnabled(store, id, 'plugin:foo', false)
    expect([...listDisabledExtras(store, id)]).toEqual(['plugin:foo'])
    store.close()
  })

  /** 它**只属于这一条会话**——这正是它不能写进全局配置的理由。 */
  test('只影响这一条会话，另一条不受牵连', () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const a = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const b = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })

    setExtraEnabled(store, a.id, 'mcp:github', false)
    expect(listDisabledExtras(store, a.id).has('mcp:github')).toBe(true)
    expect(listDisabledExtras(store, b.id).has('mcp:github')).toBe(false)
    store.close()
  })

  /** 会话删了它也该跟着走，否则留下一批指向不存在会话的行。 */
  test('会话被删时级联清掉', () => {
    const { store, id } = conv()
    setExtraEnabled(store, id, 'memory:style', false)
    store.db.query('DELETE FROM conversations WHERE id = ?').run(id)
    expect(listDisabledExtras(store, id).size).toBe(0)
    store.close()
  })
})
