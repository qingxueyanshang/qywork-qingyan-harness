import { describe, expect, test } from 'bun:test'
import type { StepPayload } from '@qywork/core'
import { Store } from './db.ts'
import {
  appendStep,
  createConversation,
  createRun,
  fileReadHash,
  finishRun,
  getConversation,
  getRun,
  listProviderRequests,
  listSteps,
  markProviderRequestSent,
  markRunRunning,
  markStepExecuting,
  openProviderRequest,
  recordFileRead,
  recoverStaleRuns,
  setConversationModel,
  setStepNodeState,
  settleToolStep,
  touchRun,
  upsertWorkspace,
} from './repos.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'claude-opus-5',
    title: 't',
  })
  return { store, ws, conv }
}

function newRun(store: Store, ws: { id: string }, conv: { id: string }) {
  return createRun(store, {
    conversationId: conv.id as never,
    workspaceId: ws.id as never,
    model: 'claude-opus-5',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
}

describe('会话级模型切换', () => {
  test('写入后 getConversation 读取到新模型', () => {
    const { store, conv } = fresh()
    const updated = setConversationModel(store, conv.id, {
      provider: 'mirror',
      model: 'deepseek-v4-pro',
    })
    expect(updated?.model).toBe('deepseek-v4-pro')
    expect(updated?.provider).toBe('mirror')
    const back = getConversation(store, conv.id)
    expect(back?.model).toBe('deepseek-v4-pro')
    // 接口与模型一同更换：只写入模型时，若两个接口下配置了同名模型，会话的归属只能推测。
    expect(back?.provider).toBe('mirror')
    store.close()
  })

  test('会话不存在时返回 null，不静默成功', () => {
    const { store } = fresh()
    expect(
      setConversationModel(store, 'conv_nope' as never, { provider: 'p', model: 'm' }),
    ).toBeNull()
    store.close()
  })
})

describe('崩溃恢复', () => {
  test('未进入执行器的 run 判定为可以安全重新执行', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    // 有 step，但从未调用 markStepExecuting：确定未进入执行器。
    appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'read_file',
      status: 'running',
    })

    const result = recoverStaleRuns(store)
    expect(result.recovered).toBe(1)
    expect(result.ambiguous).toBe(0)

    const after = getRun(store, run.id)!
    expect(after.status).toBe('interrupted')
    /*
     * 不是 `user_interrupt`：用户没有点击停止，而是服务进程退出。
     * 两者共用一个停止原因时事后无法区分，界面只显示「已中断」，
     * 进程退出因此被显示为用户的停止操作。判据写在 `recoverStaleRuns` 顶部。
     */
    expect(after.stopReason).toBe('process_exit')
    expect(after.interruption).toMatchObject({
      source: 'orphan_recovery',
      ownerPid: process.pid,
      ambiguousToolExecution: false,
    })
    store.close()
  })

  test('桌面外壳观察到的退出码与 stderr 末段随 run 写入账本', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)

    recoverStaleRuns(store, {
      source: 'desktop_sidecar',
      observedAt: 1_725_000_000_000,
      exitKind: 'terminated',
      exitCode: -1_073_741_819,
      signal: null,
      stderrTail: 'panic at packages/server/src/server.ts:173',
    })

    const after = getRun(store, run.id)!
    expect(after.errorMessage).toContain('exit code -1073741819')
    expect(after.interruption).toMatchObject({
      source: 'desktop_sidecar',
      observedAt: 1_725_000_000_000,
      exitKind: 'terminated',
      exitCode: -1_073_741_819,
      stderrTail: 'panic at packages/server/src/server.ts:173',
      ambiguousToolExecution: false,
    })
    store.close()
  })

  test('已发出但未结束的 provider 请求随孤儿 run 记为 uncertain', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    const request = openProviderRequest(store, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      model: 'claude-opus-5',
      measuredInputTokens: 123,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'payload',
    })
    markProviderRequestSent(store, request.id)

    expect(recoverStaleRuns(store).recovered).toBe(1)
    const [after] = listProviderRequests(store, run.id)
    expect(after?.status).toBe('uncertain')
    expect(after?.providerInputTokens).toBeNull()
    expect(after?.providerOutputTokens).toBeNull()
    expect(after?.providerCachedTokens).toBeNull()
    expect(after?.providerCacheWriteTokens).toBeNull()
    expect(after?.completedAt).not.toBeNull()
    expect(after?.diagnostic?.retry.decision).toBe('process_exit')
    store.close()
  })

  test('已进入执行器但未写入终态的 run 判定为结果不可信', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      status: 'running',
    })
    markStepExecuting(store, step.id)

    const result = recoverStaleRuns(store)
    expect(result.ambiguous).toBe(1)

    const after = getRun(store, run.id)!
    expect(after.stopReason).toBe('internal_guard')
    // 两种情况的 stopReason 必须不同：统一后无法区分「进程崩溃」与「用户点击了停止」。
    expect(after.stopReason).not.toBe('user_interrupt')
    store.close()
  })

  test('停留在 running 的 step 一并写入终态，否则界面上会留下一张持续加载的卡片', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      status: 'running',
    })
    markStepExecuting(store, step.id)

    recoverStaleRuns(store)

    const settled = listSteps(store, run.id)[0]!
    expect(settled.status).toBe('failure')
    // executed 取保守值 true：无法判定时不能向模型断言「没有副作用」。
    expect((settled.payload as { outcome: { executed: boolean } }).outcome.executed).toBe(true)
    store.close()
  })

  test('写入终态时只修改 outcome，action 与 args 必须原样保留', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    const started = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'run_command',
      status: 'running',
      payload: {
        kind: 'tool_call',
        args: { command: 'docker start sqhj-postgres' },
        action: { kind: 'run', objectLabel: '命令', target: 'docker start sqhj-postgres' },
      } as never,
    })
    markStepExecuting(store, started.id)
    const notStarted = appendStep(store, {
      runId: run.id,
      seq: 2,
      kind: 'tool_action',
      toolName: 'read_file',
      status: 'running',
      payload: {
        kind: 'tool_call',
        args: { path: 'run.ps1' },
        action: { kind: 'read', objectLabel: '文件', target: 'run.ps1' },
      } as never,
    })

    recoverStaleRuns(store)

    // 使用 `StepPayload` 中 tool_result 分支的类型，不另行定义：本测试验证的是结束之后
    // payload 的形状，另行定义时，写入侧修改字段名不会使本测试失败。
    const payloadOf = (id: string) =>
      listSteps(store, run.id).find((x) => x.id === id)!.payload as Extract<
        StepPayload,
        { kind: 'tool_result' }
      >

    // action 丢失后，该 step 在会话流中只显示「失败」，没有标题：
    // 标题（动词 + 对象 + 目标）全部由它提供，前端无法推测。
    for (const id of [started.id, notStarted.id]) {
      const p = payloadOf(id)
      expect(p.kind).toBe('tool_result')
      expect(p.action).toBeDefined()
      expect(p.args).toBeDefined()
      expect(p.outcome.status).toBe('failure')
    }

    const one = payloadOf(started.id)
    expect(one.action?.objectLabel).toBe('命令')
    expect(one.args?.command).toBe('docker start sqhj-postgres')
    // 合并写入 outcome 之后，两种情况的 executed 仍须不同。
    expect(one.outcome.executed).toBe(true)
    const two = payloadOf(notStarted.id)
    expect(two.outcome.executed).toBe(false)
    expect(two.action?.objectLabel).toBe('文件')
    store.close()
  })

  test('已终结的 run 不受影响', () => {
    const { store, ws, conv } = fresh()
    const done = newRun(store, ws, conv)
    finishRun(store, done.id, { status: 'done', stopReason: 'completed' })

    expect(recoverStaleRuns(store).recovered).toBe(0)
    expect(getRun(store, done.id)?.stopReason).toBe('completed')
    store.close()
  })

  test('终态 run 下遗留的 in_flight 请求也收敛为 uncertain', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    const request = openProviderRequest(store, {
      runId: run.id,
      turnIndex: 0,
      retryIndex: 0,
      model: 'claude-opus-5',
      measuredInputTokens: 123,
      sentCategories: {} as never,
      omittedCategories: {} as never,
      payloadHash: 'payload',
    })
    markProviderRequestSent(store, request.id)
    finishRun(store, run.id, { status: 'interrupted', stopReason: 'process_exit' })

    expect(recoverStaleRuns(store).recovered).toBe(0)
    expect(listProviderRequests(store, run.id)[0]?.status).toBe('uncertain')
    store.close()
  })

  test('无残留时启动是零开销的 no-op', () => {
    const { store } = fresh()
    expect(recoverStaleRuns(store)).toEqual({ recovered: 0, ambiguous: 0, heldByOthers: 0 })
    store.close()
  })
})

