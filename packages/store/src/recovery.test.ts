import { describe, expect, test } from 'bun:test'
import { Store } from './db.ts'
import {
  appendStep,
  createConversation,
  createRun,
  fileReadHash,
  finishRun,
  getConversation,
  getRun,
  listSteps,
  markRunRunning,
  markRunSuperseded,
  markStepExecuting,
  recordFileRead,
  recoverStaleRuns,
  setConversationModel,
  touchRun,
  upsertWorkspace,
} from './repos.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, { workspaceId: ws.id, model: 'claude-opus-5', title: 't' })
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
  })
}

describe('会话级模型切换', () => {
  test('写入后 getConversation 读到新模型', () => {
    const { store, conv } = fresh()
    const updated = setConversationModel(store, conv.id, 'deepseek-v4-pro')
    expect(updated?.model).toBe('deepseek-v4-pro')
    expect(getConversation(store, conv.id)?.model).toBe('deepseek-v4-pro')
    store.close()
  })

  test('会话不存在时返回 null，不静默成功', () => {
    const { store } = fresh()
    expect(setConversationModel(store, 'conv_nope' as never, 'm')).toBeNull()
    store.close()
  })
})

describe('retry / supersede', () => {
  test('已终结的 run 可以被标记接替', () => {
    const { store, ws, conv } = fresh()
    const first = newRun(store, ws, conv)
    finishRun(store, first.id, { status: 'failed', stopReason: 'provider_error' })
    const second = newRun(store, ws, conv)

    expect(markRunSuperseded(store, first.id, second.id)).toBe(true)
    expect(getRun(store, first.id)?.supersededBy).toBe(second.id)
    store.close()
  })

  test('仍在跑的 run 不能被接替 —— 否则两个 run 同时写同一个工作区', () => {
    const { store, ws, conv } = fresh()
    const first = newRun(store, ws, conv)
    markRunRunning(store, first.id)
    const second = newRun(store, ws, conv)

    expect(markRunSuperseded(store, first.id, second.id)).toBe(false)
    expect(getRun(store, first.id)?.supersededBy).toBeNull()
    store.close()
  })

  test('被接替的 run 保留，不删除 —— 那些步骤真实发生过', () => {
    const { store, ws, conv } = fresh()
    const first = newRun(store, ws, conv)
    appendStep(store, { runId: first.id, seq: 1, kind: 'text', content: '写过的字' })
    finishRun(store, first.id, { status: 'failed', stopReason: 'provider_error' })
    const second = newRun(store, ws, conv)
    markRunSuperseded(store, first.id, second.id)

    expect(getRun(store, first.id)).not.toBeNull()
    expect(listSteps(store, first.id)).toHaveLength(1)
    store.close()
  })
})

