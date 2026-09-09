import { describe, expect, test } from 'bun:test'
import type { FileChange, MessageId } from '@qywork/core'
import { Store } from './db.ts'
import {
  appendMessage,
  appendStep,
  archiveConversation,
  createConversation,
  createRun,
  deleteConversation,
  failThinkingSteps,
  findRunByClientRequest,
  finishRun,
  getConversation,
  getRun,
  interruptRunningNodes,
  latestAnchoredProviderRequest,
  latestSentProviderRequest,
  listChildConversations,
  listConversationChangesPage,
  listConversationHistoryPage,
  listConversations,
  listMessages,
  listProviderRequests,
  listRunContextSnapshots,
  listSteps,
  markProviderRequestFirstContent,
  markProviderRequestFirstEvent,
  markProviderRequestSent,
  openProviderRequest,
  providerFinishRates,
  setConversationTitle,
  setStepNodeState,
  settleProviderRequest,
  settleRunningSteps,
  settleToolStep,
  upsertWorkspace,
  workspaceOf,
} from './repos.ts'
import { recordUsage, usageTotals } from './usage.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  return { store, ws }
}

describe('逐请求传输证据', () => {
  test('路线、体积、首事件、首内容与终态逐项落库', () => {
    const { store, ws } = fresh()
    const cv = createConversation(store, { workspaceId: ws.id, provider: 'relay', model: 'm' })
    const run = createRun(store, {
      conversationId: cv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'transport-evidence',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const request = openProviderRequest(store, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      providerName: 'relay',
      providerKind: 'openai_responses',
      model: 'm',
      measuredInputTokens: 123,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'h',
      requestBytes: 4096,
    })
    markProviderRequestSent(store, request.id)
    markProviderRequestFirstEvent(store, request.id)
    markProviderRequestFirstContent(store, request.id)
    settleProviderRequest(store, request.id, 'received', null, null, 'completed')

    const found = listProviderRequests(store, run.id)[0]!
    expect(found).toMatchObject({
      providerName: 'relay',
      providerKind: 'openai_responses',
      requestBytes: 4096,
      status: 'received',
      finishReason: 'completed',
    })
    expect(found.sentAt).toBeNumber()
    expect(found.firstEventAt).toBeNumber()
    expect(found.firstContentAt).toBeNumber()
    expect(found.completedAt).toBeNumber()
    store.close()
  })
})

describe('会话列表排序', () => {
  /**
   * 回归用例：同一毫秒创建的多个会话，updated_at 全相等。
   * 只按 updated_at DESC 排序时 SQLite 退回插入顺序，列表看起来完全是反的
   * ——在种子数据上实测过。
   */
  test('updated_at 并列时仍按创建倒序', () => {
    const { store, ws } = fresh()
    const titles = ['第一个', '第二个', '第三个', '第四个']
    for (const title of titles) {
      createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm', title })
    }
    const listed = listConversations(store, ws.id).map((c) => c.title)
    expect(listed).toEqual([...titles].reverse())
    store.close()
  })

  test('机器会话不进列表', () => {
    const { store, ws } = fresh()
    createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm', title: '用户的' })
    createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: '子代理的',
      source: 'temp',
    })
    expect(listConversations(store, ws.id).map((c) => c.title)).toEqual(['用户的'])
    store.close()
  })
})

describe('run 幂等', () => {
  test('同一 clientRequestId 只对应一个 run', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const key = 'req-1'
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: key,
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    expect(findRunByClientRequest(store, conv.id, key)?.id).toBe(run.id)
    // 重复创建必须被唯一索引挡下，而不是静默起第二个 run。
    expect(() =>
      createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: key,
        userMessageId: null,
        messageIdUpperBound: null,
        contextSnapshot: [],
      }),
    ).toThrow()
    store.close()
  })
})

