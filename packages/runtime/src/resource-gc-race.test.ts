/**
 * 跨操作系统进程的正文写入与回收竞争。**覆盖范围**：`runtime/sink.ts` 的 `RuntimeSink.land`
 * 与 `collectResourceGarbage` 共用的主库锁顺序，以及 `store/content.ts` 的写事务在争锁下的表现。
 * 子进程入口是 `resource-gc-race-child.ts`。
 *
 * 同进程里的交错在 `sink.test.ts` 里验，那里证明的是「窗口不存在」；这里证明的是
 * 「另一个进程会等，等到之后拿到的是完整集合」——等待只有跨进程才成立。
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

/** 建一对真实库文件，并把工作区、会话、run 播好——子进程只写正文与引用。 */
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
 * 屏障：等到 `expected` 个进程都到齐再一起放行。
 *
 * 没有它，先起来的那个进程会在另一个开库之前跑完，两个进程的执行区间不重叠。
 */
function barrier(expected: number) {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived = 0
  const server = Bun.serve({
    port: 0,
    // 先到的那个请求要一直挂到最后一个进程到齐。默认 10 秒的空闲超时会把它掐断，
    // 而子进程冷启动在满负载下就可能超过它——那时失败的是屏障，不是被测行为。
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

test('活跃写入期间另一个进程回收：等得到写权，不删掉正在登记的正文', async () => {
  const { dbPath, store, run } = seed()
  // 播几条没人引用的正文，回收方才有真活可干——removed 恒为 0 证明不了它跑过。
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

  // 两个进程真的在同一段时间里跑，否则下面的断言只是在测一个空窗口。
  const overlap = Math.min(landed.endedAt, gc.endedAt) - Math.max(landed.startedAt, gc.startedAt)
  expect(overlap).toBeGreaterThan(0)
  // 回收方一次都没有被 SQLITE_BUSY 打断：它在主库写锁上等，等到就放行。
  expect(gc.errors).toEqual([])
  expect(gc.iterations).toBeGreaterThan(0)
  expect(gc.removed).toBe(3)

  // 悬空引用检查：账本里每一条 content_hash 都必须还有字节。
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

test('大正文占住主库写锁期间，另一进程写主库在 busy_timeout 内完成', async () => {
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

  // 单次 land 的占锁时长就是这里要量的数：64 MB 一份，本机在几百毫秒量级。
  expect(landed.landMs.length).toBe(2)
  expect(Math.max(...landed.landMs)).toBeGreaterThan(0)
  // 另一进程确实撞上了这把锁（等了至少 100 ms），而且是等到、不是被拒。
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
    // 引用没提交，正文提交了：这正是「可回收孤儿」，不是悬空引用。
    expect(n('SELECT COUNT(*) AS n FROM intermediate_resources', check)).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM content_blobs', content)).toBe(1)
    expect(collectResourceGarbage(check, content).removed).toBe(1)
    expect(n('SELECT COUNT(*) AS n FROM content_chunks', content)).toBe(0)
  } finally {
    content.close()
    check.close()
  }
}, 30_000)
