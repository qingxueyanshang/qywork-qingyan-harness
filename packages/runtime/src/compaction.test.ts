import { describe, expect, test } from 'bun:test'
import type { MessageId } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createRun,
  getConversation,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { RuntimeCompaction } from './compaction.ts'

function fresh(messageCount = 8) {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    title: 't',
  })
  const ids: MessageId[] = []
  for (let i = 0; i < messageCount; i++) {
    ids.push(
      appendMessage(store, {
        conversationId: conv.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i === 0 ? '重构认证模块，不要动 legacy/' : `第 ${i} 条消息`,
      }).id,
    )
  }
  return { store, ws, conv, ids }
}

function port(store: Store, conversationId: string, summarize: any = null) {
  return new RuntimeCompaction({
    store,
    conversationId: conversationId as never,
    messageIdUpperBound: null,
    summarize,
  })
}

describe('压缩是投影，不销毁数据', () => {
  test('压缩后原始消息一条不少', async () => {
    const { store, conv } = fresh()
    const before = store.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
      )
      .get(conv.id)!.n

    const p = port(store, conv.id)
    const r = await p.run()
    expect(r.status).toBe('compacted')

    const after = store.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
      )
      .get(conv.id)!.n
    expect(after).toBe(before)
    store.close()
  })

  test('manifest 落在 conversations 上，可跨进程恢复', async () => {
    const { store, conv } = fresh()
    await port(store, conv.id).run()

    const reloaded = getConversation(store, conv.id)!.compactionManifest
    expect(reloaded).not.toBeNull()
    expect(reloaded!.revision).toBe(1)
    expect(reloaded!.compactedThroughMessageId).not.toBeNull()
    store.close()
  })
})

describe('投影', () => {
  test('未压缩时原样返回历史', () => {
    const { store, conv, ids } = fresh()
    const history = ids.map((id) => ({ role: 'user' as const, content: 'x', _messageId: id }))
    expect(port(store, conv.id).project(history as never)).toHaveLength(history.length)
    store.close()
  })

  test('压缩后被压掉的消息换成摘要 + 事实清单两条', async () => {
    const { store, conv, ids } = fresh()
    const p = port(store, conv.id)
    await p.run()

    const history = ids.map((id) => ({ role: 'user' as const, content: 'x', _messageId: id }))
    const projected = p.project(history as never)

    // 8 条消息，末尾 2 条不压 → 压掉 6 条，换成 2 条投影，剩 2 条原样。
    expect(projected.length).toBeLessThan(history.length)
    expect(projected[0]!.content).toContain('被压缩的早期对话摘要')
    expect(projected[1]!.content).toContain('事实清单')
    store.close()
  })

  test('末尾两条不压 —— 压掉它模型就忘了自己刚被问了什么', async () => {
    const { store, conv, ids } = fresh()
    const p = port(store, conv.id)
    await p.run()

    const history = ids.map((id) => ({
      role: 'user' as const,
      content: `msg-${id}`,
      _messageId: id,
    }))
    const projected = p.project(history as never)
    const tail = projected.slice(-2).map((m) => m.content)
    expect(tail).toEqual([`msg-${ids[6]}`, `msg-${ids[7]}`])
    store.close()
  })

  test('没有 _messageId 的消息（尾区注记）一律保留', async () => {
    const { store, conv, ids } = fresh()
    const p = port(store, conv.id)
    await p.run()

    const history = [
      ...ids.map((id) => ({ role: 'user' as const, content: 'x', _messageId: id })),
      { role: 'system' as const, content: '尾区注记：当前分支 main' },
    ]
    const projected = p.project(history as never)
    expect(projected.some((m) => String(m.content).includes('尾区注记'))).toBe(true)
    store.close()
  })

  test('manifest 与当前历史对不上时原样返回，不平白多两条', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    await p.run()

    // 换一批完全不同的消息 id（模拟切了会话）。
    const alien = [{ role: 'user' as const, content: 'x', _messageId: 'ms_zzzzzzzz' }]
    expect(p.project(alien as never)).toHaveLength(1)
    store.close()
  })
})

