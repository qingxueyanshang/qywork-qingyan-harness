/**
 * 跨操作系统进程的正文写入与回收竞争。覆盖范围：`runtime/sink.ts` 的 `RuntimeSink.land`
 * 与 `collectResourceGarbage` 共用的主库锁顺序，以及 `store/content.ts` 的写事务在锁竞争下的行为。
 * 子进程入口是 `resource-gc-race-child.ts`。
 *
 * 同一进程内的交错由 `sink.test.ts` 验证，该测试证明窗口不存在；本测试证明
 * 另一个进程会等待，且等待结束后取得完整集合：等待只在跨进程时成立。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { collectResourceGarbage } from './sink.ts'

const CHILD = join(import.meta.dir, 'resource-gc-race-child.ts')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 创建一对真实数据库文件，并预置工作区、会话与 run：子进程只写入正文与引用。 */
function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-gc-race-'))
  dirs.push(dir)
  const dbPath = join(dir, 'race.sqlite3')
  const store = new Store({ path: dbPath })
  const ws = upsertWorkspace(store, dir, 'W')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    title: 't',
  })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  return { dir, dbPath, store, conv, run }
}

/**
 * 屏障：等待 `expected` 个进程全部到达后同时放行。
 *
 * 没有屏障时，先启动的进程会在另一个进程打开数据库之前执行完毕，两个进程的执行区间不重叠。
 */
function barrier(expected: number) {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived = 0
  const server = Bun.serve({
    port: 0,
    // 先到达的请求须保持挂起，直到最后一个进程到达。默认 10 秒的空闲超时会中止该请求，
    // 而子进程冷启动在满负载下可能超过该时长：此时失败的是屏障，不是被测行为。
    idleTimeout: 120,
    async fetch() {
      arrived++
      if (arrived >= expected) release()
      await gate
      return new Response('go')
    },
  })
  return { port: server.port ?? 0, stop: () => server.stop(true), arrived: () => arrived }
}

