/**
 * 跨进程并发打开与写入同一个库。覆盖范围：`db.ts` 的 `enableWal` 与 `Store.migrate`、
 * `repos.ts` 的 `upsertWorkspace` 与 `createRun`（跨进程占用判定）、`goals.ts` 的 `createGoal` / `updateGoal`。
 * 子进程入口是 `concurrency-child.ts`。
 *
 * 每条用例都复现原始失败形状：多个进程在同一时刻执行同一操作。对应的失败依次是
 * 全新库上有进程报 `database is locked` 或 `table … already exists`、同一目录触发 `root_path` 的 UNIQUE 冲突、
 * 同一会话创建多个进行中的目标、同一会话在两个进程中各启动一轮。
 */

import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './db.ts'
import { createGoal } from './goals.ts'
import { ConversationBusyError, createConversation, createRun, upsertWorkspace } from './repos.ts'
import { MIGRATIONS } from './schema.ts'

const CHILD = join(import.meta.dir, 'concurrency-child.ts')
const PROCESSES = 4

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-store-cc-'))
  dirs.push(dir)
  return dir
}

/** 等待 `expected` 个进程全部到达后一并放行；子进程冷启动时间不一，没有屏障时各进程的执行区间不重叠。 */
function barrier(expected: number) {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived = 0
  const server = Bun.serve({
    port: 0,
    // 先到的请求须挂起至最后一个进程到达；默认 10 秒空闲超时会在满负载冷启动时将其中止。
    idleTimeout: 120,
    async fetch() {
      arrived++
      if (arrived >= expected) release()
      await gate
      return new Response('go')
    },
  })
  return { port: server.port ?? 0, stop: () => server.stop(true) }
}