describe('崩溃恢复', () => {
  test('没进执行器的 run 判为可安全重来', () => {
    const { store, ws, conv } = fresh()
    const run = newRun(store, ws, conv)
    markRunRunning(store, run.id)
    // 有 step，但从没调用 markStepExecuting —— 确定没进执行器。
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
    expect(after.stopReason).toBe('user_interrupt')
    store.close()
  })

  test('进了执行器却没落终态的 run 判为结果不可信', () => {
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
    // 两种情况的 stopReason 必须不同：统一了就分不出「进程崩了」和「用户点了停止」。
    expect(after.stopReason).not.toBe('user_interrupt')
    store.close()
  })

  test('卡在 running 的 step 一并落终态 —— 否则 UI 留一张永远转圈的卡', () => {
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
    expect((settled.payload as Record<string, any>).outcome.executed).toBe(true)
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

  test('干净启动时是零成本的 no-op', () => {
    const { store } = fresh()
    expect(recoverStaleRuns(store)).toEqual({ recovered: 0, ambiguous: 0, heldByOthers: 0 })
    store.close()
  })
})

/**
 * **只回收没人在跑的那些。**
 *
 * 账本是共享的：两个工作区的 sidecar、开发态热重载、终端里的 `qy exec` 都写它。
 * 这里原来无差别回收，实测把另一个进程正在跑的一轮判死了——那条 run 已经跑了
 * 40 步，第 27 次请求发出后 257 毫秒被写成 interrupted，写入者是刚起来的进程。
 *
 * 四条判据两两互补，所以四条都要测：pid 会被复用（只看 pid 会漏），
 * 崩溃后立刻重启时心跳还是新的（只看心跳会漏）。
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

  test('归属进程活着、心跳在推 → 放过，这是别人正在跑的那一轮', () => {
    const { store, run } = running()
    // 父进程一定活着，而且不是自己——正是「另一个还在跑的进程」的形状。
    setOwner(store, run.id, process.ppid, Date.now())

    const r = recoverStaleRuns(store)
    expect(r.recovered).toBe(0)
    expect(r.heldByOthers).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('running')
    store.close()
  })

  test('归属进程活着但心跳早停了 → 回收（pid 被复用的兜底）', () => {
    const { store, run } = running()
    setOwner(store, run.id, process.ppid, Date.now() - 10 * 60_000)

    expect(recoverStaleRuns(store).recovered).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('interrupted')
    store.close()
  })

  test('归属进程已经没了 → 回收，哪怕心跳是刚推的', async () => {
    const { store, run } = running()
    // 真起一个进程再等它退出：拿一个确定死掉的 pid，不靠猜一个大数字。
    const dead = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' })
    await dead.exited
    setOwner(store, run.id, dead.pid, Date.now())

    expect(recoverStaleRuns(store).recovered).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('interrupted')
    store.close()
  })

  /**
   * **这条是「不要引入新 bug」的那一条。**
   *
   * 崩溃后立刻重启，Windows 把同一个 pid 发给了新进程。此时 pid 活着（就是我）、
   * 心跳才过去两秒——只按这两条判都会认定「还有人在跑」，那条 run 于是永远没人
   * 回收，会话被 isBusy 永久锁死。所以「归属是我自己」必须单独成一条，且在心跳之前。
   */
  test('归属是本进程的 pid → 回收：我刚启动，不可能拥有任何 run', () => {
    const { store, run } = running()
    setOwner(store, run.id, process.pid, Date.now())

    expect(recoverStaleRuns(store).recovered).toBe(1)
    expect(getRun(store, run.id)?.status).toBe('interrupted')
    store.close()
  })

  test('心跳只推 running 的行 —— 终态 run 不该看起来像还在跑', () => {
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

describe('会话级读记录', () => {
  test('记下、读回、覆盖只留最近一次', () => {
    const { store, conv } = fresh()
    expect(fileReadHash(store, conv.id, 'C:/ws/a.ts')).toBeNull()

    recordFileRead(store, conv.id, 'C:/ws/a.ts', 'h1')
    expect(fileReadHash(store, conv.id, 'C:/ws/a.ts')).toBe('h1')

    recordFileRead(store, conv.id, 'C:/ws/a.ts', 'h2')
    expect(fileReadHash(store, conv.id, 'C:/ws/a.ts')).toBe('h2')
    store.close()
  })

  test('按会话隔离 —— 另一条会话读过不算你读过', () => {
    const { store, ws, conv } = fresh()
    const other = createConversation(store, { workspaceId: ws.id, model: 'm' })
    recordFileRead(store, conv.id, 'C:/ws/a.ts', 'h1')
    expect(fileReadHash(store, other.id, 'C:/ws/a.ts')).toBeNull()
    store.close()
  })
})

describe('终态 run 底下的孤儿 step', () => {
  /**
   * **这条是回归测试，挡的是一个真实写错过的形状。**
   *
   * 孤儿扫描原本写在「有 stale run」的早退之后，于是最常见的情形——
   * run 全是终态、底下留着 running step——那趟扫描一次都不会跑。
   * 而这正是它要治的场景：`tool.started` 的 yield 处被生成器 `.return()`
   * 掐断，step 已经 running 但没人收尾，随后 run 被标成 interrupted 终态。
   *
   * 后果不是「UI 上一张转圈的卡」：历史投影必须跳过含未终结调用的整个 batch，
   * 一条孤儿会让同批次里**已经成功的写文件结果一起从历史里消失**。
   */
  test('没有任何 stale run 时，孤儿 step 照样被收尾', () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const conv = createConversation(store, { workspaceId: ws.id, model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'c1',
      userMessageId: null,
      messageIdUpperBound: null,
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
    // run 先落终态——这一步让它逃出「status IN ('running','queued')」那次扫描。
    finishRun(store, run.id, { status: 'interrupted', stopReason: 'user_interrupt' })

    const result = recoverStaleRuns(store)
    // 一个 stale run 都没有。
    expect(result.recovered).toBe(0)

    const settled = listSteps(store, run.id)[0]
    expect(settled?.status).toBe('failure')
    // 已进执行器 → 保守标「可能已执行」，不能说没执行。
    expect((settled?.payload as { outcome?: { executed?: boolean } })?.outcome?.executed).toBe(true)
    store.close()
  })
})