/**
 * 只回收已无进程执行的 run。
 *
 * 账本是共享的：两个工作区的 sidecar、开发模式热重载、终端中的 `qy exec` 都会写入。
 * 不加区分地回收会把另一个进程正在执行的一轮判定为中断。实测形状：该 run 已执行了
 * 40 步，第 27 次请求发出后 257 毫秒被写为 interrupted，写入者是刚启动的进程。
 *
 * 四条判据两两互补，因此四条都需要测试：pid 会被复用（只检查 pid 会遗漏），
 * 崩溃后立即重启时心跳仍是新的（只检查心跳会遗漏）。
 */
describe('run 归属', () => {
  const setOwner = (store: Store, id: string, pid: number, beat: number) =>
    store.db
      .query('UPDATE runs SET owner_pid = ?, heartbeat_at = ? WHERE id = ?')
      .run(pid, beat, id)

  function running() {
    const f = fresh()
    const run = newRun(f.store, f.ws, f.conv)
    markRunRunning(f.store, run.id)
    return { ...f, run }
  }

  test('归属进程存活、心跳持续更新 → 跳过，这是其他进程正在执行的一轮', () => {
    const { store, run } = running()
    // 父进程必然存活，且不是本进程：符合「另一个仍在运行的进程」的条件。
    setOwner(store, run.id, process.ppid, Date.now())

    const r = recoverStaleRuns(store)
    expect(r.recovered).toBe(0)
    expect(r.heldByOthers).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('running')
    store.close()
  })

  test('归属进程存活但心跳已停止 → 回收（应对 pid 被复用）', () => {
    const { store, run } = running()
    setOwner(store, run.id, process.ppid, Date.now() - 10 * 60_000)

    expect(recoverStaleRuns(store).recovered).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('interrupted')
    store.close()
  })

  test('归属进程已退出 → 回收，即使心跳刚刚更新', async () => {
    const { store, run } = running()
    // 实际启动一个进程并等待其退出，以取得确定已退出的 pid，不使用推测的大数值。
    const dead = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' })
    await dead.exited
    setOwner(store, run.id, dead.pid, Date.now())

    expect(recoverStaleRuns(store).recovered).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('interrupted')
    store.close()
  })

  /**
   * 本用例锁定 pid 被复用时的判定顺序。
   *
   * 崩溃后立即重启时，Windows 把同一个 pid 分配给了新进程。此时 pid 存活（即本进程）、
   * 心跳仅过去两秒：只按这两条判定都会认为仍有进程在运行，该 run 因此永远不会
   * 被回收，会话被 isBusy 永久锁定。因此「归属是本进程」必须单独成为一条判据，且位于心跳之前。
   */
  test('归属是本进程的 pid → 回收：本进程刚启动，不可能拥有任何 run', () => {
    const { store, run } = running()
    setOwner(store, run.id, process.pid, Date.now())

    expect(recoverStaleRuns(store).recovered).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('interrupted')
    store.close()
  })

  test('心跳只更新 running 的行，终态 run 不应显示为仍在运行', () => {
    const { store, run } = running()
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })
    setOwner(store, run.id, process.ppid, 0)
    touchRun(store, run.id)

    const beat = store.db
      .query<{ heartbeat_at: number | null }, [string]>(
        'SELECT heartbeat_at FROM runs WHERE id = ?',
      )
      .get(run.id)?.heartbeat_at
    expect(beat).toBe(0)
    store.close()
  })
})