async function race(mode: string, dbPath: string, arg = '', env: Record<string, string> = {}) {
  const gate = barrier(PROCESSES)
  try {
    const procs = Array.from({ length: PROCESSES }, () =>
      Bun.spawn([process.execPath, CHILD], {
        env: {
          ...process.env,
          ...env,
          QY_CC_MODE: mode,
          QY_CC_DB: dbPath,
          QY_CC_BARRIER: String(gate.port),
          QY_CC_ARG: arg,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    return await Promise.all(
      procs.map(async (p) => {
        const [out, err] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ])
        const line = out.trim().split(/\r?\n/).at(-1) ?? ''
        try {
          return JSON.parse(line) as {
            ok: boolean
            value?: string
            error?: string
            pid?: number
            holderPid?: number
          }
        } catch {
          return { ok: false, error: `子进程没有输出结果：${err.slice(-400)}` }
        }
      }),
    )
  } finally {
    gate.stop()
  }
}

test('全新库上四个进程同时打开：全部成功，每条迁移恰好登记一次', async () => {
  for (let round = 0; round < 3; round++) {
    const path = join(tempDir(), 'ledger.sqlite3')
    const results = await race('open', path)
    expect(results.filter((r) => !r.ok)).toEqual([])
    const db = new Database(path)
    const ids = db
      .query<{ id: number }, []>('SELECT id FROM _migrations ORDER BY id')
      .all()
      .map((r) => r.id)
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode
    db.close()
    expect(ids).toEqual(MIGRATIONS.map((m) => m.id))
    expect(mode).toBe('wal')
  }
}, 60_000)

test('四个进程同时为同一目录创建工作区：全部成功且为同一行', async () => {
  const dir = tempDir()
  const path = join(dir, 'ledger.sqlite3')
  new Store({ path }).close()
  const results = await race('upsert', path, join(dir, 'ws'))
  expect(results.filter((r) => !r.ok)).toEqual([])
  expect(new Set(results.map((r) => r.value)).size).toBe(1)
}, 60_000)

test('四个进程同时为同一会话创建目标：恰好一个成功，其余返回 goal_exists', async () => {
  const dir = tempDir()
  const path = join(dir, 'ledger.sqlite3')
  const store = new Store({ path })
  const ws = upsertWorkspace(store, join(dir, 'ws'), 'W')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  store.close()
  const results = await race('create-goal', path, conv.id)
  expect(results.filter((r) => !r.ok)).toEqual([])
  expect(results.map((r) => r.value).sort()).toEqual([
    'goal_exists',
    'goal_exists',
    'goal_exists',
    'ok',
  ])
}, 60_000)

test('四个进程以同一个 revision 修改目标：恰好一个成功，其余返回 stale_revision 而不是抛出异常', async () => {
  const dir = tempDir()
  const path = join(dir, 'ledger.sqlite3')
  const store = new Store({ path })
  const ws = upsertWorkspace(store, join(dir, 'ws'), 'W')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const created = createGoal(store, { conversationId: conv.id, objective: '目标' })
  store.close()
  if (!created.ok) throw new Error(created.message)
  const results = await race('update-goal', path, `${conv.id}|${created.goal.id}`)
  expect(results.filter((r) => !r.ok)).toEqual([])
  expect(results.map((r) => r.value).sort()).toEqual([
    'ok',
    'stale_revision',
    'stale_revision',
    'stale_revision',
  ])
}, 60_000)

/** 创建工作区与会话，返回 `createRun` 所需的两个 id。 */
function seedConversation(dir: string) {
  const path = join(dir, 'ledger.sqlite3')
  const store = new Store({ path })
  const ws = upsertWorkspace(store, join(dir, 'ws'), 'W')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  store.close()
  return { path, ws, conv }
}

function runInput(conversationId: string, workspaceId: string) {
  return {
    conversationId: conversationId as never,
    workspaceId: workspaceId as never,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }
}

/** 启动一个创建轮次后不退出的占用进程，等待其输出 run id 与 pid。 */
async function spawnHolder(path: string, arg: string, owner: 'serve' | 'cli') {
  const proc = Bun.spawn([process.execPath, CHILD], {
    env: { ...process.env, QY_CC_MODE: 'hold', QY_CC_DB: path, QY_CC_ARG: arg, QY_CC_OWNER: owner },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = proc.stdout.getReader()
  let text = ''
  while (!/\r?\n/.test(text)) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  const line = JSON.parse(text.trim()) as { ok: boolean; value: string; pid: number }
  if (!line.ok) throw new Error(`占用进程没有建成轮：${text}`)
  return { proc, runId: line.value, pid: line.pid }
}

test('四个进程同时在同一会话上启动一轮：恰好一个成功，其余报告占用方', async () => {
  const { path, ws, conv } = seedConversation(tempDir())
  const results = await race('create-run', path, `${conv.id}|${ws.id}`, { QY_CC_OWNER: 'cli' })
  expect(results.filter((r) => !r.ok)).toEqual([])
  const winners = results.filter((r) => r.value === 'ok')
  expect(winners).toHaveLength(1)
  const losers = results.filter((r) => r.value === 'busy')
  expect(losers).toHaveLength(PROCESSES - 1)
  for (const l of losers) {
    expect(l.holderPid).toBe(winners[0]?.pid)
    expect(l.error).toContain('终端的 qy')
  }
}, 60_000)

test('占用进程结束后，另一个进程可以在同一会话上启动一轮', async () => {
  const dir = tempDir()
  const { path, ws, conv } = seedConversation(dir)
  const holder = await spawnHolder(path, `${conv.id}|${ws.id}`, 'serve')
  const store = new Store({ path, owner: 'cli' })
  try {
    let busy: unknown = null
    try {
      createRun(store, runInput(conv.id, ws.id))
    } catch (err) {
      busy = err
    }
    expect(busy).toBeInstanceOf(ConversationBusyError)
    expect((busy as ConversationBusyError).holder).toEqual({
      runId: holder.runId as never,
      ownerPid: holder.pid,
      ownerKind: 'serve',
    })
    expect((busy as Error).message).toContain('桌面端')

    holder.proc.kill()
    await holder.proc.exited
    const run = createRun(store, runInput(conv.id, ws.id))
    expect(run.conversationId).toBe(conv.id)
  } finally {
    holder.proc.kill()
    store.close()
  }
}, 60_000)

test('占用进程仍存在但心跳超过一分钟未更新：可以启动一轮', async () => {
  const dir = tempDir()
  const { path, ws, conv } = seedConversation(dir)
  const holder = await spawnHolder(path, `${conv.id}|${ws.id}`, 'serve')
  const store = new Store({ path, owner: 'cli' })
  try {
    store.db
      .query('UPDATE runs SET heartbeat_at = ? WHERE id = ?')
      .run(Date.now() - 120_000, holder.runId)
    const run = createRun(store, runInput(conv.id, ws.id))
    expect(run.conversationId).toBe(conv.id)
  } finally {
    holder.proc.kill()
    await holder.proc.exited
    store.close()
  }
}, 60_000)
