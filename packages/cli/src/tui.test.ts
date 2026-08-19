/**
 * 交互模式的斜杠命令。
 *
 * 不测「跑一轮」——那需要真实 provider，归 smoke。这里测的是命令分派，
 * 因为它决定了**输入什么时候会被当成提问发出去**：一条打错的斜杠命令
 * 如果被当成提问，用户会收到一段莫名其妙的模型回答，还要为它付钱。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationId } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { createConversation, recordUsage, Store, upsertWorkspace } from '@qywork/store'
import { type CommandContext, handleCommand } from './tui.ts'

const config: QyConfig = {
  active: { provider: 'ds', model: 'deepseek-v4-flash' },
  providers: {
    ds: { kind: 'openai_compatible', apiKey: 'sk-x', models: { 'deepseek-v4-flash': {} } },
    cl: { kind: 'anthropic', apiKey: 'sk-y', models: { 'claude-opus-5': {} } },
  },
}

function ctx(over: Partial<{ conversationId: ConversationId | undefined; model: string }> = {}) {
  const store = new Store({ path: ':memory:' })
  const state = {
    conversationId: over.conversationId,
    model: over.model ?? 'deepseek-v4-flash',
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
  test('/quit 与 /exit 都认', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/quit', c)).toBe('quit')
    expect(await handleCommand('/exit', c)).toBe('quit')
    store.close()
  })
})

describe('会话与模型', () => {
  test('/new 清掉会话 id —— 下一轮就是全新上下文', async () => {
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
   * 换模型**不清会话**。用户多半是想「换个模型接着聊」，
   * 把两件事绑在一起会让人不敢换模型——真要重来有 /new。
   */
  test('/model 不清会话', async () => {
    const { c, state, store } = ctx({ conversationId: 'cv_1' as ConversationId })
    await handleCommand('/model claude-opus-5', c)
    expect(state.conversationId).toBe('cv_1' as ConversationId)
    store.close()
  })

  test('/model 不带参数只查看，不改', async () => {
    const { c, state, store } = ctx()
    await handleCommand('/model', c)
    expect(state.model).toBe('deepseek-v4-flash')
    store.close()
  })

  test('/model 带空白参数当作查看，不把模型改成空串', async () => {
    const { c, state, store } = ctx()
    await handleCommand('/model    ', c)
    expect(state.model).toBe('deepseek-v4-flash')
    store.close()
  })
})

describe('未知命令', () => {
  /**
   * 这条是这一组里最重要的：未知命令必须**被拒绝**，不能落到「当成提问发出去」。
   * 打错一个斜杠却收到一段模型回答，是最让人困惑的那种反馈，而且要付钱。
   */
  test('/nope 被拒，不返回 quit 也不改任何状态', async () => {
    const { c, state, store } = ctx({ conversationId: 'cv_1' as ConversationId })
    expect(await handleCommand('/nope', c)).toBe('ok')
    expect(state.conversationId).toBe('cv_1' as ConversationId)
    expect(state.model).toBe('deepseek-v4-flash')
    store.close()
  })

  test('只有一个斜杠也不当成提问', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/', c)).toBe('ok')
    store.close()
  })
})

describe('用量与导出', () => {
  test('/usage 空账本时说没有记录，不报错', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/usage', c)).toBe('ok')
    store.close()
  })

  test('/usage 有记录时能查出来', async () => {
    const { c, store } = ctx()
    recordUsage(store, {
      kind: 'run',
      model: 'm',
      provider: 'openai_compatible',
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.01,
    })
    expect(await handleCommand('/usage', c)).toBe('ok')
    store.close()
  })

  test('还没开始时 /export 不炸', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/export', c)).toBe('ok')
    store.close()
  })

  test('有会话时 /export 能导出', async () => {
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

  test('/cost 在还没开始时也不炸', async () => {
    const { c, store } = ctx()
    expect(await handleCommand('/cost', c)).toBe('ok')
    store.close()
  })
})