describe('会话级读取记录', () => {
  test('记录与读取，覆盖时只保留最近一次', () => {
    const { store, conv } = fresh()
    expect(fileReadHash(store, conv.id, 'C:/ws/a.ts')).toBeNull()

    recordFileRead(store, conv.id, 'C:/ws/a.ts', 'h1')
    expect(fileReadHash(store, conv.id, 'C:/ws/a.ts')).toBe('h1')

    recordFileRead(store, conv.id, 'C:/ws/a.ts', 'h2')
    expect(fileReadHash(store, conv.id, 'C:/ws/a.ts')).toBe('h2')
    store.close()
  })

  test('按会话隔离：其他会话的读取不计入当前会话', () => {
    const { store, ws, conv } = fresh()
    const other = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    recordFileRead(store, conv.id, 'C:/ws/a.ts', 'h1')
    expect(fileReadHash(store, other.id, 'C:/ws/a.ts')).toBeNull()
    store.close()
  })
})

describe('终态 run 下的孤儿 step', () => {
  /**
   * 本用例是回归测试，锁定已实际出现的错误形状。
   *
   * 孤儿扫描若位于「存在 stale run」的提前返回之后，在最常见的情形下，
   * 即 run 全部为终态、其下留有 running step 时，孤儿扫描不会执行。
   * 该情形正是孤儿扫描的处理对象：生成器在 `tool.started` 的 yield 处被 `.return()`
   * 中止，step 已是 running 但未被结束，随后 run 被标为 interrupted 终态。
   *
   * 除界面上持续加载的卡片外，历史投影必须跳过含未终结调用的整个 batch，
   * 因此一条孤儿 step 会使同批次中已成功的写文件结果一并从历史中消失。
   */
  test('没有任何 stale run 时，孤儿 step 同样被结束', () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'c1',
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    const orphan = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'write_file',
      toolCallId: 'A',
      providerBatchId: 'b1',
      callIndex: 0,
      status: 'running',
      payload: { kind: 'tool_call', args: { path: 'a.ts' } },
    })
    markStepExecuting(store, orphan.id)
    // run 先写入终态，使它不在「status IN ('running','queued')」扫描的范围内。
    finishRun(store, run.id, { status: 'interrupted', stopReason: 'user_interrupt' })

    const result = recoverStaleRuns(store)
    // 不存在任何 stale run。
    expect(result.recovered).toBe(0)

    const settled = listSteps(store, run.id)[0]
    expect(settled?.status).toBe('failure')
    // 已进入执行器 → 保守标记为「可能已执行」，不能声称未执行。
    expect((settled?.payload as { outcome?: { executed?: boolean } })?.outcome?.executed).toBe(true)
    store.close()
  })
})