describe('run 上下文快照', () => {
  test('内部快照原样落库，公开 Run 不长出第二份可编辑状态', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const user = appendMessage(store, { conversationId: conv.id, role: 'user', content: '继续' })
    const segments = [
      { content: '工作区：C:/ws', group: 'workspaceState' as const },
      { content: '## 记忆索引\n- cache-rule', group: 'memory' as const },
    ]
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'snapshot',
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: segments,
    })

    expect(listRunContextSnapshots(store, conv.id)).toEqual([
      { runId: run.id, userMessageId: user.id, segments },
    ])
    expect(Object.hasOwn(getRun(store, run.id) as object, 'contextSnapshot')).toBe(false)
    store.close()
  })
})

describe('消息来源', () => {
  /**
   * 回执与用户本人的话都以 user 角色落库，分辨只剩这一列。读回来丢掉它的话，
   * 界面把回执渲染成用户气泡，账本把回执算进用户说过的话。
   */
  test('带来源的写读回原值，不带的读回 null', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const mine = appendMessage(store, { conversationId: conv.id, role: 'user', content: '开工' })
    const sub = appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: '[子 agent 回执] 已返回',
      origin: 'subagent',
    })
    const flow = appendMessage(store, {
      conversationId: conv.id,
      role: 'user',
      content: '[检查点回执] 上游已齐',
      origin: 'workflow',
    })

    expect([mine.origin, sub.origin, flow.origin]).toEqual([null, 'subagent', 'workflow'])
    expect(listMessages(store, conv.id).map((m) => m.origin)).toEqual([
      null,
      'subagent',
      'workflow',
    ])
    expect(
      listConversationHistoryPage(store, conv.id, { limit: 10 }).messages.map((m) => m.origin),
    ).toEqual([null, 'subagent', 'workflow'])
    store.close()
  })

  test('列上有约束：来源只认这两个值', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    expect(() =>
      store.db
        .query(
          'INSERT INTO messages (id, conversation_id, role, content, origin, created_at) VALUES (?,?,?,?,?,?)',
        )
        .run('ms_bad', conv.id, 'user', '正文', 'human', 0),
    ).toThrow()
    store.close()
  })
})

describe('消息高水位', () => {
  /**
   * run 创建后、拿到执行锁前，用户可能又发了消息。那些消息不属于本 run 的历史，
   * 放进去等于让模型看到「未来」。
   */
  test('upperBound 之后的消息不进历史', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const m1 = appendMessage(store, { conversationId: conv.id, role: 'user', content: '第一条' })
    const m2 = appendMessage(store, { conversationId: conv.id, role: 'user', content: '第二条' })
    appendMessage(store, { conversationId: conv.id, role: 'user', content: '排队期间发的' })

    const scoped = listMessages(store, conv.id, m2.id).map((m) => m.content)
    expect(scoped).toEqual(['第一条', '第二条'])
    expect(listMessages(store, conv.id, m1.id).map((m) => m.content)).toEqual(['第一条'])
    store.close()
  })
})

describe('会话历史分页', () => {
  test('按完整用户轮次分页并批量带回 run/step，页间不重不漏', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const users: MessageId[] = []
    for (let i = 1; i <= 5; i++) {
      const user = appendMessage(store, {
        conversationId: conv.id,
        role: 'user',
        content: `用户 ${i}`,
      })
      users.push(user.id)
      const run = createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: `page-${i}`,
        userMessageId: user.id,
        messageIdUpperBound: user.id,
        contextSnapshot: [],
      })
      appendStep(store, { runId: run.id, seq: 1, kind: 'text', content: `回答 ${i}` })
      if (i === 1) {
        appendStep(store, {
          runId: run.id,
          seq: 2,
          kind: 'tool_action',
          toolName: 'write_todos',
          status: 'success',
          payload: {
            kind: 'tool_result',
            args: { todos: [{ content: '跨页待办', status: 'pending' }] },
          } as never,
        })
      }
      finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
      appendMessage(store, {
        conversationId: conv.id,
        role: 'assistant',
        content: `兜底 ${i}`,
      })
    }

    const newest = listConversationHistoryPage(store, conv.id, { limit: 2 })
    expect(newest.messages.map((m) => m.content)).toEqual(['用户 4', '兜底 4', '用户 5', '兜底 5'])
    expect(newest.runs).toHaveLength(2)
    expect(newest.steps.map((s) => s.content)).toEqual(['回答 4', '回答 5'])
    expect(newest.todos.map((t) => t.content)).toEqual(['跨页待办'])
    expect(newest.nextCursor).toBe(users[3]!)

    const older = listConversationHistoryPage(store, conv.id, {
      limit: 2,
      before: newest.nextCursor,
    })
    expect(older.messages.map((m) => m.content)).toEqual(['用户 2', '兜底 2', '用户 3', '兜底 3'])
    expect(older.runs).toHaveLength(2)
    expect(older.steps.map((s) => s.content)).toEqual(['回答 2', '回答 3'])
    expect(older.nextCursor).toBe(users[1]!)

    const oldest = listConversationHistoryPage(store, conv.id, {
      limit: 2,
      before: older.nextCursor,
    })
    expect(oldest.messages.map((m) => m.content)).toEqual(['用户 1', '兜底 1'])
    expect(oldest.steps.map((s) => s.content)).toEqual(['回答 1', null])
    expect(oldest.nextCursor).toBeNull()
    store.close()
  })
})

