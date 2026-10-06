import { describe, expect, test } from 'bun:test'
import { resolve, sep } from 'node:path'
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
  getWorkspaceByPath,
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
  listWorkspaces,
  markProviderRequestContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
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
  test('路由、体积、响应头、首事件、首内容与终态逐项写入账本', () => {
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
    markProviderRequestHeaders(store, request.id, 1_700_000_000_000)
    // 观察时刻由调用方提供，重复写入时保留第一次：后写入的值不是响应头的到达时刻。
    markProviderRequestHeaders(store, request.id, 1_700_000_009_000)
    markProviderRequestFirstEvent(store, request.id)
    // 每一段内容都写入一次：首值保留在 first_content_at，末值覆盖 last_content_at。
    markProviderRequestContent(store, request.id, 1_700_000_010_000)
    markProviderRequestContent(store, request.id, 1_700_000_012_000)
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
    expect(found.headersAt).toBe(1_700_000_000_000)
    expect(found.firstEventAt).toBeNumber()
    expect(found.firstContentAt).toBe(1_700_000_010_000)
    expect(found.lastContentAt).toBe(1_700_000_012_000)
    expect(found.completedAt).toBeNumber()
    store.close()
  })

  /**
   * 回归用例：同一毫秒创建的多个会话，updated_at 全部相等。
   * 只按 updated_at DESC 排序时 SQLite 回退为插入顺序，列表顺序完全相反；
   * 已在种子数据上实测。
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

  test('机器会话不进入列表', () => {
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
    // 重复创建必须被唯一索引拒绝，而不是静默创建第二个 run。
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
  test('内部快照原样写入账本，公开的 Run 不出现第二份可编辑状态', () => {
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
   * 回执与用户本人的消息都以 user 角色写入账本，只能依靠该列区分。读取时丢失该列，
   * 界面会把回执渲染为用户气泡，账本会把回执计为用户的发言。
   */
  test('带来源写入时读取到原值，不带来源时读取到 null', () => {
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

  test('列上有约束：来源只接受这两个值', () => {
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
   * run 创建后、取得执行锁前，用户可能又发送了消息。这些消息不属于本 run 的历史，
   * 放入历史会使模型看到在本 run 之后发送的消息。
   */
  test('upperBound 之后的消息不进入历史', () => {
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
  test('按完整用户轮次分页并批量返回 run/step，页间不重复不遗漏', () => {
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
    }

    const newest = listConversationHistoryPage(store, conv.id, { limit: 2 })
    expect(newest.messages.map((m) => m.content)).toEqual(['用户 4', '用户 5'])
    expect(newest.runs).toHaveLength(2)
    expect(newest.steps.map((s) => s.content)).toEqual(['回答 4', '回答 5'])
    expect(newest.todos.map((t) => t.content)).toEqual(['跨页待办'])
    expect(newest.nextCursor).toBe(users[3]!)

    const older = listConversationHistoryPage(store, conv.id, {
      limit: 2,
      before: newest.nextCursor,
    })
    expect(older.messages.map((m) => m.content)).toEqual(['用户 2', '用户 3'])
    expect(older.runs).toHaveLength(2)
    expect(older.steps.map((s) => s.content)).toEqual(['回答 2', '回答 3'])
    expect(older.nextCursor).toBe(users[1]!)

    const oldest = listConversationHistoryPage(store, conv.id, {
      limit: 2,
      before: older.nextCursor,
    })
    expect(oldest.messages.map((m) => m.content)).toEqual(['用户 1'])
    expect(oldest.steps.map((s) => s.content)).toEqual(['回答 1', null])
    expect(oldest.nextCursor).toBeNull()
    store.close()
  })
})

describe('历史页返回被引用的 workflow 首次派发', () => {
  test('续接调用在页内而首次派发不在时，首次派发随页返回；都在页内时不重复返回', () => {
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

  test('子会话入口随原行进入终态，不依赖从 outcome 读取', () => {
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
   * 原始失败形状：执行完毕时界面上显示耗时（`tool.finished` 事件携带该值），
   * 刷新之后消失：该值从未写入账本，只存在于连接期间。
   */
  test('耗时随终态写入账本，可以读取', () => {
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
    // 创建行时尚未执行，该字段必须为空。
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

  /** 不提供耗时的调用方仍然合法：写入 null，界面按「无值则不显示」处理。 */
  test('未提供耗时时写入 null，不编造数值', () => {
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

describe('run 结束', () => {
  test('stopReason 必须写入账本，不存在静默完成', () => {
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

  test('cachedTokens 为 null 表示未回报，不被改写为 0', () => {
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
 * 会话运行目录的权威。
 *
 * 所有解析都经由此处（服务进程不得自行持有一个 `workspaceRoot` 常量），因此它必须在
 * 同时存在多个项目时也返回正确结果，而不只是在只有一个项目时恰好正确。
 */
describe('会话所属项目', () => {
  test('两个项目并存时，各自的会话解析到各自的根目录', () => {
    const store = new Store({ path: ':memory:' })
    const a = upsertWorkspace(store, '/tmp/a', 'a')
    const b = upsertWorkspace(store, '/tmp/b', 'b')
    const ca = createConversation(store, { workspaceId: a.id, provider: 'p', model: 'm' })
    const cb = createConversation(store, { workspaceId: b.id, provider: 'p', model: 'm' })

    expect(workspaceOf(store, ca.id)?.rootPath).toBe(a.rootPath)
    expect(workspaceOf(store, cb.id)?.rootPath).toBe(b.rootPath)
    expect(a.rootPath).not.toBe(b.rootPath)
    store.close()
  })

  /* 未查到时必须返回 null，使调用方停止。回退到某个默认根目录等于用 A 项目的
     会话在 B 项目的目录中运行命令，而工具的路径约束正是以该根目录为边界。 */
  test('会话不存在时返回 null，不回退到任何项目', () => {
    const store = new Store({ path: ':memory:' })
    upsertWorkspace(store, '/tmp/a', 'a')
    expect(workspaceOf(store, 'cv_nope' as never)).toBeNull()
    store.close()
  })
})

/*
 * `root_path` 是 UNIQUE，但按字符串比较：同一目录的两种写法各自创建一行时，
 * 同一目录下的会话会分散在两个项目中，侧栏出现两个同名项目。
 */
describe('工作区根路径归一', () => {
  test('同一目录的两种写法只产生一行，第二次是更新而非新建', () => {
    const store = new Store({ path: ':memory:' })
    const root = resolve('/ws/demo')
    // 分隔符改为 `/` 并追加末尾分隔符：Windows 上两处都需归一，POSIX 上只需归一末尾分隔符。
    const unnormalized = `${root.replaceAll(sep, '/')}/`
    const first = upsertWorkspace(store, unnormalized, '未归一')
    const second = upsertWorkspace(store, root, '已归一')

    expect(second.id).toBe(first.id)
    expect(second.rootPath).toBe(root)
    expect(listWorkspaces(store).length).toBe(1)
    expect(getWorkspaceByPath(store, unnormalized)?.id).toBe(first.id)
    expect(getWorkspaceByPath(store, root)?.id).toBe(first.id)
    store.close()
  })
})

/*
 * 「最近修改」列的计算口径。
 *
 * 它是侧栏中会话行显示的时间，也是 `listConversations` 的排序键：写错时不会报错，
 * 只会静默显示一个错误的时间（例如发送消息不更新该列时，显示的是会话创建时间）。
 */
describe('会话的最近修改时间', () => {
  test('发送一条消息即更新 updated_at', async () => {
    const { store, ws } = fresh()
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    // Date.now() 的分辨率是毫秒，同一毫秒内写入两次时无法区分先后。
    await Bun.sleep(2)
    appendMessage(store, { conversationId: conv.id, role: 'user', content: '在吗' })
    const after = getConversation(store, conv.id)
    expect(after?.updatedAt).toBeGreaterThan(conv.updatedAt)
    store.close()
  })

  /* 重命名不代表会话有新内容。更新该列会使列表重新排序，
     且该行显示的时间会与实际内容的更新时间不符。 */
  test('重命名不更新 updated_at', async () => {
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
 * 派发任务创建的子会话属于父会话。删除父会话时子会话一并删除，否则库中留下无法打开的孤儿会话；
 * 账目不随之删除：`usage_ledger` 没有外键，按设计这些行的生命周期长于业务数据。
 */
describe('子会话归属', () => {
  test('删除父会话时子会话随之删除，账本行保留', () => {
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

describe('归档与硬删除', () => {
  /* 归档只改变是否显示：列表中不再出现，按 id 仍能读取。 */
  test('归档之后不进入列表，但数据仍保留', () => {
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
    // 重复归档返回 false：调用方必须能区分「未修改任何行」与「成功」。
    expect(archiveConversation(store, conv.id)).toBe(false)
    store.close()
  })

  /*
   * 硬删除是真实删除。本用例锁定级联行为：消息与 run 随之一并删除。
   * 只断言 conversations 表少了一行时，一条失效的外键会使残留数据永久留在库中，
   * 而界面上完全无法察觉。
   */
  test('删除会话后，消息与 run 一并删除', () => {
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

  test('删除不存在的会话返回 false，不抛出异常', () => {
    const { store } = fresh()
    expect(deleteConversation(store, 'cv_nope' as never)).toBe(false)
    store.close()
  })
})

describe('思考 step 写入失败终态', () => {
  /**
   * 用于轮内自动重发。锁定两点：只修改思考（同一批 id 中的工具行不得被一并修改），
   * 以及不删除内容（这些 step 已渲染给用户，删除会使它们从界面上消失）。
   */
  test('只把 thinking 标为失败，内容保留', () => {
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
    // 工具行的终态由 settleToolStep 负责，本函数不得修改。
    expect(rows[1]?.status).toBe('done')
    store.close()
  })

  test('空列表不执行语句', () => {
    const { store } = fresh()
    expect(() => failThinkingSteps(store, [])).not.toThrow()
    store.close()
  })
})

describe('按模型统计的请求完成率', () => {
  /**
   * 用于判断该端点在本机是否稳定。分母是该时段内创建的全部账本行，
   * 分子只有 `received`：`uncertain` 表示连接未正常结束，正是需要统计的一类。
   */
  test('按状态计数，并报告出现最多的错误码', () => {
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

describe('卡片返回后节点仍可写入终态', () => {
  /** 一张已写入终态的派发任务卡。一个节点失败并先行返回后，其余节点的终态仍写在该卡片上。 */
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

  test('已返回的卡片上仍能写入节点', () => {
    const { store, run, step, nodes } = returnedCard()
    setStepNodeState(store, step.id, 'slow', { phase: 'done', label: '慢', durationMs: 9 })
    expect(nodes()?.slow?.phase).toBe('done')
    expect(listSteps(store, run.id)[0]?.status).toBe('failure')
    store.close()
  })

  /**
   * run 结束时不修改节点：子 agent 的生命周期跟随会话，本轮结束时它仍在运行，
   * 回执几分钟后才到达。标为中断时，回执到达后节点上显示的是「中断」。
   */
  test('本轮结束不修改节点', () => {
    const { store, run, nodes } = returnedCard()
    settleRunningSteps(store, run.id)
    expect(nodes()?.slow).toMatchObject({ phase: 'working' })
    store.close()
  })

  /** 只在重启回收时扫描：进程中已无接收方处理回执，节点停留在「进行中」时该图无法继续。 */
  test('重启回收把未到达终态的节点标为中断，已到达的不变', () => {
    const { store, run, nodes } = returnedCard()
    const changed = interruptRunningNodes(store, run.id)
    expect(changed.map((row) => row.nodeId)).toEqual(['slow'])
    expect(nodes()?.slow).toMatchObject({ phase: 'interrupted', error: '调用中断' })
    expect(nodes()?.fast).toMatchObject({ phase: 'failed', error: '连不上' })
    expect(listSteps(store, run.id)[0]?.status).toBe('failure')
    store.close()
  })
})

/** 摘要请求发送的是摘要提示词，其输入量与会话占用无关，锚点与「最近发出」都不采用它。 */
describe('摘要请求与主请求分开统计', () => {
  test('锚点与最近发出只采用主请求', () => {
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
  test('跳过未写入文件的轮；合计覆盖整个会话；游标与历史页相同', () => {
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
      // 写入失败的调用没有 fileChanges，不计入。
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

describe('变更页合并子 agent 与外部 CLI 的写入', () => {
  test('子会话的写入按 run 上的派发来源归入父轮；CLI 节点的写入来自其节点', async () => {
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
    const childRound = (
      content: string,
      path: string,
      dispatch?: { stepId: string; nodeId: string },
    ) => {
      const user = appendMessage(store, { conversationId: child.id, role: 'user', content })
      const run = createRun(store, {
        conversationId: child.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: 'child-' + String(++seq),
        userMessageId: user.id,
        messageIdUpperBound: user.id,
        contextSnapshot: [],
        ...(dispatch
          ? { dispatch: { stepId: dispatch.stepId as never, nodeId: dispatch.nodeId } }
          : {}),
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
    const parentRound = (content: string, key: string, nodes: Record<string, unknown>) => {
      const user = appendMessage(store, { conversationId: conv.id, role: 'user', content })
      const run = createRun(store, {
        conversationId: conv.id,
        workspaceId: ws.id,
        model: 'm',
        clientRequestId: key,
        userMessageId: user.id,
        messageIdUpperBound: user.id,
        contextSnapshot: [],
      })
      const step = appendStep(store, {
        runId: run.id,
        seq: 1,
        kind: 'tool_action',
        toolName: 'workflow',
        status: 'success',
        payload: {
          kind: 'tool_result',
          args: { goal: 'x' },
          outcome: { status: 'success', executed: true, message: '' },
          nodes: nodes as never,
        },
      })
      finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
      return step
    }

    // 没有派发来源的轮不归入任何父轮：不按时间推测。
    childRound('自己跑的', 'early.ts')

    const step = parentRound('派活', 'parent-1', {
      n1: { phase: 'done', label: '写手', subagentId: child.id },
      n2: {
        phase: 'done',
        label: 'codex',
        kind: 'cli',
        fileChanges: [{ path: 'cli.txt', changeType: 'modified' }],
      },
    })
    await Bun.sleep(5)
    childRound('写 c', 'c.ts', { stepId: step.id, nodeId: 'n1' })

    const page = listConversationChangesPage(store, conv.id, { limit: 10 })
    expect(page.turns.map((t) => t.text)).toEqual(['派活'])
    expect(
      page.turns[0]?.steps.map((s) => [
        s.toolName,
        s.via?.name ?? null,
        s.fileChanges.map((c) => c.path),
      ]),
    ).toEqual([
      // CLI 的记录排在派发 step 结束的时刻；子会话的写入在其之后。
      ['cli', 'codex', ['cli.txt']],
      ['edit_file', '写手', ['c.ts']],
    ])
    // 行数只累加已知值：CLI 的记录没有行数。
    expect(page.totals).toEqual({ paths: ['cli.txt', 'c.ts'], additions: 4, deletions: 4 })

    // 继续派发：带有后一次来源的轮归入后一轮，前一轮不再变化。
    const step2 = parentRound('再派', 'parent-2', {
      child: { phase: 'done', label: '写手', subagentId: child.id },
    })
    childRound('写 d', 'd.ts', { stepId: step2.id, nodeId: 'child' })
    const two = listConversationChangesPage(store, conv.id, { limit: 10 })
    expect(
      two.turns.map((t) => [t.text, t.steps.flatMap((s) => s.fileChanges.map((c) => c.path))]),
    ).toEqual([
      ['再派', ['d.ts']],
      ['派活', ['cli.txt', 'c.ts']],
    ])
    store.close()
  })
})
