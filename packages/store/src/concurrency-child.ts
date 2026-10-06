/**
 * `concurrency.test.ts` 的子进程入口：多个操作系统进程同时对同一个库文件执行同一操作。
 *
 * 单进程内无法构造这些竞争：bun:sqlite 是同步的，同一线程中的两个连接只能依次执行。
 * 开始执行的时刻用 HTTP 屏障对齐，参数经由环境变量传递（Windows 的命令行转义会改写含反斜杠的路径）。
 * 每个进程在 stdout 上输出一行 JSON：`{ ok, value?, error? }`。
 *
 * 创建轮次的两种模式：`create-run` 争用同一会话，成功的一方在 `QY_CC_HOLD_MS` 内不退出，
 * 使其他进程查到的占用方仍然存活；`hold` 创建一轮后持续不退出，由测试结束该进程。
 */

import type { ConversationId, WorkspaceId } from '@qywork/core'
import { type RunOwner, Store } from './db.ts'
import { createGoal, updateGoal } from './goals.ts'
import { ConversationBusyError, createRun, upsertWorkspace } from './repos.ts'

const mode = process.env.QY_CC_MODE ?? ''
const dbPath = process.env.QY_CC_DB ?? ''
const barrier = Number(process.env.QY_CC_BARRIER ?? '0')
const arg = process.env.QY_CC_ARG ?? ''
const owner = (process.env.QY_CC_OWNER || undefined) as RunOwner | undefined
const holdMs = Number(process.env.QY_CC_HOLD_MS ?? '2000')

function newRun(store: Store) {
  const [conversationId, workspaceId] = arg.split('|')
  return createRun(store, {
    conversationId: conversationId as ConversationId,
    workspaceId: workspaceId as WorkspaceId,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
}

async function waitAtBarrier(): Promise<void> {
  if (barrier > 0) await fetch(`http://127.0.0.1:${barrier}/ready`)
}

try {
  if (mode === 'open') {
    // 打开本身就是被测行为：切换 WAL 与迁移都在构造函数中执行。
    await waitAtBarrier()
    new Store({ path: dbPath }).close()
    console.log(JSON.stringify({ ok: true }))
  } else {
    const store = new Store({ path: dbPath, ...(owner ? { owner } : {}) })
    await waitAtBarrier()
    if (mode === 'create-run') {
      try {
        newRun(store)
        console.log(JSON.stringify({ ok: true, value: 'ok', pid: process.pid }))
        await Bun.sleep(holdMs)
      } catch (err) {
        if (!(err instanceof ConversationBusyError)) throw err
        console.log(
          JSON.stringify({
            ok: true,
            value: 'busy',
            holderPid: err.holder.ownerPid,
            error: err.message,
          }),
        )
      }
    } else if (mode === 'hold') {
      const run = newRun(store)
      console.log(JSON.stringify({ ok: true, value: run.id, pid: process.pid }))
      await new Promise(() => {})
    } else if (mode === 'upsert') {
      console.log(JSON.stringify({ ok: true, value: upsertWorkspace(store, arg, 'W').id }))
    } else if (mode === 'create-goal') {
      const r = createGoal(store, { conversationId: arg as ConversationId, objective: '并发目标' })
      console.log(JSON.stringify({ ok: true, value: r.ok ? 'ok' : r.code }))
    } else if (mode === 'update-goal') {
      const [conversationId, goalId] = arg.split('|')
      const r = updateGoal(store, {
        conversationId: conversationId as ConversationId,
        goalId: goalId ?? '',
        revision: 1,
        action: 'pause',
      })
      console.log(JSON.stringify({ ok: true, value: r.ok ? 'ok' : r.code }))
    } else {
      throw new Error(`未知模式：${mode}`)
    }
    store.close()
  }
} catch (err) {
  console.log(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  )
}