describe('历史页带回被引用的 workflow 首派', () => {
  test('续接调用在页里而首派不在时，首派随页带回；都在页里时不重复带', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const round = (content: string) => {
      const user = appendMessage(store, { conversationId: conv.id, role: 'user', content })
      const run = createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: `wf-${content}`,
        userMessageId: user.id,
        messageIdUpperBound: user.id,
        contextSnapshot: [],
      })
      return run
    }
    const first = round('派')
    const start = appendStep(store, {
      runId: first.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { goal: '目标', nodes: [{ id: 'a', kind: 'temp', name: 'a', task: '做' }] },
        outcome: { status: 'success', executed: true, message: '到检查点' },
      },
    })
    finishRun(store, first.id, { status: 'done', stopReason: 'completed' })
    const second = round('批准')
    appendStep(store, {
      runId: second.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { workflowId: start.id, checkpointId: 'cp', decision: 'approve', note: '好' },
        outcome: { status: 'success', executed: true, message: '完成' },
      },
    })
    finishRun(store, second.id, { status: 'done', stopReason: 'completed' })

    const latest = listConversationHistoryPage(store, conv.id, { limit: 1 })
    expect(latest.steps.map((step) => step.runId)).toEqual([second.id])
    expect(latest.workflowStarts.map((step) => step.id)).toEqual([start.id])

    const both = listConversationHistoryPage(store, conv.id, { limit: 2 })
    expect(both.workflowStarts).toEqual([])
    store.close()
  })
})

describe('工具 step 原地更新', () => {
  test('一次调用只有一行，从 running 更新到终态', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: 'c1',
      status: 'running',
      payload: { kind: 'tool_call', args: { path: 'a.ts' } },
    })

    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args: { path: 'a.ts' },
      outcome: { status: 'success', executed: true, message: 'ok' },
    })

    const steps = listSteps(store, run.id)
    expect(steps).toHaveLength(1)
    expect(steps[0]?.status).toBe('success')
    expect(steps[0]?.payload?.kind).toBe('tool_result')
    store.close()
  })

  test('子会话入口随原行进入终态，不再依赖 outcome 回读', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'child-entry',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'subagent',
      toolCallId: 'c1',
      providerBatchId: 'bt1',
      status: 'running',
      payload: { kind: 'tool_call', args: {} },
    })
    setStepNodeState(store, step.id, 'child', {
      phase: 'working',
      label: '子',
      subagentId: 'cv_child' as never,
    })

    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args: {},
      outcome: { status: 'success', executed: true, message: 'ok' },
    })

    expect(listSteps(store, run.id)[0]?.payload).toMatchObject({
      kind: 'tool_result',
      nodes: { child: { phase: 'working', label: '子', subagentId: 'cv_child' } },
    })
    store.close()
  })

  /**
   * 原始失败形状：跑完那一刻界面上有耗时（`tool.finished` 事件带着它），
   * 刷新之后没了——这个数从来没落过库，只活在连接期。
   */
  test('耗时随终态落库，读得回来', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'subagent',
      toolCallId: 'c1',
      status: 'running',
      payload: { kind: 'tool_call', args: {} },
    })
    // 建行的时候还没跑，这一格必须是空的。
    expect(listSteps(store, run.id)[0]?.durationMs).toBeNull()

    settleToolStep(
      store,
      step.id,
      'success',
      {
        kind: 'tool_result',
        args: {},
        outcome: { status: 'success', executed: true, message: 'ok' },
      },
      8712,
    )

    expect(listSteps(store, run.id)[0]?.durationMs).toBe(8712)
    store.close()
  })

  /** 不给耗时的调用方仍然合法：落 null，界面按「没有就不显示」处理。 */
  test('没给耗时时落 null，不编一个数', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      toolCallId: 'c1',
      status: 'running',
      payload: { kind: 'tool_call', args: {} },
    })
    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args: {},
      outcome: { status: 'success', executed: true, message: 'ok' },
    })
    expect(listSteps(store, run.id)[0]?.durationMs).toBeNull()
    store.close()
  })
})