describe('事实提取', () => {
  test('用户约束逐字进 facts，工具目标进 filesTouched', async () => {
    const { store, ws, conv, ids } = fresh()
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'edit_file',
      status: 'running',
    })
    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args: {},
      outcome: { status: 'success', executed: true, message: '改了 3 处' },
      action: { kind: 'edit', objectLabel: '文件', target: 'src/auth/token.ts' },
    })

    const r = await port(store, conv.id).run()
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.userConstraints.join('\n')).toContain('不要动 legacy/')
    expect(r.manifest.facts.filesTouched).toContain('src/auth/token.ts')
    store.close()
  })

  test('还在 running 的 step 不进事实包 —— 结果未知不能当已完成', async () => {
    const { store, ws, conv, ids } = fresh()
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: ids[0]!,
      messageIdUpperBound: ids[0]!,
    })
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      status: 'running',
      payload: {
        kind: 'tool_call',
        args: {},
        action: { kind: 'run', objectLabel: '命令', target: '还没跑完.sh' },
      },
    })

    const r = await port(store, conv.id).run()
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).not.toContain('还没跑完.sh')
    store.close()
  })
})

describe('增量压缩', () => {
  test('第二次压缩只处理新增部分，revision 递增', async () => {
    const { store, conv } = fresh()
    const p = port(store, conv.id)
    const first = await p.run()
    expect(first.status === 'compacted' && first.manifest.revision).toBe(1)

    for (let i = 0; i < 4; i++) {
      appendMessage(store, { conversationId: conv.id, role: 'user', content: `新消息 ${i}` })
    }

    const second = await p.run()
    expect(second.status === 'compacted' && second.manifest.revision).toBe(2)
    store.close()
  })

  test('没有新东西时跳过，不白花一次摘要调用', async () => {
    const { store, conv } = fresh()
    let calls = 0
    const p = port(store, conv.id, async () => {
      calls++
      return '摘要'
    })
    await p.run()
    expect(calls).toBe(1)

    const again = await p.run()
    expect(again.status).toBe('skipped')
    expect(calls).toBe(1)
    store.close()
  })
})

describe('降级', () => {
  test('摘要器抛异常时仍产出 manifest', async () => {
    const { store, conv } = fresh()
    const r = await port(store, conv.id, async () => {
      throw new Error('上下文超限')
    }).run()
    expect(r.status).toBe('compacted')
    expect(r.status === 'compacted' && r.summarized).toBe(false)
    store.close()
  })

  test('消息太少时跳过而不是失败', async () => {
    const { store, conv } = fresh(3)
    // 8 条里末尾 2 条不压；3 条里只剩 1 条可压，低于门槛。
    const r = await port(store, conv.id).run()
    expect(r.status).toBe('skipped')
    store.close()
  })
})

/**
 * 中断安全。
 *
 * 复现的原始失败形状：用户按停止之后 8 毫秒，一份机械截取的 manifest 落了库，
 * 32 万 token 的上下文在下一轮变成 4.5 万——不可逆，用户也看不出发生过什么。
 */
describe('中断即丢弃', () => {
  test('摘要已经写完但信号被拉起：manifest 未变更', async () => {
    const { store, conv } = fresh()
    const ac = new AbortController()
    const before = getConversation(store, conv.id)!.compactionManifest
    // 摘要返回的同一刻用户按下停止——正是账本里那 8 毫秒的形状。
    const r = await port(store, conv.id, async () => {
      ac.abort()
      return '一份没人等到的摘要'
    }).run(ac.signal)

    expect(r.status).toBe('aborted')
    expect(getConversation(store, conv.id)!.compactionManifest).toEqual(before)
    store.close()
  })

  test('摘要调用被中断掐掉时不走本地降级', async () => {
    const { store, conv } = fresh()
    const ac = new AbortController()
    const r = await port(store, conv.id, async () => {
      throw new DOMException('已中断', 'AbortError')
    }).run(ac.signal)

    expect(r.status).toBe('aborted')
    expect(getConversation(store, conv.id)!.compactionManifest).toBeNull()
    store.close()
  })

  /** 中断之后投影必须与中断前逐条相等——占用跳水就是从这里发生的。 */
  test('中断之后投影不变，历史一条不少', async () => {
    const { store, conv, ids } = fresh()
    const ac = new AbortController()
    const p = port(store, conv.id, async () => {
      ac.abort()
      return '摘要'
    })
    const history = ids.map((id) => ({ role: 'user' as const, content: 'x', _messageId: id }))

    await p.run(ac.signal)
    expect(p.project(history as never)).toHaveLength(history.length)
    store.close()
  })

  /** provider 失败仍旧降级落库：中断与失败是两件事，只有前者一律丢弃。 */
  test('provider 失败不受影响，照旧降级落库', async () => {
    const { store, conv } = fresh()
    const r = await port(store, conv.id, async () => {
      throw new Error('上下文超限')
    }).run(new AbortController().signal)

    expect(r.status).toBe('compacted')
    expect(getConversation(store, conv.id)!.compactionManifest).not.toBeNull()
    store.close()
  })
})
