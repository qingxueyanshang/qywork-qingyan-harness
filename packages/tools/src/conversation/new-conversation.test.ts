/** 覆盖 `conversation/new-conversation.ts`：注册条件、参数校验、经端口新开会话的结果与失败。 */

import { describe, expect, test } from 'bun:test'
import { Ports, provide, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from '../index.ts'
import { newConversationTool } from './new-conversation.ts'
import { ConversationPort } from './port.ts'

function ctx(port: ConversationPort): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv_1',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    state: new Map(),
    sink: null,
    port: new Ports([provide(ConversationPort, port)]).get,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  } as unknown as ToolContext
}

describe('注册条件', () => {
  test('没有新开会话的端口时不注册，有端口时注册', () => {
    const without = new ToolRegistry()
    registerBuiltinTools(without)
    expect(without.list().some((s) => s.name === 'new_conversation')).toBe(false)

    const port: ConversationPort = { open: async () => ({ id: 'cv_2', title: '' }) }
    const withPort = new ToolRegistry()
    registerBuiltinTools(withPort, new Ports([provide(ConversationPort, port)]))
    expect(withPort.list().some((s) => s.name === 'new_conversation')).toBe(true)
  })
})

describe('新开会话', () => {
  test('把标题与第一条消息交给端口，返回新会话的 id 与标题', async () => {
    const opened: { title: string; message: string }[] = []
    const port: ConversationPort = {
      open: async (input) => {
        opened.push(input)
        return { id: 'cv_new', title: input.title }
      },
    }
    const r = await newConversationTool.fn(
      { title: ' 静态审计 ', message: ' 审计 src/ 的改动 ' },
      ctx(port),
    )
    expect(opened).toEqual([{ title: '静态审计', message: '审计 src/ 的改动' }])
    expect(r.status).toBe('success')
    expect(r.data).toEqual({ conversationId: 'cv_new', title: '静态审计' })
    expect(r.message).toContain('静态审计')
  })

  test('没有第一条消息时不新开会话', async () => {
    let calls = 0
    const port: ConversationPort = {
      open: async () => {
        calls++
        return { id: 'cv_new', title: '' }
      },
    }
    const r = await newConversationTool.fn({ title: '审计', message: '  ' }, ctx(port))
    expect(r.status).toBe('failure')
    expect(calls).toBe(0)
  })

  test('端口失败时返回失败与原因', async () => {
    const port: ConversationPort = {
      open: async () => {
        throw new Error('本会话已不存在')
      },
    }
    const r = await newConversationTool.fn({ title: '审计', message: '审计改动' }, ctx(port))
    expect(r.status).toBe('failure')
    expect(r.message).toContain('本会话已不存在')
  })
})