describe('run 收尾', () => {
  test('stopReason 必须落库，不存在静默完成', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
    const found = findRunByClientRequest(store, conv.id, 'r')
    expect(found?.status).toBe('done')
    expect(found?.stopReason).toBe('completed')
    expect(found?.finishedAt).toBeGreaterThan(0)
    store.close()
  })

  test('cachedTokens 为 null 表示未回报，不被压成 0', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'r',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const found = findRunByClientRequest(store, conv.id, 'r')
    expect(found?.usage.cachedTokens).toBeNull()
    expect(run.usage.cachedTokens).toBeNull()
    store.close()
  })
})

/*
 * 「这条会话跑在哪个目录下」的权威。
 *
 * 所有解析都走这里（服务进程不许自己拿一个 `workspaceRoot` 常量），所以它必须在
 * **同时存在多个项目**时也答对，而不只是在只有一个项目时碰巧对。
 */
describe('会话所属项目', () => {
  test('两个项目并存时，各自的会话解析到各自的根', () => {
    const store = new Store({ path: ':memory:' })
    const a = upsertWorkspace(store, '/tmp/a', 'a')
    const b = upsertWorkspace(store, '/tmp/b', 'b')
    const ca = createConversation(store, { workspaceId: a.id, provider: 'p', model: 'm' })
    const cb = createConversation(store, { workspaceId: b.id, provider: 'p', model: 'm' })

    expect(workspaceOf(store, ca.id)?.rootPath).toBe('/tmp/a')
    expect(workspaceOf(store, cb.id)?.rootPath).toBe('/tmp/b')
    store.close()
  })

  /* 查不到必须是 null，让调用方停下来。回落到「某个默认根」等于拿着 A 项目的
     会话去 B 项目的目录里跑命令，而工具的路径约束正是以这个根为界的。 */
  test('会话不存在时返回 null，不回落到任何项目', () => {
    const store = new Store({ path: ':memory:' })
    upsertWorkspace(store, '/tmp/a', 'a')
    expect(workspaceOf(store, 'cv_nope' as never)).toBeNull()
    store.close()
  })
})

/*
 * 「最近修改」这一列的口径。
 *
 * 它是侧栏那一行显示的时间，也是 `listConversations` 的排序键——写错了不会报错，
 * 只会安静地显示一个假数（这正是它此前的状态：发消息不推进，显示出来的是建会话时间）。
 */