/**
 * 派发任务卡上的节点不随 run 结束：子 agent 的生命周期与会话一致，回执可能几分钟后才到达。
 * 重启之后进程中已无接收方处理该回执，因此回收时须把它们标为中断；
 * 否则该图既无法 approve（上游回执不完整）也无法 revise（指定的节点没有终态）。
 */
describe('重启回收扫描派发任务卡上的节点', () => {
  test('终态 run 下未写入终态的节点标为中断，已有终态的不变', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    const step = appendStep(store, {
      runId: run.id,
      seq: 1,
      kind: 'tool_action',
      toolName: 'workflow',
      status: 'running',
      payload: { kind: 'tool_call', args: {} } as never,
    })
    setStepNodeState(store, step.id, 'fast', { phase: 'done', label: '快', durationMs: 1 })
    setStepNodeState(store, step.id, 'slow', { phase: 'working', label: '慢' })
    // 工具已经返回：派出即返回，节点的终态写在一张已处于终态的卡片上。
    settleToolStep(store, step.id, 'success', {
      kind: 'tool_result',
      args: {},
      outcome: { status: 'success', executed: true, message: '已起跑' },
    })
    finishRun(store, run.id, { status: 'done', stopReason: 'completed' })

    recoverStaleRuns(store)

    const nodes = (
      listSteps(store, run.id)[0]?.payload as {
        nodes?: Record<string, { phase: string; error?: string }>
      }
    ).nodes
    expect(nodes?.slow).toMatchObject({ phase: 'interrupted', error: '调用中断' })
    expect(nodes?.fast).toMatchObject({ phase: 'done' })
    store.close()
  })
})
