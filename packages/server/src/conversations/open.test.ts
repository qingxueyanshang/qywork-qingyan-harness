/** 覆盖 `conversations/open.ts`：新开的会话的归属、模型与权限模式，列表广播，以及第一条消息的投递。 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AgentEvent, ConversationId } from '@qywork/core'
import {
  createConversation,
  getConversation,
  listConversations,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import type { EventBus } from '../bus.ts'
import { conversationPortOf } from './open.ts'

let store: Store
let published: AgentEvent[]
let bus: EventBus

beforeEach(() => {
  store = new Store({ path: ':memory:' })
  published = []
  bus = { publish: (ev: AgentEvent) => published.push(ev) } as unknown as EventBus
})
afterEach(() => store.close())

test('新会话与本会话同工作区、同模型与权限模式，显示在会话列表中，广播后投递第一条消息', async () => {
  const workspace = upsertWorkspace(store, '/tmp/qy-open-ws', 'ws')
  const from = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'relay',
    model: 'claude-opus-5-5',
    mode: 'auto',
  })
  const sent: { to: ConversationId; text: string; listed: boolean }[] = []
  const port = conversationPortOf({ store, bus }, from.id, async (to, text) => {
    sent.push({ to, text, listed: published.some((ev) => ev.type === 'conversation.created') })
  })

  const opened = await port.open({ title: '静态审计', message: '审计 src/ 的改动' })

  const conversation = getConversation(store, opened.id as ConversationId)!
  expect(conversation).toMatchObject({
    workspaceId: workspace.id,
    title: '静态审计',
    provider: 'relay',
    model: 'claude-opus-5-5',
    mode: 'auto',
    source: null,
    parentConversationId: null,
  })
  expect(listConversations(store, workspace.id).map((c) => c.id)).toContain(conversation.id)
  expect(published).toEqual([{ type: 'conversation.created', conversation }])
  // 先广播再投递：列表中出现该会话之后，它的第一轮事件才有归属。
  expect(sent).toEqual([{ to: conversation.id, text: '审计 src/ 的改动', listed: true }])
})

test('权限模式取本会话的当前值，不取配置中的默认值', async () => {
  const workspace = upsertWorkspace(store, '/tmp/qy-open-ws', 'ws')
  const from = createConversation(store, {
    workspaceId: workspace.id,
    provider: 'relay',
    model: 'm',
    mode: 'full',
  })
  const port = conversationPortOf({ store, bus }, from.id, async () => {})
  const opened = await port.open({ title: '', message: '继续' })
  expect(getConversation(store, opened.id as ConversationId)?.mode).toBe('full')
})

test('本会话已不存在时失败，不新建会话', async () => {
  const workspace = upsertWorkspace(store, '/tmp/qy-open-ws', 'ws')
  const port = conversationPortOf({ store, bus }, 'cv_missing' as ConversationId, async () => {})
  await expect(port.open({ title: '审计', message: '审计改动' })).rejects.toThrow('本会话已不存在')
  expect(listConversations(store, workspace.id)).toEqual([])
  expect(published).toEqual([])
})