describe('会话的最近修改时间', () => {
  test('发一条消息就推进 updated_at', async () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    // Date.now() 的分辨率是毫秒，同一毫秒内写两次就分不出先后。
    await Bun.sleep(2)
    appendMessage(store, { conversationId: conv.id, role: 'user', content: '在吗' })
    const after = getConversation(store, conv.id)
    expect(after?.updatedAt).toBeGreaterThan(conv.updatedAt)
    store.close()
  })

  /* 改个名字不是「这条会话有了新内容」。推进它会让列表重排，
     而那一行显示的时间会与实际内容更新时间不符。 */
  test('重命名不推进 updated_at', async () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    await Bun.sleep(2)
    const renamed = setConversationTitle(store, conv.id, '改过的名字')
    expect(renamed?.title).toBe('改过的名字')
    expect(renamed?.updatedAt).toBe(conv.updatedAt)
    store.close()
  })

  test('会话不存在时重命名返回 null，不静默成功', () => {
    const { store } = fresh()
    expect(setConversationTitle(store, 'cv_nope' as never, 'x')).toBeNull()
    store.close()
  })
})

/**
 * 派活建出来的子会话属于父会话。删父会话时它们跟着走，否则库里留下点不开的孤儿会话；
 * 账目不跟着走——`usage_ledger` 没有外键，那些行按设计比业务数据活得久。
 */
describe('子会话归属', () => {
  test('删父会话时子会话跟着删，账本行留着', () => {
    const { store, ws } = fresh()
    const parent = createConversation(store, {
      workspaceId: ws.id,
      provider: 'openai',
      model: 'm',
    })
    const child = createConversation(store, {
      workspaceId: ws.id,
      provider: 'openai',
      model: 'm',
      source: 'temp',
      sourceRef: 'build-glm',
      parentConversationId: parent.id,
    })
    expect(getConversation(store, child.id)?.parentConversationId).toBe(parent.id)
    expect(listChildConversations(store, parent.id).map((c) => c.id)).toEqual([child.id])
    recordUsage(store, {
      kind: 'run',
      conversationId: child.id,
      model: 'm',
      provider: 'openai',
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: null,
      reasoningTokens: 0,
      cost: 0.5,
    })

    expect(deleteConversation(store, parent.id)).toBe(true)
    expect(getConversation(store, child.id)).toBeNull()
    expect(usageTotals(store).entries).toBe(1)
    store.close()
  })
})

describe('归档与硬删', () => {
  /* 归档只改「显不显示」：列表里没有了，按 id 仍然读得回。 */
  test('归档之后不进列表，但数据还在', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: '要归档的',
    })
    expect(archiveConversation(store, conv.id)).toBe(true)
    expect(listConversations(store, ws.id).map((c) => c.id)).not.toContain(conv.id)
    expect(getConversation(store, conv.id)?.title).toBe('要归档的')
    // 已经归档过的回 false——「0 条」和「成功」在界面上必须能分开。
    expect(archiveConversation(store, conv.id)).toBe(false)
    store.close()
  })

  /*
   * 硬删是**真删**。这条锁的是级联：消息与 run 跟着一起没。
   * 只断言 conversations 表少了一行的话，一条断掉的 FK 会让残骸永远留在库里，
   * 而界面上完全看不出来。
   */
  test('删掉会话，消息与 run 一并没了', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const msg = appendMessage(store, { conversationId: conv.id, role: 'user', content: '喂' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'req-del',
      userMessageId: msg.id,
      messageIdUpperBound: msg.id,
      contextSnapshot: [],
    })

    expect(deleteConversation(store, conv.id)).toBe(true)
    expect(getConversation(store, conv.id)).toBeNull()
    expect(listMessages(store, conv.id)).toEqual([])
    expect(getRun(store, run.id)).toBeNull()
    store.close()
  })

  test('删一条不存在的会话回 false，不抛', () => {
    const { store } = fresh()
    expect(deleteConversation(store, 'cv_nope' as never)).toBe(false)
    store.close()
  })
})

describe('思考 step 落失败终态', () => {
  /**
   * 轮内自动重发用。锁两件事：**只碰思考**（同一批 id 里的工具行不得被一并改掉），
   * 以及**不删内容**（那几条已经渲染给用户看过，删掉会让它们从界面上消失）。
   */
  test('只把 thinking 标失败，内容留着', () => {
    const { store, ws } = fresh()
    const cv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: cv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: `req_${cv.id}`,
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const think = appendStep(store, { runId: run.id, seq: 1, kind: 'thinking', content: '半截' })
    const tool = appendStep(store, { runId: run.id, seq: 2, kind: 'tool_action' })

    failThinkingSteps(store, [think.id, tool.id])

    const rows = listSteps(store, run.id)
    expect(rows[0]?.status).toBe('failure')
    expect(rows[0]?.content).toBe('半截')
    // 工具行的终态归 settleToolStep 管，这个函数不许碰。
    expect(rows[1]?.status).toBe('done')
    store.close()
  })

  test('空列表不发语句', () => {
    const { store } = fresh()
    expect(() => failThinkingSteps(store, [])).not.toThrow()
    store.close()
  })
})

