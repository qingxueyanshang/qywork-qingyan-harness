import { describe, expect, test } from 'bun:test'
import type { ConversationId } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  createConversation,
  createGoal,
  createRun,
  finishRun,
  openProviderRequest,
  recordLoadedTools,
  registerResource,
  Store,
  setExtraEnabled,
  settleProviderRequest,
  settleToolStep,
  updateRunUsage,
  upsertWorkspace,
} from '@qywork/store'
import pkg from '../package.json' with { type: 'json' }
import { collect, exportConversation, exportConversationDiagnostics } from './archive.ts'

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
    contextSnapshot: [
      { group: 'workspaceState', content: '分支 main，工作区有未提交修改' },
      { group: 'skills', content: '技能：先验证再修改' },
      { group: 'memory', content: '记忆：保留用户改动' },
      { group: 'mcpTools', content: '按需工具：mcp__docs__search' },
    ],
  })
  createGoal(store, { conversationId: conv.id, objective: '修好 calc.js' })
  recordLoadedTools(store, conv.id, ['mcp__docs__search'])
  setExtraEnabled(store, conv.id, 'skill:legacy', false)

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
  registerResource(store, {
    runId: run.id,
    stepId: ok.id,
    toolName: 'read_file',
    sourceType: 'file',
    status: 'complete',
    contentHash: 'sha256:calc',
    sizeBytes: 128,
    mimeType: 'text/javascript',
    coverage: { deliveredBytes: 128, totalBytes: 128, truncated: false },
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
  const request = openProviderRequest(store, {
    runId: run.id,
    turnIndex: 0,
    retryIndex: 0,
    model: 'deepseek-v4-flash',
    measuredInputTokens: 98,
    sentCategories: {} as never,
    omittedCategories: {} as never,
    payloadHash: 'payload-hash',
  })
  settleProviderRequest(
    store,
    request.id,
    'received',
    { inputTokens: 100, outputTokens: 20, cachedTokens: null, cacheWriteTokens: null },
    null,
    'tool_calls',
  )
  finishRun(store, run.id, { status: 'done', stopReason: 'completed' })

  return { store, conversationId: conv.id }
}

describe('采集', () => {
  test('工作区、会话状态、运行上下文、消息、step、资源与逐请求账本都取到了', () => {
    const { store, conversationId } = fixture()
    const b = collect(store, conversationId)
    expect(b.workspace?.rootPath).toBe('/tmp/ws')
    expect(b.conversation?.id).toBe(conversationId)
    expect(b.messages).toHaveLength(1)
    expect(b.sessionState.goal?.objective).toBe('修好 calc.js')
    expect(b.sessionState.loadedTools).toEqual(['mcp__docs__search'])
    expect(b.sessionState.disabledExtras).toEqual(['skill:legacy'])
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0]!.contextSnapshot.map((s) => s.group)).toEqual([
      'workspaceState',
      'skills',
      'memory',
      'mcpTools',
    ])
    expect(b.runs[0]!.steps).toHaveLength(3)
    expect(b.runs[0]!.resources[0]).toMatchObject({
      toolName: 'read_file',
      contentHash: 'sha256:calc',
      sizeBytes: 128,
    })
    expect(b.runs[0]!.providerRequests[0]?.finishReason).toBe('tool_calls')
    expect(b.collectionErrors).toEqual([])
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

describe('诊断导出', () => {
  test('带请求形状所需的接口信息，但不泄露凭证值', () => {
    const { store, conversationId } = fixture()
    const text = exportConversationDiagnostics(store, conversationId, {
      active: { provider: 'p', model: 'deepseek-v4-flash' },
      providers: {
        p: {
          kind: 'openai_chat_completions',
          apiKey: 'secret-api-key',
          baseUrl: 'https://user:url-password@relay.example/v1?key=url-secret#fragment',
          headers: { Authorization: 'secret-header', 'X-Route': 'route-a' },
          models: { 'deepseek-v4-flash': { effort: 'high' } },
        },
      },
    })
    const parsed = JSON.parse(text)
    expect(parsed.kind).toBe('qywork.session-diagnostic')
    expect(parsed.schemaVersion).toBe(5)
    expect(parsed.exportedBy).toMatchObject({ name: 'qywork', version: pkg.version })
    expect(parsed.provider).toMatchObject({
      name: 'p',
      kind: 'openai_chat_completions',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://relay.example/v1',
      effort: 'high',
      headerNames: ['Authorization', 'X-Route'],
    })
    expect(parsed.provider.effectiveModel).toMatchObject({
      id: 'deepseek-v4-flash',
      provider: 'openai_chat_completions',
    })
    expect(parsed.runtimeConfig).toMatchObject({
      permissionMode: 'auto',
      sandboxNetwork: 'allow',
      workspaceTrusted: false,
    })
    expect(parsed.runs[0].contextSnapshot).toHaveLength(4)
    expect(parsed.runs[0].resources[0].contentHash).toBe('sha256:calc')
    expect(parsed.runs[0].providerRequests[0].finishReason).toBe('tool_calls')
    expect(text).not.toContain('secret-api-key')
    expect(text).not.toContain('secret-header')
    expect(text).not.toContain('route-a')
    expect(text).not.toContain('url-password')
    expect(text).not.toContain('url-secret')
    store.close()
  })

  test('工具专用且无正文/思考的异常形状能被原样识别', () => {
    const { store, conversationId } = fixture()
    store.db.query("DELETE FROM steps WHERE kind = 'text'").run()

    const parsed = JSON.parse(
      exportConversationDiagnostics(store, conversationId, {
        active: { provider: 'p', model: 'deepseek-v4-flash' },
        providers: {
          p: {
            kind: 'openai_chat_completions',
            apiKey: 'secret-api-key',
            models: { 'deepseek-v4-flash': {} },
          },
        },
      }),
    )
    const run = parsed.runs[0]
    expect(run.steps.every((step: { kind: string }) => step.kind === 'tool_action')).toBe(true)
    expect(run.steps.map((step: { toolName: string }) => step.toolName)).toEqual([
      'read_file',
      'run_command',
    ])
    expect(run.providerRequests[0].finishReason).toBe('tool_calls')
    expect(run.stopReason).toBe('completed')
    expect(parsed.runSignals[0]).toMatchObject({
      runId: run.id,
      textSteps: 0,
      thinkingSteps: 0,
      toolSteps: 2,
      failedToolSteps: 1,
      finishReasons: ['tool_calls'],
      hasUnsettledProviderRequest: false,
      toolOnly: true,
    })
    expect(parsed.coverage).toMatchObject({
      messages: 'full',
      steps: 'full_except_tool_result_media',
      toolResultMedia: 'metadata_only',
      rawProviderBodies: 'not_persisted',
      providerFailureAndRetryDecisions: 'persisted_when_observed',
      runInterruptionSources: 'persisted_when_observed',
      sidecarExitCodeSignalAndStderrTail: 'persisted_on_supervised_restart',
      configuredCredentials: 'redacted',
    })
    store.close()
  })

  test('工具图片在诊断包中只留元数据，完整 JSON 存档仍保留原始结果', () => {
    const { store, conversationId } = fixture()
    const run = collect(store, conversationId).runs[0]!
    appendStep(store, {
      runId: run.id,
      seq: 4,
      kind: 'tool_action',
      toolName: 'view_image',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { path: 'chart.png' },
        outcome: {
          status: 'success',
          executed: true,
          message: '读取图片',
          data: {
            note: '保留非媒体诊断信息',
            images: [{ mime: 'image/png', data: 'QUJDRA==' }],
          },
        },
      },
    })

    const text = exportConversationDiagnostics(store, conversationId, {
      active: { provider: 'p', model: 'deepseek-v4-flash' },
      providers: {
        p: {
          kind: 'openai_chat_completions',
          apiKey: 'secret-api-key',
          models: { 'deepseek-v4-flash': {} },
        },
      },
    })
    const parsed = JSON.parse(text)
    const imageStep = parsed.runs[0].steps.find(
      (step: { toolName?: string }) => step.toolName === 'view_image',
    )
    expect(text).not.toContain('QUJDRA==')
    expect(imageStep.payload.outcome.data).toEqual({
      note: '保留非媒体诊断信息',
      images: [{ mime: 'image/png', base64Chars: 8, bytesOmitted: true }],
    })
    expect(exportConversation(store, conversationId, 'json')).toContain('QUJDRA==')
    store.close()
  })

  test('父会话按规范入口递归带出子 Agent 与孙会话，循环引用不重复正文', () => {
    const { store, conversationId } = fixture()
    const parent = collect(store, conversationId)
    const parentRun = parent.runs[0]!
    const workspaceId = parent.workspace!.id

    const child = createConversation(store, {
      workspaceId,
      provider: 'child-provider',
      model: 'child-model',
      title: '研究员子会话',
      source: 'workflow',
      sourceRef: 'researcher',
    })
    const childMessage = appendMessage(store, {
      conversationId: child.id,
      role: 'user',
      content: '调查工具为什么循环',
    })
    const childRun = createRun(store, {
      conversationId: child.id,
      workspaceId,
      model: 'child-model',
      clientRequestId: crypto.randomUUID(),
      userMessageId: childMessage.id,
      messageIdUpperBound: childMessage.id,
      contextSnapshot: [{ group: 'skills', content: '先检查请求账本' }],
    })
    appendStep(store, {
      runId: childRun.id,
      seq: 1,
      kind: 'thinking',
      status: 'done',
      content: '先比较 finish reason。',
    })
    const childRequest = openProviderRequest(store, {
      runId: childRun.id,
      turnIndex: 0,
      retryIndex: 0,
      model: 'child-model',
      measuredInputTokens: 50,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'child-payload',
    })
    settleProviderRequest(store, childRequest.id, 'received', null, null, 'tool_calls')
    finishRun(store, childRun.id, { status: 'done', stopReason: 'completed' })

    const grandchild = createConversation(store, {
      workspaceId,
      provider: 'child-provider',
      model: 'child-model',
      title: '孙会话',
      source: 'workflow',
      sourceRef: 'reviewer',
    })
    const grandchildMessage = appendMessage(store, {
      conversationId: grandchild.id,
      role: 'user',
      content: '复核研究员结论',
    })
    const grandchildRun = createRun(store, {
      conversationId: grandchild.id,
      workspaceId,
      model: 'child-model',
      clientRequestId: crypto.randomUUID(),
      userMessageId: grandchildMessage.id,
      messageIdUpperBound: grandchildMessage.id,
      contextSnapshot: [{ group: 'memory', content: '保留原始证据' }],
    })
    appendStep(store, {
      runId: grandchildRun.id,
      seq: 1,
      kind: 'text',
      status: 'done',
      content: '确认是工具专用响应。',
    })
    finishRun(store, grandchildRun.id, { status: 'done', stopReason: 'completed' })

    // 新账本：父 step 上直接有 childConversationId。
    appendStep(store, {
      runId: parentRun.id,
      seq: 10,
      kind: 'tool_action',
      toolName: 'delegate',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { task: '调查循环' },
        outcome: {
          status: 'success',
          executed: true,
          message: '研究完成',
          data: { conversationId: child.id },
        },
        childConversationId: child.id,
      },
    })
    // 子会话入口始终在 step 顶层；outcome 里的同名业务结果不是归档关系来源。
    appendStep(store, {
      runId: childRun.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'delegate',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { task: '复核' },
        outcome: {
          status: 'success',
          executed: true,
          message: '复核完成',
          data: { conversationId: grandchild.id },
        },
        childConversationId: grandchild.id,
      },
    })
    // 损坏账本可能形成环；应保留这条关系，但不能再次导出根正文或无限递归。
    appendStep(store, {
      runId: grandchildRun.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'delegate',
      status: 'success',
      payload: {
        kind: 'tool_result',
        args: { task: '错误回指' },
        outcome: { status: 'success', executed: true, message: '回指父会话' },
        childConversationId: conversationId,
      },
    })

    const text = exportConversationDiagnostics(store, conversationId, {
      active: { provider: 'p', model: 'deepseek-v4-flash' },
      providers: {
        p: {
          kind: 'openai_chat_completions',
          apiKey: 'root-secret',
          models: { 'deepseek-v4-flash': {} },
        },
        'child-provider': {
          kind: 'openai_responses',
          apiKey: 'child-secret',
          models: { 'child-model': { effort: 'high' } },
        },
      },
    })
    const parsed = JSON.parse(text)
    expect(parsed.conversationTree.rootConversationId).toBe(conversationId)
    expect(
      parsed.conversationTree.childConversations.map(
        (item: { conversation: { id: string } }) => item.conversation.id,
      ),
    ).toEqual([child.id, grandchild.id])
    expect(parsed.conversationTree.childConversations[0]).toMatchObject({
      conversation: { id: child.id, source: 'workflow', sourceRef: 'researcher' },
      messages: [{ content: '调查工具为什么循环' }],
      runs: [
        {
          contextSnapshot: [{ group: 'skills', content: '先检查请求账本' }],
          providerRequests: [{ finishReason: 'tool_calls' }],
        },
      ],
    })
    const exportedGrandchild = parsed.conversationTree.childConversations[1]
    expect(exportedGrandchild).toMatchObject({
      conversation: { id: grandchild.id, sourceRef: 'reviewer' },
      messages: [{ content: '复核研究员结论' }],
    })
    expect(exportedGrandchild.runs[0].steps[0]).toMatchObject({
      kind: 'text',
      content: '确认是工具专用响应。',
    })
    expect(parsed.conversationTree.links).toEqual([
      expect.objectContaining({
        parentConversationId: conversationId,
        childConversationId: child.id,
        source: 'step_payload',
      }),
      expect.objectContaining({
        parentConversationId: child.id,
        childConversationId: grandchild.id,
        source: 'step_payload',
      }),
      expect.objectContaining({
        parentConversationId: grandchild.id,
        childConversationId: conversationId,
        source: 'step_payload',
      }),
    ])
    expect(parsed.conversationTree.unresolvedChildren).toEqual([])
    expect(parsed.conversationProfiles).toContainEqual(
      expect.objectContaining({
        conversationId: child.id,
        provider: expect.objectContaining({
          name: 'child-provider',
          kind: 'openai_responses',
          model: 'child-model',
          effort: 'high',
        }),
      }),
    )
    expect(
      parsed.runSignals.some(
        (signal: { conversationId: string }) => signal.conversationId === grandchild.id,
      ),
    ).toBe(true)
    expect(parsed.coverage.childConversations).toBe('recursive_full_except_tool_result_media')
    expect(text).not.toContain('root-secret')
    expect(text).not.toContain('child-secret')
    store.close()
  })

  test('子会话引用损坏时仍导出父会话，并把缺失项明确列出', () => {
    const { store, conversationId } = fixture()
    const run = collect(store, conversationId).runs[0]!
    appendStep(store, {
      runId: run.id,
      seq: 10,
      kind: 'tool_action',
      toolName: 'delegate',
      status: 'failure',
      payload: {
        kind: 'tool_result',
        args: { task: '丢失的子会话' },
        outcome: { status: 'failure', executed: true, message: '子会话记录丢失' },
        childConversationId: 'cv_missing_child' as never,
      },
    })

    const parsed = JSON.parse(
      exportConversationDiagnostics(store, conversationId, {
        active: { provider: 'p', model: 'deepseek-v4-flash' },
        providers: {
          p: {
            kind: 'openai_chat_completions',
            apiKey: 'secret-api-key',
            models: { 'deepseek-v4-flash': {} },
          },
        },
      }),
    )
    expect(parsed.conversation.id).toBe(conversationId)
    expect(parsed.conversationTree.childConversations).toEqual([])
    expect(parsed.conversationTree.unresolvedChildren).toMatchObject([
      {
        link: { childConversationId: 'cv_missing_child' },
        error: '会话不存在：cv_missing_child',
      },
    ])
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
