import { describe, expect, test } from 'bun:test'
import type { ConversationId } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  finishRun,
  Store,
  settleToolStep,
  updateRunUsage,
  upsertWorkspace,
} from '@qywork/store'
import { collect, exportConversation } from './archive.ts'

function fixture(): { store: Store; conversationId: ConversationId } {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'deepseek-v4-flash',
    title: '导出用会话',
  })
  const msg = appendMessage(store, {
    conversationId: conv.id,
    role: 'user',
    content: '把 calc.js 改一下',
  })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'deepseek-v4-flash',
    clientRequestId: crypto.randomUUID(),
    userMessageId: msg.id,
    messageIdUpperBound: msg.id,
  })

  const ok = appendStep(store, {
    runId: run.id,
    seq: 1,
    kind: 'tool_action',
    toolName: 'read_file',
    status: 'running',
  })
  settleToolStep(store, ok.id, 'success', {
    kind: 'tool_result',
    args: { path: 'calc.js' },
    outcome: { status: 'success', executed: true, message: '读取 calc.js（4 行）' },
    action: { kind: 'read', objectLabel: '文件', target: 'calc.js' },
  })

  const bad = appendStep(store, {
    runId: run.id,
    seq: 2,
    kind: 'tool_action',
    toolName: 'run_command',
    status: 'running',
  })
  settleToolStep(store, bad.id, 'failure', {
    kind: 'tool_result',
    args: { command: 'npm test' },
    outcome: {
      status: 'failure',
      executed: true,
      message: '命令退出码 1\nExpected 3 to be 4',
    },
    action: { kind: 'run', objectLabel: '命令', target: 'npm test' },
  })

  appendStep(store, {
    runId: run.id,
    seq: 3,
    kind: 'text',
    status: 'done',
    content: '改好了，测试还挂着。',
  })

  updateRunUsage(store, run.id, {
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    cost: 0.0012,
    currency: 'USD',
    turns: [],
  })
  finishRun(store, run.id, { status: 'done', stopReason: 'completed' })

  return { store, conversationId: conv.id }
}

describe('采集', () => {
  test('会话、消息、run、step 都取到了', () => {
    const { store, conversationId } = fixture()
    const b = collect(store, conversationId)
    expect(b.conversation?.id).toBe(conversationId)
    expect(b.messages).toHaveLength(1)
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0]!.steps).toHaveLength(3)
    store.close()
  })

  test('会话不存在时抛，不返回一个空壳', () => {
    const store = new Store({ path: ':memory:' })
    // 返回空壳的话，导出会静默产出一份空文档，而它与「这个会话本来就是空的」
    // 无从区分。
    expect(() => collect(store, 'cv_不存在' as ConversationId)).toThrow('不存在')
    store.close()
  })
})

describe('markdown：给人读', () => {
  const md = () => {
    const { store, conversationId } = fixture()
    const text = exportConversation(store, conversationId, 'markdown')
    store.close()
    return text
  }

  test('标题、模型、用量都在头部', () => {
    const t = md()
    expect(t).toContain('# 导出用会话')
    expect(t).toContain('deepseek-v4-flash')
    expect(t).toContain('$0.0012')
  })

  test('用户消息与助手正文都在', () => {
    const t = md()
    expect(t).toContain('把 calc.js 改一下')
    expect(t).toContain('改好了，测试还挂着。')
  })

  test('成功的工具折叠成一行', () => {
    expect(md()).toContain('- ✓ `read_file` calc.js')
  })

  /**
   * 失败的展开。成功的调用读者基本不看，失败的是最需要细节的地方——
   * 一视同仁地折叠会让这份文档在最有用的地方最没用。
   */
  test('失败的工具展开，带上失败正文', () => {
    const t = md()
    expect(t).toContain('- ✗ `run_command` npm test')
    expect(t).toContain('Expected 3 to be 4')
  })

  test('超长失败正文截断，并指路 json', () => {
    const { store, conversationId } = fixture()
    const text = exportConversation(store, conversationId, 'markdown', { maxToolChars: 10 })
    expect(text).toContain('json')
    store.close()
  })

  test('默认不含思考 —— 它最长且对读者价值最低', () => {
    const { store, conversationId } = fixture()
    const run = collect(store, conversationId).runs[0]!
    appendStep(store, {
      runId: run.id,
      seq: 9,
      kind: 'text',
      status: 'done',
      content: '（这里本来是思考）',
    })
    store.close()
    expect(md()).not.toContain('<details>')
  })
})