describe('按模型的请求收尾率', () => {
  /**
   * 回答的是「这条端点在本机稳不稳」。分母是这段时间里开过的全部账本行，
   * 分子只有 `received`——`uncertain` 是连接没收尾，正是要数出来的那一类。
   */
  test('分状态计数，并报出现最多的错误码', () => {
    const { store, ws } = fresh()
    const cv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: cv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: `req_${cv.id}`,
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const open = (turnIndex: number, model: string) =>
      openProviderRequest(store, {
        runId: run.id,
        turnIndex,
        retryIndex: 0,
        model,
        measuredInputTokens: 1,
        sentCategories: {} as never,
        omittedCategories: {} as never,
        payloadHash: 'h',
      })
    settleProviderRequest(store, open(0, 'ox').id, 'received', null)
    settleProviderRequest(store, open(1, 'ox').id, 'uncertain', null, 'network_error')
    settleProviderRequest(store, open(2, 'ox').id, 'uncertain', null, 'network_error')
    settleProviderRequest(store, open(3, 'glm').id, 'received', null)

    const rows = providerFinishRates(store, 0)
    const ox = rows.find((r) => r.model === 'ox')
    expect(ox).toMatchObject({ total: 3, received: 1, uncertain: 2, topErrorCode: 'network_error' })
    expect(rows.find((r) => r.model === 'glm')).toMatchObject({
      total: 1,
      received: 1,
      topErrorCode: null,
    })
    store.close()
  })

  test('窗口之外的行不计入', () => {
    const { store, ws } = fresh()
    const cv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: cv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: `req_${cv.id}`,
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    openProviderRequest(store, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      model: 'ox',
      measuredInputTokens: 1,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'h',
    })
    expect(providerFinishRates(store, Date.now() + 60_000)).toHaveLength(0)
    store.close()
  })
})

describe('卡返回后格仍可落终态', () => {
  /** 一张已经收成终态的派活卡。一格失败先交回后，其余格的终态还写在它上面。 */
  function returnedCard() {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'returned-card',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      toolCallId: 'c1',
      providerBatchId: 'bt1',
      status: 'running',
      payload: { kind: 'tool_call', args: {} },
    })
    setStepNodeState(store, step.id, 'fast', { phase: 'failed', label: '快', error: '连不上' })
    setStepNodeState(store, step.id, 'slow', { phase: 'working', label: '慢' })
    settleToolStep(store, step.id, 'failure', {
      kind: 'tool_result',
      args: {},
      outcome: { status: 'failure', executed: true, message: '先交回' },
    })
    const nodes = () =>
      (
        listSteps(store, run.id)[0]?.payload as {
          nodes?: Record<string, { phase: string; error?: string }>
        }
      ).nodes
    return { store, run, step, nodes }
  }

  test('已返回的卡上仍能写格', () => {
    const { store, run, step, nodes } = returnedCard()
    setStepNodeState(store, step.id, 'slow', { phase: 'done', label: '慢', durationMs: 9 })
    expect(nodes()?.slow?.phase).toBe('done')
    expect(listSteps(store, run.id)[0]?.status).toBe('failure')
    store.close()
  })

  /**
   * run 收尾**不动格**：子 agent 的生命期跟着会话，这一轮结束时它还在跑，
   * 回执几分钟后才到。扫成中断的话那份回执回来时格上写的是「中断」。
   */
  test('这一轮收尾不碰格', () => {
    const { store, run, nodes } = returnedCard()
    settleRunningSteps(store, run.id)
    expect(nodes()?.slow).toMatchObject({ phase: 'working' })
    store.close()
  })

  /** 重启回收才扫：进程里没有任何人在收那份回执了，格留在「进行中」那张图就没有出口。 */
  test('重启回收把没到终态的格标中断，到了的不动', () => {
    const { store, run, nodes } = returnedCard()
    const changed = interruptRunningNodes(store, run.id)
    expect(changed.map((row) => row.nodeId)).toEqual(['slow'])
    expect(nodes()?.slow).toMatchObject({ phase: 'interrupted', error: '调用中断' })
    expect(nodes()?.fast).toMatchObject({ phase: 'failed', error: '连不上' })
    expect(listSteps(store, run.id)[0]?.status).toBe('failure')
    store.close()
  })
})

