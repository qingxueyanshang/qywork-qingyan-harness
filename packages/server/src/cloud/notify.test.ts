/**
 * 覆盖范围：`cloud/notify.ts`。事件经真实的 `EventBus` 发布，会话保存在内存账本中。
 */

import { afterAll, expect, test } from 'bun:test'
import type { AgentEvent, RunId } from '@qywork/core'
import { createConversation, Store, upsertWorkspace } from '@qywork/store'
import { EventBus } from '../bus.ts'
import { watchRunEnds } from './notify.ts'

const store = new Store({ path: ':memory:' })
const ws = upsertWorkspace(store, '/ws/notify', 'notify')
const top = createConversation(store, {
  workspaceId: ws.id,
  provider: 'p',
  model: 'm',
  title: '整理报表',
})
const child = createConversation(store, {
  workspaceId: ws.id,
  provider: 'p',
  model: 'm',
  parentConversationId: top.id,
})
const untitled = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })

afterAll(() => store.close())

const finished = (runId: string, status: 'done' | 'failed' | 'interrupted'): AgentEvent =>
  ({
    type: 'run.finished',
    runId: runId as RunId,
    status,
    stopReason: status === 'done' ? 'completed' : 'provider_error',
    usage: {},
    fileChanges: [],
  }) as unknown as AgentEvent

const error = (runId: string): AgentEvent => ({
  type: 'run.error',
  runId: runId as RunId,
  code: 'internal_error',
  message: 'x',
})

function watch() {
  const bus = new EventBus()
  const sent: string[] = []
  const off = watchRunEnds(bus, store, (event, conversationId, title) =>
    sent.push(`${event} ${conversationId === top.id ? 'top' : conversationId} ${title}`),
  )
  return { bus, sent, off }
}

test('顶层会话的一轮完成时上送；子 agent 的一轮不上送；没有标题时记为「新对话」', () => {
  const { bus, sent } = watch()
  bus.publish(finished('r1', 'done'), child.id)
  bus.publish(finished('r2', 'done'), top.id)
  bus.publish(finished('r3', 'done'), untitled.id)
  expect(sent).toEqual(['run.finished top 整理报表', `run.finished ${untitled.id} 新对话`])
})

test('轮内出错只上送一次；开始之前被拒绝时上送；用户停止不上送；没有错误事件的失败记为出错', () => {
  const { bus, sent } = watch()
  bus.publish(error('r4'), top.id)
  bus.publish(finished('r4', 'failed'), top.id)
  bus.publish(error(''), top.id)
  bus.publish(finished('r5', 'interrupted'), top.id)
  bus.publish(finished('r6', 'failed'), top.id)
  expect(sent).toEqual([
    'run.error top 整理报表',
    'run.error top 整理报表',
    'run.error top 整理报表',
  ])
})

test('取消订阅后不再上送', () => {
  const { bus, sent, off } = watch()
  off()
  bus.publish(finished('r7', 'done'), top.id)
  expect(sent).toEqual([])
})