describe('json：给脚本读', () => {
  test('是合法 JSON 且结构完整', () => {
    const { store, conversationId } = fixture()
    const parsed = JSON.parse(exportConversation(store, conversationId, 'json'))
    expect(parsed.conversation.id).toBe(conversationId)
    expect(parsed.runs[0].steps).toHaveLength(3)
    store.close()
  })

  /**
   * json **不裁剪**。裁剪等于把「导出的内容不全」藏起来，
   * 而脚本没法像人一样看出「这里少了点什么」。
   */
  test('不受 maxToolChars 影响，原样导出', () => {
    const { store, conversationId } = fixture()
    const parsed = JSON.parse(
      exportConversation(store, conversationId, 'json', { maxToolChars: 1 }),
    )
    const failed = parsed.runs[0].steps.find((s: { status: string }) => s.status === 'failure')
    expect(failed.payload.outcome.message).toContain('Expected 3 to be 4')
    store.close()
  })

  test('带上导出时间 —— 归档要能回答「这是什么时候的快照」', () => {
    const { store, conversationId } = fixture()
    const parsed = JSON.parse(exportConversation(store, conversationId, 'json'))
    expect(typeof parsed.exportedAt).toBe('number')
    store.close()
  })
})

describe('压缩过的会话要在最上面说清楚', () => {
  test('有 manifest 时给出警告', () => {
    const { store, conversationId } = fixture()
    store.db.query('UPDATE conversations SET compaction_manifest = ? WHERE id = ?').run(
      JSON.stringify({
        revision: 2,
        compactedThroughMessageId: null,
        summary: 's',
        facts: { userConstraints: [], filesTouched: [], decisions: [] },
        createdAt: 0,
      }),
      conversationId,
    )
    const t = exportConversation(store, conversationId, 'markdown')
    // 不说的话，「模型为什么忘了前面」会变成一个查不出原因的问题。
    expect(t).toContain('压缩')
    expect(t).toContain('修订 2')
    store.close()
  })
})

/*
 * run 内注入的那句用户消息。
 *
 * `renderRun` 末尾是一个**隐式兜底**——三个 kind 判完，剩下的一切都按思考渲染。
 * 少了 user 那一支，导出思考时用户的话会被印成模型的思考，不导出时整句消失。
 */
describe('执行中插入的用户消息', () => {
  function withInjected(): { store: Store; conversationId: ConversationId } {
    const { store, conversationId } = fixture()
    const run = store.db
      .query<{ id: string }, [string]>('SELECT id FROM runs WHERE conversation_id = ?')
      .get(conversationId) as { id: string }
    appendStep(store, {
      runId: run.id as never,
      seq: 99,
      kind: 'user',
      content: '别动 legacy/',
      payload: { kind: 'user' },
    })
    return { store, conversationId }
  }

  test('以用户身份出现一次，不管导不导出思考', () => {
    const { store, conversationId } = withInjected()
    const plain = exportConversation(store, conversationId, 'markdown')
    const withThinking = exportConversation(store, conversationId, 'markdown', {
      includeThinking: true,
    })

    for (const t of [plain, withThinking]) {
      expect(t.split('别动 legacy/')).toHaveLength(2)
      expect(t).toContain('## 用户（执行中插入）')
      // 不许掉进那个兜底：它不是模型的思考。
      const before = t.slice(0, t.indexOf('别动 legacy/'))
      expect(before.endsWith('<details><summary>思考</summary>\n\n')).toBe(false)
    }
    store.close()
  })
})