/** 摘要请求发的是摘要提示词，它的输入量与会话占用无关，锚点与「最近发出」都不认它。 */
describe('摘要请求与主请求分开看', () => {
  test('锚点与最近发出只看主请求', () => {
    const { store, ws } = fresh()
    const cv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: cv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'anchor-vs-summary',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const open = (turnIndex: number, purpose: 'turn' | 'summary', measured: number) =>
      openProviderRequest(store, {
        runId: run.id,
        turnIndex,
        retryIndex: 0,
        purpose,
        model: 'm',
        measuredInputTokens: measured,
        sentCategories: {} as never,
        omittedCategories: {} as never,
        payloadHash: `h${turnIndex}`,
      })
    const main = open(0, 'turn', 100)
    markProviderRequestSent(store, main.id)
    settleProviderRequest(store, main.id, 'received', {
      inputTokens: 90,
      outputTokens: 5,
      cachedTokens: null,
      cacheWriteTokens: null,
    })
    const summary = open(1, 'summary', 9000)
    markProviderRequestSent(store, summary.id)
    settleProviderRequest(store, summary.id, 'received', {
      inputTokens: 9000,
      outputTokens: 300,
      cachedTokens: null,
      cacheWriteTokens: null,
    })

    expect(listProviderRequests(store, run.id).map((r) => r.purpose)).toEqual(['turn', 'summary'])
    expect(latestSentProviderRequest(store, cv.id)?.id).toBe(main.id)
    expect(latestAnchoredProviderRequest(store, cv.id)?.id).toBe(main.id)
    store.close()
  })
})

describe('变更页按写过文件的轮分页', () => {
  test('跳过没写文件的轮；合计覆盖整条会话；游标与历史页同一种', () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const other = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    let seq = 0
    const round = (
      conversationId: typeof conv.id,
      content: string,
      fill: (runId: string) => void,
    ) => {
      const user = appendMessage(store, { conversationId, role: 'user', content })
      const run = createRun(store, {
        conversationId,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: 'changes-' + String(++seq),
        userMessageId: user.id,
        messageIdUpperBound: user.id,
        contextSnapshot: [],
      })
      fill(run.id)
      finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
      return user.id
    }
    const write = (
      runId: string,
      stepSeq: number,
      path: string,
      additions: number,
      deletions: number,
      changeType: FileChange['changeType'] = 'modified',
    ) =>
      appendStep(store, {
        runId: runId as never,
        seq: stepSeq,
        kind: 'tool_action',
        toolName: 'edit_file',
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { path },
          outcome: {
            status: 'success',
            executed: true,
            message: '',
            fileChanges: [{ path, changeType, additions, deletions }],
          },
        },
      })

    round(conv.id, '改 a', (runId) => {
      write(runId, 1, 'a.ts', 3, 1)
    })
    round(conv.id, '只看看', (runId) => {
      appendStep(store, {
        runId: runId as never,
        seq: 1,
        kind: 'tool_action',
        toolName: 'read_file',
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { path: 'a.ts' },
          outcome: { status: 'success', executed: true, message: '' },
        },
      })
    })
    const t3 = round(conv.id, '再改', (runId) => {
      write(runId, 1, 'a.ts', 2, 0)
      write(runId, 2, 'b.ts', 0, 0, 'deleted')
      // 写失败的调用没有 fileChanges，不进账。
      appendStep(store, {
        runId: runId as never,
        seq: 3,
        kind: 'tool_action',
        toolName: 'write_file',
        status: 'failure',
        payload: {
          kind: 'tool_result',
          args: { path: 'c.ts' },
          outcome: { status: 'failure', executed: true, message: 'EACCES' },
        },
      })
    })
    round(other.id, '别的会话', (runId) => {
      write(runId, 1, 'z.ts', 9, 9)
    })

    const first = listConversationChangesPage(store, conv.id, { limit: 1 })
    expect(first.turns.map((t) => t.text)).toEqual(['再改'])
    expect(first.turns[0]?.origin).toBeNull()
    expect(first.turns[0]?.steps.map((s) => s.fileChanges[0]?.path)).toEqual(['a.ts', 'b.ts'])
    expect(first.turns[0]?.steps.every((s) => s.via === null)).toBe(true)
    expect(first.totals).toEqual({ paths: ['a.ts', 'b.ts'], additions: 5, deletions: 1 })
    expect(first.nextCursor).toBe(t3)

    const rest = listConversationChangesPage(store, conv.id, {
      limit: 10,
      before: first.nextCursor,
    })
    expect(rest.turns.map((t) => t.text)).toEqual(['改 a'])
    expect(rest.turns[0]?.steps).toHaveLength(1)
    expect(rest.nextCursor).toBeNull()

    expect(listConversationChangesPage(store, other.id, { limit: 10 }).totals).toEqual({
      paths: ['z.ts'],
      additions: 9,
      deletions: 9,
    })
    store.close()
  })
})