function spawnChild(env: Record<string, string>) {
  return Bun.spawn([process.execPath, CHILD], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function collect(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) {
  const [exitCode, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode, out, err }
}

test('活跃写入期间另一个进程执行回收：等待后取得写锁，不删除正在登记的正文', async () => {
  const { dbPath, store, run } = seed()
  // 预置几条无引用的正文，使回收方有实际可回收的内容：removed 恒为 0 时无法证明回收已执行。
  const content = new ContentStore(contentPathFor(dbPath))
  for (const s of ['孤儿一', '孤儿二', '孤儿三']) content.put(new TextEncoder().encode(s))
  content.close()
  store.close()

  const gate = barrier(2)
  const lander = spawnChild({
    QY_RACE_MODE: 'land',
    QY_RACE_DB: dbPath,
    QY_RACE_BARRIER: String(gate.port),
    QY_RACE_COUNT: '40',
    QY_RACE_BYTES: String(256 * 1024),
    QY_RACE_RUN: run.id,
  })
  const collector = spawnChild({
    QY_RACE_MODE: 'gc',
    QY_RACE_DB: dbPath,
    QY_RACE_BARRIER: String(gate.port),
    QY_RACE_MS: '1200',
  })
  const [a, b] = await Promise.all([collect(lander), collect(collector)])
  gate.stop()

  expect({ land: a.exitCode, landErr: a.err, gc: b.exitCode, gcErr: b.err }).toEqual({
    land: 0,
    landErr: '',
    gc: 0,
    gcErr: '',
  })
  const landed = JSON.parse(a.out) as { startedAt: number; endedAt: number; hashes: string[] }
  const gc = JSON.parse(b.out) as {
    startedAt: number
    endedAt: number
    iterations: number
    removed: number
    errors: string[]
  }

  // 两个进程确实在同一时间段内运行，否则下方的断言测试的只是空窗口。
  const overlap = Math.min(landed.endedAt, gc.endedAt) - Math.max(landed.startedAt, gc.startedAt)
  expect(overlap).toBeGreaterThan(0)
  // 回收方从未被 SQLITE_BUSY 中断：它在主库写锁上等待，取得写锁后继续执行。
  expect(gc.errors).toEqual([])
  expect(gc.iterations).toBeGreaterThan(0)
  expect(gc.removed).toBe(3)

  // 悬空引用检查：账本中每一条 content_hash 都必须仍有对应的字节。
  const check = new Store({ path: dbPath })
  const body = new ContentStore(contentPathFor(dbPath))
  try {
    const refs = check.db
      .query<{ content_hash: string }, []>(
        'SELECT content_hash FROM intermediate_resources WHERE content_hash IS NOT NULL',
      )
      .all()
      .map((r) => r.content_hash)
    expect(refs.length).toBe(40)
    expect(new Set(refs)).toEqual(new Set(landed.hashes))
    expect(refs.filter((h) => body.info(h) === null)).toEqual([])
  } finally {
    body.close()
    check.close()
  }
}, 60_000)

test('大正文占用主库写锁期间，另一进程对主库的写入在 busy_timeout 内完成', async () => {
  const { dbPath, store, conv, run } = seed()
  store.close()

  const gate = barrier(2)
  const lander = spawnChild({
    QY_RACE_MODE: 'land',
    QY_RACE_DB: dbPath,
    QY_RACE_BARRIER: String(gate.port),
    QY_RACE_COUNT: '2',
    QY_RACE_BYTES: String(64 * 1024 * 1024),
    QY_RACE_RUN: run.id,
  })
  const writer = spawnChild({
    QY_RACE_MODE: 'mainwrite',
    QY_RACE_DB: dbPath,
    QY_RACE_BARRIER: String(gate.port),
    QY_RACE_MS: '2500',
    QY_RACE_CONV: conv.id,
  })
  const [a, b] = await Promise.all([collect(lander), collect(writer)])
  gate.stop()

  expect({ land: a.exitCode, landErr: a.err, write: b.exitCode, writeErr: b.err }).toEqual({
    land: 0,
    landErr: '',
    write: 0,
    writeErr: '',
  })
  const landed = JSON.parse(a.out) as { landMs: number[] }
  const wrote = JSON.parse(b.out) as { writes: number; maxMs: number; errors: string[] }

  // 此处测量单次 land 的占锁时长：每份 64 MB，本机约为数百毫秒。
  expect(landed.landMs.length).toBe(2)
  expect(Math.max(...landed.landMs)).toBeGreaterThan(0)
  // 另一进程确实遇到该锁（等待至少 100 ms），且在等待后取得，而不是被拒绝。
  expect(wrote.maxMs).toBeGreaterThanOrEqual(100)
  expect(wrote.maxMs).toBeLessThan(5000)
  expect(wrote.errors).toEqual([])
  expect(wrote.writes).toBeGreaterThan(0)
}, 120_000)

test('进程在主库提交前退出：留下可回收的孤儿正文，不留悬空引用', async () => {
  const { dbPath, store, run } = seed()
  store.close()

  const dying = spawnChild({
    QY_RACE_MODE: 'die',
    QY_RACE_DB: dbPath,
    QY_RACE_BYTES: String(64 * 1024),
    QY_RACE_RUN: run.id,
  })
  const r = await collect(dying)
  expect({ exitCode: r.exitCode, err: r.err }).toEqual({ exitCode: 9, err: '' })

  const check = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  try {
    const n = (sql: string, db: Store | ContentStore) =>
      db.db.query<{ n: number }, []>(sql).get()?.n ?? 0
    // 引用未提交而正文已提交：这正是可回收的孤儿正文，不是悬空引用。
    expect(n('SELECT COUNT(*) AS n FROM intermediate_resources', check)).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM content_blobs', content)).toBe(1)
    expect(collectResourceGarbage(check, content).removed).toBe(1)
    expect(n('SELECT COUNT(*) AS n FROM content_chunks', content)).toBe(0)
  } finally {
    content.close()
    check.close()
  }
}, 30_000)
