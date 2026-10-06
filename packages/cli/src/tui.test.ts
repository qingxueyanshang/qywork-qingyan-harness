/**
 * 交互模式的斜杠命令。
 *
 * 不测试「执行一轮」：那需要真实 provider，属于 smoke 测试的范围。这里测试命令分派，
 * 因为它决定了**输入何时会被当作提问发出**：输错的斜杠命令
 * 若被当作提问，用户会收到一段与命令无关的模型回答，并需为此付费。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationId } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { createConversation, recordUsage, Store, upsertWorkspace } from '@qywork/store'
import { type CommandContext, handleCommand } from './tui.ts'

const config: QyConfig = {
  active: { provider: 'ds', model: 'deepseek-flash' },
  providers: {
    ds: { kind: 'openai_chat_completions', apiKey: 'sk-x', models: { 'deepseek-flash': {} } },
    cl: { kind: 'anthropic_messages', apiKey: 'sk-y', models: { 'claude-opus-5': {} } },
  },
}

function ctx(over: Partial<{ conversationId: ConversationId | undefined; model: string }> = {}) {
  const store = new Store({ path: ':memory:' })
  const state = {
    conversationId: over.conversationId,
    model: over.model ?? 'deepseek-flash',
  }
  const c: CommandContext = {
    store,
    config,
    get conversationId() {
      return state.conversationId
    },
    setConversation: (id) => {
      state.conversationId = id
    },
    get model() {
      return state.model
    },
    setModel: (m) => {
      state.model = m
    },
  }
  return { c, state, store }
}

describe('退出', () => {
  test('/quit 与 /exit 均可识别', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/quit', c)).toBe('quit')
    expect(await handleCommand('/exit', c)).toBe('quit')
    store.close()
  })
})

describe('会话与模型', () => {
  test('/new 清除会话 id，下一轮使用全新上下文', async () => {
    const { c, state, store } = ctx({ conversationId: 'cv_1' as ConversationId })
    await handleCommand('/new', c)
    expect(state.conversationId).toBeUndefined()
    store.close()
  })

  test('/model 带参数时切换', async () => {
    const { c, state, store } = ctx()
    await handleCommand('/model claude-opus-5', c)
    expect(state.model).toBe('claude-opus-5')
    store.close()
  })

  /**
   * 切换模型**不清除会话**。用户通常是要更换模型后继续对话，
   * 两者绑定会使用户不敢切换模型；需要重新开始时可使用 /new。
   */
  test('/model 不清除会话', async () => {
    const { c, state, store } = ctx({ conversationId: 'cv_1' as ConversationId })
    await handleCommand('/model claude-opus-5', c)
    expect(state.conversationId).toBe('cv_1' as ConversationId)
    store.close()
  })

  test('/model 不带参数时只查看，不修改', async () => {
    const { c, state, store } = ctx()
    await handleCommand('/model', c)
    expect(state.model).toBe('deepseek-flash')
    store.close()
  })

  test('/model 参数为空白时视为查看，不把模型改为空串', async () => {
    const { c, state, store } = ctx()
    await handleCommand('/model    ', c)
    expect(state.model).toBe('deepseek-flash')
    store.close()
  })
})

describe('未知命令', () => {
  /**
   * 本组中最重要的用例：未知命令必须**被拒绝**，不能被当作提问发出。
   * 输错斜杠命令却收到一段模型回答，是最令人困惑的反馈，而且会产生费用。
   */
  test('/nope 被拒绝，不返回 quit，也不修改任何状态', async () => {
    const { c, state, store } = ctx({ conversationId: 'cv_1' as ConversationId })
    expect(await handleCommand('/nope', c)).toBe('ok')
    expect(state.conversationId).toBe('cv_1' as ConversationId)
    expect(state.model).toBe('deepseek-flash')
    store.close()
  })

  test('只有一个斜杠时同样不作为提问', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/', c)).toBe('ok')
    store.close()
  })
})

describe('用量与导出', () => {
  test('/usage 账本为空时提示没有记录，不报错', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/usage', c)).toBe('ok')
    store.close()
  })

  test('/usage 有记录时可以查询到', async () => {
    const { c, store } = ctx()
    recordUsage(store, {
      kind: 'run',
      model: 'm',
      provider: 'openai_chat_completions',
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
    })
    expect(await handleCommand('/usage', c)).toBe('ok')
    store.close()
  })

  test('尚未开始会话时 /export 不抛出异常', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/export', c)).toBe('ok')
    store.close()
  })

  test('有会话时 /export 可以导出', async () => {
    const { c: base, store } = ctx()
    const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
    const conv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: 't',
    })
    const { c } = { c: { ...base, conversationId: conv.id } as CommandContext }
    expect(await handleCommand('/export', c)).toBe('ok')
    store.close()
  })

  test('尚未开始会话时 /cost 不抛出异常', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/cost', c)).toBe('ok')
    store.close()
  })
})