describe('变更页并进子 agent 与外部 CLI 的写入', () => {
  test('子会话的写入按 subagentId 与父 step 的执行窗口归轮；CLI 节点的写入来自它的格', async () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const child = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: '写手',
      source: 'role',
      sourceRef: 'writer',
      parentConversationId: conv.id,
    })
    let seq = 0
    const childRound = (content: string, path: string) => {
      const user = appendMessage(store, { conversationId: child.id, role: 'user', content })
      const run = createRun(store, {
        conversationId: child.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: 'child-' + String(++seq),
        userMessageId: user.id,
        messageIdUpperBound: user.id,
        contextSnapshot: [],
      })
      appendStep(store, {
        runId: run.id,
        seq: 1,
        kind: 'tool_action',
        toolName: 'edit_file',
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { path },
          outcome: {
            status: 'success',
            executed: true,
            message: '',
            fileChanges: [{ path, changeType: 'modified', additions: 4, deletions: 4 }],
          },
        },
      })
      finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
    }

    // 子会话里早于本轮的写入不归本轮：续派会复用同一个子会话。
    childRound('之前的活', 'early.ts')
    await Bun.sleep(5)

    const user = appendMessage(store, { conversationId: conv.id, role: 'user', content: '派活' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'parent-1',
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: [],
    })
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { goal: 'x' },
        outcome: { status: 'success', executed: true, message: '' },
        nodes: {
          n1: { phase: 'done', label: '写手', subagentId: child.id },
          n2: {
            phase: 'done',
            label: 'codex',
            kind: 'cli',
            fileChanges: [{ path: 'cli.txt', changeType: 'modified' }],
          },
        },
      },
    })
    childRound('写 c', 'c.ts')
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
    await Bun.sleep(5)

    const page = listConversationChangesPage(store, conv.id, { limit: 10 })
    expect(page.turns.map((t) => t.text)).toEqual(['派活'])
    expect(
      page.turns[0]?.steps.map((s) => [
        s.toolName,
        s.via?.name ?? null,
        s.fileChanges.map((c) => c.path),
      ]),
    ).toEqual([
      ['edit_file', '写手', ['c.ts']],
      ['cli', 'codex', ['cli.txt']],
    ])
    // 行数只加已知的：CLI 那条没有
    expect(page.totals).toEqual({ paths: ['cli.txt', 'c.ts'], additions: 4, deletions: 4 })
    store.close()
  })
})
